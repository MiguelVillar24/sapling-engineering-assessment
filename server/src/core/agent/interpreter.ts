import type { PatientRecord } from '../clinic-data/types.js';
import { extractWhen, type WhenSpec } from '../time/when.js';
import { repairText } from './spelling.js';
import { type BpReading, extractReadings, normalize, splitClauses } from './text.js';

/**
 * Natural-language understanding: message text -> structured intents.
 *
 * This is the only "language" component of the agent. Everything after it
 * (what to do, which tool to call, what to say) is deterministic policy code,
 * so a different interpreter (e.g. an LLM) can be swapped in behind the same
 * interface without touching safety rules, tools or patient-facing wording.
 */

export type DayRef = { kind: 'today' } | { kind: 'tomorrow' } | { kind: 'weekday'; day: number } | { kind: 'holiday'; name: string };

export type Intent =
  | { type: 'affirm' }
  | { type: 'deny' }
  | { type: 'time_preference'; when: WhenSpec; text: string }
  | {
      type: 'schedule';
      action: 'schedule' | 'reschedule' | 'cancel';
      mentionsBp: boolean;
      mentionsPhysical: boolean;
      explicitNew: boolean;
      text: string;
    }
  | { type: 'withdraw_request'; about: 'appointment' | 'refill' | 'any'; weak?: boolean }
  | { type: 'request_status'; about: 'appointment' | 'refill' | 'clinical' | 'any' }
  | { type: 'next_appointment' }
  | { type: 'clinic_hours'; ask: 'close_time' | 'open_time' | 'open_on_day' | 'hours'; day: DayRef | null }
  | { type: 'faq'; topic: 'address' | 'parking' | 'phone' | 'texting' | 'payment' | 'what_to_bring' | 'cancellations' }
  | { type: 'insurance_accepted'; payer: string | null; mine: boolean; text: string }
  | { type: 'record_info'; field: 'medications' | 'pharmacy' | 'insurance' | 'last_visit' | 'balance' }
  | { type: 'refill'; medicationMention: string | null; text: string }
  | { type: 'clinical_question'; text: string; readings: BpReading[]; symptoms: string[]; timeframe: string | null }
  | { type: 'billing_question'; amount: number | null }
  | { type: 'billing_issue'; issue: 'dispute' | 'payment_plan' | 'insurance_billing' | 'other'; text: string }
  | { type: 'talk_to_staff' }
  | { type: 'identity' }
  | { type: 'greeting' }
  | { type: 'thanks' }
  | { type: 'goodbye' }
  | { type: 'unknown'; text: string };

export type IntentType = Intent['type'];

export interface Interpretation {
  interpreter: string;
  normalized: string;
  intents: Intent[];
}

export interface InterpretContext {
  patient: PatientRecord;
}

export interface Interpreter {
  readonly name: string;
  interpret(text: string, ctx: InterpretContext): Promise<Interpretation> | Interpretation;
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

const AFFIRM =
  /^(ye+s+|yessir|yeah|yea|yep|yup|ya|yah|sure|ok|okay|k|kk|alright|all right|please|yes please|sounds (good|great|perfect)|that works|works for me|that would be (great|helpful|nice|wonderful|lovely|fantastic|amazing|perfect|brilliant)|that'?d be (great|helpful|nice|wonderful|lovely|fantastic|amazing|perfect|brilliant)|definitely|absolutely|of course|for sure|sure thing|please do|go ahead|go for it|do it|let'?s do (it|that)|count me in|i'?m in|y|si|sí|correct|perfect|great|bet|i would(?=\s*[.!]*$)|i'?d (like|love) that|i do(?=\s*[.!]*$)|totally|please (set|book|request|schedule) (it|that|one|me)( up)?)\b/;
const DENY =
  /^(no|nope|nah|naw|no thanks|no thank you|not now|not right now|not yet|not at this time|never ?mind|nvm|i'?m (good|ok|okay|fine)|im good|no need|don'?t bother|pass|i'?ll pass|maybe later|not interested|i'?d rather not|rather not|i'?ll call( (instead|myself|the office|you))?|i will call)\b/;
/** Leading filler before a yes/no ("thanks, yes please", "oh ok sure"). */
const LEAD_FILLER =
  /^(?:(?:hi|hey|hello|oh|ah|um+|uh+|hmm+|well|thanks|thank you|great|cool|awesome|perfect|omg|wow|lol|ngl|oops|oh shoot|good (morning|afternoon|evening))[\s,!.]+)+/;
const THANKS = /\b(thanks|thank you|thank u|thx|ty|tysm|appreciate (it|you))\b/;
const GREETING = /^(hi|hello|hey|hiya|good (morning|afternoon|evening)|howdy)\b/;
const GOODBYE = /\b(bye|goodbye|see you|talk later|have a good (day|one|night))\b/;

const CLINICAL: RegExp[] = [
  /\b(should|can|could|may|do|must|am i supposed to|is it (ok|okay|safe|fine) (to|if i)|is it (ok|okay|safe|fine) for me to)\s+i?\s*(be\s+)?(take|taking|stop|stopping|skip|skipping|double|doubling|increase|decrease|lower|raise|cut|split|change|switch|keep taking|go off|come off|halve|start|starting)\b/,
  /\b(two|2|double|extra|another|more|less|half|a second) (pills?|doses?|tablets?|capsules?)\b/,
  /\b(higher|lower|increase|decrease|change|double|adjust)\w* (my |the |in )?(dose|dosage)\b/,
  /\b(side effects?|interact(ion|ions|s)?|contraindicat\w*|allergic to)\b/,
  /\bis (\d{2,3}\/\d{2,3}|my (bp|blood pressure|pressure|reading|readings|heart rate|pulse)|that (reading|number)) (normal|bad|high|too high|low|too low|dangerous|serious|ok|okay|safe|concerning|worrying|something to worry about)\b/,
  /\bis (it|this|that) (normal|bad|dangerous|serious|concerning|worrying|something to worry about)\b/,
  /\b(what should i do|should i be (worried|concerned)|do i need to (worry|be concerned)|should i (come in|see (a|the) doctor|go to))\b/,
  /\b(dizzy|dizziness|light-?headed|headaches?|nause\w*|vomit\w*|cough\w*|swelling|swollen|rash|fever|fatigue\w*|palpitations?|heart (is )?racing|blurry vision|nosebleeds?|pain|hurts?|sore|sick|symptoms?|tired|exhausted|weakness|fatigued|cramps?|insomnia|can'?t sleep)\b/,
  /\b(my|the) (readings?|numbers?|bp|blood pressure|pressure) (has been|have been|is|are|was|were|been|keeps|keep|stays|stay|runs|is running|has been running)\b[^.?!]{0,12}\b(high|low|up|down|elevated|around|over|under|about|\d{2,3})\b/,
  /\b(diagnos\w*|medical advice)\b/,
  /\b(miss(ed)?|skip(ped)?|forgot( to take)?) (a |my |one |the |today'?s )?(dose|doses|pill|pills|meds|medication)\b/,
  /\b(drink|drinking|alcohol|wine|beer|grapefruit|coffee|caffeine|ibuprofen|advil|motrin|aleve|tylenol|aspirin|nsaids?|supplements?)\b[^.?!]{0,40}\b(with|while on|while taking|on) (my |the |this )?(meds|medication|medicine|pills|lisinopril|bp med\w*|blood pressure med\w*)\b/,
  /\b(normal|good|healthy|safe|target|ideal|too high|high|low) (blood pressure|bp)\b/,
  /\bwhat should my (bp|blood pressure|numbers?|readings?) be\b/,
  /\b(make|making|made|makes|give|giving|cause|causing|causes) me (dizzy|tired|cough\w*|sick|nause\w*|light-?headed|sleepy)\b/,
];

const SYMPTOMS =
  /\b(dizzy|dizziness|light-?headed|headaches?|nause\w*|vomit\w*|cough\w*|swelling|swollen|rash|fever|fatigue\w*|palpitations?|heart (?:is )?racing|blurry vision|nosebleeds?|pain|sore|tired)\b/g;

const REFILL =
  /\b(re-?fill\w*|renew\w*|ran out|run out|running out|running low|almost out|out of\b[^.?!]{0,25}\b(pills|meds|medication|medicine|lisinopril|prescription|tablets)|new (prescription|script|rx)|call (in )?(a |my |the )?(prescription|refill|meds|medication)( in)?|call (it|them) in|send (in |over )?(a |my |the )?(prescription|refill)|need (a |my )?(new )?prescription)\b/;
/** Weaker refill wording ("more of my pills") only counts when the text isn't a dose question. */
/** Context-dependent refill wording: counts only when the clause also mentions a medication. */
const REFILL_CONTEXTUAL =
  /\b(down to (my |his |her |the )?last|(\d+|a few|few|couple( of)?|only|last|one|two|three|four|five) (more )?(pills?|tablets?|doses?|days?)( worth)?\b[^.?!]{0,25}\b(left|remaining)|(almost|nearly|about to be|going to be|running) (finish\w*|done|gone|empty|out|short)|need (some )?more|call in more|send (in |over )?more|repeat prescription|can'?t get more)\b/;
const MED_WORD = /\b(pills?|tablets?|meds?|medication|medicine|prescription|rx|lisinopril|refill)\b/;
/** A health question about a medication or blood pressure that nothing more specific matched. */
const MED_OR_CONDITION =
  /\b(lisinopril|medication|medicine|meds|pills?|tablets?|dose|dosage|bp|blood pressure|hypertension|potassium|salt|sodium|heart rate|pulse|cholesterol|caffeine|coffee|alcohol)\b/;
const QUESTIONISH = /\?|\b(should|can i|could i|may i|is it|is that|is this|does|do i|will it|would it|what if|which one|how much|how many|why)\b/;
const SCHEDULING_WORDS = /\b(appointment|appt|recheck|visit|book|booked|schedule|scheduled|slot|reschedule|cancel|confirmed)\b/;
/** Idioms that contain symptom words but are not symptoms ("sorry to be a pain"). */
const SYMPTOM_IDIOMS = /\b(to be|being|such|what) a pain\b|\bpain in the (neck|butt|ass)\b/g;
const REFILL_WEAK = /\bmore\b[^.?!]{0,20}\b(pills|meds|medication|medicine|tablets)\b/;
const DOSE_QUESTION = /\b(should|is it|side effect|dose|dosage|two|double|extra|can i take|safe)\b/;
const MED_GENERIC =
  /\b(bp|blood pressure|pressure|hypertension) (med|meds|medication|medicine|pills?|prescription)\b|\bmy (med|meds|medication|medicine|prescription|pills|rx)\b/;

const BILLING_ISSUE: Array<[RegExp, 'dispute' | 'payment_plan' | 'insurance_billing' | 'other']> = [
  [/\b(already paid|paid (it|this|that) already|paid already|shouldn'?t (owe|have to pay|be charged)|wrong (charge|amount|bill)|overcharg\w*|dispute|incorrect (charge|bill|amount)|(bill|charge) is (wrong|a mistake)|refund)\b/, 'dispute'],
  [/\b(payment plan|can'?t afford|pay (it )?in installments|pay over time)\b/, 'payment_plan'],
  [/\binsurance (should|was supposed to|is supposed to) (have )?(cover|pay)\w*\b/, 'insurance_billing'],
];
const BILLING_Q =
  /\b(why do i owe|what (is|'s) (the|this|my) (\$?\d+|charge|bill|balance)|my balance|a balance|balance due|what do i owe|how much do i (owe|have to pay)|do i owe|owe (you|the clinic)|copay|co-pay|\bbill\b|billing|charged?|invoice|statement)\b|\$\s?\d+|\b\d+ (dollar|buck)s?\b|\bwhy (was|am|did) i (get )?(charged|billed)\b|\bwhy (do |did |must )?i (have to|need to|got to|gotta) pay\b|\bwhat (is|'s) (this|the|that) (fee|charge)\b/;
const PAYMENT_HOW = /\b(how (do|can) i pay|pay (my|the|this) (bill|balance)|pay online|payment (link|options?|methods?)|where (do|can) i pay)\b/;

const INSURANCE_ACCEPT =
  /\b(do|does) (you|u|y'?all|the (clinic|office)|sapling)( guys)? (take|accept)\b|\b(take|accept)s? (my )?(insurance|aetna|cigna|kaiser|medicare|medi-?cal|medicaid|tricare|humana|anthem|blue (shield|cross)|united\w*|uhc|molina|oscar|health ?net)\b|\bin[- ]network\b|\b(is|are) (\w+ ){0,3}(accepted|in network)\b|\binsurance (do you|does the clinic) (take|accept)\b|\bwhat insurance(s| plans)? do you (take|accept)\b|\b(will|does|would|is) (my )?insurance (cover|pay|work)\b|\bcan i use my \w+( \w+)? (insurance|plan|card)\b|\b(are|r) (you|u|y'?all) (in[- ]network|contracted) with\b|\bdo (you|u) (guys )?(work with|bill)\b|\bif (you|u|the clinic|y'?all)( guys)? (take|accept)\b|\b(take|accept|takes|accepts)\b[^.?!]{0,20}\b(insurance(?! card)|plan|aetna|cigna|kaiser|medicare|medi-?cal|medicaid|tricare|humana|anthem|blue (shield|cross)|united\w*|uhc|molina|oscar|health ?net)\b/;
const PAYERS = [
  'aetna', 'cigna', 'kaiser', 'medicare', 'medi-cal', 'medical', 'medicaid', 'tricare', 'humana', 'anthem',
  'blue shield', 'blue cross', 'unitedhealthcare', 'united healthcare', 'united', 'uhc', 'molina', 'oscar', 'health net',
];

const STATUS =
  /\b(booked|scheduled|confirmed|approved|processed)\s+(yet|already)\b|\bis (it|my \w+( \w+)?|that|the \w+) (booked|scheduled|confirmed|approved|ready|done|processed|set)\b|\b(any|an) (update|news|word)\b|\bheard (anything|back)\b|\bstatus\b|\bdid (you|anyone|staff|they) (book|schedule|approve|confirm|send|process)\b|\bhas (it|my \w+) been\b|\bwhere (are we|is it) (with|on)\b|\b(go|gone|went) through\b|\bam i (booked|scheduled|confirmed|all set|set)\b|\blocked in\b|\bis (it|that|everything) (all )?set\b|\bhave (you|they|staff|the clinic) (booked|scheduled|confirmed|approved)\b|\bconfirm(ed)? (the|my) (appointment|appt|recheck|booking)\b|\bis (it|my|the|that|this|everything)\b[^.?!]{0,30}\b(booked|scheduled|confirmed|approved|official|officially set|final|on the books|locked in|set)\b|\b(hear|heard) back\b|\bon the books\b|\b(has|have|was|were|is|did) (anyone |someone |staff |dr\.? \w+ |the clinic |the office )?(approved|booked|confirmed|processed|scheduled|looked at|seen)\b[^.?!]{0,20}\b(my |the )?(request|appointment|appt|recheck)\b|\b(my|the) (request|appointment|appt|recheck)\b[^.?!]{0,15}\b(been )?(approved|confirmed|processed|gone through)\b|\bdid (someone|the (clinic|office|doctor|nurse)|dr\.? \w+) (book|schedule|approve|confirm|process|see|look at)\b|^(booked|confirmed|scheduled|approved|all set)\s*(yet)?\s*\?|\block(ed)? (it |that |me )?in\b|\bis (it|the appointment|my appointment) fix(ed)?\b|\bwait (for )?(an? )?(answer|reply|confirmation)\b/;
const NEXT_APPT =
  /\b(next|upcoming|future|scheduled|booked) (appointment|appt|visit|physical)s?\b|\bwhen('?s| is| are) my (appointment|appt|visit|physical|next)\b|\bdo i have (any|an|a) (appointment|appt|visit)s?\b|\bwhen am i (scheduled|booked|seeing)\b|\bwhat (day|time|date) is my (next )?(appointment|appt|visit|physical)\b|\bwhen do i (see|have|go see) (dr\.?|doctor|the doctor|my doctor|my)\b|\bwhat appointments? do i have\b|\bany appointments? (coming up|scheduled|booked)\b|\bwhen('?s| is) (my )?next (one|visit|appointment)\b|\bdo i have anything (scheduled|booked|coming up)\b|\b(appointment|appt|visit|physical)s? (coming up|scheduled|booked|on the calendar)\b|\balready have an? (appointment|appt|visit)\b|\bremind me when\b|\b(have|got) (anything|any appointments?|something) (booked|scheduled|coming up)\b|\b(have|got) (\w+ )?booked\b|\bnext thing\b[^.?!]{0,30}\bbooked\b|\bwhen('?s| is)\b[^.?!]{0,30}\b(physical|checkup|check-up)\b/;
/** Looser next-appointment wording; ignored when the clause is about moving/cancelling it. */
const NEXT_APPT_LOOSE =
  /\bwhen('?s| is| are)? my (annual|physical|annual physical|checkup|check-up|next (one|visit|appointment|appt))\b|\b(what|which) (day|time|date)\b[^.?!]{0,12}\bmy (next )?(appointment|appt|visit|physical|annual|checkup)\b|\bmy (annual |yearly )?(physical|checkup|check-up)\b[^.?!]*\?/;

const CLOSE_TIME =
  /\b(what time|what hour|when|how late|until when|til when|till when)\b[^?]{0,30}\b(close|closing|closes|shut|shuts|shutting)\b|\bclosing (time|hour)\b|\bclose today\b|\bopen (until|till|til|to) (what time|when)\b|\bhow late (are|is) (you|y'?all|the clinic|the office)\b/;
const OPEN_TIME = /\b(what time|when)\b[^?]{0,30}\b(open|opening|opens)\b/;
const WHAT_DAYS = /\b(what|which) days\b|\bdays (are you|is the clinic|is the office|you are|you're) open\b|\bopen (on )?(weekends|saturdays|sundays)\b/;
const OPEN_ON = /\b(are|r) (you|u|y'?all|ya'?ll|the clinic|the office)( guys| all| folks)?( still| even)? (open|closed)\b|\b(open|closed) (today|tomorrow|now|on \w+|this \w+)\b|\bis the (clinic|office) (open|closed)\b/;
const HOURS = /\b(hours|office hours|business hours|opening hours)\b/;

const FAQ_TOPICS: Array<[RegExp, Extract<Intent, { type: 'faq' }>['topic']]> = [
  [/\b(address|suite|which (floor|building)|find (it|you|the (clinic|office|place))|where (are|is) (you|u|the (clinic|office))|where('?s| is) (the )?(clinic|office)|located|location|directions|how do i (get there|find (you|the clinic|the office)|get to (you|the clinic|the office)))\b/, 'address'],
  [/\bpark(ing)?\b/, 'parking'],
  [/\b(phone number|number to call|call (you|the clinic|the office)|can i call|what'?s your number|telephone|how (do|can) i (call|reach) (you|the clinic|the office)|what number (do|should|can) i (call|use|dial)|(what|which) number (to call|reaches you))\b/, 'phone'],
  [/\b(do you read|(is|are) (this|these|texts?|this line|this number|messages?) (monitored|read)|does (anyone|someone) read|monitored)\b/, 'texting'],
  [/\b(what (should|do) i (need to )?bring|bring (to|with)|what to bring|need to bring|should i bring|do i need (to bring )?(my |an? )?(id|photo id|insurance card|card|med(ication)? list))\b/, 'what_to_bring'],
  [/\b(cancellation (policy|fee|rules)|how much notice|cancel(l)?ation fee|notice to cancel|(fee|charge|penalty) (to|for) cancel\w*|how far (in advance|ahead) (do i|should i|to) cancel)\b/, 'cancellations'],
];

const RECORD_INFO: Array<[RegExp, Extract<Intent, { type: 'record_info' }>['field']]> = [
  [/\b(what|which) (meds|medications|medicines|prescriptions)\b|\bwhat am i (taking|on)\b|\bmy (med|medication) list\b/, 'medications'],
  [/\b(which|what) pharmacy\b|\bpharmacy (on file|do you have)\b/, 'pharmacy'],
  [/\b(what|which) insurance (do you have|is on file|on file|do i have)\b|\binsurance (on file|do you have for me)\b/, 'insurance'],
  [/\b(last|previous|most recent) (visit|appointment)\b/, 'last_visit'],
];

const IDENTITY = /\b(are you|is this) (a |an )?(bot|robot|real person|human|person|automated|ai|computer|machine)\b/;
const STAFF_WHO =
  '(someone|somebody|anyone|a person|a real person|a human|a live person|a member of (staff|the team)|staff|the staff|the doctor|a doctor|my doctor|dr\\.? \\w+|a nurse|the nurse|the front desk|reception|a receptionist|the office)';
const TALK_TO_STAFF = new RegExp(
  `\\b(talk|speak|chat) (to|with) ${STAFF_WHO}\\b|\\b(can|could|would|have) ${STAFF_WHO} (call|phone|text|contact|reach out to|get back to) me\\b|\\bcall me back\\b|\\b(need|want|would like) (to (talk|speak) (to|with) )?(a |an )?(human|real person|live person|person|nurse|doctor|someone)\\b|\\bget me (a |an )?(human|person|real person|someone|nurse|staff)\\b|\\b(done|tired of|sick of) (texting|talking to) (a |this )?(robot|bot|machine)\\b`,
);

const SCHEDULE_CANCEL = /\bcancel\b/;
const SCHEDULE_RESCHEDULE = /\b(reschedule|re-schedule|push back|postpone|move)\b/;
const SCHEDULE_NEW =
  /\b(make|book|schedule|set up|get|need|want|like|request) (an? |my |another |the )?(appointment|appt|visit|check[- ]?up|recheck|follow[- ]?up)\b|\bcheck (my |the )?(bp|blood pressure|pressure)\b|\bwishes to see me\b|\b(might|may|could|can) i come in\b|\b(see|come in to see|visit) (dr\.?|doctor|the doctor)\b|\bcome in\b|\b(bp|blood pressure) (re)?check\b|\brecheck\b|\b(get|need|have) (my )?(bp|blood pressure) (re)?checked\b|\bappointment for\b/;
const APPOINTMENT_WORDS = /\b(appointment|appt|visit|physical|recheck|check[- ]?up|booking)\b/;
const EXPLICIT_NEW = /\b(another|second|separate|additional|new|also need an?) (appointment|appt|visit)\b/;
const WITHDRAW =
  /\b(cancel|withdraw|drop|scrap|forget( about)?) (the|my|that) (request|recheck request|refill request|refill|recheck)\b|\b(don'?t|do not|no longer) (need|want) (the|my|that|this) (appointment|recheck|refill|request)\b|\bnever ?mind (the|about the|my|about my) (appointment|recheck|refill|request)\b|\bno longer (want|need) (it|that|this)\b|\bchanged my mind\b|\b(cancel|withdraw|drop|scrap|forget( about)?|remove|delete|pull|take back|retract)\b[^.?!]{0,25}\b(request|recheck)\b|\bdon'?t (book|schedule) (anything|it|that|the recheck|the appointment)\b/;
/** "nvm" / "scratch that": a withdrawal only if nothing is being asked right now (decided in policy). */
const WEAK_WITHDRAW =
  /^(?:(?:ok|okay|actually|oh|hmm|um+|nah|no|nope)[\s,]+)?(nvm|never ?mind|scratch that|scrap that|scrap it|forget it|forget that|disregard( that)?|cancel that)\b/;

// ---------------------------------------------------------------------------

function matchPayer(t: string): string | null {
  for (const p of PAYERS) {
    if (new RegExp(`\\b${p}\\b`).test(t)) {
      return p === 'medical' ? 'Medi-Cal' : p.replace(/\b\w/g, (c) => c.toUpperCase()).replace('Uhc', 'UHC');
    }
  }
  return null;
}

const HOLIDAY_WORDS: Array<[RegExp, string]> = [
  [/\bnew year'?s\b/, "New Year's Day"],
  [/\b(mlk|martin luther king)\b/, 'Martin Luther King Jr. Day'],
  [/\b(presidents'? day|washington'?s birthday)\b/, "Washington's Birthday"],
  [/\bmemorial day\b/, 'Memorial Day'],
  [/\bjuneteenth\b/, 'Juneteenth'],
  [/\b(july 4th|4th of july|fourth of july|independence day)\b/, 'Independence Day'],
  [/\blabor day\b/, 'Labor Day'],
  [/\b(columbus day|indigenous peoples'? day)\b/, 'Columbus Day'],
  [/\bveterans'? day\b/, 'Veterans Day'],
  [/\bthanksgiving\b/, 'Thanksgiving Day'],
  [/\bchristmas\b/, 'Christmas Day'],
];

function hoursDay(t: string): DayRef | null {
  const holiday = HOLIDAY_WORDS.find(([re]) => re.test(t));
  if (holiday) return { kind: 'holiday', name: holiday[1] };
  if (/\btomorrow\b/.test(t)) return { kind: 'tomorrow' };
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const i = days.findIndex((d) => new RegExp(`\\b${d}s?\\b`).test(t));
  if (i >= 0) return { kind: 'weekday', day: i + 1 };
  if (/\b(today|tonight|now|right now)\b/.test(t)) return { kind: 'today' };
  return null;
}

function mergeWhen(a: WhenSpec, b: WhenSpec): WhenSpec {
  return {
    weekdays: [...a.weekdays, ...b.weekdays.filter((w) => !a.weekdays.some((x) => x.day === w.day))],
    rejectedWeekdays: [...new Set([...a.rejectedWeekdays, ...b.rejectedWeekdays])],
    dates: [...a.dates, ...b.dates],
    dayOfMonth: a.dayOfMonth ?? b.dayOfMonth,
    relative: a.relative ?? b.relative,
    range: a.range ?? b.range,
    window: a.window ?? b.window,
    time: a.time ?? b.time,
    ordinal: a.ordinal ?? b.ordinal,
    anyTime: a.anyTime || b.anyTime,
  };
}

// Spanish -> English lexical bridge (the Phase 2 eval "one change"). Unicode-aware boundaries
// because JS \b treats accented letters as non-word characters.
const es = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'gu');
const SPANISH: Array<[RegExp, string]> = [
  [es('claro que s[ií]|claro|s[ií] por favor|s[ií]'), 'yes'],
  [es('de acuerdo|vale|est[aá] bien'), 'ok'],
  [es('no gracias'), 'no thanks'],
  [es('por la mañana|en la mañana|de mañana'), 'in the morning'],
  [es('por la tarde|en la tarde|de tarde'), 'in the afternoon'],
  [es('por la noche|en la noche'), 'in the evening'],
  [es('pasado mañana'), 'day after tomorrow'],
  [es('mañana'), 'tomorrow'],
  [es('hoy'), 'today'],
  [es('lunes'), 'monday'],
  [es('martes'), 'tuesday'],
  [es('mi[eé]rcoles'), 'wednesday'],
  [es('jueves'), 'thursday'],
  [es('viernes'), 'friday'],
  [es('s[aá]bado'), 'saturday'],
  [es('domingo'), 'sunday'],
  [es('en vez de eso|en lugar de eso|en vez|en lugar|mejor'), 'instead'],
  [es('(?:pr[oó]xima|siguiente) cita'), 'next appointment'],
  [es('cita'), 'appointment'],
  [es('medicina (?:para|de) la presi[oó]n|pastillas (?:para|de) la presi[oó]n'), 'blood pressure medication'],
  [es('resurtir|resurtido|surtir|rellenar|receta'), 'refill'],
  [es('a las (\\d{1,2}(?::\\d{2})?)'), 'at $1'],
  [es('a la una'), 'at 1'],
  [es('m[aá]s (?:pastillas|medicina|medicamento|medicinas)'), 'more pills'],
  [es('(?:ya )?(?:casi )?se me (?:acaban|acabaron|est[aá]n acabando|terminan|terminaron)|casi no me quedan|ya no me quedan'), 'running out'],
  [es('(?:ya )?(?:me )?(?:confirmaron|agendaron|reservaron|programaron)'), 'did they confirm'],
  [es('d[oó]lares?'), 'dollars'],
  [es('cuenta|factura'), 'bill'],
  [es('de qu[eé] es'), 'what is it for'],
  [es('a qu[eé] hora cierran'), 'what time do you close'],
  [es('a qu[eé] hora abren'), 'what time do you open'],
  [es('(?:ya )?est[aá] (?:agendada|reservada|confirmada|programada)'), 'is it booked yet'],
  [es('(?:cu[aá]nto|por qu[eé]) debo'), 'why do i owe'],
  [es('aceptan|toman'), 'do you take'],
];

export function bridgeSpanish(normalized: string): string {
  return SPANISH.reduce((t, [re, en]) => t.replace(re, en), normalized);
}

export interface RuleBasedOptions {
  /** Understand common Spanish replies (default on). Off = the eval baseline. */
  spanish?: boolean;
}

/** Deterministic rule-based interpreter (the local demo mode: no API keys, no network). */
export class RuleBasedInterpreter implements Interpreter {
  readonly name: string;

  constructor(private readonly options: RuleBasedOptions = {}) {
    this.name = options.spanish === false ? 'rules(en)' : 'rules';
  }

  interpret(text: string, ctx: InterpretContext): Interpretation {
    const base = this.options.spanish === false ? normalize(text) : bridgeSpanish(normalize(text));
    const t = repairText(base);
    const intents: Intent[] = [];
    const has = (type: IntentType) => intents.some((i) => i.type === type);
    const add = (i: Intent) => {
      if (!has(i.type)) intents.push(i);
    };

    const medNames = ctx.patient.medications.map((m) => m.name.toLowerCase());
    const mentionsMedName = (c: string) => medNames.find((n) => new RegExp(`\\b${n}\\b`).test(c)) ?? null;

    // Message-level conversational acts.
    const thanks = THANKS.test(t);
    // "ok thanks" / "great, thank you" acknowledge; they don't accept an offer.
    const ACK = /^(ok|okay|k|kk|great|perfect|cool|awesome|got it)\b[\s,!.]*(thanks|thank you|thank u|ty|thx)\b/;
    // A yes/no can open any short sentence: "oh shoot I forgot about that. yes please".
    for (const sentence of [t, ...splitClauses(t)]) {
      const lead = sentence.replace(LEAD_FILLER, '');
      // Short sentences, or any sentence that opens with an explicit "Yes," / "No,".
      const short = sentence === t || lead.split(/\s+/).length <= 6 || /^(yes|yeah|yep|sure|absolutely|definitely|of course|no|nope)\b[,!.]/.test(lead);
      if (short && (AFFIRM.test(sentence) || AFFIRM.test(lead)) && !ACK.test(sentence)) add({ type: 'affirm' });
      if (short && (DENY.test(sentence) || DENY.test(lead))) add({ type: 'deny' });
    }
    if (WEAK_WITHDRAW.test(t)) add({ type: 'withdraw_request', about: 'any', weak: true });
    if (GREETING.test(t)) add({ type: 'greeting' });
    if (thanks) add({ type: 'thanks' });
    if (GOODBYE.test(t)) add({ type: 'goodbye' });

    let when: WhenSpec | null = null;
    let whenText = '';

    for (const c of splitClauses(t)) {
      const readings = extractReadings(c);
      const medName = mentionsMedName(c);
      const refill =
        REFILL.test(c) ||
        (REFILL_WEAK.test(c) && !DOSE_QUESTION.test(c)) ||
        (REFILL_CONTEXTUAL.test(c) && (MED_WORD.test(c) || MED_WORD.test(t) || !!medName) && !DOSE_QUESTION.test(c)) ||
        (!!medName && new RegExp(`\\b(more|out of|need|needs|refill on|refill of)\\s+(my\\s+)?${medName}\\b`).test(c));
      const symptomText = c.replace(SYMPTOM_IDIOMS, ' ');
      let clinical = readings.length > 0 || CLINICAL.some((re) => re.test(symptomText));
      // "can I get a refill" is a refill; "should I take two pills" is clinical even though it mentions pills.
      if (clinical && !(refill && !readings.length && !/\b(should|is it|side effect|dose|dosage|two|double|extra)\b/.test(c))) {
        const timeframe = c.match(/\b(all week|this week|for (?:a |the )?(?:few|couple|past|last) (?:days|weeks)|for \d+ (?:days|weeks)|since \w+|today|yesterday|this morning|lately|recently)\b/)?.[0] ?? null;
        add({
          type: 'clinical_question',
          text: c,
          readings,
          symptoms: [...new Set([...c.matchAll(SYMPTOMS)].map((m) => m[0]))],
          timeframe,
        });
      }
      if (refill) add({ type: 'refill', medicationMention: medName ?? c.match(MED_GENERIC)?.[0] ?? null, text: c });

      const issue = BILLING_ISSUE.find(([re]) => re.test(c));
      if (issue) add({ type: 'billing_issue', issue: issue[1], text: c });
      else if (BILLING_Q.test(c) && !INSURANCE_ACCEPT.test(c)) {
        const amount = c.match(/\$\s?(\d+(?:\.\d{2})?)/);
        add({ type: 'billing_question', amount: amount ? Number(amount[1]) : null });
      }
      if (PAYMENT_HOW.test(c)) add({ type: 'faq', topic: 'payment' });

      const payerQuestion = matchPayer(c) !== null && QUESTIONISH.test(c) && !/\b(bill|charge|owe|balance)\b/.test(c);
      if (INSURANCE_ACCEPT.test(c) || payerQuestion) {
        add({ type: 'insurance_accepted', payer: matchPayer(c), mine: /\bmy insurance\b/.test(c), text: c });
      }

      const status = STATUS.test(c) && !(/\block(ed)? in\b/.test(c) && extractWhen(c)?.time);
      if (status) {
        // (Grouping matters: an ungrouped /refill|med/ matched "confirMED".)
        const about = /\b(refill\w*|prescription|meds?|medication|medicine|lisinopril|pills?)\b/.test(c)
          ? 'refill'
          : /\b(question|readings?|clinician|doctor (get|see))\b/.test(c)
            ? 'clinical'
            : /\b(appointment|appt|recheck|booked|scheduled|visit|confirmed|approved|set|official|request|books)\b/.test(c) || /\bit\b/.test(c)
              ? 'appointment'
              : 'any';
        add({ type: 'request_status', about });
      }
      const nextAppt = NEXT_APPT.test(c) || (NEXT_APPT_LOOSE.test(c) && !SCHEDULE_RESCHEDULE.test(c) && !SCHEDULE_CANCEL.test(c));
      if (nextAppt) add({ type: 'next_appointment' });

      let hoursQ = false;
      if (WHAT_DAYS.test(c)) (add({ type: 'clinic_hours', ask: 'hours', day: hoursDay(c) }), (hoursQ = true));
      else if (CLOSE_TIME.test(c)) (add({ type: 'clinic_hours', ask: 'close_time', day: hoursDay(c) }), (hoursQ = true));
      else if (OPEN_TIME.test(c)) (add({ type: 'clinic_hours', ask: hoursDay(c) ? 'open_time' : 'hours', day: hoursDay(c) }), (hoursQ = true));
      else if (OPEN_ON.test(c)) (add({ type: 'clinic_hours', ask: 'open_on_day', day: hoursDay(c) }), (hoursQ = true));
      else if (HOURS.test(c)) (add({ type: 'clinic_hours', ask: 'hours', day: hoursDay(c) }), (hoursQ = true));

      let faqHit = false;
      for (const [re, topic] of FAQ_TOPICS) {
        if (re.test(c)) {
          if (!intents.some((i) => i.type === 'faq' && i.topic === topic)) intents.push({ type: 'faq', topic });
          faqHit = true;
        }
      }
      for (const [re, field] of RECORD_INFO) {
        if (re.test(c) && !intents.some((i) => i.type === 'record_info' && i.field === field)) {
          intents.push({ type: 'record_info', field });
        }
      }
      if (IDENTITY.test(c)) add({ type: 'identity' });
      if (TALK_TO_STAFF.test(c)) add({ type: 'talk_to_staff' });

      const withdraw = WITHDRAW.test(c);
      if (withdraw) {
        add({ type: 'withdraw_request', about: /refill/.test(c) ? 'refill' : /appointment|recheck|visit/.test(c) ? 'appointment' : 'any' });
      } else if (!clinical && !has('insurance_accepted')) {
        const mentionsBp = /\b(bp|blood pressure|my pressure|pressure check)\b/.test(t);
        const mentionsPhysical = /\b(physical|january|jan 14|annual)\b/.test(c);
        const action = SCHEDULE_CANCEL.test(c) && (APPOINTMENT_WORDS.test(c) || /\bcancel (it|that)\b/.test(c))
          ? 'cancel'
          : SCHEDULE_RESCHEDULE.test(c) && (APPOINTMENT_WORDS.test(c) || /\b(it|that)\b/.test(c))
            ? 'reschedule'
            : SCHEDULE_NEW.test(c) && !nextAppt && !status
              ? 'schedule'
              : null;
        if (action) {
          add({ type: 'schedule', action, mentionsBp, mentionsPhysical, explicitNew: EXPLICIT_NEW.test(c), text: c });
        }
      }

      // Catch-all: a health question about a medication/BP that nothing more specific matched.
      const otherTopic =
        refill || status || nextAppt || hoursQ || faqHit || INSURANCE_ACCEPT.test(c) || BILLING_Q.test(c) || TALK_TO_STAFF.test(c) || withdraw;
      const aboutScheduling =
        SCHEDULING_WORDS.test(c) || SCHEDULE_NEW.test(c) || SCHEDULE_RESCHEDULE.test(c) || SCHEDULE_CANCEL.test(c) || extractWhen(c) !== null;
      if (!clinical && !otherTopic && !aboutScheduling && MED_OR_CONDITION.test(c) && QUESTIONISH.test(c)) {
        clinical = true;
        add({ type: 'clinical_question', text: c, readings, symptoms: [], timeframe: null });
      }

      // Dates and times count as a scheduling preference only outside questions about
      // hours, statuses, next appointment or symptoms ("close today" is not a preference).
      const clauseWhen = extractWhen(c);
      const notAPreference =
        /\b(see you|see ya|talk to you|since|ago|yesterday|every|last (week|month|year|time|visit|monday|tuesday|wednesday|thursday|friday)|i was (there|in|at)|had (an?|my) (appointment|visit))\b/.test(c);
      if (clauseWhen && !hoursQ && !status && !nextAppt && !clinical && !faqHit && !refill && !notAPreference) {
        when = when ? mergeWhen(when, clauseWhen) : clauseWhen;
        whenText = whenText ? `${whenText} ${c}` : c;
      }
    }

    // Insurance named in one sentence and asked about in another ("switching to Cigna... will I still be able to see Dr. Lee?").
    if (!has('insurance_accepted') && !when && matchPayer(t) && QUESTIONISH.test(t) && !/\b(bill|charge|owe|balance|paid|pay)\b/.test(t)) {
      for (let i = intents.length - 1; i >= 0; i--) if (intents[i].type === 'schedule') intents.splice(i, 1);
      intents.push({ type: 'insurance_accepted', payer: matchPayer(t), mine: /\bmy insurance\b/.test(t), text: t });
    }
    if (when) intents.push({ type: 'time_preference', when, text: whenText });
    const meaningful = intents.filter((i) => !['greeting', 'thanks', 'goodbye'].includes(i.type));
    // Content we didn't understand must not be answered with a bare greeting ("Hello, <question>").
    const residue = t
      .replace(GREETING, '')
      .replace(new RegExp(THANKS.source, 'g'), '')
      .replace(/[^a-z0-9' ]+/g, ' ')
      .replace(
        /(so|much|very|for|your|the|help|again|a|lot|lots|appreciate|it|you|have|good|great|nice|day|night|weekend|ok|okay|cool|awesome|perfect|bye|see|ya|later|take|care|alex|dr|lee|sapling|clinic|team|all|guys|everyone|and|oh|um|hi|hello|hey|there|morning|afternoon|evening)/g,
        ' ',
      )
      .trim();
    if (!meaningful.length && (!intents.length || residue.split(/\s+/).filter(Boolean).length >= 3)) {
      intents.push({ type: 'unknown', text: t });
    }
    return { interpreter: this.name, normalized: t, intents };
  }
}
