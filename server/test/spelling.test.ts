import { describe, expect, it } from 'vitest';
import { detectEmergency } from '../src/core/agent/safety.js';
import { correctToken, editDistance, repairText } from '../src/core/agent/spelling.js';
import { SPELLING_ALLOWLIST } from '../src/core/agent/spelling-allowlist.js';
import { clinic, CLINIC_OFFER, patient, testCore } from './helpers.js';

describe('typo and shorthand repair', () => {
  it.each([
    ['thrusday afternon works', 'thursday afternoon works'],
    ['can i get a refil on my perscription', 'can i get a refill on my prescription'],
    ['tommorow mornin', 'tomorrow morning'],
    ['is my apointment confirmd', 'is my appointment confirmed'],
    ['r u open sat', 'are you open saturday'],
    ['pls send my rx thx', 'please send my prescription thanks'],
    ['whens my next appt', "when's my next appointment"],
    ['cant breath', "can't breath"],
  ])('%s -> %s', (input, output) => {
    expect(repairText(input)).toBe(output);
  });

  it('never changes a correctly spelled English word (all generated allowlist entries)', () => {
    const changed = SPELLING_ALLOWLIST.filter((w) => correctToken(w) !== w);
    expect(changed).toEqual([]);
    expect(SPELLING_ALLOWLIST.length).toBeGreaterThan(1000);
  });

  it('leaves ordinary sentences alone', () => {
    for (const t of ['i sat down and had some bread', 'the test was fine', 'my wife and i', 'see you at the office']) {
      expect(repairText(t)).toBe(t);
    }
  });

  it('uses optimal-string-alignment distance (transpositions count as one edit)', () => {
    expect(editDistance('thrusday', 'thursday')).toBe(1);
    expect(editDistance('bread', 'breath')).toBe(2);
  });
});

describe('misspelled messages still work end to end', () => {
  it.each(['cant breath', 'chest pian and sweating', 'my chet hurts real bad', 'CANT FEEL MY LEFT ARM'])(
    'emergency with typos is caught: %s',
    (text) => {
      expect(detectEmergency(text)).not.toBeNull();
    },
  );

  it('"thrusday afternon" files the Thursday afternoon request', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    await patient(core, 'yes');
    const r = await patient(core, 'thrusday afternon works');
    expect(r.reply.body).toContain('Thursday, Nov 12');
    expect(core.requests.list()[0].details).toMatchObject({ preferred_date: '2026-11-12', time_window: { label: 'afternoon' } });
  });

  it('"can i get a refil on my perscription pls" files the refill', async () => {
    const core = testCore();
    await patient(core, 'can i get a refil on my perscription pls');
    expect(core.requests.list()[0]).toMatchObject({ type: 'refill', details: { medication: 'Lisinopril' } });
  });
});
