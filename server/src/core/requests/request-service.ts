import { z } from 'zod';
import {
  type HandoffRequest,
  OPEN_STATUSES,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  type RequestEvent,
  type RequestStatus,
  type RequestType,
} from '../domain.js';
import { type Db, transaction } from '../store/db.js';
import type { Repositories } from '../store/repositories.js';
import type { ScenarioClock } from '../time/clock.js';
import { REQUEST_TYPE_REGISTRY } from './request-types.js';

export class DomainError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_request_type' | 'invalid_details' | 'request_closed' | 'invalid_status',
    message: string,
  ) {
    super(message);
  }
}

const unique = (ids: string[]) => [...new Set(ids.filter(Boolean))];

function diff(before: Record<string, unknown>, after: Record<string, unknown>): RequestEvent['changes'] {
  const changes: RequestEvent['changes'] = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return changes;
}

/**
 * The only way requests are written. Invariants enforced here (not in the agent):
 *  - new requests always start as `pending_staff`;
 *  - details are validated against the type's schema;
 *  - a patient change updates the same record (revision + 1) and returns it to staff review;
 *  - closed requests cannot be changed by the agent;
 *  - status transitions are staff-only;
 *  - every write leaves an audit event.
 */
export class RequestService {
  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly clock: ScenarioClock,
  ) {}

  create(input: {
    patientId: string;
    conversationId: string | null;
    type: RequestType;
    details: Record<string, unknown>;
    sourceMessageIds: string[];
    actor?: 'agent' | 'staff';
  }): HandoffRequest {
    if (!(REQUEST_TYPES as readonly string[]).includes(input.type)) {
      throw new DomainError('invalid_request_type', `Unknown request type "${input.type}"`);
    }
    const def = REQUEST_TYPE_REGISTRY[input.type];
    const details = this.validate(input.type, input.details);
    const now = this.clock.now();
    const at = now.toISO()!;
    return transaction(this.db, () => {
      const req: HandoffRequest = {
        id: this.repos.ids.next('req'),
        patient_id: input.patientId,
        conversation_id: input.conversationId,
        type: input.type,
        status: 'pending_staff',
        priority: def.defaultPriority,
        summary: def.summarize(details, now),
        details,
        source_message_ids: unique(input.sourceMessageIds),
        revision: 1,
        staff_note: null,
        created_at: at,
        updated_at: at,
      };
      this.repos.requests.insert(req);
      this.repos.events.insert({
        request_id: req.id,
        at,
        actor: input.actor ?? 'agent',
        kind: 'created',
        message_id: req.source_message_ids.at(-1) ?? null,
        changes: {},
        note: req.summary,
      });
      return req;
    });
  }

  /** Patient-driven change to an open request (agent tool). Keeps the same id. */
  amend(
    id: string,
    input: { details?: Record<string, unknown>; addSourceMessageIds?: string[]; note?: string },
  ): HandoffRequest {
    const existing = this.mustGet(id);
    if (!OPEN_STATUSES.includes(existing.status)) {
      throw new DomainError('request_closed', `Request ${id} is ${existing.status}; it can no longer be changed by the agent`);
    }
    const def = REQUEST_TYPE_REGISTRY[existing.type];
    const details = this.validate(existing.type, { ...existing.details, ...(input.details ?? {}) });
    const now = this.clock.now();
    const at = now.toISO()!;
    const changes = diff(existing.details, details);
    const sources = unique([...existing.source_message_ids, ...(input.addSourceMessageIds ?? [])]);
    if (sources.length !== existing.source_message_ids.length) {
      changes.source_message_ids = { from: existing.source_message_ids, to: sources };
    }
    const status: RequestStatus = 'pending_staff';
    if (existing.status !== status) changes.status = { from: existing.status, to: status };
    const updated: HandoffRequest = {
      ...existing,
      details,
      status,
      summary: def.summarize(details, now),
      source_message_ids: sources,
      revision: existing.revision + 1,
      updated_at: at,
    };
    transaction(this.db, () => {
      this.repos.requests.update(updated);
      this.repos.events.insert({
        request_id: id,
        at,
        actor: 'agent',
        kind: 'updated',
        message_id: input.addSourceMessageIds?.at(-1) ?? null,
        changes,
        note: input.note ?? null,
      });
    });
    return updated;
  }

  /** Staff-only status change (the agent has no access to this method). */
  setStatus(id: string, status: string, note?: string | null): HandoffRequest {
    if (!(REQUEST_STATUSES as readonly string[]).includes(status)) {
      throw new DomainError('invalid_status', `Unknown status "${status}"`);
    }
    const existing = this.mustGet(id);
    const at = this.clock.now().toISO()!;
    const updated: HandoffRequest = {
      ...existing,
      status: status as RequestStatus,
      staff_note: note === undefined ? existing.staff_note : note,
      revision: existing.revision + 1,
      updated_at: at,
    };
    const changes: RequestEvent['changes'] = {};
    if (existing.status !== updated.status) changes.status = { from: existing.status, to: updated.status };
    if (existing.staff_note !== updated.staff_note) changes.staff_note = { from: existing.staff_note, to: updated.staff_note };
    transaction(this.db, () => {
      this.repos.requests.update(updated);
      this.repos.events.insert({
        request_id: id,
        at,
        actor: 'staff',
        kind: changes.status ? 'status_changed' : 'note',
        message_id: null,
        changes,
        note: note ?? null,
      });
    });
    return updated;
  }

  get(id: string): HandoffRequest | null {
    return this.repos.requests.get(id);
  }

  list(filter: { patientId?: string; status?: string } = {}): HandoffRequest[] {
    return this.repos.requests.list(filter);
  }

  events(id: string): RequestEvent[] {
    return this.repos.events.forRequest(id);
  }

  private mustGet(id: string): HandoffRequest {
    const req = this.repos.requests.get(id);
    if (!req) throw new DomainError('not_found', `Request ${id} not found`);
    return req;
  }

  private validate(type: RequestType, details: Record<string, unknown>): Record<string, unknown> {
    const result = REQUEST_TYPE_REGISTRY[type].schema.safeParse(details);
    if (!result.success) {
      throw new DomainError('invalid_details', `Invalid ${type} details: ${z.prettifyError(result.error)}`);
    }
    return result.data as Record<string, unknown>;
  }
}
