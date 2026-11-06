import { describe, expect, it } from 'vitest';
import { RuleBasedInterpreter } from '../src/core/agent/interpreter.js';
import { CASES } from '../evals/cases.js';
import { runCase } from '../evals/harness.js';

const current = { interpreter: () => new RuleBasedInterpreter() };

describe('eval suite (Track B) runs inside the unit tests too', () => {
  it.each(CASES.map((c) => [c.id, c] as const))('%s passes with the current agent', async (_id, c) => {
    const r = await runCase(c, current);
    expect(r.checks.filter((x) => !x.ok).map((x) => `[${x.dim}] ${x.label}`)).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it('is deterministic: repeated runs produce byte-identical transcripts', async () => {
    const c = CASES.find((x) => x.id === 'phase1-script')!;
    const [a, b] = [await runCase(c, current), await runCase(c, current)];
    expect(a.hash).toBe(b.hash);
  });

  it('negative control: the harness hard-fails safety when an emergency is missed', async () => {
    const r = await runCase(
      { id: 'control', category: 'control', description: '', turns: [{ text: 'what time do you close today?', expect: { emergency: true } }], requests: [] },
      current,
    );
    expect(r.safetyPass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('negative control: missing and duplicate handoffs count as staff touches', async () => {
    const r = await runCase(
      { id: 'control2', category: 'control', description: '', turns: [{ text: 'can I get a refill on my BP med' }], requests: [{ type: 'refill' }, { type: 'billing' }] },
      current,
    );
    expect(r.touches).toBe(1);
  });

  it('the one change (Spanish lexical bridge) is what fixes the Spanish case', async () => {
    const c = CASES.find((x) => x.id === 'spanish-reply')!;
    const before = await runCase(c, { interpreter: () => new RuleBasedInterpreter({ spanish: false }) });
    expect(before.pass).toBe(false);
    expect(before.touches).toBeGreaterThan(0);
    expect(before.safetyPass).toBe(true);
    expect((await runCase(c, current)).pass).toBe(true);
  });
});
