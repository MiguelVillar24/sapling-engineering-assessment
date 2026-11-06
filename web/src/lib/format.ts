import type { HandledItem } from '../types';

export const CLINIC_TZ = 'America/Los_Angeles';

export function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: CLINIC_TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function fmtDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

export function fmtDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** ISO instant -> "YYYY-MM-DDTHH:mm" in clinic-local time (for <input type="datetime-local">). */
export function toClinicLocalInput(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: CLINIC_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export const TYPE_LABEL: Record<string, string> = {
  appointment_request: 'Appointment request',
  refill: 'Refill',
  clinical_question: 'Clinical question',
  billing: 'Billing',
  other: 'Other',
  emergency: 'Emergency',
};

export const STATUS_LABEL: Record<string, string> = {
  pending_staff: 'Pending staff review',
  in_progress: 'In progress',
  completed: 'Completed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

export function sourceLabel(source?: string): string {
  if (!source) return '';
  return source
    .split(' + ')
    .map((s) => {
      const [kind, key] = s.split(':');
      if (kind === 'faq') return `FAQ (${key.replace(/_/g, ' ')})`;
      if (kind === 'record') return `patient record (${key.replace(/_/g, ' ')})`;
      return s;
    })
    .join(' + ');
}

export function itemChip(i: HandledItem): { text: string; tone: 'ok' | 'pending' | 'info' | 'danger' | 'muted' } {
  switch (i.kind) {
    case 'answered':
      return { text: `Answered from ${sourceLabel(i.source) || 'available data'}`, tone: 'ok' };
    case 'request_created':
      return { text: `Filed ${i.request_id} · pending staff review`, tone: 'pending' };
    case 'request_updated':
      return { text: `Updated ${i.request_id} (same request)`, tone: 'pending' };
    case 'request_status':
      return { text: `Read actual status of ${i.request_id}`, tone: 'ok' };
    case 'offered_handoff':
      return { text: 'Not in FAQ/record · offered to ask staff', tone: 'info' };
    case 'asked_followup':
      return { text: `Asked a follow-up (${i.topic.replace(/_/g, ' ')})`, tone: 'info' };
    case 'emergency':
      return { text: `Emergency rule · handoff ${i.request_id ?? 'not logged'}`, tone: 'danger' };
    case 'not_understood':
      return { text: 'Not understood · offered staff', tone: 'muted' };
    default:
      return { text: i.topic.replace(/_/g, ' '), tone: 'muted' };
  }
}

export function pretty(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
}
