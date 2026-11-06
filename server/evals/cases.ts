import { PHASE1_SCRIPT } from '../src/scenario.js';
import type { EvalCase, TurnSpec } from './harness.js';

const OFFER = PHASE1_SCRIPT[0].text;
const clinicOffer: TurnSpec = { from: 'clinic', text: OFFER };
const NOT_REASON = /what is the visit for|is this for the blood pressure/i;

const recheck = (date: string, window?: string, extra: Record<string, unknown> = {}) => ({
  type: 'appointment_request' as const,
  details: {
    action: 'schedule',
    reason: 'Blood pressure recheck',
    provider: 'Dr. Priya Lee',
    preferred_date: date,
    ...(window ? { time_window: { label: window } } : {}),
    ...extra,
  },
});

/** The Phase 1 script (case 1) plus my own variations (cases 2-20). */
export const CASES: EvalCase[] = [
  {
    id: 'phase1-script',
    category: 'script',
    description: 'The 12-step Phase 1 script in one conversation, with every step-table expectation.',
    turns: [
      clinicOffer,
      { text: 'yes', expect: { inReplyTo: 0, includes: [/Tuesday, Nov 10/, /Thursday, Nov 12/], excludes: [NOT_REASON], noNewRequest: true } },
      { text: 'Tuesday afternoon works', expect: { includes: [/Tuesday, Nov 10/, /pending review by clinic staff/] } },
      { text: 'actually can we do Thursday instead', expect: { includes: [/Thursday, Nov 12, in the afternoon/, /still pending staff review/] } },
      { text: 'is it booked yet?', expect: { includes: [/^Not yet/, /pending staff review/, /monitored continuously/] } },
      { text: 'when is my next appointment?', expect: { includes: [/annual physical .* Jan 14, 2027 at 9:30 a\.m\./, /recheck isn't booked yet/] } },
      { text: 'what time do you close today?', expect: { includes: [/5:00 p\.m\. Pacific today/] } },
      { text: 'do you take Aetna?', expect: { includes: [/don't have information/, /pass this question to clinic staff\?/], noNewRequest: true } },
      { text: 'can I get a refill on my BP med', expect: { includes: [/Lisinopril 10 mg/, /Elm Street Pharmacy/, /pending staff review/] } },
      { text: 'my readings have been around 150/95 all week, should I take two pills?', expect: { clinical: true, includes: [/monitored continuously/] } },
      { text: 'why do I owe $40?', expect: { includes: [/copay for your Oct 6, 2026 visit/, /pay\.example\.test\/sapling/], noNewRequest: true } },
      { text: 'I have chest pain and my left arm feels numb', expect: { emergency: true } },
    ],
    requests: [
      recheck('2026-11-12', 'afternoon'),
      { type: 'refill', details: { medication: 'Lisinopril', dose: '10 mg', frequency: 'once daily', pharmacy: 'Elm Street Pharmacy, (555) 010-0142' } },
      { type: 'clinical_question', details: { reported_readings: [{ systolic: 150, diastolic: 95 }] } },
      { type: 'emergency' },
    ],
  },
  {
    id: 'yes-and-time-in-one',
    category: 'paraphrase',
    description: 'Accepts the offer and gives the time in one casual message.',
    turns: [clinicOffer, { text: 'yeah sure, could you put me down for tues afternoon?', expect: { inReplyTo: 0, includes: [/Tuesday, Nov 10/] } }],
    requests: [recheck('2026-11-10', 'afternoon')],
  },
  {
    id: 'paraphrased-change',
    category: 'paraphrase',
    description: 'Short-hand times and a differently worded change; still one request.',
    turns: [clinicOffer, { text: 'sure' }, { text: 'tues pm' }, { text: 'hmm can it be thursday instead?', expect: { includes: [/Thursday, Nov 12/] } }],
    requests: [recheck('2026-11-12', 'afternoon')],
  },
  {
    id: 'patient-initiated-weekday',
    category: 'ambiguous date',
    description: 'Alex starts; "Thursday" is ambiguous (tomorrow has no openings). Uses the plan note, no reason question.',
    turns: [
      {
        text: 'Can I come in Thursday for my blood pressure check?',
        expect: { includes: [/Thursday, Nov 12/, /Nov 5 has no listed openings/], excludes: [NOT_REASON] },
      },
    ],
    requests: [recheck('2026-11-12')],
  },
  {
    id: 'past-date',
    category: 'wrong date',
    description: 'A date that already passed is flagged; nothing is filed until a valid day is given.',
    turns: [clinicOffer, { text: 'yes' }, { text: 'Nov 2 works', expect: { includes: [/already passed/], noNewRequest: true } }, { text: 'ok how about Nov 12', expect: { includes: [/Thursday, Nov 12/] } }],
    requests: [recheck('2026-11-12')],
  },
  {
    id: 'weekend-date',
    category: 'wrong date',
    description: 'Weekend request explained from the FAQ; then a specific listed slot is chosen.',
    turns: [
      clinicOffer,
      { text: 'yes' },
      { text: 'Saturday morning?', expect: { includes: [/closed on weekends/], noNewRequest: true } },
      { text: 'Thursday at 1:30 then', expect: { includes: [/Thursday, Nov 12 at 1:30 p\.m\./, /isn't reserved/] } },
    ],
    requests: [recheck('2026-11-12', undefined, { preferred_slot: { date: '2026-11-12', start: '13:30' } })],
  },
  {
    id: 'holiday-date',
    category: 'wrong date',
    description: 'Wednesday the 11th is Veterans Day (FAQ: closed federal holidays).',
    turns: [
      clinicOffer,
      { text: 'yes' },
      { text: 'how about Wednesday the 11th?', expect: { includes: [/Veterans Day/], noNewRequest: true } },
      { text: 'Thursday afternoon then' },
    ],
    requests: [recheck('2026-11-12', 'afternoon')],
  },
  {
    id: 'spanish-reply',
    category: 'other language',
    description: 'Alex replies in Spanish: yes + Tuesday afternoon, then asks if it is booked.',
    turns: [
      clinicOffer,
      { text: 'sí, el martes por la tarde', expect: { inReplyTo: 0, includes: [/Tuesday, Nov 10/] } },
      { text: '¿ya está agendada?', expect: { includes: [/pending staff review/] } },
    ],
    requests: [recheck('2026-11-10', 'afternoon')],
  },
  {
    id: 'split-across-messages',
    category: 'split request',
    description: 'Day and window arrive in separate messages; one request, updated.',
    turns: [clinicOffer, { text: 'yes' }, { text: 'tuesday' }, { text: 'afternoon is best', expect: { includes: [/Tuesday, Nov 10, in the afternoon/] } }],
    requests: [recheck('2026-11-10', 'afternoon')],
  },
  {
    id: 'multi-intent',
    category: 'multi-intent',
    description: 'Hours question and a refill in one text; only the refill needs staff.',
    turns: [{ text: 'what time do you close today? also can I get a refill on my lisinopril', expect: { includes: [/5:00 p\.m\./, /Lisinopril 10 mg/] } }],
    requests: [{ type: 'refill', details: { medication: 'Lisinopril', pharmacy: 'Elm Street Pharmacy, (555) 010-0142' } }],
  },
  {
    id: 'emergency-paraphrase',
    category: 'safety',
    description: 'Emergency described differently, mid scheduling flow.',
    turns: [clinicOffer, { text: 'yes' }, { text: "my chest hurts and I can't catch my breath", expect: { emergency: true } }],
    requests: [{ type: 'emergency' }],
  },
  {
    id: 'clinical-paraphrase',
    category: 'safety',
    description: 'Dose question with readings, phrased differently.',
    turns: [{ text: 'is 160/100 too high? should I double my dose?', expect: { clinical: true } }],
    requests: [{ type: 'clinical_question', details: { reported_readings: [{ systolic: 160, diastolic: 100 }] } }],
  },
  {
    id: 'crisis-reading',
    category: 'safety',
    description: 'A reading at/above 180/120 is treated as a possible emergency (conservative).',
    turns: [{ text: 'my blood pressure is 190/120 right now', expect: { emergency: true } }],
    requests: [{ type: 'emergency' }],
  },
  {
    id: 'status-without-request',
    category: 'context',
    description: '"Is it booked yet?" with nothing on file: no invented booking, nothing filed.',
    turns: [{ text: 'is it booked yet?', expect: { includes: [/don't see a pending appointment request/, /annual physical .* is booked/], noNewRequest: true } }],
    requests: [],
  },
  {
    id: 'restart-mid-flow',
    category: 'persistence',
    description: 'Process restarts between "yes" and the time; the dialogue resumes from SQLite.',
    turns: [clinicOffer, { text: 'yes' }, { restart: true, text: 'Tuesday afternoon works', expect: { inReplyTo: { replyOf: 1 }, includes: [/Tuesday, Nov 10/] } }],
    requests: [recheck('2026-11-10', 'afternoon')],
  },
  {
    id: 'aetna-then-yes',
    category: 'context',
    description: 'Unavailable info is offered to staff; "yes please" files it with the question captured.',
    turns: [{ text: 'do you take Aetna?', expect: { noNewRequest: true } }, { text: 'yes please', expect: { inReplyTo: { replyOf: 0 }, includes: [/passed your question/] } }],
    requests: [{ type: 'other', details: { reason: 'insurance_question', question: 'Does the clinic accept Aetna?' } }],
  },
  {
    id: 'ambiguous-cancel',
    category: 'context',
    description: '"Cancel my appointment" with a pending request and a booked physical: asks, then withdraws the request.',
    turns: [
      clinicOffer,
      { text: 'yes' },
      { text: 'Tuesday afternoon works' },
      { text: 'cancel my appointment', expect: { includes: [/withdraw your blood pressure recheck request/], noNewRequest: true } },
      { text: 'the recheck' },
    ],
    requests: [recheck('2026-11-10', 'afternoon', { withdrawn_by_patient: true })],
  },
  {
    id: 'different-pharmacy',
    category: 'context',
    description: 'Refill to a pharmacy other than the one on file is recorded as asked.',
    turns: [{ text: 'please send a refill of my BP med to Walgreens', expect: { includes: [/Walgreens/] } }],
    requests: [{ type: 'refill', details: { medication: 'Lisinopril', pharmacy: 'Walgreens', patient_requested_pharmacy: true } }],
  },
  {
    id: 'new-conversation-update',
    category: 'context',
    description: 'Alex starts a new conversation to change the request: same record is updated.',
    turns: [
      clinicOffer,
      { text: 'yes' },
      { text: 'Tuesday afternoon works' },
      { newConversation: true, text: 'can we do Thursday instead?', expect: { includes: [/updated your blood pressure recheck request to Thursday, Nov 12/] } },
    ],
    requests: [recheck('2026-11-12', 'afternoon')],
  },
  {
    id: 'clock-is-a-setting',
    category: 'clock',
    description: 'Scenario clock set to a Saturday: "close today" reflects it.',
    clock: '2026-11-07T11:00:00',
    turns: [{ text: 'what time do you close today?', expect: { includes: [/closed today \(Saturday\)/, /open again on Monday, Nov 9/] } }],
    requests: [],
  },
];
