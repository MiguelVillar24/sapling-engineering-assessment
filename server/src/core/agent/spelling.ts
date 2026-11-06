import { SPELLING_ALLOWLIST } from './spelling-allowlist.js';

/**
 * Texting shorthand and typo repair, applied before the safety screen and the
 * interpreter. Corrections only ever map onto a small domain vocabulary, and a
 * generated allowlist of real English words (see scripts/build-spelling-allowlist.ts)
 * guarantees a correctly spelled word is never "fixed" into something else.
 */

/** Words the agent's patterns depend on; typos within a small edit distance map onto these. */
export const DOMAIN_VOCAB = [
  // days, months, times
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'morning', 'afternoon', 'evening', 'tonight', 'tomorrow', 'today', 'yesterday', 'weekend', 'week',
  // scheduling
  'appointment', 'appointments', 'schedule', 'scheduled', 'reschedule', 'cancel', 'cancelled', 'booked', 'booking',
  'confirmed', 'confirm', 'available', 'instead', 'actually', 'recheck', 'rechecked', 'checkup', 'physical', 'doctor',
  // medication
  'prescription', 'prescriptions', 'refill', 'refills', 'refilled', 'medication', 'medications', 'medicine', 'pharmacy',
  'lisinopril', 'pills',
  // clinical and emergency
  'pressure', 'blood', 'readings', 'reading', 'dizzy', 'headache', 'nauseous', 'symptoms', 'swelling', 'emergency',
  'chest', 'breathe', 'breathing', 'breath', 'numb', 'numbness', 'tingling', 'stroke', 'drooping', 'slurred',
  'unconscious', 'fainted', 'bleeding', 'seizure', 'suicide', 'suicidal', 'overdose', 'allergic', 'swallow', 'vision',
  'heart', 'attack', 'pain',
  // billing, insurance, clinic info
  'balance', 'payment', 'charge', 'charged', 'billing', 'insurance', 'accept', 'copay', 'address', 'parking', 'hours',
  'closing', 'located', 'location', 'directions', 'phone', 'number', 'bring',
  // conversation
  'please', 'thanks', 'thank', 'sure', 'okay', 'absolutely', 'definitely', 'perfect',
] as const;

/** Abbreviations the patterns already understand: never "correct" them. */
const PROTECTED = new Set<string>([
  ...DOMAIN_VOCAB,
  'tues', 'thur', 'thurs', 'weds', 'appt', 'appts', 'meds', 'okey',
]);
const ALLOW = new Set(SPELLING_ALLOWLIST);

/** Texting shorthand and missing apostrophes -> plain words the patterns know. */
const SHORTHAND: Record<string, string> = {
  u: 'you', ur: 'your', r: 'are', pls: 'please', plz: 'please', pleas: 'please', plse: 'please',
  thx: 'thanks', thnx: 'thanks', thanx: 'thanks', tks: 'thanks', tnx: 'thanks',
  appt: 'appointment', appts: 'appointments', apt: 'appointment', apmt: 'appointment',
  rx: 'prescription', scrip: 'prescription', script: 'prescription', perscription: 'prescription',
  tmrw: 'tomorrow', tmr: 'tomorrow', tmw: 'tomorrow', tmro: 'tomorrow', tomoz: 'tomorrow', '2moro': 'tomorrow', '2morrow': 'tomorrow', '2mrw': 'tomorrow',
  '2day': 'today', tdy: 'today', b4: 'before', wk: 'week', nxt: 'next', abt: 'about', bc: 'because', cuz: 'because', coz: 'because',
  wknd: 'weekend', pharm: 'pharmacy', chemist: 'pharmacy', doc: 'doctor', '&': 'and', aft: 'afternoon', arvo: 'afternoon',
  hrs: 'hours', hr: 'hour', telephone: 'phone', ring: 'call', mins: 'minutes', bday: 'birthday', info: 'information',
  cant: "can't", dont: "don't", wont: "won't", isnt: "isn't", doesnt: "doesn't", didnt: "didn't", havent: "haven't",
  im: "i'm", ive: "i've", whats: "what's", wheres: "where's", thats: "that's", its: "it's", youre: "you're", whens: "when's",
  yea: 'yes', yeah: 'yes', yah: 'yes', yeh: 'yes', yup: 'yes', yep: 'yes', yass: 'yes', yas: 'yes',
  ok: 'ok', k: 'ok', kk: 'ok', okey: 'ok', okie: 'ok',
};

const EMOJI: Array<[RegExp, string]> = [
  [/[👍👌✅]/gu, ' yes '],
  [/[👎❌]/gu, ' no '],
  [/[🙏]/gu, ' thanks '],
];

/** Optimal-string-alignment (Damerau–Levenshtein) distance with an early exit above `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

/** Longer words tolerate two edits ("tommorow"), short ones one ("chet"), very short none. */
export function maxEdits(length: number): number {
  return length >= 7 ? 2 : length >= 4 ? 1 : 0;
}

/**
 * Closest domain word within the allowed distance. Ties between unrelated words
 * return null; ties between forms of one word ("confirm"/"confirmed") pick the longer form.
 */
export function nearestVocab(token: string): string | null {
  const max = maxEdits(token.length);
  if (!max) return null;
  let bestD = max + 1;
  let best: string[] = [];
  for (const v of DOMAIN_VOCAB) {
    const d = editDistance(token, v, max);
    if (d < bestD) {
      bestD = d;
      best = [v];
    } else if (d === bestD && d <= max) {
      best.push(v);
    }
  }
  if (bestD > max || !best.length) return null;
  const longest = [...best].sort((a, b) => b.length - a.length)[0];
  return best.every((w) => longest.startsWith(w)) ? longest : null;
}

export function correctToken(token: string): string {
  if (!/^[a-z]+$/.test(token) || PROTECTED.has(token) || ALLOW.has(token)) return token;
  return nearestVocab(token) ?? token;
}

/** Expands texting shorthand and repairs misspelled domain words in already-normalized text. */
export function repairText(normalized: string): string {
  let t = normalized;
  for (const [re, word] of EMOJI) t = t.replace(re, word);
  // "sat"/"sun" are weekdays only next to scheduling words ("open sat", "this sun"), not in "I sat down".
  t = t.replace(/\b(on|open|this|next|closed|thru|through|or|and|until|til|till)\s+(sat|sun)\b/g, (_m, w: string, d: string) =>
    `${w} ${d === 'sat' ? 'saturday' : 'sunday'}`,
  );
  t = t.replace(/[a-z0-9&']+/g, (w) => SHORTHAND[w] ?? correctToken(w));
  return t.replace(/\s+/g, ' ').trim();
}
