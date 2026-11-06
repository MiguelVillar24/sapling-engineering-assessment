/**
 * Eval suite (Phase 2, Track B).
 *
 *   npm run eval                       # current agent, every case x3, scorecard
 *   npm run eval -- --compare          # before/after the one change (Spanish understanding)
 *   npm run eval -- --runs 5 --verbose # more runs, print transcripts of failing cases
 *   npm run eval -- --case spanish-reply
 *   npm run eval -- --compare --markdown ../docs/EVAL_RESULTS.md
 *
 * Exits non-zero if any safety check fails (a missed emergency or any advice fails the run).
 */
import { writeFileSync } from 'node:fs';
import { RuleBasedInterpreter } from '../src/core/agent/interpreter.js';
import { CASES } from '../evals/cases.js';
import { type CaseResult, type EvalCase, runCase } from '../evals/harness.js';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const runs = Number(opt('runs') ?? 3);
const only = opt('case');
const verbose = args.includes('--verbose');
const markdownPath = opt('markdown');
const cases = CASES.filter((c) => !only || c.id === only);

interface Aggregate {
  label: string;
  perCase: Array<{ c: EvalCase; runs: CaseResult[] }>;
}

async function suite(label: string, makeInterpreter: () => RuleBasedInterpreter): Promise<Aggregate> {
  const perCase = [];
  for (const c of cases) {
    const results: CaseResult[] = [];
    for (let i = 0; i < runs; i++) results.push(await runCase(c, { interpreter: makeInterpreter }));
    perCase.push({ c, runs: results });
  }
  return { label, perCase };
}

function summarize(a: Aggregate) {
  const rows = a.perCase.map(({ c, runs: rs }) => {
    const r = rs[0];
    const passes = rs.filter((x) => x.pass).length;
    const deterministic = rs.every((x) => x.hash === r.hash);
    return {
      id: c.id,
      category: c.category,
      safety: rs.every((x) => x.safetyPass) ? 'PASS' : 'FAIL',
      touches: Math.max(...rs.map((x) => x.touches)),
      context: `${r.context.passed}/${r.context.total}`,
      passRate: `${passes}/${rs.length}`,
      deterministic,
      failures: r.checks.filter((x) => !x.ok).map((x) => `[${x.dim}] ${x.label}`),
      transcript: r.transcript,
    };
  });
  const ctxPassed = a.perCase.reduce((s, x) => s + x.runs[0].context.passed, 0);
  const ctxTotal = a.perCase.reduce((s, x) => s + x.runs[0].context.total, 0);
  return {
    rows,
    safetyFailures: rows.filter((r) => r.safety === 'FAIL').length,
    touches: rows.reduce((s, r) => s + r.touches, 0),
    context: { passed: ctxPassed, total: ctxTotal },
    casesPassing: rows.filter((r) => r.passRate === `${runs}/${runs}`).length,
    deterministic: rows.every((r) => r.deterministic),
  };
}

type Summary = ReturnType<typeof summarize>;

function printScorecard(title: string, s: Summary) {
  const pad = (v: string, n: number) => v.padEnd(n);
  console.log(`\n${title}`);
  console.log('─'.repeat(100));
  console.log(`${pad('case', 28)}${pad('category', 17)}${pad('safety', 8)}${pad('staff touches', 15)}${pad('context', 10)}${pad('pass rate', 11)}deterministic`);
  console.log('─'.repeat(100));
  for (const r of s.rows) {
    console.log(`${pad(r.id, 28)}${pad(r.category, 17)}${pad(r.safety, 8)}${pad(String(r.touches), 15)}${pad(r.context, 10)}${pad(r.passRate, 11)}${r.deterministic ? 'yes' : 'NO'}`);
  }
  console.log('─'.repeat(100));
  const pct = s.context.total ? Math.round((100 * s.context.passed) / s.context.total) : 100;
  console.log(
    `OVERALL  safety: ${s.safetyFailures ? `HARD FAIL (${s.safetyFailures} case${s.safetyFailures > 1 ? 's' : ''})` : 'PASS'}  ·  staff touches: ${s.touches}  ·  context: ${s.context.passed}/${s.context.total} (${pct}%)  ·  cases passing: ${s.casesPassing}/${s.rows.length}  ·  runs per case: ${runs}  ·  deterministic: ${s.deterministic ? 'yes' : 'NO'}`,
  );
  const failing = s.rows.filter((r) => r.failures.length);
  for (const r of failing) {
    console.log(`\n  ✗ ${r.id}`);
    for (const f of r.failures) console.log(`      ${f}`);
    if (verbose) for (const line of r.transcript) console.log(`        | ${line}`);
  }
}

function markdown(title: string, s: Summary): string {
  const pct = s.context.total ? Math.round((100 * s.context.passed) / s.context.total) : 100;
  const lines = [
    `### ${title}`,
    '',
    '| case | category | safety | staff touches | context | pass rate |',
    '|---|---|---|---|---|---|',
    ...s.rows.map((r) => `| ${r.id} | ${r.category} | ${r.safety} | ${r.touches} | ${r.context} | ${r.passRate} |`),
    '',
    `**Overall:** safety ${s.safetyFailures ? `HARD FAIL (${s.safetyFailures})` : 'PASS'} · staff touches ${s.touches} · context ${s.context.passed}/${s.context.total} (${pct}%) · cases passing ${s.casesPassing}/${s.rows.length} · ${runs} runs per case · deterministic: ${s.deterministic ? 'yes' : 'no'}`,
    '',
  ];
  const failing = s.rows.filter((r) => r.failures.length);
  if (failing.length) {
    lines.push('Failures:', '');
    for (const r of failing) lines.push(`- \`${r.id}\`: ${r.failures.join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

const header = `Sapling agent evals · ${cases.length} cases × ${runs} runs · scenario clock Wed Nov 4, 2026 10:00 PT (per-case overrides allowed)`;
console.log(header);
console.log('Scoring: deterministic assertions (see evals/harness.ts). Safety is pass/fail; touches = avoidable staff follow-ups; context = checks passed.');

const after = summarize(await suite('current', () => new RuleBasedInterpreter()));
let md = `# Eval results\n\n_Generated by \`npm run eval -- --compare --markdown ../docs/EVAL_RESULTS.md\`._\n\n${header}\n\n`;

if (args.includes('--compare')) {
  const before = summarize(await suite('baseline', () => new RuleBasedInterpreter({ spanish: false })));
  printScorecard('BEFORE — baseline interpreter (English only)', before);
  printScorecard('AFTER — interpreter with the Spanish lexical bridge (the one change)', after);
  const changed = after.rows.filter((r, i) => r.passRate !== before.rows[i].passRate || r.context !== before.rows[i].context || r.touches !== before.rows[i].touches);
  console.log(`\nDelta: staff touches ${before.touches} → ${after.touches}, context ${before.context.passed}/${before.context.total} → ${after.context.passed}/${after.context.total}, cases passing ${before.casesPassing} → ${after.casesPassing}, safety ${before.safetyFailures ? 'FAIL' : 'PASS'} → ${after.safetyFailures ? 'FAIL' : 'PASS'}`);
  console.log(`Cases that changed: ${changed.map((r) => r.id).join(', ') || 'none'}`);
  md += markdown('Before: baseline interpreter (English only)', before);
  md += markdown('After: with the Spanish lexical bridge', after);
  md += `**Delta:** staff touches ${before.touches} → ${after.touches}; context ${before.context.passed}/${before.context.total} → ${after.context.passed}/${after.context.total}; cases passing ${before.casesPassing} → ${after.casesPassing}; changed: ${changed.map((r) => `\`${r.id}\``).join(', ') || 'none'}.\n`;
} else {
  printScorecard('Scorecard — current agent', after);
  md += markdown('Current agent', after);
}

if (markdownPath) {
  writeFileSync(markdownPath, md);
  console.log(`\nWrote ${markdownPath}`);
}
process.exitCode = after.safetyFailures ? 1 : 0;
