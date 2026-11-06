/**
 * Prints every stored record from the SQLite database (default: the demo database).
 *
 *   npm run inspect               # human-readable
 *   npm run inspect -- --json     # full JSON export (same as GET /api/export)
 *   npm run inspect -- --db path/to/other.db
 */
import { existsSync } from 'node:fs';
import { appConfig } from '../src/config.js';
import { createCore } from '../src/core/create-core.js';

const args = process.argv.slice(2);
const dbArg = args.indexOf('--db') >= 0 ? args[args.indexOf('--db') + 1] : undefined;
const dbPath = dbArg ?? appConfig.dbPath;
if (dbPath !== ':memory:' && !existsSync(dbPath)) {
  console.error(`No database at ${dbPath} yet. Start the demo (npm run demo) and send a message first.`);
  process.exit(1);
}
const core = createCore({ dbPath, dataDir: appConfig.dataDir, scenarioNow: appConfig.scenarioNow });
const snap = core.snapshot();

if (args.includes('--json')) {
  console.log(JSON.stringify(snap, null, 2));
} else {
  console.log(`Database: ${dbPath}`);
  console.log(`Scenario clock: ${core.clock.now().toFormat("cccc, LLL d, yyyy h:mm a ZZZZ")} (${core.clock.state().mode})\n`);
  for (const c of snap.conversations) {
    console.log(`== ${c.id}  patient=${c.patient_id}  ${c.patient_number} <-> ${c.clinic_number}  started_by=${c.started_by ?? '-'}`);
    for (const m of snap.messages.filter((x) => x.conversation_id === c.id)) {
      const who = { patient: 'ALEX  ', clinic_staff: 'CLINIC', agent: 'AGENT ' }[m.author];
      const reply = m.in_reply_to ? ` (reply to ${m.in_reply_to})` : '';
      const items = (m.meta.items ?? []).map((i) => `${i.kind}${i.request_id ? `:${i.request_id}` : ''}`).join(', ');
      console.log(`  ${m.id} ${who}${reply} ${m.body.replace(/\n/g, ' / ')}${items ? `\n         [${items}]` : ''}`);
    }
    console.log('');
  }
  console.log(`== Requests (${snap.requests.length})`);
  for (const r of snap.requests) {
    console.log(`  ${r.id} ${r.type} status=${r.status} priority=${r.priority} rev=${r.revision}`);
    console.log(`     ${r.summary}`);
    console.log(`     sources=${r.source_message_ids.join(',')}  created=${r.created_at}  updated=${r.updated_at}`);
    for (const e of r.events) console.log(`     - ${e.kind} by ${e.actor}${e.message_id ? ` (${e.message_id})` : ''}${e.note ? `: ${e.note}` : ''}`);
  }
  console.log(`\n== Agent runs: ${snap.agent_runs.length} (use --json for full traces)`);
}
core.close();
