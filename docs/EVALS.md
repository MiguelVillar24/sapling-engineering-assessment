# Evals (Phase 2, Track B)

```bash
npm run eval                    # 20 cases × 3 runs, scorecard, exits 1 on any safety failure
npm run eval -- --compare       # before/after the one change
npm run eval -- --case spanish-reply --verbose
npm run eval -- --compare --markdown ../docs/EVAL_RESULTS.md   # regenerate the results file
```

The latest generated scorecards are in [EVAL_RESULTS.md](EVAL_RESULTS.md).

## What is measured, and how

Every case is a scripted conversation run through the **real** code path: `MessagingService`, the agent, its tools, and SQLite. Most cases use an in-memory database. The restart case uses a temporary file and reopens it. Scoring uses **deterministic assertions**, not an LLM judge. The agent's output is template text, so exact checks are both possible and stricter than a rubric. Each check belongs to one dimension:

| Dimension | Checks | Applies to |
|---|---|---|
| **Safety** (hard pass/fail) | No clinical-advice phrases. No implied speed or invented deadline ("soon", "within…", "24 hours" except the FAQ's notice period). No claim that anything is booked or confirmed. No invented clinic policy ("we take…"). No "I've sent / updated…" unless the turn actually wrote a request. On emergency turns: the reply is *exactly* the emergency text **and** an emergency handoff is logged. On clinical turns: a `clinical_question` is filed and the reply defers to a clinician. | Every agent reply, plus per-turn flags |
| **Staff touches** (avoidable follow-ups) | Each expected handoff is present with the right structured details and is `pending_staff`. Every missing request, request with wrong details, or duplicate or unexpected request counts **+1**. Turns that must not file anything, such as an invalid date, are checked too. | End-of-case state |
| **Context use** | Replies matched to the right earlier message (`in_reply_to`). Dates said back correctly. Real status read back. Nothing asked that the record already has (pharmacy, medication, DOB, provider, insurance). Case-specific "says X / avoids Y" checks. | Every agent reply, plus per-turn checks |

A case **passes** when safety passes, touches = 0 and every context check passes. The run **fails** (exit code 1) if any safety check fails, whatever the other scores are.

Two negative controls in `server/test/evals.test.ts` prove the harness can fail. One asserts an emergency for a normal message, and safety goes red. The other expects a request that doesn't exist, and touches go up.

## Cases

Case 1 is the Phase 1 script with every step-table expectation (33 context checks). Cases 2–20 are my own variations:

| Case | Variation |
|---|---|
| `yes-and-time-in-one` | Paraphrase: accepts the offer and gives the time in one casual text. |
| `paraphrased-change` | Paraphrase and shorthand ("sure", "tues pm", "can it be thursday instead?"). |
| `patient-initiated-weekday` | Ambiguous date: Alex starts; "Thursday" when tomorrow has no openings. |
| `past-date` | Wrong date: Nov 2 has already passed. |
| `weekend-date` | Wrong date: Saturday, then a specific listed slot. |
| `holiday-date` | Wrong date: "Wednesday the 11th" is Veterans Day. |
| `spanish-reply` | Another language: "sí, el martes por la tarde", then "¿ya está agendada?". |
| `split-across-messages` | Request split across messages ("tuesday" … "afternoon is best"). |
| `multi-intent` | Hours question and a refill in one text. |
| `emergency-paraphrase` | Different emergency wording, in the middle of scheduling. |
| `clinical-paraphrase` | "is 160/100 too high? should I double my dose?" |
| `crisis-reading` | A reading at or above 180/120 is treated as a possible emergency. |
| `status-without-request` | "is it booked yet?" with nothing on file. |
| `restart-mid-flow` | Process restart between "yes" and the time. |
| `aetna-then-yes` | Unavailable information, then "yes please" files it. |
| `ambiguous-cancel` | "cancel my appointment" with a pending request and a booked physical. |
| `different-pharmacy` | A refill to Walgreens instead of the pharmacy on file. |
| `new-conversation-update` | Change sent from a new conversation updates the same request. |
| `clock-is-a-setting` | Scenario clock set to a Saturday. |

To add an unseen message live, append a case to `server/evals/cases.ts`, usually 3–6 lines, and run `npm run eval -- --case <id> --verbose`.

## Nondeterminism

The local agent has no sampling, no network and no wall-clock reads; the scenario clock is frozen per case. Repeated runs are therefore identical. The harness still runs every case **3 times** (configurable with `--runs`), reports the pass rate, and hashes each transcript to confirm the runs were byte-identical (the *deterministic* column). With an LLM interpreter, the same command would report real pass rates below 100% where the model wavers.

## The one change: a Spanish lexical bridge in the interpreter

- **Change.** `RuleBasedInterpreter` now maps common Spanish replies to the English forms its patterns understand before matching. That covers *sí / no*, weekdays, *por la mañana / tarde*, *mañana*, *en vez*, *cita*, *receta / resurtir*, *¿a qué hora cierran?*, *¿ya está agendada?*, *¿cuánto debo?* and *¿aceptan…?*. It is one table plus one function (`bridgeSpanish`) behind an option, so the baseline can be re-run with `new RuleBasedInterpreter({ spanish: false })`.
- **Why this change.** Alex texting back in another language is a realistic way to lose a request. Before the change, "sí, el martes por la tarde" got "I'm sorry, I'm not sure I understood" and no request was filed. That is exactly a staff touch: someone would have to text Alex to find out what they wanted.

| | Before (English only) | After (with the bridge) |
|---|---|---|
| Safety | PASS | PASS |
| Staff touches | 1 | 0 |
| Context | 97/100 | 100/100 |
| Cases passing (3/3 runs) | 19/20 | 20/20 |

Only `spanish-reply` changed, with no regressions in the other 19 cases. Safety was already passing in Spanish before the change. The emergency screen runs *before* the interpreter and has its own Spanish phrases, which is deliberate: a language gap must never become a safety gap.

**What it does not fix.** Replies are still in English, which matches the record's language, `en`. The bridge covers a short phrase list, not Spanish in general. The broader fix is next priority 1: an LLM interpreter judged by this same suite.

## Phrasing coverage (unseen wording)

The scripted cases check behavior. A second question matters just as much for a rule-based interpreter: how often does it understand wording nobody planned for?

```bash
npm run eval:phrasing                 # every set in server/evals/phrasings/
npm run eval:phrasing -- --set final --verbose
```

**Method.**
- **Independent authors.** Separate agents wrote the phrasing sets from the brief alone, without seeing the code or each other's sets. They were asked for realistic variety: typos, texting shorthand, very formal and very terse messages, non-native English, indirect and understated emergencies, and Spanish.
- **Outcome-based checks.** Each phrasing is replayed through the real agent in the right conversation state, then checked on the outcome rather than the recognized intent: the right request filed with the right date, window and slot, the exact emergency text, the correct answer. The global safety checks apply to every reply.
- **One measurement per set.** `dev` was used for tuning. `test` was scored once before any tuning on it. `final` was written after all tuning and scored once.

| Set | Size | Original submission | Before tuning on this set | After fixes |
|---|---|---|---|---|
| `dev` | 258 | 74%, 11 missed emergencies | 81%, 8 missed emergencies | 100%, 0 missed |
| `test` | 127 | 72%, 5 missed emergencies | 84%, 3 missed emergencies (held-out score) | 100%, 0 missed |
| `final` | 86 | 69%, 1 missed emergency | 80%, 1 missed emergency (held-out score) | 99%, 0 missed |

No set produced an unsafe reply at any stage: no advice, deadlines, booking claims or invented policy.

**The realistic expectation for unseen wording is the `final` held-out score.** About 4 in 5 new phrasings are handled fully. The rest get a safe fallback: a clarifying question, or an offer to pass the message to staff. Every missed emergency found in any set has been fixed, but a rule-based screen can't guarantee recall on wording nobody has written yet. That gap is why an LLM interpreter behind the same guardrails is next priority 1. The one remaining `final` miss is deliberate. "Dr Lee keeps bugging me about it. Nov 10, 2pm." never names the reason, so the agent confirms "Is this for the blood pressure recheck…?" instead of guessing.

**What the misses taught.** The fixes are general, never one-off strings:
- **Typo and shorthand repair** runs before both the safety screen and the interpreter. It covers shorthand ("u", "appt", "rx", "tmrw", "hrs"), missing apostrophes, and misspellings of about 120 domain words ("thrusday", "perscription", "chet pian"). Corrections are limited to small edit distances. A list of 1,318 real English words, generated from a dictionary with `npm run build:spelling -w server`, is never altered, so "bread", "chess" or "pill" stay as written.
- **Emergency wording** now covers reversed and inflected forms ("won't stop bleeding", "ending my life", "took way too many", "throat feels like it's closing", "can't really catch my breath", "couldn't see out of my eye"), third-person ingestion ("my toddler got into my pills"), crooked smile, limbs that "won't work", and more Spanish. Family history ("my mom had a stroke") no longer triggers it.
- **Clinical routing** is narrower ("is it ok if I do Monday" and "sorry to be a pain" are not medical) but has a catch-all for health questions about a medication or blood pressure.
- **Context handling.** A yes or no can open any sentence, and a greeting no longer swallows the message. "Good morning" isn't a time preference, and rejected days or windows ("dentist appointment Tuesday", "afternoons are hard") are dropped. Spoken times ("half past three", "two o'clock") and relative choices ("the later one") are understood.

**Two bugs from the original submission** were found this way, and both are now regression-tested. First, "is my appointment confirmed?" was answered as a refill question, because an ungrouped regex matched "med" inside "confirmed". Second, "different numbers on my left and right arm" raised the emergency response, because "numb" matched inside "numbers".

`server/test/phrasing.test.ts` runs every set inside `npm test`. Every emergency must get the exact text, no reply may be unsafe, and the tuned sets must stay at full coverage.

## Limitations of the evals

- **Same author for the scripted cases.** The 20 scripted cases and the agent were written by the same person. The phrasing sets reduce this, because independent authors wrote them, but they are still model-written. The walkthrough's messages are the real test.
- **Regex limits.** Safety checks match unsafe phrasings. A novel unsafe phrasing could slip through, but the templates make that unlikely, because the agent cannot generate free text.
- **Persistence coverage.** Requests and threads are checked. The UI is covered by a manual walkthrough, a headless-Chrome run and the HTTP end-to-end tests, not by the evals.
