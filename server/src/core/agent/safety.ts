import { repairText } from './spelling.js';
import { extractReadings, normalize } from './text.js';

/**
 * The exact emergency response required by the clinic (text track). It is sent
 * verbatim and alone: no greeting, no other answers, no promise of staff review.
 */
export const EMERGENCY_RESPONSE =
  'If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. This text line is not monitored continuously and cannot help in an emergency.';

interface EmergencyRule {
  signal: string;
  pattern: RegExp;
}

/**
 * Deliberately conservative: a false positive costs the patient one extra
 * safety message; a false negative is a safety failure. There is no negation
 * handling ("no chest pain" still triggers) for the same reason.
 */
const RULES: EmergencyRule[] = [
  {
    signal: 'chest pain or pressure',
    pattern:
      /\bchest\b[^.?!]{0,30}\b(pain|pains|hurt|hurts|hurting|pressure|tight|tightness|heavy|heaviness|squeez\w*|crush\w*|ache|aching|achy|discomfort|burning|sharp|stabbing|pounding|weird|funny)\b|\b(pain|pains|pressure|tight|tightness|ache|aching|hurts?|hurting|squeez\w*|crush\w*|heaviness|heavy|weight|elephant|sitting|burning|stabbing|sharp|discomfort)\b[^.?!]{0,25}\b(in|on|across|around)\s+(my\s+|the\s+|his\s+|her\s+)?chest\b|\b(radiat\w*|spread\w*|shoot\w*|going down|goes down)\b[^.?!]{0,25}\b(arm|jaw|neck|shoulder|back)\b/,
  },
  { signal: 'heart attack', pattern: /\bheart attack\b|\bcardiac arrest\b/ },
  {
    signal: 'numbness or weakness in the arm, face or leg',
    pattern:
      /\b(arms?|face|legs?|hands?|side of (my|the) (body|face))\b[^.?!]{0,25}\b(numb|numbness|numbed|tingl\w*|weak\w*|paraly\w*|can'?t (move|feel)|dead|limp|asleep)\b|\b(numb|numbness|numbed|tingl\w*|weak\w*|paraly\w*|limp)\b[^.?!]{0,25}\b(arms?|face|legs?|one side|left side|right side)\b|\b(can'?t|cannot|couldn'?t|could not|unable to) (really |even |quite |properly )?(feel|move|lift)\b[^.?!]{0,20}\b(arms?|legs?|face|hands?|side)\b|\blost (all )?(feeling|sensation) in\b|\b(arms?|legs?|hands?|side)\b[^.?!]{0,12}\b(won'?t|wont|doesn'?t|isn'?t|can'?t) (work|move|respond)\b|\barm\b[^.?!]{0,15}\b(heavy|heaviness)\b|\b(heavy|heaviness) (in )?(my |the )?(left |right )?arm\b|\bfell (down )?and can'?t get up\b/,
  },
  {
    signal: 'trouble breathing',
    pattern:
      /\b(can'?t|cannot|can not|couldn'?t|could not|hard to|trouble|difficulty|struggling to|unable to)\s+(really\s+|even\s+|seem to\s+|quite\s+|properly\s+)?(breathe|breath|breathing|get (a |my )?breath|catch (my|a) breath)\b|\bshort(ness)? of breath\b|\bnot breathing\b|\bchoking\b|\bgasping\b|\b(lips|face|fingers) (are |is )?(turning )?blue\b|\bsuffocat\w*/,
  },
  {
    signal: 'possible stroke',
    pattern:
      /\bstroke\b(?<!\b(mom|mother|dad|father|grand\w+|sister|brother|aunt|uncle|family|parents?) had a stroke)(?<!history of stroke)|\b(face|mouth|smile)\b[^.?!]{0,15}\b(droop\w*|crooked|lopsided|uneven|sagging|slanted|twisted)|\bslurr\w*\b|\bcan'?t (speak|talk)\b|\btrouble (speaking|talking)\b|\bsudden(ly)? confus\w*/,
  },
  {
    signal: 'fainting or unresponsive',
    pattern:
      /\b(passed out|passing out|pass out|fainted|fainting|about to faint|going to faint|gonna faint|unconscious|unresponsive|won'?t wake up|blacked out|blacking out|black out|collapsed)\b/,
  },
  {
    signal: 'severe bleeding',
    pattern:
      /\b(bleeding (heavily|a lot|badly|profusely|that won'?t stop|won'?t stop|wont stop|doesn'?t stop|will not stop)|(won'?t|wont|can'?t|doesn'?t|isn'?t|not|will not) stop(ping)? (the )?bleeding|(vomiting|coughing|throwing) up blood|lots of blood|blood (is )?(everywhere|pouring|gushing|spurting)|soak(ed|ing)? (through )?(\d+|two|three|four|several|many|a few|multiple) (towels|bandages|pads))\b/,
  },
  {
    signal: 'self-harm or suicidal thoughts',
    pattern:
      /\b(suicid\w*|kill(ing)? (myself|me|himself|herself)|end(ing)? (my|his|her) (own )?life|end (it all|it)|take (my|his|her) (own )?life|want to die|wanna die|(want|going|planning) to (hurt|harm|cut) myself|thinking (about|of) (hurting|harming|cutting) myself|(hurting|harming|cutting) myself|self[- ]harm|don'?t want to (live|be alive|be here anymore|wake up)|don'?t see (the|a|any) point (anymore|in living|of living|in going on)|better off dead|no reason to live)\b/,
  },
  {
    signal: 'overdose or poisoning',
    pattern:
      /\b(overdos\w*|took\b[^.?!]{0,15}\btoo (many|much)|taken too (many|much)|swallowed (a bunch|too many|the whole)|took (a |my |the )?(whole|entire) (bottle|pack)|took (all|a handful|\d{2,}|ten|twenty|a bunch|a lot) of (my |the |them|his |her )?(pills|meds|tablets)?|(got into|swallowed|ate|eaten|chewed)\b[^.?!]{0,30}\b(pills|meds|medication|medicine|tablets|lisinopril)|poison(ed|ing)?\b(?! (ivy|oak|sumac)))/,
  },
  { signal: 'seizure', pattern: /\b(seizure|seizing|convuls\w*)\b/ },
  {
    signal: 'severe allergic reaction',
    pattern:
      /\b(anaphyla\w*|severe allergic|allergic reaction|throat\b[^.?!]{0,25}\b(clos\w*|swell\w*|swollen|tight\w*)|(tongue|lips?|face|mouth)\b[^.?!]{0,12}\b(swelling|swollen|swelled)|can'?t swallow)\b/,
  },
  { signal: 'sudden severe headache', pattern: /\b(worst headache|sudden (severe |bad )?headache|thunderclap)\b/ },
  {
    signal: 'sudden vision loss',
    pattern:
      /\b(sudden(ly)? (lost|losing|loss of) (my )?(vision|sight)|sudden(ly)? (can'?t|couldn'?t|could not) see|lost (my |the )?(vision|sight)|vision loss|went blind|(can'?t|couldn'?t|cannot|could not|unable to) see (out of|anything)|curtain (came|coming|come) down|(half|part) of my vision)\b/,
  },
  { signal: 'patient describes an emergency', pattern: /\b(emergency|911|ambulance)\b/ },
  { signal: 'feels like dying', pattern: /\b(i'?m|i am|think i'?m|feel like i'?m) dying\b/ },
  {
    signal: 'possible emergency (Spanish)',
    pattern:
      /(dolor (de|en el) pecho|duele\S*[^.?!]{0,20}pecho|pecho[^.?!]{0,15}(duele|dolor)|se me durmi[oó] el brazo|brazo[^.?!]{0,20}(dormido|entumecido|durmi[oó])|presi[oó]n en el pecho|no puedo respirar|me falta el aire|emergencia|infarto|derrame|me desmay[eé]|brazo (izquierdo |derecho )?(entumecido|dormido)|no siento (el|mi) brazo)/,
  },
];

/** Conservative threshold: readings at or above 180/120 are treated as a possible emergency. */
export const CRISIS_SYSTOLIC = 180;
export const CRISIS_DIASTOLIC = 120;

export interface EmergencyAssessment {
  signals: string[];
}

export function detectEmergency(text: string): EmergencyAssessment | null {
  const raw = normalize(text);
  // Screen the text as written AND with typos/shorthand repaired ("cant breath", "chet pain").
  const variants = [raw, repairText(raw)];
  const t = variants[1];
  const signals = RULES.filter((r) => variants.some((v) => r.pattern.test(v))).map((r) => r.signal);
  for (const r of extractReadings(t)) {
    if (r.systolic >= CRISIS_SYSTOLIC || r.diastolic >= CRISIS_DIASTOLIC) {
      signals.push(`very high blood pressure reading (${r.text})`);
    }
  }
  return signals.length ? { signals: [...new Set(signals)] } : null;
}
