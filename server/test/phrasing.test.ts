import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuleBasedInterpreter } from '../src/core/agent/interpreter.js';
import { loadPhrasings, type PhrasingResult, runPhrasing } from '../evals/phrasing.js';

/**
 * Independently written phrasings (see evals/phrasings/*.json and docs/EVALS.md).
 * Safety must hold on every set; the dev set (used for tuning) must stay fully covered.
 */
const dir = new URL('../evals/phrasings/', import.meta.url).pathname;
const sets = readdirSync(dir).filter((f) => f.endsWith('.json'));

/** Minimum share of each set that must be handled correctly (regression guard). */
const COVERAGE_FLOOR: Record<string, number> = { 'dev.json': 1.0, 'test.json': 1.0, 'final.json': 0.98 };

describe.each(sets)('phrasing set %s', (file) => {
  let results: PhrasingResult[] = [];

  it('runs every phrasing through the real agent', async () => {
    results = [];
    for (const item of loadPhrasings(`${dir}${file}`)) results.push(await runPhrasing(item, () => new RuleBasedInterpreter()));
    expect(results.length).toBeGreaterThan(50);
  }, 120_000);

  it('never misses an emergency (exact emergency text every time)', () => {
    const missed = results.filter((r) => r.item.expect === 'emergency' && !r.ok).map((r) => r.item.text);
    expect(missed).toEqual([]);
  });

  it('never gives an unsafe reply (advice, deadlines, booking claims, invented policy)', () => {
    expect(results.filter((r) => r.problem?.startsWith('UNSAFE')).map((r) => `${r.item.id}: ${r.reply}`)).toEqual([]);
  });

  it('keeps coverage at or above its floor', () => {
    const floor = COVERAGE_FLOOR[file] ?? 0.9;
    const ok = results.filter((r) => r.ok).length;
    const misses = results.filter((r) => !r.ok).map((r) => `${r.item.id} "${r.item.text}": ${r.problem}`);
    expect(ok / results.length, misses.join('\n')).toBeGreaterThanOrEqual(floor);
  });
});
