import { DateTime } from 'luxon';
import type { BusinessHours, OpenSlot } from '../clinic-data/types.js';

export const CLINIC_ZONE = 'America/Los_Angeles';

export interface Holiday {
  date: string;
  name: string;
}

const utcDate = (year: number, month: number, day: number) =>
  DateTime.fromObject({ year, month, day }, { zone: 'UTC' });

function nthWeekday(year: number, month: number, weekday: number, n: number): DateTime {
  let d = utcDate(year, month, 1);
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  return d.plus({ weeks: n - 1 });
}

function lastWeekday(year: number, month: number, weekday: number): DateTime {
  let d = utcDate(year, month, 1).endOf('month').startOf('day');
  while (d.weekday !== weekday) d = d.minus({ days: 1 });
  return d;
}

/** Fixed-date federal holidays falling on a weekend are observed on the nearest weekday. */
function observed(d: DateTime): DateTime {
  if (d.weekday === 6) return d.minus({ days: 1 });
  if (d.weekday === 7) return d.plus({ days: 1 });
  return d;
}

/** U.S. federal holidays (5 U.S.C. 6103) with observed dates. */
export function federalHolidays(year: number): Holiday[] {
  const list: Array<[DateTime, string]> = [
    [observed(utcDate(year, 1, 1)), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'],
    [nthWeekday(year, 2, 1, 3), "Washington's Birthday"],
    [lastWeekday(year, 5, 1), 'Memorial Day'],
    [observed(utcDate(year, 6, 19)), 'Juneteenth'],
    [observed(utcDate(year, 7, 4)), 'Independence Day'],
    [nthWeekday(year, 9, 1, 1), 'Labor Day'],
    [nthWeekday(year, 10, 1, 2), 'Columbus Day'],
    [observed(utcDate(year, 11, 11)), 'Veterans Day'],
    [nthWeekday(year, 11, 4, 4), 'Thanksgiving Day'],
    [observed(utcDate(year, 12, 25)), 'Christmas Day'],
  ];
  return list.map(([d, name]) => ({ date: d.toISODate()!, name }));
}

export function holidayOn(isoDate: string): Holiday | undefined {
  const year = Number(isoDate.slice(0, 4));
  // New Year's Day of year+1 can be observed on Dec 31 of `year`.
  return [...federalHolidays(year), ...federalHolidays(year + 1)].find((h) => h.date === isoDate);
}

export type DayStatus =
  | { open: true; opensAt: string; closesAt: string }
  | { open: false; reason: 'weekend' | 'holiday' | 'closed_day'; holiday?: string };

export function clinicDayStatus(date: DateTime, hours: BusinessHours): DayStatus {
  const iso = date.toISODate()!;
  if (hours.closedOnFederalHolidays) {
    const h = holidayOn(iso);
    if (h) return { open: false, reason: 'holiday', holiday: h.name };
  }
  if (!hours.days.includes(date.weekday)) {
    return { open: false, reason: date.weekday >= 6 ? 'weekend' : 'closed_day' };
  }
  return { open: true, opensAt: hours.open, closesAt: hours.close };
}

export function nextOpenDay(after: DateTime, hours: BusinessHours): DateTime | null {
  let d = after.startOf('day').plus({ days: 1 });
  for (let i = 0; i < 21; i++, d = d.plus({ days: 1 })) {
    if (clinicDayStatus(d, hours).open) return d;
  }
  return null;
}

export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** "14:00" -> "2:00 p.m." (the FAQ's own style). */
export function formatTime(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);
  const suffix = h >= 12 ? 'p.m.' : 'a.m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${suffix}`;
}

/** "2026-11-10" -> "Tuesday, Nov 10" (adds the year when it differs from `now`). */
export function formatDate(isoDate: string, now: DateTime, style: 'long' | 'short' = 'long'): string {
  const d = DateTime.fromISO(isoDate, { zone: now.zoneName ?? CLINIC_ZONE });
  const base = d.toFormat(style === 'long' ? 'cccc, LLL d' : 'ccc, LLL d');
  return d.year === now.year ? base : `${base}, ${d.year}`;
}

export function slotDateTime(slot: Pick<OpenSlot, 'date' | 'start'>, zone = CLINIC_ZONE): DateTime {
  return DateTime.fromISO(`${slot.date}T${slot.start}`, { zone });
}

export function formatSlot(slot: OpenSlot, now: DateTime): string {
  return `${formatDate(slot.date, now)} at ${formatTime(slot.start)}`;
}

export function weekdayName(isoWeekday: number): string {
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][isoWeekday - 1];
}
