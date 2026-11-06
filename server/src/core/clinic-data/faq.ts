import type { BusinessHours, FaqEntry, FaqKey } from './types.js';

const TITLE_TO_KEY: Record<string, FaqKey> = {
  hours: 'hours',
  address: 'address',
  phone: 'phone',
  texting: 'texting',
  'paying a balance': 'payment',
  'what to bring': 'what_to_bring',
  cancellations: 'cancellations',
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Parses "- **Title:** text" bullet lines from the clinic FAQ markdown. */
export function parseFaq(markdown: string): FaqEntry[] {
  const entries: FaqEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*•●]\s+\*\*(.+?):?\*\*:?\s*(.+?)\s*$/);
    if (!m) continue;
    const title = m[1].replace(/:$/, '').trim();
    const text = m[2].trim();
    entries.push({ key: TITLE_TO_KEY[title.toLowerCase()] ?? slug(title), title, text });
  }
  return entries;
}

const DAY_INDEX: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const ZONES: Record<string, string> = {
  pacific: 'America/Los_Angeles',
  mountain: 'America/Denver',
  central: 'America/Chicago',
  eastern: 'America/New_York',
};

function to24h(hour: string, minute: string | undefined, meridiem: string): string {
  let h = Number(hour) % 12;
  if (/^p/i.test(meridiem)) h += 12;
  return `${String(h).padStart(2, '0')}:${minute ?? '00'}`;
}

/**
 * Parses e.g. "Monday–Friday, 9:00 a.m.–5:00 p.m. Pacific. Closed weekends and federal holidays."
 * Returns null when the text has an unexpected shape; callers then fall back to quoting the FAQ.
 */
export function parseBusinessHours(text: string): BusinessHours | null {
  const day = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const time = '(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?\\s*m\\.?';
  const re = new RegExp(
    `${day}\\s*[–—-]\\s*${day}\\s*,?\\s*${time}\\s*[–—-]\\s*${time}\\s*(pacific|mountain|central|eastern)?`,
    'i',
  );
  const m = text.match(re);
  if (!m) return null;
  const [, fromDay, toDay, oh, om, omer, ch, cm, cmer, zoneWord] = m;
  const from = DAY_INDEX[fromDay.toLowerCase()];
  const to = DAY_INDEX[toDay.toLowerCase()];
  const days: number[] = [];
  for (let d = from; ; d = (d % 7) + 1) {
    days.push(d);
    if (d === to) break;
  }
  return {
    days,
    open: to24h(oh, om, omer),
    close: to24h(ch, cm, cmer),
    zone: ZONES[(zoneWord ?? 'pacific').toLowerCase()],
    closedOnFederalHolidays: /federal holidays?/i.test(text),
  };
}

/** "Monday–Friday, 9:00 a.m.–5:00 p.m. Pacific" — the first sentence of the FAQ hours entry. */
export function hoursSummary(faq: FaqEntry[]): string {
  const text = findFaq(faq, 'hours')?.text;
  if (!text) return 'during business hours';
  const upToZone = text.match(/^.*?\b(Pacific|Mountain|Central|Eastern)\b/)?.[0];
  return upToZone ?? text.split(/(?<!\b[ap]\.m)\.\s+(?=[A-Z])/)[0].replace(/\.$/, '');
}

export function findFaq(faq: FaqEntry[], key: FaqKey): FaqEntry | undefined {
  return faq.find((e) => e.key === key);
}
