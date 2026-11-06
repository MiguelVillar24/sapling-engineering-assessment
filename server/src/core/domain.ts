import type { Appointment, OpenSlot } from './clinic-data/types.js';
import type { WhenSpec } from './time/when.js';

/** Shapes persisted in SQLite. Kept framework-free so the agent, HTTP layer, scripts and evals share them. */

export type Author = 'patient' | 'clinic_staff' | 'agent';
export type Direction = 'inbound' | 'outbound';

export interface Conversation {
  id: string;
  patient_id: string;
  channel: 'sms';
  patient_number: string;
  clinic_number: string;
  started_by: 'clinic' | 'patient' | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  seq: number;
  direction: Direction;
  author: Author;
  from_number: string;
  to_number: string;
  body: string;
  /** The earlier message (clinic, agent or patient) this one answers. */
  in_reply_to: string | null;
  meta: MessageMeta;
  created_at: string;
}

export interface MessageMeta {
  /** Outbound messages: what kind of reply would answer them (dialogue state). */
  expects?: Expectation;
  /** Agent replies: what the agent did for this turn (answered / filed / updated ...). */
  items?: HandledItem[];
  /** Inbound messages: expectations (message ids) this message answered. */
  resolves?: string[];
  /** Clinic outbound messages are simulated; nothing is sent over SMS. */
  simulated_sms?: boolean;
  agent_run_id?: string;
  fallback?: boolean;
}

export const REQUEST_TYPES = [
  'appointment_request',
  'refill',
  'clinical_question',
  'billing',
  'other',
  'emergency',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_STATUSES = ['pending_staff', 'in_progress', 'completed', 'declined', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
/** Statuses the agent may still update (a later patient message changes the same record). */
export const OPEN_STATUSES: readonly RequestStatus[] = ['pending_staff', 'in_progress'];

export interface HandoffRequest {
  id: string;
  patient_id: string;
  conversation_id: string | null;
  type: RequestType;
  status: RequestStatus;
  priority: 'routine' | 'urgent';
  summary: string;
  details: Record<string, unknown>;
  source_message_ids: string[];
  revision: number;
  staff_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestEvent {
  id: number;
  request_id: string;
  at: string;
  actor: 'agent' | 'staff' | 'system';
  kind: 'created' | 'updated' | 'status_changed' | 'note';
  message_id: string | null;
  changes: Record<string, { from: unknown; to: unknown }>;
  note: string | null;
}

export interface AgentRun {
  id: string;
  conversation_id: string;
  inbound_message_id: string;
  reply_message_id: string | null;
  mode: string;
  trace: Record<string, unknown>;
  error: string | null;
  created_at: string;
}

// --- Dialogue state carried on outbound messages ---------------------------

export interface AppointmentFlow {
  action: 'schedule' | 'reschedule' | 'cancel';
  reason: string;
  provider: string | null;
  /** Why the visit is needed, from the record / clinic message (so staff never have to ask). */
  context: string | null;
  related_appointment: Appointment | null;
  origin_message_ids: string[];
}

export type Expectation =
  | { kind: 'appointment_offer'; flow: AppointmentFlow }
  | { kind: 'time_preference'; flow: AppointmentFlow; offered_slots: OpenSlot[] }
  | {
      kind: 'appointment_reason';
      suggested_reason: string | null;
      provider: string | null;
      context: string | null;
      pending_when: WhenSpec | null;
      origin_message_ids: string[];
    }
  | { kind: 'staff_handoff_offer'; topic: string; request: { type: RequestType; details: Record<string, unknown> } }
  | { kind: 'staff_question'; question: string }
  /** "Cancel it" was ambiguous between the pending request and the booked appointment. */
  | { kind: 'cancel_target'; request_id: string; appointment: Appointment };

export type HandledKind =
  | 'answered'
  | 'request_created'
  | 'request_updated'
  | 'request_status'
  | 'offered_handoff'
  | 'asked_followup'
  | 'emergency'
  | 'acknowledged'
  | 'not_understood';

export interface HandledItem {
  kind: HandledKind;
  topic: string;
  /** Where an answer came from, e.g. "faq:hours" or "record:balance". */
  source?: string;
  request_id?: string;
}
