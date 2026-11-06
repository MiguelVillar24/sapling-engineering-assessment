import type { DateTime } from 'luxon';
import type { ClinicData, PatientRecord } from '../clinic-data/types.js';
import type { Conversation, HandoffRequest, Message, RequestType } from '../domain.js';
import type { RequestService } from '../requests/request-service.js';

/** Everything the agent may use on a turn: record, FAQ/slots, the full thread and the patient's requests. */
export interface AgentContext {
  now: DateTime;
  patient: PatientRecord;
  clinic: ClinicData;
  conversation: Conversation;
  /** Full thread, oldest first, including the inbound message being handled. */
  thread: Message[];
  inbound: Message;
  /** All of this patient's requests (any conversation); tools keep it current within a turn. */
  requests: HandoffRequest[];
  /** Pre-allocated id of the reply message (lets an emergency handoff reference the response). */
  replyMessageId: string;
}

/**
 * The agent's only write capabilities. There is deliberately no tool to set a
 * status, book, reschedule, cancel or approve anything: staff do that.
 */
export interface AgentTools {
  createRequest(type: RequestType, details: Record<string, unknown>, sourceMessageIds: string[]): HandoffRequest;
  amendRequest(id: string, details: Record<string, unknown>, addSourceMessageIds: string[], note?: string): HandoffRequest;
}

export interface ToolCall {
  tool: 'create_request' | 'amend_request';
  input: Record<string, unknown>;
  result: { id: string; status: string; revision: number };
}

export class RequestTools implements AgentTools {
  readonly calls: ToolCall[] = [];

  constructor(
    private readonly service: RequestService,
    private readonly ctx: AgentContext,
  ) {}

  createRequest(type: RequestType, details: Record<string, unknown>, sourceMessageIds: string[]): HandoffRequest {
    const req = this.service.create({
      patientId: this.ctx.patient.patient_id,
      conversationId: this.ctx.conversation.id,
      type,
      details,
      sourceMessageIds,
      actor: 'agent',
    });
    this.ctx.requests.push(req);
    this.calls.push({ tool: 'create_request', input: { type, details, sourceMessageIds }, result: { id: req.id, status: req.status, revision: req.revision } });
    return req;
  }

  amendRequest(id: string, details: Record<string, unknown>, addSourceMessageIds: string[], note?: string): HandoffRequest {
    const req = this.service.amend(id, { details, addSourceMessageIds, note });
    const i = this.ctx.requests.findIndex((r) => r.id === id);
    if (i >= 0) this.ctx.requests[i] = req;
    this.calls.push({ tool: 'amend_request', input: { id, details, addSourceMessageIds, note }, result: { id: req.id, status: req.status, revision: req.revision } });
    return req;
  }
}
