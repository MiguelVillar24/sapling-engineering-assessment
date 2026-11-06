import { type Expectation, type HandledItem, type HandoffRequest, OPEN_STATUSES, type RequestType } from '../domain.js';
import type { AgentContext, AgentTools } from './context.js';
import type { OpenExpectation } from './dialogue.js';
import type { Intent, IntentType, Interpretation } from './interpreter.js';

/** Standard, FAQ-backed wording. No promise of speed and no deadline, by design. */
export const REVIEW_NOTE = "Texts are read during business hours and aren't monitored continuously.";
export const CLINICAL_SAFETY_NOTE = 'If you think you are having a medical emergency, call 911.';

/** Most recently updated first (compares instants, not strings, so DST offsets can't reorder). */
const newestFirst = (a: HandoffRequest, b: HandoffRequest) =>
  Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id.localeCompare(a.id);

/** Mutable state for handling one inbound message. Policies write to it; the agent turns it into a reply. */
export class Turn {
  readonly parts: string[] = [];
  readonly items: HandledItem[] = [];
  readonly resolves = new Set<string>();
  inReplyTo: string | null = null;
  expects: Expectation | null = null;
  reviewNote = false;
  clinicalNote = false;

  constructor(
    readonly ctx: AgentContext,
    readonly tools: AgentTools,
    readonly interpretation: Interpretation,
    readonly open: OpenExpectation[],
  ) {}

  get name(): string {
    return this.ctx.patient.preferred_name;
  }

  has(type: IntentType): boolean {
    return this.interpretation.intents.some((i) => i.type === type);
  }

  intent<T extends IntentType>(type: T): Extract<Intent, { type: T }> | undefined {
    return this.interpretation.intents.find((i) => i.type === type) as Extract<Intent, { type: T }> | undefined;
  }

  intents<T extends IntentType>(type: T): Array<Extract<Intent, { type: T }>> {
    return this.interpretation.intents.filter((i) => i.type === type) as Array<Extract<Intent, { type: T }>>;
  }

  say(text: string): void {
    this.parts.push(text.trim());
  }

  record(item: HandledItem): void {
    this.items.push(item);
  }

  /** Marks an earlier clinic/agent message as answered by this inbound message. */
  answer(exp: OpenExpectation): void {
    this.resolves.add(exp.messageId);
    this.inReplyTo ??= exp.messageId;
  }

  /** Links this inbound message to the latest agent message about `requestId` (e.g. "is it booked yet?"). */
  linkTo(requestId: string): void {
    if (this.inReplyTo) return;
    const prior = this.ctx.thread.filter((m) => m.id !== this.ctx.inbound.id && m.author === 'agent');
    const hit = [...prior].reverse().find((m) => m.meta.items?.some((i) => i.request_id === requestId));
    if (hit) this.inReplyTo = hit.id;
  }

  firstOpen(kinds: Array<Expectation['kind']>, maxDistance = Infinity): OpenExpectation | undefined {
    return this.open.find((o) => kinds.includes(o.expectation.kind) && o.distance <= maxDistance && !this.resolves.has(o.messageId));
  }

  openRequests(type?: RequestType): HandoffRequest[] {
    return this.ctx.requests
      .filter((r) => OPEN_STATUSES.includes(r.status) && (!type || r.type === type))
      .sort(newestFirst);
  }

  latestRequest(type?: RequestType): HandoffRequest | undefined {
    return [...this.ctx.requests]
      .filter((r) => !type || r.type === type)
      .sort(newestFirst)[0];
  }

  get spoke(): boolean {
    return this.parts.length > 0;
  }

  text(): string {
    const tail = [this.reviewNote || this.clinicalNote ? REVIEW_NOTE : '', this.clinicalNote ? CLINICAL_SAFETY_NOTE : '']
      .filter(Boolean)
      .join(' ');
    const parts = [...this.parts];
    if (tail) parts[parts.length - 1] = `${parts.at(-1) ?? ''} ${tail}`.trim();
    return parts.join('\n\n');
  }
}
