import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { appConfig } from '../src/config.js';
import { loadClinicData } from '../src/core/clinic-data/load.js';
import { clinicDayStatus, federalHolidays } from '../src/core/time/calendar.js';
import { type AppointmentPreference, extractWhen, resolvePreference, WINDOWS } from '../src/core/time/when.js';

const clinic = loadClinicData(appConfig.dataDir);
const NOW = DateTime.fromISO('2026-11-04T10:00:00', { zone: 'America/Los_Angeles' });

function resolve(text: string, opts: { offered?: boolean; current?: Partial<AppointmentPreference>; now?: DateTime } = {}) {
  const spec = extractWhen(text);
  if (!spec) return null;
  const current = opts.current
    ? { preferred_date: null, alternative_dates: [], date_range: null, time_window: null, preferred_time: null, preferred_slot: null, ...opts.current }
    : null;
  return resolvePreference(spec, {
    now: opts.now ?? NOW,
    hours: clinic.hours,
    openSlots: clinic.slots,
    offeredSlots: opts.offered ? clinic.slots : [],
    provider: 'Dr. Priya Lee',
    current,
  });
}

describe('extracting a preference from text', () => {
  it('finds weekday + window', () => {
    expect(extractWhen('Tuesday afternoon works')).toMatchObject({ weekdays: [{ day: 2 }], window: { label: 'afternoon' } });
  });
  it('ignores things that are not times or dates', () => {
    expect(extractWhen('should I take 2 pills')).toBeNull();
    expect(extractWhen('my readings have been around 150/95 all week')).toBeNull();
    expect(extractWhen('why do I owe $40?')).toBeNull();
    expect(extractWhen('can I get a refill on my 10 mg dose')).toBeNull();
  });
  it('reads negated days as rejections', () => {
    expect(extractWhen("Tuesday doesn't work, how about Thursday")).toMatchObject({ weekdays: [{ day: 4 }], rejectedWeekdays: [2] });
  });
});

describe('resolving a preference against the scenario clock (Wed Nov 4, 2026 10:00 PT)', () => {
  it('"Tuesday afternoon" -> Tue Nov 10, afternoon, with the two listed afternoon slots', () => {
    const r = resolve('Tuesday afternoon works', { offered: true })!;
    expect(r.preference).toMatchObject({ preferred_date: '2026-11-10', time_window: WINDOWS.afternoon });
    expect(r.matchingSlots.map((s) => s.start)).toEqual(['14:00', '15:30']);
    expect(r.issues).toEqual([]);
  });

  it('"Thursday instead" while changing a Tue Nov 10 afternoon request -> Thu Nov 12, keeps afternoon', () => {
    const r = resolve('actually can we do Thursday instead', {
      offered: true,
      current: { preferred_date: '2026-11-10', time_window: WINDOWS.afternoon },
    })!;
    expect(r.preference).toMatchObject({ preferred_date: '2026-11-12', time_window: WINDOWS.afternoon });
  });

  it('a bare "Thursday" with no offered slots skips tomorrow (no openings) and says so', () => {
    const r = resolve('Thursday')!;
    expect(r.preference.preferred_date).toBe('2026-11-12');
    expect(r.skippedNearest).toBe('2026-11-05');
  });

  it('"this Thursday" and "tomorrow" mean Nov 5; "next Thursday" means Nov 12', () => {
    expect(resolve('this Thursday')!.preference.preferred_date).toBe('2026-11-05');
    expect(resolve('tomorrow morning')!.preference.preferred_date).toBe('2026-11-05');
    expect(resolve('next Thursday')!.preference.preferred_date).toBe('2026-11-12');
  });

  it('explicit dates: "Nov 12", "11/12", "Jan 14" (next year)', () => {
    expect(resolve('Nov 12 works')!.preference.preferred_date).toBe('2026-11-12');
    expect(resolve('how about 11/12')!.preference.preferred_date).toBe('2026-11-12');
    expect(resolve('January 14th')!.preference.preferred_date).toBe('2027-01-14');
  });

  it('a specific time picks the listed slot ("Tuesday at 3:30", "the 4pm one")', () => {
    expect(resolve('Tuesday at 3:30', { offered: true })!.preference.preferred_slot).toMatchObject({ date: '2026-11-10', start: '15:30' });
    expect(resolve('the 4pm one works', { offered: true })!.preference.preferred_slot).toMatchObject({ date: '2026-11-12', start: '16:00' });
  });

  it('flags days the clinic is closed (weekend, federal holiday) and dates already passed', () => {
    expect(resolve('Saturday morning')!.issues).toEqual([expect.objectContaining({ kind: 'clinic_closed', reason: 'weekend' })]);
    expect(resolve('Nov 11 please')!.issues).toEqual([expect.objectContaining({ kind: 'clinic_closed', reason: 'holiday', holiday: 'Veterans Day' })]);
    expect(resolve('Nov 2')!.issues).toEqual([expect.objectContaining({ kind: 'past_date', date: '2026-11-02' })]);
  });

  it('flags times outside clinic hours', () => {
    expect(resolve('Tuesday evening')!.issues).toEqual([expect.objectContaining({ kind: 'outside_hours' })]);
    expect(resolve('Tuesday at 7pm')!.issues).toEqual([expect.objectContaining({ kind: 'outside_hours' })]);
  });

  it('a window with no listed openings still resolves (staff find a time), with no matching slots', () => {
    const r = resolve('Thursday morning', { offered: true })!;
    expect(r.preference).toMatchObject({ preferred_date: '2026-11-12', time_window: WINDOWS.morning });
    expect(r.matchingSlots).toEqual([]);
  });

  it('follows the clock when it changes (now = Mon Nov 9 -> "Thursday" is Nov 12)', () => {
    const now = DateTime.fromISO('2026-11-09T09:00:00', { zone: 'America/Los_Angeles' });
    expect(resolve('Thursday afternoon', { now })!.preference.preferred_date).toBe('2026-11-12');
  });
});

describe('clinic calendar', () => {
  it('knows 2026 federal holidays used by the FAQ ("closed ... federal holidays")', () => {
    const h = federalHolidays(2026).map((x) => `${x.date} ${x.name}`);
    expect(h).toContain('2026-11-11 Veterans Day');
    expect(h).toContain('2026-11-26 Thanksgiving Day');
    expect(h).toContain('2026-12-25 Christmas Day');
  });
  it('parses business hours from the FAQ text', () => {
    expect(clinic.hours).toEqual({ days: [1, 2, 3, 4, 5], open: '09:00', close: '17:00', zone: 'America/Los_Angeles', closedOnFederalHolidays: true });
    expect(clinicDayStatus(NOW, clinic.hours!)).toMatchObject({ open: true });
    expect(clinicDayStatus(NOW.set({ day: 7 }), clinic.hours!)).toMatchObject({ open: false, reason: 'weekend' });
  });
});
