import type { ClinicalQuestionDetailsT } from '../../requests/request-types.js';
import { capitalize } from '../text.js';
import type { Turn } from '../turn.js';

/**
 * Clinical questions are never answered. The agent captures the question,
 * readings, symptoms and medication context for a clinician and tells the
 * patient a clinician will review it — with no advice and no timeline.
 */

function questionFrom(body: string): string {
  const segments = body
    .split(/(?<=[.?!])\s+|,\s*(?=(?:should|can|could|is|do|does|what|how|am|will)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const q = segments.filter((s) => s.endsWith('?')).at(-1) ?? segments.at(-1) ?? body.trim();
  return capitalize(q);
}

export function handleClinical(turn: Turn): void {
  const cq = turn.intent('clinical_question');
  if (!cq) return;
  const { ctx } = turn;
  const p = ctx.patient;
  const body = ctx.inbound.body.trim();
  const approx = /\b(around|about|roughly|approximately|~)\b/.test(cq.text);
  const readings = cq.readings.map((r) => ({ ...r, timeframe: cq.timeframe, message_id: ctx.inbound.id }));
  const medsOnFile = p.medications.map((m) => `${m.name} ${m.dose} ${m.frequency}`);
  const relatedMedication =
    /\b(pill|pills|dose|doses|tablet|tablets|med|meds|medication|medicine)\b/.test(cq.text) && p.medications.length === 1
      ? `${medsOnFile[0]} (the only medication on file)`
      : null;

  const existing = turn
    .openRequests('clinical_question')
    .find((r) => r.conversation_id === ctx.conversation.id && r.status === 'pending_staff');
  let requestId: string;
  if (existing) {
    const d = existing.details as ClinicalQuestionDetailsT;
    const updated = turn.tools.amendRequest(
      existing.id,
      {
        questions: [...d.questions, { text: body, message_id: ctx.inbound.id }],
        reported_readings: [...d.reported_readings, ...readings],
        symptoms_mentioned: [...new Set([...d.symptoms_mentioned, ...cq.symptoms])],
        related_medication: d.related_medication ?? relatedMedication,
      },
      [ctx.inbound.id],
      'Patient added to their clinical question',
    );
    requestId = updated.id;
    turn.record({ kind: 'request_updated', topic: 'clinical_question', request_id: requestId });
  } else {
    const details: ClinicalQuestionDetailsT = {
      question: questionFrom(body),
      questions: [{ text: body, message_id: ctx.inbound.id }],
      reported_readings: readings,
      symptoms_mentioned: cq.symptoms,
      related_medication: relatedMedication,
      medications_on_file: medsOnFile,
      conditions_on_file: p.conditions,
      routed_to: 'clinician',
      advice_given_to_patient: false,
    };
    requestId = turn.tools.createRequest('clinical_question', details, [ctx.inbound.id]).id;
    turn.record({ kind: 'request_created', topic: 'clinical_question', request_id: requestId });
  }

  const readingText = readings.length
    ? ` and your readings (${approx ? 'around ' : ''}${readings.map((r) => r.text).join(', ')}${cq.timeframe ? ` ${cq.timeframe}` : ''})`
    : '';
  const asked = /\?|\b(should|can|could|is it|is that|is this|do i|what|how|why|when)\b/i.test(body);
  const what = asked ? `your question${readingText}` : readings.length ? `your readings (${readingText.replace(/^ and your readings \(|\)$/g, '')})` : 'your message';
  turn.say(`I can't give medical advice by text, so I've sent ${what} to the clinical team. A clinician will review ${!asked && readings.length ? 'them' : 'it'}.`);
  turn.clinicalNote = true;
}
