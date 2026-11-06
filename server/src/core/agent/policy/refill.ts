import type { Medication } from '../../clinic-data/types.js';
import type { RefillDetailsT } from '../../requests/request-types.js';
import { normalize } from '../text.js';
import type { Turn } from '../turn.js';

/** Common antihypertensives, used only to resolve "my BP med" when a patient has several medications. */
const BP_MEDS = /\b(lisinopril|losartan|amlodipine|metoprolol|hydrochlorothiazide|hctz|valsartan|olmesartan|carvedilol|chlorthalidone|enalapril|ramipril|benazepril|irbesartan|nifedipine|diltiazem|atenolol|spironolactone)\b/;

const CHAINS = /\b(cvs|walgreens|rite aid|walmart|costco|target|kroger|safeway|ralphs|vons|albertsons|sam'?s club)\b/i;

/** A pharmacy the patient names in this message, if different from the one on file. */
function requestedPharmacy(text: string, onFile: string): string | null {
  const chain = text.match(CHAINS)?.[1];
  const named = text.match(/\b((?:[A-Z][\w'&-]*\s+){0,3}[A-Z][\w'&-]*)\s+[Pp]harmacy\b/)?.[1];
  const name = chain ? chain.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Cvs$/, 'CVS') : named ? `${named} Pharmacy` : null;
  if (!name) return null;
  return onFile.toLowerCase().includes(name.toLowerCase().replace(/ pharmacy$/, '')) ? null : name;
}

export function resolveMedication(mention: string | null, meds: Medication[]): Medication | 'ambiguous' | null {
  if (!meds.length) return null;
  const m = mention ? normalize(mention) : '';
  const named = meds.find((med) => m.includes(med.name.toLowerCase()));
  if (named) return named;
  if (meds.length === 1) return meds[0];
  if (/\b(bp|blood pressure|pressure|hypertension)\b/.test(m)) {
    const bp = meds.filter((med) => BP_MEDS.test(med.name.toLowerCase()));
    if (bp.length === 1) return bp[0];
  }
  return 'ambiguous';
}

/**
 * Refills are filed with everything staff need from the record (drug, dose,
 * frequency, refills left, pharmacy) so the patient is never asked for them.
 */
export function handleRefill(turn: Turn): void {
  const r = turn.intent('refill');
  if (!r) return;
  const { ctx } = turn;
  const p = ctx.patient;
  const med = resolveMedication(r.medicationMention, p.medications);
  if (med === null) {
    turn.say("I don't see any medications on your record, so I can't send a refill request. Would you like me to pass your message to clinic staff?");
    turn.expects = {
      kind: 'staff_handoff_offer',
      topic: 'refill',
      request: { type: 'other', details: { reason: 'refill_question', question: null, patient_message: ctx.inbound.body, context: {} } },
    };
    turn.record({ kind: 'offered_handoff', topic: 'refill' });
    return;
  }
  if (med === 'ambiguous') {
    turn.say(`Which medication do you need refilled: ${p.medications.map((m) => `${m.name} ${m.dose}`).join(' or ')}? Reply with "refill" and the name.`);
    turn.record({ kind: 'asked_followup', topic: 'refill_medication' });
    return;
  }

  const existing = turn.openRequests('refill').find((q) => {
    const d = q.details as RefillDetailsT;
    return d.medication.toLowerCase() === med.name.toLowerCase();
  });
  if (existing) {
    turn.tools.amendRequest(existing.id, {}, [ctx.inbound.id], 'Patient asked about the same refill again');
    turn.say(`Your refill request for ${med.name} ${med.dose} is already with clinic staff and is still pending review, so I've added your message to it rather than starting a new one.`);
    turn.record({ kind: 'request_updated', topic: 'refill', request_id: existing.id });
    turn.reviewNote = true;
    return;
  }

  const otherPharmacy = requestedPharmacy(ctx.inbound.body, p.pharmacy);
  const details: RefillDetailsT = {
    medication: med.name,
    dose: med.dose,
    frequency: med.frequency,
    refills_remaining: med.refills_remaining,
    pharmacy: otherPharmacy ?? p.pharmacy,
    pharmacy_on_file: p.pharmacy,
    patient_requested_pharmacy: !!otherPharmacy,
    withdrawn_by_patient: false,
    needs_prescriber_approval: med.refills_remaining === 0,
    prescriber_context: `Last visit ${p.last_visit.date} with ${p.last_visit.provider} (${p.last_visit.reason}). Conditions on file: ${p.conditions.join(', ') || 'none'}.`,
    patient_message: ctx.inbound.body,
  };
  const req = turn.tools.createRequest('refill', details, [ctx.inbound.id]);
  turn.record({ kind: 'request_created', topic: 'refill', request_id: req.id });
  const remaining =
    med.refills_remaining === 0
      ? 'Your record shows no refills remaining, so it needs approval from the clinic first.'
      : `Your record shows ${med.refills_remaining} refill${med.refills_remaining === 1 ? '' : 's'} remaining.`;
  const where = otherPharmacy ? `${otherPharmacy} (instead of ${p.pharmacy.split(',')[0]} on file)` : p.pharmacy;
  turn.say(
    `I've sent a refill request for your ${med.name} ${med.dose} (${med.frequency}) to clinic staff, to go to ${where}. ${remaining} It's pending staff review.`,
  );
  turn.reviewNote = true;
}
