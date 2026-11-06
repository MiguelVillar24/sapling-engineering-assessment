/**
 * Runs the Phase 1 scenario script end to end and prints the transcript and handoffs.
 *
 *   npm run scenario                      # fresh in-memory database
 *   npm run scenario -- --db ./var/x.db   # persist to a file (inspect later / keep chatting in the UI)
 *   npm run scenario -- --until 5         # stop after step 5 (e.g. to test a restart, then --from 6)
 *   npm run scenario -- --from 6 --db ./var/x.db
 *   npm run scenario -- --json            # machine-readable output
 */
import { appConfig } from '../src/config.js';
import { createCore } from '../src/core/create-core.js';
import { PHASE1_SCRIPT } from '../src/scenario.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes('--json');
const from = Number(opt('from') ?? 0);
const until = Number(opt('until') ?? 99);
const core = createCore({ dbPath: opt('db') ?? ':memory:', dataDir: appConfig.dataDir, scenarioNow: appConfig.scenarioNow });

const conv = core.messaging.listConversations().at(-1)!;
const transcript: Array<Record<string, unknown>> = [];

for (const step of PHASE1_SCRIPT.filter((s) => s.step >= from && s.step <= until)) {
  if (step.from === 'clinic') {
    const msg = core.messaging.sendClinicMessage(conv.id, step.text);
    transcript.push({ step: step.step, clinic: msg.body, id: msg.id, expects: msg.meta.expects?.kind ?? null });
  } else {
    const { inbound, reply } = await core.messaging.receivePatientMessage(conv.id, step.text);
    transcript.push({
      step: step.step,
      patient: inbound.body,
      id: inbound.id,
      in_reply_to: inbound.in_reply_to,
      agent: reply.body,
      reply_id: reply.id,
      handled: (reply.meta.items ?? []).map((i) => `${i.kind}:${i.topic}${i.request_id ? `(${i.request_id})` : ''}`),
    });
  }
}

const requests = core.requests.list();
if (json) {
  console.log(JSON.stringify({ scenario_now: core.clock.now().toISO(), conversation: conv.id, transcript, requests }, null, 2));
} else {
  console.log(`Scenario clock: ${core.clock.now().toFormat("cccc, LLL d, yyyy, h:mm a ZZZZ")}   Conversation: ${conv.id}\n`);
  for (const t of transcript) {
    if (t.clinic) {
      console.log(`#${t.step}  CLINIC  [${t.id}] ${t.clinic}\n        (simulated, no SMS sent; expects: ${t.expects})\n`);
    } else {
      console.log(`#${t.step}  ALEX    [${t.id}]${t.in_reply_to ? ` (reply to ${t.in_reply_to})` : ''} ${t.patient}`);
      console.log(`    AGENT   [${t.reply_id}] ${String(t.agent).replace(/\n/g, '\n            ')}`);
      console.log(`            handled: ${(t.handled as string[]).join(', ') || '-'}\n`);
    }
  }
  console.log('Handoff requests:');
  for (const r of requests) {
    console.log(`\n${r.id}  ${r.type}  status=${r.status}  priority=${r.priority}  rev=${r.revision}`);
    console.log(`  summary: ${r.summary}`);
    console.log(`  source_message_ids: ${r.source_message_ids.join(', ')}`);
    console.log(`  created_at: ${r.created_at}  updated_at: ${r.updated_at}`);
    console.log(`  details: ${JSON.stringify(r.details, null, 2).replace(/\n/g, '\n  ')}`);
  }
}
core.close();
