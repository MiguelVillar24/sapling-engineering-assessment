# Design notes

These notes cover how the system meets the brief, how state is modeled and why. For setup and a walkthrough, see the [README](../README.md).

## Requirements and where they are met

| Requirement (Phase 1) | Where | How |
|---|---|---|
| Two-way thread; clinic can initiate; Alex can reply or start a new conversation | `MessagingService`, web composer | Clinic messages are saved and shown with no SMS sent. Patient messages run the agent. **+ New** starts another thread, and requests are per patient, so they follow Alex across threads. |
| Replies matched to earlier messages, including the clinic's | `agent/dialogue.ts`, `Turn.answer` / `Turn.linkTo` | Outbound messages carry an `expects` marker (offer, time question, staff question …). An answer sets `in_reply_to` on the inbound message and marks that question resolved. Changes and status questions link to the agent message about the same request. |
| Context-aware: record, FAQ and full thread on every message | `AgentContext` | Each turn gets the patient record, FAQ, slots, the whole stored thread and all of the patient's requests. |
| Never asks for something already known | Policies | Refills take drug, dose, frequency and pharmacy from the record. The recheck takes its reason and provider from the clinic message and the plan note. Insurance on file is used when Alex says "my insurance". |
| Persistence that survives a restart | `store/*`, SQLite (WAL, `synchronous=FULL`) | Messages, requests, request events, agent runs and settings are stored. Dialogue state is derived from stored messages, never kept in memory. |
| Make the handoff visible | Web UI | Each reply has chips. The right panel has *awaiting staff review*, *answered by the agent* and *not answerable* sections. The staff queue and the Records tab complete the picture. |
| Handoff records staff can act on; a later change updates the same record | `RequestService.amend`, policies | Duplicate checks run before any create: an open recheck, the same medication refill, the same question or an open emergency in the conversation is updated instead. |
| Never book, reschedule, cancel, approve refills or edit the record | `AgentTools` | The agent's only write tools are `createRequest` and `amendRequest`. Status changes are staff-only (`RequestService.setStatus`). The record files are read-only. |
| Local demo mode with no keys | `RuleBasedInterpreter` | Fully deterministic and offline. |
| Never give clinical advice | `policy/clinical.ts`, fixed templates | Clinical intents always become a `clinical_question` handoff. The wording comes from a template, never from generated text. |
| No implied speed, no invented deadline | `REVIEW_NOTE` | The only timing statement is the FAQ's: texts are read during business hours and are not monitored continuously. Tests and evals reject words like "soon" or "within 24 hours". |
| Exact emergency response, logged, with no promise of staff review | `agent/safety.ts`, `PatientAgent.emergency` | The screen runs before any interpretation. The reply is the constant `EMERGENCY_RESPONSE` and nothing else. The emergency handoff records the signals, the message and the response message id. |
| "Now" is a setting | `time/clock.ts` | Persisted in `settings`, frozen by default, and changed through the UI or the API. |

## State model

```
conversations  id, patient_id, channel='sms', patient_number, clinic_number, started_by, created_at, updated_at
messages       id, conversation_id, seq, direction, author(patient|clinic_staff|agent), from/to numbers, body,
               in_reply_to → messages.id, meta(JSON: expects | items | resolves | simulated_sms | agent_run_id), created_at
requests       id, patient_id, conversation_id, type, status, priority, summary, details(JSON), source_message_ids(JSON),
               revision, staff_note, created_at, updated_at
request_events id, request_id, at, actor(agent|staff), kind(created|updated|status_changed|note), message_id, changes(JSON diff), note
agent_runs     id, conversation_id, inbound_message_id, reply_message_id, mode, trace(JSON), error, created_at
settings       key → JSON (scenario clock)
counters       readable ids: conv_001, msg_0001, req_001, run_0001
```

- **Request statuses** are `pending_staff`, `in_progress`, `completed`, `declined` and `cancelled`. Only the first two are *open*. If Alex changes an `in_progress` request, it returns to `pending_staff`, because staff must review the new details. Closed requests cannot be changed by the agent.
- **Types and statuses are validated in code**, through the registry and zod, not by database CHECK constraints. Adding a type therefore needs no migration.
- **Every message knows what it answered.** A patient message stores `in_reply_to` and `resolves`. Each agent reply stores what it did (`items`, shown as the chips) and, when it asked a question, what it expects next (`expects`).

## Agent turn

1. **Persist the inbound message**, in its own commit. A patient's text is never lost, even if the agent fails.
2. **Safety screen.** Deterministic patterns cover chest pain, breathing, stroke signs, numbness, fainting, bleeding, self-harm, overdose, seizures, anaphylaxis, a sudden severe headache, vision loss, and "emergency" or "911", plus a few Spanish phrases. Readings at or above 180/120 also count. A match produces the exact response and an emergency handoff. The turn ends there.
3. **Interpret.** `RuleBasedInterpreter` splits the text into clauses and produces intents: `affirm`, `deny`, `time_preference`, `schedule` (schedule, reschedule or cancel), `withdraw_request`, `request_status`, `next_appointment`, `clinic_hours`, `faq`, `insurance_accepted`, `record_info`, `refill`, `clinical_question`, `billing_question`, `billing_issue`, `talk_to_staff`, `identity` and small talk. Dates and times count as a scheduling preference only outside questions about hours, statuses or symptoms. Farewells and past tense don't count either, so "close today" and "see you Thursday" don't move a request.
4. **Dialogue state.** The open questions are the unanswered `expects` markers in the last 14 messages, newest first. A bare yes or no answers the newest one. A time preference answers the newest *compatible* one, so an Aetna question asked in between does not swallow "Tuesday afternoon".
5. **Policies,** one file per topic, run in a fixed order. Each one reads its intents, may call tools, and adds a paragraph to the reply. One text can therefore be answered on several topics.
6. **Commit.** Request writes, the reply message, the inbound's `in_reply_to`/`resolves` and the agent-run trace commit in **one** transaction. If anything throws, everything from the turn rolls back. The reply then says no request was created, and an emergency still gets the exact text.

Steps 2–3 are the asynchronous, side-effect-free "understand" part. Steps 5–6 are the synchronous "act" part inside the transaction. An LLM interpreter would therefore never hold a database transaction open. Turns are serialized per conversation.

## Scheduling details

- **Resolving a weekday.** A plain weekday such as "Thursday" is resolved in this order, which is how step 3 lands on Thursday, Nov 12 and not tomorrow:
  1. The same weekday among slots the agent already offered in this thread.
  2. The same week as the request being changed ("instead").
  3. The nearest such day that has listed openings. The reply then notes which nearer day was skipped.
  4. The nearest such day.

  "This" and "next", explicit dates, "the 10th", "tomorrow", "next week" and "the week of Jan 18" are supported.
- **Validation.** Past dates, weekends, federal holidays and times outside the FAQ hours are explained, and nothing is filed until a valid preference arrives.
- **Request contents.** A request stores `preferred_date`, `time_window` and an exact `preferred_slot` if Alex picked a listed time. It also stores `matching_open_slots`, so staff can book directly, and `patient_flexibility`, so staff know any matching slot is fine. Clinical context comes from the record's plan note.
- **Changes.** "Thursday instead" keeps the afternoon window. Changing only the window or the time keeps the date. A specific time chosen for the old date is dropped when the date changes.
- **Ambiguous cancels** are clarified. "Cancel that", right after the agent talked about the request, withdraws the request. "Cancel my appointment", when both a request and a booked physical exist, gets a question first.

## Trade-offs considered

| Decision | Alternatives | Why |
|---|---|---|
| Rule-based interpreter with deterministic policies and templates | LLM agent with tool calls | Safety is pass/fail, and the demo must run without keys. Templates guarantee exact wording; an LLM can only be prompted toward it. The interface leaves room for an LLM interpreter later, with the same guardrails. |
| SQLite through `node:sqlite` | Postgres (Sapling's stack), better-sqlite3, JSON file | Zero setup and no native compile. Transactions and SQL keep a Postgres move contained to the repositories. |
| Requests per patient, not per thread | Requests per conversation | Alex can start a new thread and still change the existing request. That avoids duplicates and follow-ups. |
| Offer to pass unknown questions to staff | File them automatically | Required by step 7. It also avoids filling the queue with questions Alex no longer cares about. Action requests are filed directly. |
| Frozen clock by default | Running clock | Reproducible behavior and restarts on later days don't change the script's answers. Running mode exists for realistic timestamps. |
| Conservative emergency rules | Negation and context handling | A missed emergency fails the submission; an extra safety message does not. |
| Withdrawal is a flag (`withdrawn_by_patient`) and stays pending | Agent sets `cancelled` | Only staff change status. Staff may already have acted on the request, for example by booking it. |
