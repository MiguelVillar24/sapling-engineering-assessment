# Sapling Family Clinic: two-way patient texting

An interview project for Sapling. Clinic staff and the patient, Alex Morgan, exchange texts in one thread. Behind the thread, an agent answers what the patient record and the clinic FAQ can answer. Everything else becomes a structured request that staff can act on without texting Alex again.

| | Scope |
|---|---|
| **Phase 1** | Text track, complete. Web UI with a chat thread, handoff panel, staff queue and raw-record view. NestJS API. SQLite persistence. |
| **Phase 2** | Track B (evals). Running `npm run eval` scores 20 cases on safety, staff touches and context use, with a before/after for one agent change. |
| **External services** | None. The agent runs locally and deterministically. It needs no API keys, accounts or network. |

## Quick start

You need **Node.js 22.13 or newer** (developed on Node 24 LTS). No database server, Docker or API keys are needed.

```bash
npm install
npm run demo          # builds the web app and the server, then serves both on http://localhost:3000
```

Open <http://localhost:3000>. Data is stored in `server/var/sapling.db`.

| Command | What it does |
|---|---|
| `npm run demo` | Build everything and start the server (same as `npm run build && npm start`). |
| `npm start` | Start the server from an existing build. |
| `npm run dev` | API on :3000 with auto-reload, plus the UI on <http://localhost:5173> with hot reload. |
| `npm test` | 181 automated tests (Vitest), including the HTTP end-to-end tests, the eval cases and the phrasing sets. |
| `npm run eval` | The Phase 2 eval suite: 20 cases × 3 runs, printed as a scorecard. |
| `npm run eval -- --compare` | Scorecards before and after the one agent change. |
| `npm run eval:phrasing` | Phrasing coverage: hundreds of independently written ways to say each thing, scored on outcome. |
| `npm run scenario` | Runs the whole Phase 1 script in a terminal and prints the transcript and the handoff records. |
| `npm run inspect` | Prints every record stored in the demo database, from a terminal. |
| `npm run evidence` | Regenerates [docs/TEST_EVIDENCE.md](docs/TEST_EVIDENCE.md) from a real run. |

## Simulating the conversation (Phase 1 walkthrough)

1. Start the demo and open <http://localhost:3000>. The thread for `conv_001` is empty.
   - **Quick tour for an audience.** The **Requirements ✓** tab lists every requirement from the brief with live proof: it runs the script, a restart, the evals and the phrasing sets on throwaway databases. **▶ Play all steps**, in the Phase 1 script card, resets the demo and plays steps 0–11 in the thread.
2. **Step 0.** The composer starts on **Clinic staff (outbound)**. Click step **0** in the *Phase 1 script* list on the left to fill the composer, then press **Send**. The message is saved and shown, marked "simulated, no SMS sent". No agent reply is sent.
3. **Steps 1–11.** The composer switches to **Alex (patient reply)**. Click each step, or type your own text, and press **Send**. Each inbound message is treated as coming from Alex's number on file.
4. While you go, watch three places:
   - **Thread.** Patient messages show which earlier message they answer, for example "reply to msg_0001". Each agent reply has chips saying what the agent did, such as *Answered from FAQ (hours)* or *Filed req_001 · pending staff review*. Click **why?** to see the agent's trace: intents, open questions and tool calls.
   - **Right panel.** It lists emergency handoffs, requests awaiting staff review, questions the agent answered directly, and questions the data could not answer, which were offered to staff.
   - **Staff queue tab.** This is the optional staff view. Each request shows its full structured details, source messages and history. Staff can change the status and add a note. If Alex then asks "is it booked yet?", the agent reads that real status and note.
5. **Scenario clock.** In the header, click **change**. Set "now", for example to a Saturday or to 6:00 p.m., then ask "what time do you close today?". The clock is a persisted setting, frozen by default; *running* mode makes it tick.
6. **Restart.** Stop the server with Ctrl+C, run `npm start`, and reload the page. Every message, request, event and setting is still there, and you can keep going in the same conversation. The **Records** tab, `GET /api/export` and `npm run inspect` show every stored record.
7. **Starting over.** **+ New** starts another conversation; Alex can start one too. Requests belong to the patient, so a change sent from a new thread updates the same request. **Reset demo** deletes everything.

For a terminal-only run, use `npm run scenario`, or `npm run scenario -- --db ./var/demo.db --until 5` and then `--from 6` to split the run across a restart.

## How it works

```
 Clinic UI / HTTP (NestJS controllers, zod-validated)
        │
        ▼
 MessagingService ── saves the inbound message first, then one transaction per agent turn
        │
        ▼
 PatientAgent
   1. Safety screen ─── possible emergency? → exact emergency text + emergency handoff. Stop.
   2. Interpreter ───── text → intents (rule-based; swappable, e.g. for an LLM)
   3. Dialogue state ── which earlier clinic/agent question is open? (derived from the stored thread)
   4. Policies ──────── decide; call tools; write the reply from fixed templates
        │
        ▼
 Agent tools: createRequest / amendRequest only ──► RequestService (rules + audit log) ──► SQLite
        ▲
 Read-only data: data/alex_morgan.json, data/clinic_faq.md, data/open_slots.json
```

- **The agent only files and updates requests.** Its tools cannot set a status, book, reschedule, cancel or approve anything; staff record those in the staff queue. Every request starts as `pending_staff`. A later change from Alex updates the same record: the revision goes up and an audit event records the diff.
- **Every turn is atomic.** The request writes, the reply and the trace commit together. If anything fails, the turn rolls back and the reply says no request was created, so the agent never claims something was saved when it wasn't. An emergency still gets the exact emergency text.
- **Language understanding is separate from what the agent says.** The interpreter only produces intents. Patient-facing wording comes from fixed, reviewed templates. That is how no-advice, no-deadline and exact-emergency are guaranteed rather than hoped for.
- **Dialogue state comes from the stored thread.** That is how "yes" is matched to clinic message 0, and why a restart in the middle of a dialogue loses nothing.

Code map:

| Path | Contents |
|---|---|
| `server/src/core/agent/` | Safety screen, interpreter, dialogue state, per-topic policies (`policy/*.ts`), agent tools. |
| `server/src/core/requests/` | Request-type registry (zod schemas and summaries) and `RequestService` (rules and audit log). |
| `server/src/core/time/` | Scenario clock, federal holidays and clinic hours, date and time preference resolution. |
| `server/src/core/store/` | SQLite schema, migrations, transactions and repositories. |
| `server/src/core/clinic-data/` | Loaders for the supplied files; parses the FAQ, including business hours. |
| `server/src/http/` | NestJS module, controllers and error mapping. Thin: no business logic. |
| `server/evals/` | Phase 2 eval harness and cases. |
| `web/src/` | React (Vite) UI. |
| `docs/` | Design notes, test evidence, eval method and results. |

More detail is in [docs/DESIGN.md](docs/DESIGN.md).

### Handoff records

Every record has `id`, `patient_id`, `type`, `status` (starts as `pending_staff`), structured `details` for its type, `source_message_ids`, `created_at` and `updated_at`. It also carries `priority`, a one-line `summary`, a `revision` counter, a `staff_note` and an audit `events` history. Here is the appointment request after step 3, abridged:

```json
{
  "id": "req_001", "patient_id": "pt_001", "type": "appointment_request", "status": "pending_staff", "revision": 2,
  "summary": "Schedule: Blood pressure recheck with Dr. Priya Lee — prefers Thursday, Nov 12, in the afternoon",
  "details": {
    "action": "schedule", "reason": "Blood pressure recheck", "provider": "Dr. Priya Lee",
    "preferred_date": "2026-11-12", "time_window": { "label": "afternoon", "start": "12:00", "end": "17:00" },
    "matching_open_slots": [{ "date": "2026-11-12", "start": "13:30" }, { "date": "2026-11-12", "start": "16:00" }],
    "patient_flexibility": "Patient is flexible within the stated preference; any matching listed opening works: …",
    "clinical_context": "Last visit 2026-10-06 with Dr. Priya Lee (Blood pressure follow-up). Plan note: \"Recheck BP in about 4 weeks.\""
  },
  "source_message_ids": ["msg_0001", "msg_0002", "msg_0004", "msg_0006"]
}
```

The types are `appointment_request` (schedule, reschedule or cancel), `refill`, `clinical_question`, `billing`, `other` and `emergency`. Each has its own zod schema in `server/src/core/requests/request-types.ts`.

### Adding a request type

1. Add the name to `REQUEST_TYPES` in `server/src/core/domain.ts`.
2. Add a registry entry in `request-types.ts`: a zod `details` schema, a default priority and a `summarize` function.
3. Add a policy in `server/src/core/agent/policy/` that recognizes the need and calls `turn.tools.createRequest(...)`, and register it in `policy/index.ts`. If it needs new wording, add an intent pattern in `interpreter.ts`.

No database migration is needed, because types are validated in code. The staff queue and record views render any type.

## Design decisions and trade-offs

- **A deterministic agent, not an LLM.** Safety is pass/fail, the demo must run without keys, and reviewers need repeatable behavior. So the agent uses a rule-based interpreter with deterministic policies and templates. The cost is coverage: unusual phrasing gets "I'm not sure I understood. Would you like me to pass your message to staff?". That is a safe failure, not a guess. An LLM can be added as another `Interpreter` while the safety screen, tools and templates stay as guardrails. That is next priority 1 below.
- **SQLite through Node's built-in `node:sqlite`** instead of Postgres. There is no server to install and no native build, and it satisfies "SQLite or a JSON file is fine". Repositories keep SQL in one place, so moving to Postgres is contained.
- **NestJS as a thin shell over a framework-free core.** The same core runs the HTTP API, the CLI scripts, the tests and the evals, with no HTTP involved.
- **The scenario clock is frozen by default,** so the script behaves exactly as specified even if the demo is restarted days later. As a side effect, timestamps within a frozen session are equal; message order uses a sequence number, and request updates show through `revision` and the event history. *Running* mode is one click away.
- **Conservative emergency detection.** There is no negation handling, and readings at or above 180/120 count as a possible emergency. A false positive costs one extra safety message. A false negative is a safety failure.
- **The agent asks instead of guessing when a wrong guess would cost a staff follow-up.** One example: "cancel my appointment" when both a pending request and a booked physical exist. For low-cost ambiguity it picks a sensible default and says it back. For example, "Thursday" resolves to the offered Thursday, Nov 12, and the reply says that date so Alex can correct it.
- **The agent offers instead of filing when the FAQ has no answer,** as in step 7. It files a request only when Alex accepts. Action requests such as refills and appointments are filed directly with everything staff need, so Alex is never asked for data the record already has.

## Known limitations

- **Phrasing coverage.** The interpreter is rule-based, not a general language model. On independently written phrasings it fully handled 80% of a final set it had never seen (69 of 86), and 99% after fixing what that set exposed (see [docs/EVALS.md](docs/EVALS.md)). Typos, texting shorthand and some Spanish are handled. Anything unrecognized is offered to staff, never guessed at.
- **Replies are in English only.** Spanish is understood, and the record's language is `en`.
- **One patient and one clinic.** The data is the supplied synthetic data. Every inbound message is trusted as coming from Alex's number on file, per the Phase 1 rules. There is no authentication on the demo UI or API.
- **Slots are not re-checked.** Open slots are the static supplied list, so a slot staff already gave away can still be suggested. Staff confirm availability when they book.
- **Booked appointments come only from the record.** When staff complete a request, the agent relays their note but does not write to the record, by design. A real system would sync with the scheduling system.
- **No outbound notifications.** When staff change a status, Alex is not texted automatically; staff can reply from the thread.

## Next two priorities

1. **An LLM interpreter behind the existing interface, judged by the existing evals.** It would map free text to the same intents through structured output. The deterministic safety screen, tools, templates and request rules stay unchanged as guardrails. The eval suite would then run against it with 3+ runs and pass rates, and the scorecard compared with the rule-based baseline before switching the default.
2. **Close the loop with staff.** When staff mark a request completed or declined, draft the patient notification for staff to approve. Link a completed booking to the record's appointments. Add staff authentication and roles, and move persistence to Postgres for multi-user use.

## Phase 2: Track B (evals)

Track B fits this design: the agent is deterministic, so evals are fast and reproducible and act as a regression suite for every phrasing fix. The method, scoring and the before/after change (Spanish understanding) are described in [docs/EVALS.md](docs/EVALS.md). Generated scorecards are in [docs/EVAL_RESULTS.md](docs/EVAL_RESULTS.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `DB_PATH` | `server/var/sapling.db` | SQLite file. Use `:memory:` for a throwaway run. |
| `DATA_DIR` | `data/` | Folder with the supplied patient record, FAQ and slots. |
| `SCENARIO_NOW` | `2026-11-04T10:00:00` | Default scenario "now", in Pacific time. It can also be changed in the UI or with `PUT /api/settings/clock`. |

## API

| Method and path | Purpose |
|---|---|
| `GET /api/state` | Clinic, patient, settings, conversations and the scenario script. |
| `POST /api/conversations` | Start a conversation. |
| `GET /api/conversations/:id` | Messages and agent runs (traces). |
| `POST /api/conversations/:id/messages` | `{ "from": "clinic" \| "patient", "body": "..." }`. A patient message returns the inbound message, the agent's reply and the run. |
| `GET /api/requests` | All handoffs with their history. Takes an optional `?status=`. |
| `PATCH /api/requests/:id` | Staff: `{ "status": "in_progress", "staff_note": "..." }`. |
| `PUT /api/settings/clock` | `{ "now": "2026-11-07T11:00", "mode": "frozen" }` or `{ "reset": true }`. |
| `GET /api/export` | Every stored record as JSON. |
| `POST /api/admin/reset` | Delete all demo data. |
