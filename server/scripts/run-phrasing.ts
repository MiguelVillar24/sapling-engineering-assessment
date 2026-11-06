/**
 * Phrasing coverage report: how many independently written phrasings the agent handles correctly.
 *
 *   npm run eval:phrasing                          # all sets in evals/phrasings/
 *   npm run eval:phrasing -- --set test --verbose  # one set, print every miss
 *   npm run eval:phrasing -- --only emergency
 *
 * Exits non-zero if any emergency phrasing is missed or any reply is unsafe.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RuleBasedInterpreter } from '../src/core/agent/interpreter.js';
import { loadPhrasings, type PhrasingResult, runPhrasing } from '../evals/phrasing.js';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const dir = new URL('../evals/phrasings/', import.meta.url).pathname;
const sets = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((s) => !opt('set') || s === opt('set'));
const verbose = args.includes('--verbose');

let unsafe = 0;
for (const set of sets) {
  const items = loadPhrasings(join(dir, `${set}.json`)).filter((i) => !opt('only') || i.expect === opt('only'));
  const results: PhrasingResult[] = [];
  for (const item of items) results.push(await runPhrasing(item, () => new RuleBasedInterpreter()));

  const byExpect = new Map<string, PhrasingResult[]>();
  for (const r of results) byExpect.set(r.item.expect, [...(byExpect.get(r.item.expect) ?? []), r]);
  const ok = results.filter((r) => r.ok).length;
  const pct = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 100}%`;

  console.log(`\nPhrasing set "${set}": ${ok}/${results.length} handled correctly (${pct(ok, results.length)})`);
  console.log('─'.repeat(64));
  for (const [expect, rs] of [...byExpect.entries()].sort()) {
    const n = rs.filter((r) => r.ok).length;
    console.log(`${expect.padEnd(22)}${`${n}/${rs.length}`.padEnd(9)}${pct(n, rs.length).padEnd(6)}${n < rs.length ? '✗'.repeat(rs.length - n) : ''}`);
  }
  const missedEmergencies = results.filter((r) => r.item.expect === 'emergency' && !r.ok).length;
  const unsafeReplies = results.filter((r) => r.problem?.startsWith('UNSAFE')).length;
  unsafe += missedEmergencies + unsafeReplies;
  console.log('─'.repeat(64));
  console.log(`Safety: missed emergencies ${missedEmergencies} · unsafe replies ${unsafeReplies}`);

  const misses = results.filter((r) => !r.ok);
  if (misses.length && (verbose || misses.length <= 40)) {
    console.log('\nMisses:');
    for (const r of misses) {
      console.log(`  ✗ [${r.item.id}] (${r.item.context}) "${r.item.text}"`);
      console.log(`      expected ${r.item.expect}${r.item.args ? ` ${JSON.stringify(r.item.args)}` : ''}: ${r.problem}`);
      console.log(`      intents: ${r.intents.join(', ') || '(emergency screen)'}`);
      if (verbose) console.log(`      reply: ${r.reply.replace(/\n/g, ' / ').slice(0, 220)}`);
    }
  }
}
process.exitCode = unsafe ? 1 : 0;
