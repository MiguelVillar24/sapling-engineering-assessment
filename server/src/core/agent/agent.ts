import { DateTime } from 'luxon';
import { type Expectation, type HandledItem, OPEN_STATUSES } from '../domain.js';
import type { EmergencyDetailsT } from '../requests/request-types.js';
import type { AgentContext, AgentTools } from './context.js';
import { openExpectations } from './dialogue.js';
import type { Interpretation, Interpreter } from './interpreter.js';
import { respond } from './policy/index.js';
import { detectEmergency, EMERGENCY_RESPONSE, type EmergencyAssessment } from './safety.js';
import { Turn } from './turn.js';

export interface Understanding {
  emergency: EmergencyAssessment | null;
  interpretation: Interpretation | null;
}

export interface AgentOutcome {
  text: string;
  items: HandledItem[];
  expects: Expectation | null;
  inReplyTo: string | null;
  resolves: string[];
  trace: Record<string, unknown>;
}

/**
 * The patient-messaging agent.
 *
 *   inbound text
 *     -> safety screen (deterministic; emergencies short-circuit everything)
 *     -> interpreter (text -> intents; swappable)
 *     -> policies (decide; call tools; write the reply from fixed templates)
 *
 * `understand` is async and side-effect free (an LLM interpreter could be slow);
 * `act` is synchronous and runs inside one DB transaction with the reply insert,
 * so a request is never reported as saved unless it actually was.
 */
export class PatientAgent {
  constructor(readonly interpreter: Interpreter) {}

  get mode(): string {
    return this.interpreter.name;
  }

  async understand(ctx: AgentContext): Promise<Understanding> {
    const emergency = detectEmergency(ctx.inbound.body);
    if (emergency) return { emergency, interpretation: null };
    const interpretation = await this.interpreter.interpret(ctx.inbound.body, { patient: ctx.patient });
    return { emergency: null, interpretation };
  }

  act(ctx: AgentContext, understanding: Understanding, tools: AgentTools): AgentOutcome {
    if (understanding.emergency) return this.emergency(ctx, understanding.emergency, tools);
    const open = openExpectations(ctx.thread, ctx.inbound.id);
    const turn = new Turn(ctx, tools, understanding.interpretation!, open);
    respond(turn);
    return {
      text: turn.text(),
      items: turn.items,
      expects: turn.expects,
      inReplyTo: turn.inReplyTo,
      resolves: [...turn.resolves],
      trace: {
        open_expectations: open.map((o) => ({ message_id: o.messageId, kind: o.expectation.kind, distance: o.distance })),
        intents: understanding.interpretation!.intents,
        handled: turn.items,
        expects: turn.expects?.kind ?? null,
      },
    };
  }

  /** Exact emergency text, nothing else; the handoff is logged but the patient is not told staff will review it. */
  private emergency(ctx: AgentContext, assessment: EmergencyAssessment, tools: AgentTools): AgentOutcome {
    // Repeated emergency messages in one conversation update the same open handoff (no duplicates).
    const recent = (iso: string) => DateTime.fromISO(iso) >= ctx.now.minus({ hours: 2 });
    const existing = ctx.requests.find(
      (r) => r.type === 'emergency' && r.conversation_id === ctx.conversation.id && OPEN_STATUSES.includes(r.status) && recent(r.updated_at),
    );
    const message = { message_id: ctx.inbound.id, text: ctx.inbound.body };
    let requestId: string;
    if (existing) {
      const d = existing.details as EmergencyDetailsT;
      requestId = tools.amendRequest(
        existing.id,
        {
          detected_signals: [...new Set([...d.detected_signals, ...assessment.signals])],
          patient_messages: [...d.patient_messages, message],
          response_message_ids: [...d.response_message_ids, ctx.replyMessageId],
        },
        [ctx.inbound.id],
        'Another possible-emergency message in the same conversation',
      ).id;
    } else {
      const details: EmergencyDetailsT = {
        detected_signals: assessment.signals,
        patient_messages: [message],
        response_sent: EMERGENCY_RESPONSE,
        response_message_ids: [ctx.replyMessageId],
        note: 'Patient was told to call 911 or go to the nearest emergency room. The patient was not told that staff would review this.',
      };
      requestId = tools.createRequest('emergency', details, [ctx.inbound.id]).id;
    }
    return {
      text: EMERGENCY_RESPONSE,
      items: [{ kind: 'emergency', topic: 'emergency', request_id: requestId }],
      expects: null,
      inReplyTo: null,
      resolves: [],
      trace: { emergency_signals: assessment.signals },
    };
  }
}
