import type { ClinicData, PatientRecord } from '../clinic-data/types.js';
import type { AgentRun, Conversation, Message } from '../domain.js';
import type { PatientAgent, Understanding } from '../agent/agent.js';
import { analyzeClinicMessage } from '../agent/clinic-message.js';
import { RequestTools, type AgentContext } from '../agent/context.js';
import { detectEmergency, EMERGENCY_RESPONSE } from '../agent/safety.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { DomainError, type RequestService } from '../requests/request-service.js';
import { type Db, transaction } from '../store/db.js';
import type { Repositories } from '../store/repositories.js';
import type { ScenarioClock } from '../time/clock.js';


export interface InboundResult {
  inbound: Message;
  reply: Message;
  run: AgentRun;
}

export { NotFoundError, ValidationError };

const MAX_BODY = 1600; // ~10 SMS segments

/**
 * Conversation operations. Patient (inbound) messages are always persisted
 * first, so nothing the patient says is lost even if the agent fails. The
 * agent's request writes, its reply and its trace then commit atomically.
 */
export class MessagingService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly clinic: ClinicData,
    private readonly clock: ScenarioClock,
    private readonly requests: RequestService,
    private readonly agent: PatientAgent,
  ) {}

  patient(patientId?: string): PatientRecord {
    const p = patientId ? this.clinic.patients.find((x) => x.patient_id === patientId) : this.clinic.patients[0];
    if (!p) throw new NotFoundError(`Patient ${patientId} not found`);
    return p;
  }

  createConversation(patientId?: string): Conversation {
    const p = this.patient(patientId);
    const at = this.clock.now().toISO()!;
    return transaction(this.db, () =>
      this.repos.conversations.insert({
        id: this.repos.ids.next('conv'),
        patient_id: p.patient_id,
        channel: 'sms',
        patient_number: p.phone,
        clinic_number: this.clinic.clinicSmsNumber,
        started_by: null,
        created_at: at,
        updated_at: at,
      }),
    );
  }

  /** Makes sure the demo has a conversation to type into. */
  ensureConversation(): Conversation {
    return this.repos.conversations.list()[0] ?? this.createConversation();
  }

  listConversations(): Conversation[] {
    return this.repos.conversations.list();
  }

  conversation(id: string): Conversation {
    const c = this.repos.conversations.get(id);
    if (!c) throw new NotFoundError(`Conversation ${id} not found`);
    return c;
  }

  thread(conversationId: string): Message[] {
    this.conversation(conversationId);
    return this.repos.messages.thread(conversationId);
  }

  /** A message typed by clinic staff. Displayed and saved only: no SMS is sent. */
  sendClinicMessage(conversationId: string, body: string): Message {
    const conv = this.conversation(conversationId);
    const text = this.validBody(body);
    const p = this.patient(conv.patient_id);
    const at = this.clock.now().toISO()!;
    return transaction(this.db, () => {
      const id = this.repos.ids.next('msg');
      const expects = analyzeClinicMessage(id, text, p, this.clinic.slots.map((s) => s.provider)) ?? undefined;
      const msg = this.repos.messages.insert({
        id,
        conversation_id: conv.id,
        direction: 'outbound',
        author: 'clinic_staff',
        from_number: conv.clinic_number,
        to_number: conv.patient_number,
        body: text,
        in_reply_to: null,
        meta: { simulated_sms: true, expects },
        created_at: at,
      });
      this.repos.conversations.touch(conv.id, at, 'clinic');
      return msg;
    });
  }

  /** A text from the patient. Phase 1: always treated as sent from the number on file. */
  receivePatientMessage(conversationId: string, body: string): Promise<InboundResult> {
    const prev = this.queues.get(conversationId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.handleInbound(conversationId, body));
    this.queues.set(conversationId, next);
    return next;
  }

  private async handleInbound(conversationId: string, body: string): Promise<InboundResult> {
    const conv = this.conversation(conversationId);
    const text = this.validBody(body);
    const patient = this.patient(conv.patient_id);
    const now = this.clock.now();
    const at = now.toISO()!;

    const { inbound, runId, replyId } = transaction(this.db, () => {
      const msg = this.repos.messages.insert({
        id: this.repos.ids.next('msg'),
        conversation_id: conv.id,
        direction: 'inbound',
        author: 'patient',
        from_number: patient.phone,
        to_number: conv.clinic_number,
        body: text,
        in_reply_to: null,
        meta: {},
        created_at: at,
      });
      this.repos.conversations.touch(conv.id, at, 'patient');
      return { inbound: msg, runId: this.repos.ids.next('run'), replyId: this.repos.ids.next('msg') };
    });

    const ctx: AgentContext = {
      now,
      patient,
      clinic: this.clinic,
      conversation: conv,
      thread: this.repos.messages.thread(conv.id),
      inbound,
      requests: this.requests.list({ patientId: patient.patient_id }),
      replyMessageId: replyId,
    };

    let understanding: Understanding | null = null;
    try {
      understanding = await this.agent.understand(ctx);
      const u = understanding;
      return transaction(this.db, () => {
        const tools = new RequestTools(this.requests, ctx);
        const outcome = this.agent.act(ctx, u, tools);
        const reply = this.repos.messages.insert({
          id: replyId,
          conversation_id: conv.id,
          direction: 'outbound',
          author: 'agent',
          from_number: conv.clinic_number,
          to_number: conv.patient_number,
          body: outcome.text,
          in_reply_to: inbound.id,
          meta: { items: outcome.items, expects: outcome.expects ?? undefined, agent_run_id: runId },
          created_at: at,
        });
        const inboundMeta = outcome.resolves.length ? { resolves: outcome.resolves } : {};
        this.repos.messages.setReplyLink(inbound.id, outcome.inReplyTo, inboundMeta);
        const run: AgentRun = {
          id: runId,
          conversation_id: conv.id,
          inbound_message_id: inbound.id,
          reply_message_id: reply.id,
          mode: this.agent.mode,
          trace: {
            ...outcome.trace,
            in_reply_to: outcome.inReplyTo,
            emergency: u.emergency,
            interpretation: u.interpretation ? { interpreter: u.interpretation.interpreter, normalized: u.interpretation.normalized } : null,
            tool_calls: tools.calls,
          },
          error: null,
          created_at: at,
        };
        this.repos.runs.insert(run);
        return { inbound: { ...inbound, in_reply_to: outcome.inReplyTo, meta: inboundMeta }, reply, run };
      });
    } catch (err) {
      return this.fallback(conv, inbound, runId, replyId, at, err, understanding);
    }
  }

  /**
   * Everything from the failed turn was rolled back, so the reply must not
   * claim anything was saved. An emergency still gets the exact emergency text.
   */
  private fallback(
    conv: Conversation,
    inbound: Message,
    runId: string,
    replyId: string,
    at: string,
    err: unknown,
    understanding: Understanding | null,
  ): InboundResult {
    const emergency = understanding?.emergency ?? detectEmergency(inbound.body);
    const phone = this.clinic.phoneDisplay ?? 'the clinic';
    const text = emergency
      ? EMERGENCY_RESPONSE
      : `Sorry, something went wrong on our end and I couldn't process your message, so no request was created from it. Please try again, or call the clinic at ${phone} during business hours.`;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] turn failed for ${inbound.id}: ${message}`);
    return transaction(this.db, () => {
      const reply = this.repos.messages.insert({
        id: replyId,
        conversation_id: conv.id,
        direction: 'outbound',
        author: 'agent',
        from_number: conv.clinic_number,
        to_number: conv.patient_number,
        body: text,
        in_reply_to: inbound.id,
        meta: { fallback: true, agent_run_id: runId, items: [{ kind: emergency ? 'emergency' : 'not_understood', topic: 'agent_error' }] },
        created_at: at,
      });
      const run: AgentRun = {
        id: runId,
        conversation_id: conv.id,
        inbound_message_id: inbound.id,
        reply_message_id: reply.id,
        mode: this.agent.mode,
        trace: { fallback: true, emergency_signals: emergency?.signals ?? [], handoff_logged: false },
        error: err instanceof DomainError ? `${err.code}: ${err.message}` : message,
        created_at: at,
      };
      this.repos.runs.insert(run);
      return { inbound, reply, run };
    });
  }

  private validBody(body: unknown): string {
    if (typeof body !== 'string' || !body.trim()) throw new ValidationError('Message body must be a non-empty string');
    if (body.length > MAX_BODY) throw new ValidationError(`Message body must be at most ${MAX_BODY} characters`);
    return body.trim();
  }
}
