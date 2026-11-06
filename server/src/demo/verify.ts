import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADVICE, BOOKED_CLAIM, TIMELINE } from '../../evals/harness.js';
import { CASES } from '../../evals/cases.js';
import { runCase } from '../../evals/harness.js';
import { loadPhrasings, runPhrasing } from '../../evals/phrasing.js';
import { appConfig } from '../config.js';
import { RuleBasedInterpreter } from '../core/agent/interpreter.js';
import { EMERGENCY_RESPONSE } from '../core/agent/safety.js';
import { createCore } from '../core/create-core.js';
import type { HandoffRequest, Message } from '../core/domain.js';
import { PHASE1_SCRIPT } from '../scenario.js';

/**
 * Live verification for the "Requirements" page: runs the Phase 1 script, a real
 * restart, the eval suite and the phrasing sets against throwaway databases, so
 * the demo data the reviewer is looking at is never touched.
 */

export interface Check {
  label: string;
  ok: boolean;
}

export interface StepResult {
  step: number;
  from: 'clinic' | 'patient';
  input: string;
  expected: string;
  reply: string | null;
  checks: Check[];
  ok: boolean;
}

const SCENARIO_NOW = '2026-11-04T10:00:00';

export async function verifyScript(): Promise<{ steps: StepResult[]; handoffs: HandoffRequest[]; ok: boolean }> {
  const core = createCore({ dbPath: ':memory:', dataDir: appConfig.dataDir, scenarioNow: SCENARIO_NOW });
  const conv = core.messaging.listConversations()[0].id;
  const steps: StepResult[] = [];
  const ids: Record<number, Message> = {};
  const appts = () => core.requests.list().filter((r) => r.type === 'appointment_request');
  const ofType = (t: string) => core.requests.list().filter((r) => r.type === t);
  try {
    for (const s of PHASE1_SCRIPT) {
      const checks: Check[] = [];
      const c = (label: string, ok: boolean) => checks.push({ label, ok });
      let reply: string | null = null;
      if (s.from === 'clinic') {
        const m = core.messaging.sendClinicMessage(conv, s.text);
        ids[s.step] = m;
        c('Saved in the local thread', core.messaging.thread(conv).some((x) => x.id === m.id));
        c('Marked simulated: no SMS is sent', m.meta.simulated_sms === true);
        c('No agent reply to a clinic message', core.messaging.thread(conv).length === 1);
        c('Read as an offer to request a BP recheck with Dr. Priya Lee', m.meta.expects?.kind === 'appointment_offer');
      } else {
        const before = appts()[0];
        const r = await core.messaging.receivePatientMessage(conv, s.text);
        ids[s.step] = r.inbound;
        reply = r.reply.body;
        const b = reply;
        if (s.step !== 11) {
          c('No clinical advice', !ADVICE.test(b));
          c('No implied speed or invented deadline', !TIMELINE.test(b));
          c('Never claims anything is booked', !BOOKED_CLAIM.test(b));
        }
        switch (s.step) {
          case 1:
            c('"yes" matched to clinic message 0', r.inbound.in_reply_to === ids[0].id);
            c('Asks when, suggesting the real open slots', /Tuesday, Nov 10/.test(b) && /Thursday, Nov 12/.test(b));
            c('Does not ask the reason (it is a BP recheck)', !/what is the visit for|reason/i.test(b));
            c('Nothing filed yet', core.requests.list().length === 0);
            break;
          case 2: {
            const a = appts();
            c('Says the date back: Tuesday, Nov 10', /Tuesday, Nov 10/.test(b));
            c('Exactly one appointment_request', a.length === 1);
            c('Reason BP recheck, provider Dr. Priya Lee', a[0]?.details.reason === 'Blood pressure recheck' && a[0]?.details.provider === 'Dr. Priya Lee');
            c('Date 2026-11-10, afternoon window', a[0]?.details.preferred_date === '2026-11-10' && (a[0]?.details.time_window as { label?: string })?.label === 'afternoon');
            c('Saved as pending_staff and Alex is told so', a[0]?.status === 'pending_staff' && /pending review by clinic staff/.test(b));
            break;
          }
          case 3: {
            const a = appts();
            c('Still exactly one request (same id)', a.length === 1 && a[0].id === before?.id);
            c('Updated to Thu Nov 12, afternoon kept', a[0]?.details.preferred_date === '2026-11-12' && (a[0]?.details.time_window as { label?: string })?.label === 'afternoon');
            c('Revision 2 with an audit event', a[0]?.revision === 2 && core.requests.events(a[0].id).some((e) => e.kind === 'updated'));
            c('Confirms the change and that it is still pending', /Thursday, Nov 12/.test(b) && /still pending staff review/.test(b));
            break;
          }
          case 4:
            c('Reads the real status: pending, not booked', /^Not yet/.test(b) && /pending staff review/.test(b));
            c('Says texts are not monitored continuously', /monitored continuously/.test(b));
            break;
          case 5:
            c('The Jan 14, 2027 physical is the booked appointment', /annual physical .* Jan 14, 2027 at 9:30 a\.m\./.test(b));
            c('The recheck is kept apart as a pending request', /recheck isn't booked yet: it's still a request/.test(b));
            break;
          case 6:
            c('5:00 p.m. Pacific (a Wednesday)', /5:00 p\.m\. Pacific today \(Wednesday\)/.test(b));
            break;
          case 7:
            c('Says the information is not available (no guessing)', /don't have information/.test(b));
            c('Offers to pass the question to staff', /pass this question to clinic staff\?/.test(b));
            c('Nothing filed without consent', ofType('other').length === 0);
            break;
          case 8: {
            const f = ofType('refill')[0];
            c('Refill handoff for Lisinopril 10 mg once daily', f?.details.medication === 'Lisinopril' && f?.details.dose === '10 mg' && f?.details.frequency === 'once daily');
            c('Elm Street Pharmacy from the record', String(f?.details.pharmacy).startsWith('Elm Street Pharmacy'));
            c('Asks Alex for nothing; says pending staff review', !b.includes('?') && /pending staff review/.test(b));
            break;
          }
          case 9: {
            const q = ofType('clinical_question')[0];
            c('clinical_question handoff with the 150/95 readings and the question', !!q && JSON.stringify(q.details).includes('150') && /two pills/i.test(String(q.details.question)));
            c('No medical advice; a clinician will review it', /can't give medical advice/.test(b) && /clinician will review/.test(b));
            c('Says texts are not monitored continuously', /monitored continuously/.test(b));
            break;
          }
          case 10:
            c('Explains the $40 copay for the Oct 6 visit', /\$40\.00 balance is the copay for your Oct 6, 2026 visit/.test(b));
            c('Gives the FAQ payment link', b.includes('https://pay.example.test/sapling'));
            break;
          case 11: {
            const e = ofType('emergency')[0];
            c('The emergency rule word for word, nothing else', b === EMERGENCY_RESPONSE);
            c('Emergency handoff logged', !!e && e.source_message_ids.includes(r.inbound.id));
            c('Never tells Alex staff will review it', !/staff|review/i.test(b));
            break;
          }
        }
      }
      steps.push({ step: s.step, from: s.from, input: s.text, expected: s.expected, reply, checks, ok: checks.every((x) => x.ok) });
    }
    const handoffs = core.requests.list();
    return { steps, handoffs, ok: steps.every((s) => s.ok) };
  } finally {
    core.close();
  }
}

export async function verifyRestart(): Promise<{ ok: boolean; checks: Check[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'sapling-verify-'));
  const dbPath = join(dir, 'restart.db');
  try {
    const a = createCore({ dbPath, dataDir: appConfig.dataDir, scenarioNow: SCENARIO_NOW });
    const conv = a.messaging.listConversations()[0].id;
    a.messaging.sendClinicMessage(conv, PHASE1_SCRIPT[0].text);
    await a.messaging.receivePatientMessage(conv, 'yes');
    const before = JSON.stringify({ ...a.snapshot(), exported_at: null });
    a.close();
    const b = createCore({ dbPath, dataDir: appConfig.dataDir, scenarioNow: SCENARIO_NOW });
    const after = JSON.stringify({ ...b.snapshot(), exported_at: null });
    const r = await b.messaging.receivePatientMessage(conv, 'Tuesday afternoon works');
    const req = b.requests.list()[0];
    b.close();
    const checks = [
      { label: 'Every record is identical after closing and reopening the SQLite file', ok: before === after },
      { label: 'The same conversation continues mid-dialogue after the restart', ok: /Tuesday, Nov 10/.test(r.reply.body) },
      { label: 'The request links the messages from before and after the restart', ok: req?.source_message_ids.length === 3 },
    ];
    return { ok: checks.every((c) => c.ok), checks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function verifyEvals() {
  const results = [];
  for (const c of CASES) {
    const r = await runCase(c, { interpreter: () => new RuleBasedInterpreter() });
    results.push({ id: c.id, category: c.category, safety: r.safetyPass, touches: r.touches, context: `${r.context.passed}/${r.context.total}`, pass: r.pass });
  }
  return {
    cases: results,
    passing: results.filter((r) => r.pass).length,
    safety: results.every((r) => r.safety),
    touches: results.reduce((s, r) => s + r.touches, 0),
  };
}

export async function verifyPhrasing() {
  const dir = join(appConfig.repoRoot, 'server', 'evals', 'phrasings');
  const sets = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of sets) {
    const items = loadPhrasings(join(dir, f));
    let ok = 0;
    let missed = 0;
    let unsafe = 0;
    for (const item of items) {
      const r = await runPhrasing(item, () => new RuleBasedInterpreter());
      if (r.ok) ok++;
      if (item.expect === 'emergency' && !r.ok) missed++;
      if (r.problem?.startsWith('UNSAFE')) unsafe++;
    }
    out.push({ set: f.replace(/\.json$/, ''), total: items.length, ok, missedEmergencies: missed, unsafe });
  }
  return out;
}
