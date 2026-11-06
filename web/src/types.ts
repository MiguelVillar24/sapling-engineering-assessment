/** Mirrors the server's persisted shapes (server/src/core/domain.ts). */

export type Author = 'patient' | 'clinic_staff' | 'agent';
export type RequestStatus = 'pending_staff' | 'in_progress' | 'completed' | 'declined' | 'cancelled';
export const REQUEST_STATUSES: RequestStatus[] = ['pending_staff', 'in_progress', 'completed', 'declined', 'cancelled'];

export interface HandledItem {
  kind: string;
  topic: string;
  source?: string;
  request_id?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  seq: number;
  direction: 'inbound' | 'outbound';
  author: Author;
  from_number: string;
  to_number: string;
  body: string;
  in_reply_to: string | null;
  meta: {
    expects?: { kind: string };
    items?: HandledItem[];
    resolves?: string[];
    simulated_sms?: boolean;
    agent_run_id?: string;
    fallback?: boolean;
  };
  created_at: string;
}

export interface Conversation {
  id: string;
  patient_id: string;
  channel: string;
  patient_number: string;
  clinic_number: string;
  started_by: 'clinic' | 'patient' | null;
  created_at: string;
  updated_at: string;
}

export interface RequestEvent {
  id: number;
  request_id: string;
  at: string;
  actor: 'agent' | 'staff' | 'system';
  kind: string;
  message_id: string | null;
  changes: Record<string, { from: unknown; to: unknown }>;
  note: string | null;
}

export interface HandoffRequest {
  id: string;
  patient_id: string;
  conversation_id: string | null;
  type: string;
  status: RequestStatus;
  priority: 'routine' | 'urgent';
  summary: string;
  details: Record<string, unknown>;
  source_message_ids: string[];
  revision: number;
  staff_note: string | null;
  created_at: string;
  updated_at: string;
  events: RequestEvent[];
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

export interface Patient {
  patient_id: string;
  name: string;
  preferred_name: string;
  date_of_birth: string;
  phone: string;
  conditions: string[];
  medications: Array<{ name: string; dose: string; frequency: string; refills_remaining: number }>;
  pharmacy: string;
  insurance: { payer: string; plan: string };
  last_visit: { date: string; provider: string; reason: string; plan_note: string };
  upcoming_appointments: Array<{ date: string; time: string; provider: string; type: string; status: string }>;
  balance: { amount: number; reason: string };
}

export interface Settings {
  clock: { now: string; mode: 'frozen' | 'running'; default_now: string; zone: string };
  agent_mode: string;
}

export interface ScriptStep {
  step: number;
  from: 'clinic' | 'patient';
  text: string;
  expected: string;
}

export interface AppState {
  clinic: { name: string; sms_number: string; phone: string | null; timezone: string };
  patient: Patient;
  settings: Settings;
  conversations: Conversation[];
  script: ScriptStep[];
}

export interface ThreadResponse {
  conversation: Conversation;
  messages: Message[];
  agent_runs: AgentRun[];
}
