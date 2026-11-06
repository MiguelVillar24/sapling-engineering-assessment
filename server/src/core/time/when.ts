import { DateTime } from 'luxon';
import type { BusinessHours, OpenSlot } from '../clinic-data/types.js';
import { clinicDayStatus, formatDate, formatTime, minutesOf, slotDateTime } from './calendar.js';

/**
 * Extraction and resolution of a patient's scheduling preference
 * ("Tuesday afternoon works", "actually can we do Thursday instead", "the 3:30 one").
 * Extraction is pure text -> WhenSpec; resolution applies the scenario clock,
 * the slots already offered in the thread and the request being changed.
 */

export interface TimeWindow {
  label: string;
  /** "HH:mm", inclusive. */
  start: string;
  /** "HH:mm", exclusive. */
  end: string;
}

export const WINDOWS = {
  morning: { label: 'morning', start: '00:00', end: '12:00' },
  afternoon: { label: 'afternoon', start: '12:00', end: '17:00' },
  early_afternoon: { label: 'early afternoon', start: '12:00', end: '15:00' },
  late_afternoon: { label: 'late afternoon', start: '15:00', end: '17:00' },
  evening: { label: 'evening', start: '17:00', end: '23:59' },
  midday: { label: 'around midday', start: '11:00', end: '14:00' },
} as const satisfies Record<string, TimeWindow>;

export interface WeekdayMention {
  day: number;
  qualifier: 'this' | 'next' | null;
}

export interface WhenSpec {
  weekdays: WeekdayMention[];
  rejectedWeekdays: number[];
  dates: Array<{ month: number; day: number; year: number | null }>;
  dayOfMonth: number | null;
  relative: 'today' | 'tomorrow' | 'day_after_tomorrow' | null;
  range: 'this_week' | 'next_week' | 'week_of' | null;
  window: TimeWindow | null;
  time: string | null;
  /** 1-based index into the slots offered in the thread; -1 = last. */
  ordinal: number | null;
  anyTime: boolean;
}

const WEEKDAY_NUM: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6,
  sunday: 7,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_PATTERN =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const WEEKDAY_RE =
  /\b(?:(this|next|coming)\s+)?(monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sunday)s?\b/g;
const NEG_AFTER =
  /^\s*(?:morning|afternoon|evening)?\s*(?:doesn'?t|does not|won'?t|will not|isn'?t|is not|no longer)\s+(?:work|good|possible|ok)|^\s*(?:morning|afternoon)?\s*(?:is|'s)\s+(?:bad|out|no good|not good)/;
const NEG_BEFORE =
  /(?:\bnot|\bcan'?t do|\bcannot do|\bcan'?t make|\bcannot make|\bcan'?t come(?: in)?|\bexcept|\bbut not|\bworking|\bbusy|\bat work|\bcame up|\bcome up|\bsomething (?:on|up)|\b(?:dentist|dental|doctor'?s|work|job|meeting|plans|shift|class|other|another) (?:appointment |appt |thing )?)\s*(?:on\s+)?$/;
/** A clause that only describes a conflict ("something came up at work Tuesday") rejects its days. */
const CONFLICT = /\b(came up|come up|busy|conflict|tied up|out of town|stuck at work|have work|got work)\b/;
const POSITIVE = /\b(works|work for me|good|fine|better|prefer|instead|how about|what about|could we|can we|would|available|free|open|possible|ok|okay)\b/;
const WINDOW_WORDS: Array<[RegExp, TimeWindow]> = [
  [/\bearly afternoons?\b/g, WINDOWS.early_afternoon],
  [/\blate afternoons?\b/g, WINDOWS.late_afternoon],
  [/\b(afternoons?|after lunch)\b/g, WINDOWS.afternoon],
  [/\b(mornings?|before lunch)\b/g, WINDOWS.morning],
  [/\b(evenings?|after work|tonight)\b/g, WINDOWS.evening],
  [/\b(lunch ?time|midday|mid-day)\b/g, WINDOWS.midday],
];
const WINDOW_NEG_AFTER =
  /^\s*(are|is|'re|'s)?\s*(really |pretty |too |kind of |kinda )?(hard|tough|bad|difficult|impossible|busy|out|no good|not good|rough|tricky|a no)\b|^\s*(don'?t|doesn'?t|won'?t|wont|do not|does not|will not|never) work\b/;
const WINDOW_NEG_BEFORE =
  /(\bnot|\bno|\bcan'?t do|\bcannot do|\bexcept|\bbut not|\bavoid|\b(meeting|appointment|busy|work|plans|class|shift)(\s+on)?(\s+\w+day)?)\s+(the\s+|in the\s+)?$/;

const pad = (n: number) => String(n).padStart(2, '0');

function to24h(hour: number, minute: number, meridiem: string | undefined): string {
  let h = hour;
  if (meridiem && /^p/.test(meridiem)) h = (hour % 12) + 12;
  else if (meridiem && /^a/.test(meridiem)) h = hour % 12;
  // No meridiem: assume clinic-hours sense ("at 2" = 2 p.m., "at 9" = 9 a.m.).
  else if (hour >= 1 && hour <= 6) h = hour + 12;
  return `${pad(h)}:${pad(minute)}`;
}

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};
const NUM = '(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2})';
const num = (w: string) => NUMBER_WORDS[w] ?? w;

/** "half past three" -> "3:30", "two o'clock" -> "2 o'clock", "at four" -> "at 4"; drops "good morning". */
function speakTimes(text: string): string {
  return text
    .replace(/\bgood (morning|afternoon|evening|night)\b/g, ' ')
    .replace(/\b(at|@) for\b/g, 'at 4')
    .replace(new RegExp(`\\bhalf past ${NUM}\\b`, 'g'), (_m, n: string) => `at ${num(n)}:30`)
    .replace(new RegExp(`\\b(at )?half ${NUM}\\b`, 'g'), (_m, _a: string, n: string) => `at ${num(n)}:30`)
    .replace(/\b(mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday)\s+([1-9]|1[0-2])\b(?!\s*(st|nd|rd|th)\b|\/|:|\s*(pills?|days?|weeks?))/g, '$1 at $2')
    .replace(new RegExp(`\\bquarter past ${NUM}\\b`, 'g'), (_m, n: string) => `at ${num(n)}:15`)
    .replace(new RegExp(`\\bquarter (to|till|til) ${NUM}\\b`, 'g'), (_m, _t: string, n: string) => `at ${Number(num(n)) - 1}:45`)
    .replace(new RegExp(`\\b${NUM} (thirty|fifteen|forty-?five)\\b`, 'g'), (_m, n: string, mm: string) =>
      `at ${num(n)}:${mm === 'thirty' ? '30' : mm === 'fifteen' ? '15' : '45'}`,
    )
    .replace(new RegExp(`\\b${NUM} o'?clock\\b`, 'g'), (_m, n: string) => `${num(n)} o'clock`)
    .replace(new RegExp(`\\b(at|around|after|before) ${NUM}\\b(?!\\s*(pills?|days?|weeks?|times?))`, 'g'), (_m, p: string, n: string) => `${p} ${num(n)}`)
    .replace(/\bin the (am|a\.m\.)(?=$|[^\w])/g, ' morning ')
    .replace(/\bin the (pm|p\.m\.)(?=$|[^\w])/g, ' afternoon ');
}

export function extractWhen(input: string): WhenSpec | null {
  const text = speakTimes(input.toLowerCase().replace(/[’‘]/g, "'"));
  const spec: WhenSpec = {
    weekdays: [],
    rejectedWeekdays: [],
    dates: [],
    dayOfMonth: null,
    relative: null,
    range: null,
    window: null,
    time: null,
    ordinal: null,
    anyTime: false,
  };

  for (const m of text.matchAll(WEEKDAY_RE)) {
    const day = WEEKDAY_NUM[m[2]];
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    const before = text.slice(Math.max(0, m.index! - 24), m.index!);
    if (NEG_AFTER.test(after) || NEG_BEFORE.test(before)) {
      spec.rejectedWeekdays.push(day);
      continue;
    }
    const q = m[1] === 'next' ? 'next' : m[1] ? 'this' : null;
    if (!spec.weekdays.some((w) => w.day === day)) spec.weekdays.push({ day, qualifier: q });
  }
  if (CONFLICT.test(text) && !POSITIVE.test(text) && spec.weekdays.length) {
    spec.rejectedWeekdays.push(...spec.weekdays.map((w) => w.day));
    spec.weekdays = [];
  }

  for (const m of text.matchAll(new RegExp(`\\b${MONTH_PATTERN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'g'))) {
    const day = Number(m[2]);
    if (day >= 1 && day <= 31) spec.dates.push({ month: MONTHS[m[1].slice(0, 3)] ?? MONTHS[m[1]], day, year: m[3] ? Number(m[3]) : null });
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PATTERN}\\b`, 'g'))) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) spec.dates.push({ month: MONTHS[m[2].slice(0, 3)] ?? MONTHS[m[2]], day, year: null });
  }
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
      spec.dates.push({ month, day, year });
    }
  }
  const dom = text.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dom && !spec.dates.length) spec.dayOfMonth = Number(dom[1]);

  if (/\bday after tomorrow\b/.test(text)) spec.relative = 'day_after_tomorrow';
  else if (/\b(tomorrow|tmrw|tmr|tomorow)\b/.test(text)) spec.relative = 'tomorrow';
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(text)) spec.relative = 'today';

  if (/\bweek of\b/.test(text) && (spec.dates.length || spec.dayOfMonth)) spec.range = 'week_of';
  else if (/\bnext week\b/.test(text)) spec.range = 'next_week';
  else if (/\b(this|later this) week\b/.test(text)) spec.range = 'this_week';

  const windowHits: Array<{ w: TimeWindow; start: number; end: number; rejected: boolean; explicit: boolean }> = [];
  for (const [re, w] of WINDOW_WORDS) {
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (windowHits.some((h) => start >= h.start && start < h.end)) continue; // "afternoon" inside "late afternoon"
      const before = text.slice(Math.max(0, start - 30), start);
      const explicit = WINDOW_NEG_AFTER.test(text.slice(end, end + 30)) || /(\bnot|\bno|\bcan'?t do|\bcannot do|\bexcept|\bbut not|\bavoid)\s+(the\s+|in the\s+)?$/.test(before);
      const rejected = explicit || WINDOW_NEG_BEFORE.test(before);
      windowHits.push({ w, start, end, rejected, explicit });
    }
  }
  windowHits.sort((a, b) => a.start - b.start);
  const accepted = windowHits.find((h) => !h.rejected);
  if (accepted) spec.window = accepted.w;
  else if (windowHits.some((h) => h.explicit)) {
    // Only a rejection ("not mornings"): the other half of the clinic day.
    const r = windowHits.find((h) => h.explicit)!.w;
    spec.window = r === WINDOWS.morning ? WINDOWS.afternoon : r.start >= '12:00' ? WINDOWS.morning : null;
  } else if (/(?<![\d:]\s?)\b(pm|p\.m\.)(?=$|[^\w])/.test(text)) spec.window = WINDOWS.afternoon;

  const timeRe =
    /(?:\b(at|around|about|after|before|by|from)\s+|(@)\s*)?\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|o'?clock)?(?=$|[^\w/:])/g;
  for (const m of text.matchAll(timeRe)) {
    const [, word, at, h, min, mer] = m;
    const prep = word ?? (at ? 'at' : undefined);
    if (!prep && !min && !mer) continue; // a bare number ("2 pills") is not a time
    const meridiem = mer && !/o'?clock/.test(mer) ? mer.replace(/[.\s]/g, '') : undefined;
    const hhmm = to24h(Number(h), Number(min ?? 0), meridiem);
    if (prep === 'after' || prep === 'from') {
      spec.window = { label: `after ${formatTime(hhmm)}`, start: hhmm, end: '23:59' };
    } else if (prep === 'before' || prep === 'by') {
      spec.window = { label: `before ${formatTime(hhmm)}`, start: '00:00', end: hhmm };
    } else if (prep === 'around' || prep === 'about') {
      const s = minutesOf(hhmm);
      const fmt = (x: number) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
      spec.window = { label: `around ${formatTime(hhmm)}`, start: fmt(Math.max(0, s - 60)), end: fmt(Math.min(23 * 60 + 59, s + 61)) };
      spec.time = spec.time ?? hhmm;
    } else {
      spec.time = spec.time ?? hhmm;
    }
  }
  if (!spec.time && /\bnoon\b/.test(text) && !/\bafternoon\b/.test(text.replace(/\bnoon\b/, ''))) {
    spec.time = '12:00';
  }

  const ord = text.match(
    /\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|last|earliest|later|latter|earlier|former)\s+(?:one|option|slot|time|opening|appointment|available)\b|\b(?:first|earliest|soonest) (?:available|opening)\b|\b(?:soonest|earliest)\b/,
  );
  if (ord) {
    const word = ord[1] ?? 'first';
    spec.ordinal =
      { first: 1, '1st': 1, earliest: 1, earlier: 1, former: 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1, later: -1, latter: -1 }[
        word
      ] ?? 1;
  }

  spec.anyTime = /\b(any ?time|any day|whenever|flexible|either (?:one|day|time)|either works|doesn'?t matter|no preference|both work|any of (?:those|them|these))\b/.test(text);

  const found =
    spec.weekdays.length || spec.dates.length || spec.dayOfMonth || spec.relative || spec.range ||
    spec.window || spec.time || spec.ordinal || spec.anyTime || spec.rejectedWeekdays.length;
  return found ? spec : null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface AppointmentPreference {
  preferred_date: string | null;
  alternative_dates: string[];
  date_range: { start: string; end: string } | null;
  time_window: TimeWindow | null;
  preferred_time: string | null;
  /** Set only when the patient picked a time that matches a listed open slot. */
  preferred_slot: OpenSlot | null;
}

export interface PreferenceContext {
  now: DateTime;
  hours: BusinessHours | null;
  openSlots: OpenSlot[];
  /** Slots the agent already suggested in this thread (used to read "Thursday" as the offered Thursday). */
  offeredSlots: OpenSlot[];
  provider: string | null;
  /** The preference on the request being changed, if any. */
  current: AppointmentPreference | null;
}

export type PreferenceIssue =
  | { kind: 'past_date'; date: string }
  | { kind: 'clinic_closed'; date: string; reason: 'weekend' | 'holiday' | 'closed_day'; holiday?: string }
  | { kind: 'outside_hours'; label: string };

export interface ResolvedPreference {
  preference: AppointmentPreference;
  /** Listed open slots (future, same provider) that satisfy the preference. */
  matchingSlots: OpenSlot[];
  issues: PreferenceIssue[];
  /** Set when a plain weekday skipped its nearest occurrence because that day had no listed openings. */
  skippedNearest: string | null;
  /** True when the spec contained something usable as a scheduling preference. */
  usable: boolean;
}

export function resolvePreference(spec: WhenSpec, ctx: PreferenceContext): ResolvedPreference {
  const zone = ctx.now.zoneName ?? 'America/Los_Angeles';
  const today = ctx.now.startOf('day');
  const toDate = (iso: string) => DateTime.fromISO(iso, { zone });
  const isFuture = (s: OpenSlot) => slotDateTime(s, zone) > ctx.now;
  const listed = ctx.openSlots.filter((s) => isFuture(s) && (!ctx.provider || s.provider === ctx.provider));
  const offered = ctx.offeredSlots.filter(isFuture);
  let skippedNearest: string | null = null;

  const occurrence = (from: DateTime, day: number) => {
    let d = from;
    while (d.weekday !== day) d = d.plus({ days: 1 });
    return d;
  };

  const resolveWeekday = (w: WeekdayMention): string => {
    if (w.qualifier === 'this') return occurrence(today, w.day).toISODate()!;
    if (w.qualifier === 'next') return occurrence(today.startOf('week').plus({ weeks: 1 }), w.day).toISODate()!;
    const fromOffered = offered.find((s) => toDate(s.date).weekday === w.day);
    if (fromOffered) return fromOffered.date;
    if (ctx.current?.preferred_date) {
      const sameWeek = occurrence(toDate(ctx.current.preferred_date).startOf('week'), w.day);
      if (sameWeek > today) return sameWeek.toISODate()!;
    }
    const first = occurrence(today.plus({ days: 1 }), w.day);
    const second = first.plus({ weeks: 1 });
    const hasSlots = (d: DateTime) => listed.some((s) => s.date === d.toISODate());
    if (!hasSlots(first) && hasSlots(second)) {
      skippedNearest = first.toISODate();
      return second.toISODate()!;
    }
    return first.toISODate()!;
  };

  let dates: string[] = [];
  for (const d of spec.dates) {
    let dt = DateTime.fromObject({ year: d.year ?? today.year, month: d.month, day: d.day }, { zone });
    // No year given: a date a few weeks back is a mistake to flag ("Nov 2" on Nov 4),
    // a date months back means next year ("Jan 14" in November).
    if (!d.year && dt.isValid && dt < today && today.diff(dt, 'days').days > 60) dt = dt.plus({ years: 1 });
    if (dt.isValid) dates.push(dt.toISODate()!);
  }
  if (spec.dayOfMonth) {
    let dt = today.set({ day: spec.dayOfMonth });
    if (!dt.isValid || dt < today) dt = today.plus({ months: 1 }).set({ day: spec.dayOfMonth });
    if (dt.isValid) dates.push(dt.toISODate()!);
  }
  if (spec.relative) {
    dates.push(today.plus({ days: { today: 0, tomorrow: 1, day_after_tomorrow: 2 }[spec.relative] }).toISODate()!);
  }
  const explicitWeekdays = new Set(dates.map((d) => toDate(d).weekday));
  for (const w of spec.weekdays) if (!explicitWeekdays.has(w.day)) dates.push(resolveWeekday(w));
  dates = [...new Set(dates)];

  let range: AppointmentPreference['date_range'] = null;
  if (spec.range === 'week_of' && dates.length) {
    // "the week of Jan 18": any weekday that week, not the single date.
    const mon = toDate(dates[0]).startOf('week');
    range = { start: mon.toISODate()!, end: mon.plus({ days: 4 }).toISODate()! };
    dates = [];
  } else if (spec.range === 'next_week') {
    const mon = today.startOf('week').plus({ weeks: 1 });
    range = { start: mon.toISODate()!, end: mon.plus({ days: 4 }).toISODate()! };
  } else if (spec.range === 'this_week') {
    range = { start: today.toISODate()!, end: today.startOf('week').plus({ days: 4 }).toISODate()! };
  }

  let slot: OpenSlot | null = null;
  if (spec.ordinal) {
    const onDate = dates.length ? listed.filter((s) => s.date === dates[0]) : [];
    const pool = onDate.length ? onDate : offered.length ? offered : listed;
    slot = (spec.ordinal === -1 ? pool.at(-1) : pool[spec.ordinal - 1]) ?? null;
    if (slot && !dates.length) dates = [slot.date];
  }

  let time = spec.time;
  if (time && !slot) {
    const pool = dates.length
      ? listed.filter((s) => dates.includes(s.date))
      : ctx.current?.preferred_date
        ? listed.filter((s) => s.date === ctx.current!.preferred_date)
        : offered.length
          ? offered
          : listed;
    const hits = pool.filter((s) => s.start === time);
    if (hits.length === 1) {
      slot = hits[0];
      if (!dates.length) dates = [slot.date];
    }
  }

  let window: TimeWindow | null = spec.window;
  const current = ctx.current;
  const gaveDate = dates.length > 0 || range !== null;
  const gaveTime = window !== null || time !== null || slot !== null;
  if (current && !spec.anyTime) {
    if (!gaveDate) {
      dates = current.preferred_date ? [current.preferred_date, ...current.alternative_dates] : [];
      range = current.date_range;
      if (!gaveTime) {
        window = current.time_window;
        time = current.preferred_time;
        slot = current.preferred_slot;
      }
    } else if (!gaveTime) {
      // Changing the day keeps the time-of-day preference ("Thursday instead" stays afternoon).
      window = current.time_window;
    }
  }
  if (spec.anyTime && !gaveTime) {
    window = null;
    time = null;
  }
  if (!window && (slot || time)) {
    const t = slot?.start ?? time!;
    window = t < '12:00' ? WINDOWS.morning : t < '17:00' ? WINDOWS.afternoon : WINDOWS.evening;
  }
  if (slot && !dates.includes(slot.date)) slot = null;

  const issues: PreferenceIssue[] = [];
  for (const d of dates) {
    const dt = toDate(d);
    if (dt < today) issues.push({ kind: 'past_date', date: d });
    else if (ctx.hours) {
      const st = clinicDayStatus(dt, ctx.hours);
      if (!st.open) issues.push({ kind: 'clinic_closed', date: d, reason: st.reason, holiday: st.holiday });
    }
  }
  if (ctx.hours) {
    const open = minutesOf(ctx.hours.open);
    const close = minutesOf(ctx.hours.close);
    if (time && !slot && (minutesOf(time) < open || minutesOf(time) >= close)) {
      issues.push({ kind: 'outside_hours', label: formatTime(time) });
    } else if (window && (minutesOf(window.end) <= open || minutesOf(window.start) >= close)) {
      issues.push({ kind: 'outside_hours', label: window.label });
    }
  }

  let matching = listed;
  if (slot) matching = [slot];
  else {
    if (dates.length) matching = matching.filter((s) => dates.includes(s.date));
    else if (range) matching = matching.filter((s) => s.date >= range!.start && s.date <= range!.end);
    if (time && !window?.label.startsWith('around')) matching = matching.filter((s) => s.start === time);
    else if (window) matching = matching.filter((s) => s.start >= window!.start && s.start < window!.end);
  }

  const preference: AppointmentPreference = {
    preferred_date: dates[0] ?? null,
    alternative_dates: dates.slice(1),
    date_range: dates.length ? null : range,
    time_window: window,
    preferred_time: slot ? slot.start : time,
    preferred_slot: slot,
  };
  // A bare rejection ("Tuesday doesn't work") is not a usable preference: the agent asks again.
  const usable = gaveDate || gaveTime || spec.anyTime || spec.ordinal !== null;
  return { preference, matchingSlots: matching, issues, skippedNearest, usable };
}

export function windowPhrase(w: TimeWindow): string {
  return /^(morning|afternoon|evening|early afternoon|late afternoon)$/.test(w.label) ? `in the ${w.label}` : w.label;
}

/** Human phrase for a preference, e.g. "Thursday, Nov 12, in the afternoon". */
export function describePreference(p: AppointmentPreference, now: DateTime): string {
  if (p.preferred_slot) return `${formatDate(p.preferred_slot.date, now)} at ${formatTime(p.preferred_slot.start)}`;
  const dates = p.preferred_date ? [p.preferred_date, ...p.alternative_dates] : [];
  const datePart = dates.length
    ? dates.map((d) => formatDate(d, now)).join(' or ')
    : p.date_range
      ? `the week of ${formatDate(p.date_range.start, now)}`
      : 'any weekday';
  let timePart = '';
  if (p.preferred_time && !p.time_window?.label.startsWith('around')) timePart = `at ${formatTime(p.preferred_time)}`;
  else if (p.time_window) timePart = windowPhrase(p.time_window);
  if (!timePart) return dates.length ? `${datePart} (any time)` : `${datePart}, any time`;
  return `${datePart}, ${timePart}`;
}

/** "2:00 or 3:30 p.m." style list of slot times on one date. */
export function slotTimesPhrase(slots: OpenSlot[], conj: 'or' | 'and' = 'or'): string {
  const times = slots.map((s) => formatTime(s.start));
  if (times.length <= 1) return times.join('');
  const sameSuffix = times.every((t) => t.endsWith(times[0].slice(-4)));
  const bare = sameSuffix ? times.map((t) => t.slice(0, -5)) : times;
  const last = sameSuffix ? `${bare.at(-1)} ${times[0].slice(-4)}` : bare.at(-1);
  return `${bare.slice(0, -1).join(', ')} ${conj} ${last}`;
}

/** Groups slots by date: "Tuesday, Nov 10 at 2:00 or 3:30 p.m.; Thursday, Nov 12 at 1:30 or 4:00 p.m." */
export function describeSlots(slots: OpenSlot[], now: DateTime, conj: 'or' | 'and' = 'or'): string[] {
  const byDate = new Map<string, OpenSlot[]>();
  for (const s of slots) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  return [...byDate.entries()].map(([date, ss]) => `${formatDate(date, now)} at ${slotTimesPhrase(ss, conj)}`);
}
