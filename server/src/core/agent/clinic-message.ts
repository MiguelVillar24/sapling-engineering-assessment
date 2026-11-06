import type { PatientRecord } from '../clinic-data/types.js';
import type { AppointmentFlow, Expectation } from '../domain.js';
import { normalize } from './text.js';

/**
 * Reads a clinic-staff outbound message and records what kind of reply it
 * invites, so a later "yes" from the patient can be matched to it.
 * Example: message 0 offers to request a blood-pressure recheck with Dr. Lee.
 */

const OFFER =
  /\b(would you like|do you want|want us to|shall we|should we|can we|could we|like us to|like me to|happy to)\b[^?]{0,80}\b(request|schedule|book|set up|make|find|arrange)\b[^?]{0,40}\b(time|appointment|appt|visit|slot|recheck|follow[- ]?up)\b|\brequest a time\b/;

export function knownProviders(patient: PatientRecord, extra: string[] = []): string[] {
  return [...new Set([patient.last_visit.provider, ...patient.upcoming_appointments.map((a) => a.provider), ...extra])];
}

/** "Dr. Lee" -> "Dr. Priya Lee" when the record knows that provider. */
export function resolveProvider(text: string, providers: string[]): string | null {
  const m = normalize(text).match(/\b(?:dr\.?|doctor)\s+([a-z][a-z'-]+)/);
  if (!m) return null;
  const last = m[1];
  const hit = providers.find((p) => normalize(p).split(/\s+/).at(-1) === last || normalize(p).includes(` ${last}`));
  return hit ?? `Dr. ${last.charAt(0).toUpperCase()}${last.slice(1)}`;
}

/** Clinical context for a BP recheck taken from the record, so staff never need to ask why. */
export function recheckContext(patient: PatientRecord): string {
  const v = patient.last_visit;
  return `Last visit ${v.date} with ${v.provider} (${v.reason}). Plan note: "${v.plan_note}"`;
}

export function planCallsForBpRecheck(patient: PatientRecord): boolean {
  return /\b(bp|blood pressure)\b/i.test(patient.last_visit.plan_note) && /\b(recheck|re-check|check)\b/i.test(patient.last_visit.plan_note);
}

export function analyzeClinicMessage(
  messageId: string,
  body: string,
  patient: PatientRecord,
  slotProviders: string[],
): Expectation | null {
  const t = normalize(body);
  const providers = knownProviders(patient, slotProviders);
  if (OFFER.test(t)) {
    const bp = /\b(blood pressure|bp)\b/.test(t);
    const reason = bp
      ? 'Blood pressure recheck'
      : /\bfollow[- ]?up\b/.test(t)
        ? 'Follow-up visit'
        : /\bphysical\b/.test(t)
          ? 'Annual physical'
          : /\b(flu|vaccine|shot)\b/.test(t)
            ? 'Vaccination'
            : 'Visit requested by the clinic';
    const flow: AppointmentFlow = {
      action: 'schedule',
      reason,
      provider: resolveProvider(body, providers) ?? (bp ? patient.last_visit.provider : null),
      context: bp ? recheckContext(patient) : `Clinic message: "${body.trim()}"`,
      related_appointment: null,
      origin_message_ids: [messageId],
    };
    return { kind: 'appointment_offer', flow };
  }
  if (/\?\s*("|')?\s*$/.test(body.trim()) || /\?/.test(body)) {
    return { kind: 'staff_question', question: body.trim() };
  }
  return null;
}
