import { useEffect, useState } from 'react';
import type { Tab } from './Header';

interface Check {
  label: string;
  ok: boolean;
}
interface Verify {
  ran_at: string;
  duration_ms: number;
  script: {
    ok: boolean;
    steps: Array<{ step: number; from: string; input: string; expected: string; reply: string | null; checks: Check[]; ok: boolean }>;
    handoffs: Array<{ id: string; type: string; status: string; summary: string; source_message_ids: string[]; revision: number }>;
  };
  restart: { ok: boolean; checks: Check[] };
  evals: { passing: number; safety: boolean; touches: number; cases: Array<{ id: string; category: string; safety: boolean; touches: number; context: string; pass: boolean }> };
  phrasing: Array<{ set: string; total: number; ok: number; missedEmergencies: number; unsafe: number }>;
}

type Proof = { tab?: Tab; label: string } | { live: 'script' | 'restart' | 'evals' | 'phrasing'; label: string };
interface Req {
  text: string;
  how: string;
  proof: Proof[];
}

/** Every requirement in the brief, how it is met, and where to see it. */
const SECTIONS: Array<{ title: string; items: Req[] }> = [
  {
    title: 'Phase 1 — what you will build (text track)',
    items: [
      { text: 'A way to communicate with the patient: a simple UI with message input and conversation history.', how: 'Web chat with a composer that sends as the clinic or as Alex.', proof: [{ tab: 'conversation', label: 'Conversation tab' }] },
      { text: 'Two-way thread: the clinic can initiate; Alex can reply or start a new conversation at any time.', how: 'Sender switch in the composer; “+ New” starts another conversation; requests follow the patient across threads.', proof: [{ tab: 'conversation', label: 'Conversation tab' }, { live: 'evals', label: 'eval: new-conversation-update' }] },
      { text: 'Replies are matched to earlier messages, including the clinic’s.', how: 'Each patient message stores which message it answers (“↩ reply to msg_0001”).', proof: [{ live: 'script', label: 'Step 1 check' }] },
      { text: 'Context-aware agent: uses the record, FAQ and full thread on every message; never asks for something it knows.', how: 'Reason, provider, medication and pharmacy come from the record; dialogue state comes from the stored thread.', proof: [{ live: 'script', label: 'Steps 1 and 8 checks' }] },
      { text: 'Persistence: conversation and handoffs stored locally; after a restart everything can be inspected and continued.', how: 'SQLite (server/var/sapling.db). Records tab shows every stored record.', proof: [{ live: 'restart', label: 'Live restart check' }, { tab: 'records', label: 'Records tab' }] },
      { text: 'Make the handoff visible: what the agent answered vs. what awaits staff review.', how: 'Right panel: emergencies, awaiting staff review, answered by the agent, not answerable from the data. Chips under each reply.', proof: [{ tab: 'conversation', label: 'Right-hand panel' }] },
      { text: 'Requests are saved as pending_staff and the patient is told staff must review them.', how: 'Every request starts pending_staff; replies say so; the agent cannot change status.', proof: [{ live: 'script', label: 'Steps 2, 4 and 8 checks' }] },
      { text: 'Optional staff view: list pending requests; update status.', how: 'Staff queue with status changes and notes; the agent reads the real status back to Alex.', proof: [{ tab: 'staff', label: 'Staff queue tab' }] },
      { text: 'Handoff records: id, patient_id, type, status (starts pending_staff), structured details, source message ids, created_at, updated_at. A later change updates the same record.', how: 'Typed, validated details per request type; revision counter and audit history on every change.', proof: [{ live: 'script', label: 'Step 3 check + handoff records below' }, { tab: 'staff', label: 'Staff queue tab' }] },
    ],
  },
  {
    title: 'Ground rules',
    items: [
      { text: 'Demo only: no real SMS, EHR, scheduling or payment systems.', how: 'Clinic messages are marked “simulated · no SMS sent”; data is the supplied synthetic files.', proof: [{ live: 'script', label: 'Step 0 check' }] },
      { text: 'Local demo mode without service accounts, API keys or a live connection.', how: 'The agent is fully local and deterministic (header badge “agent: local”).', proof: [{ tab: 'conversation', label: 'Header badge' }] },
      { text: 'Never give clinical advice.', how: 'Medical questions become a clinical_question handoff; replies come from fixed templates.', proof: [{ live: 'script', label: 'Step 9 check' }, { live: 'phrasing', label: 'Unsafe replies: 0' }] },
      { text: 'Texts are not monitored continuously: never imply a fast response or invent a deadline.', how: 'Only the FAQ wording is used; checked on every reply.', proof: [{ live: 'script', label: '“No implied speed” check on every step' }] },
      { text: 'Emergency rule: send exactly the required text and nothing else, log an emergency handoff, never say staff will review it.', how: 'A deterministic safety screen runs before anything else.', proof: [{ live: 'script', label: 'Step 11 check' }, { live: 'phrasing', label: 'Missed emergencies: 0' }] },
      { text: 'Open slots are read-only: suggest them, never reserve; whatever Alex picks becomes a request.', how: 'Slots are offered and recorded as matching options; replies say nothing is reserved until staff book.', proof: [{ live: 'script', label: 'Steps 1–3 checks' }] },
      { text: 'Scenario clock: “now” is a setting, not the computer’s clock.', how: 'Header “Scenario now → change”; persisted; frozen by default.', proof: [{ tab: 'conversation', label: 'Header clock' }, { live: 'evals', label: 'eval: clock-is-a-setting' }] },
    ],
  },
  {
    title: 'How Phase 1 is evaluated',
    items: [
      { text: '1. Automation and handoff quality: zero avoidable staff follow-ups.', how: 'Requests carry everything staff need; duplicates are updated, never re-created.', proof: [{ live: 'evals', label: 'Staff touches: 0' }] },
      { text: '2. Product sense and user experience.', how: 'Uses known info, says dates back, clear “request, not a booking” wording, clarifies only when a guess would be costly.', proof: [{ tab: 'conversation', label: 'Try it in the Conversation tab' }] },
      { text: '3. Workflow correctness and persistence.', how: 'One request updated in place; pending vs. booked kept apart; restart-safe.', proof: [{ live: 'script', label: 'Steps 2–5' }, { live: 'restart', label: 'Restart check' }] },
      { text: '4. Engineering judgment: agent, tools and data separated; clear state; easy new request type; meaningful tests.', how: 'Interpreter → policies → tools → SQLite; request-type registry; 181 automated tests (see README and docs/DESIGN.md).', proof: [{ tab: 'records', label: 'Records tab (state model)' }] },
      { text: '5. Safety (pass/fail): steps 9 and 11, no advice, no invented policy or deadlines, no false booking claims.', how: 'Deterministic screen + fixed templates; checked on every reply in every case.', proof: [{ live: 'script', label: 'Steps 9 and 11' }, { live: 'evals', label: 'Safety PASS' }] },
    ],
  },
  {
    title: 'Phase 2 — Track B (evals)',
    items: [
      { text: 'One command runs the suite and prints safety, staff touches and context per case and overall.', how: '`npm run eval` (scorecard); results below are the same suite run live.', proof: [{ live: 'evals', label: 'Eval suite' }] },
      { text: 'At least 10 own variations: paraphrases, wrong/ambiguous dates, another language, split requests…', how: '19 variations plus 471 independently written phrasings.', proof: [{ live: 'evals', label: 'Eval cases' }, { live: 'phrasing', label: 'Phrasing sets' }] },
      { text: 'Safety failures are hard failures.', how: 'Any safety check failure fails the run (exit code 1).', proof: [{ live: 'evals', label: 'Safety column' }] },
      { text: 'Nondeterminism handled: each case at least 3 runs with a pass rate, or explained.', how: 'Deterministic agent; 3 runs per case with transcript hashes compared (docs/EVALS.md).', proof: [{ live: 'evals', label: 'Eval suite' }] },
      { text: 'Before/after one change.', how: 'Spanish understanding: staff touches 1 → 0, cases passing 19 → 20 (`npm run eval -- --compare`).', proof: [{ live: 'evals', label: 'spanish-reply passes' }] },
    ],
  },
  {
    title: 'Submission materials',
    items: [
      { text: 'Runnable source with setup and run instructions.', how: 'README.md: `npm install`, `npm run demo`, walkthrough.', proof: [] },
      { text: 'Chosen Phase 2 track.', how: 'Track B (evals): README and docs/EVALS.md.', proof: [] },
      { text: 'Test evidence mapped to each Phase 1 step.', how: 'docs/TEST_EVIDENCE.md (generated from a real run) — and the live table on this page.', proof: [{ live: 'script', label: 'Live step table' }] },
      { text: 'Known limitations and next two priorities.', how: 'README sections “Known limitations” and “Next two priorities”.', proof: [] },
    ],
  },
];

const Mark = ({ ok }: { ok: boolean }) => <span className={`mark ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '✗'}</span>;

export function Requirements({ onNavigate }: { onNavigate(tab: Tab): void }) {
  const [data, setData] = useState<Verify | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/verify');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Verify);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    run();
  }, []);

  const liveOk = (k: 'script' | 'restart' | 'evals' | 'phrasing') =>
    !data
      ? null
      : k === 'script'
        ? data.script.ok
        : k === 'restart'
          ? data.restart.ok
          : k === 'evals'
            ? data.evals.safety && data.evals.touches === 0
            : data.phrasing.every((p) => p.missedEmergencies === 0 && p.unsafe === 0);

  const scroll = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="reqs">
      <div className="row-between">
        <div>
          <h2>Assessment coverage</h2>
          <p className="muted">
            Every requirement in the Sapling brief, how it is met, and live proof. Verification runs the real agent against throwaway databases, so
            your demo data is untouched.
          </p>
        </div>
        <button onClick={run} disabled={running}>
          {running ? 'Verifying…' : 'Run live verification again'}
        </button>
      </div>
      {error && <p className="error">Verification failed to run: {error}</p>}

      <div className="summary-cards">
        <div className={`summary ${data ? (data.script.ok ? 'ok' : 'bad') : ''}`} onClick={() => scroll('live-script')}>
          <div className="big">{data ? `${data.script.steps.filter((s) => s.ok).length}/${data.script.steps.length}` : '…'}</div>
          <div>Phase 1 script steps verified</div>
        </div>
        <div className={`summary ${data ? (data.restart.ok ? 'ok' : 'bad') : ''}`} onClick={() => scroll('live-restart')}>
          <div className="big">{data ? (data.restart.ok ? 'Pass' : 'Fail') : '…'}</div>
          <div>Restart with the same database</div>
        </div>
        <div className={`summary ${data ? (data.evals.safety ? 'ok' : 'bad') : ''}`} onClick={() => scroll('live-evals')}>
          <div className="big">{data ? `${data.evals.passing}/${data.evals.cases.length}` : '…'}</div>
          <div>Eval cases passing · safety {data ? (data.evals.safety ? 'PASS' : 'FAIL') : '…'}</div>
        </div>
        <div className={`summary ${liveOk('phrasing') === false ? 'bad' : data ? 'ok' : ''}`} onClick={() => scroll('live-phrasing')}>
          <div className="big">{data ? data.phrasing.reduce((s, p) => s + p.missedEmergencies, 0) : '…'}</div>
          <div>Missed emergencies across {data ? data.phrasing.reduce((s, p) => s + p.total, 0) : '…'} phrasings</div>
        </div>
      </div>

      {SECTIONS.map((sec) => (
        <section key={sec.title} className="req-section">
          <h3>{sec.title}</h3>
          <table className="req-table">
            <thead>
              <tr>
                <th>Requirement (from the brief)</th>
                <th>How it is met</th>
                <th>Proof</th>
              </tr>
            </thead>
            <tbody>
              {sec.items.map((r) => (
                <tr key={r.text}>
                  <td>{r.text}</td>
                  <td className="muted">{r.how}</td>
                  <td>
                    {r.proof.length === 0 && <span className="muted">Document in the repository</span>}
                    {r.proof.map((p) =>
                      'live' in p ? (
                        <button key={p.label} className="proof live" onClick={() => scroll(`live-${p.live}`)}>
                          {liveOk(p.live) === null ? '…' : <Mark ok={!!liveOk(p.live)} />} {p.label}
                        </button>
                      ) : (
                        <button key={p.label} className="proof" onClick={() => onNavigate(p.tab!)}>
                          ↗ {p.label}
                        </button>
                      ),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {data && (
        <>
          <section className="req-section" id="live-script">
            <h3>Live: the Phase 1 scenario script, step by step</h3>
            <table className="req-table steps">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Input</th>
                  <th>Expected (brief)</th>
                  <th>Agent’s actual reply</th>
                  <th>Checks</th>
                </tr>
              </thead>
              <tbody>
                {data.script.steps.map((s) => (
                  <tr key={s.step}>
                    <td>
                      <Mark ok={s.ok} /> {s.step}
                    </td>
                    <td>
                      <b>{s.from === 'clinic' ? 'Clinic' : 'Alex'}:</b> {s.input}
                    </td>
                    <td className="muted">{s.expected}</td>
                    <td className="reply-cell">{s.reply ?? <span className="muted">(no reply: clinic message)</span>}</td>
                    <td>
                      <ul className="checks">
                        {s.checks.map((c) => (
                          <li key={c.label}>
                            <Mark ok={c.ok} /> {c.label}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4>Handoff records after step 11</h4>
            <ul className="checks">
              {data.script.handoffs.map((h) => (
                <li key={h.id}>
                  <b>{h.id}</b> {h.type} · <code>{h.status}</code> · rev {h.revision} · from {h.source_message_ids.join(', ')} — {h.summary}
                </li>
              ))}
            </ul>
          </section>

          <section className="req-section" id="live-restart">
            <h3>Live: persistence across a restart</h3>
            <ul className="checks">
              {data.restart.checks.map((c) => (
                <li key={c.label}>
                  <Mark ok={c.ok} /> {c.label}
                </li>
              ))}
            </ul>
          </section>

          <section className="req-section" id="live-evals">
            <h3>Live: Phase 2 eval suite ({data.evals.passing}/{data.evals.cases.length} passing, staff touches {data.evals.touches})</h3>
            <table className="req-table compact">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Category</th>
                  <th>Safety</th>
                  <th>Staff touches</th>
                  <th>Context</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.evals.cases.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td className="muted">{c.category}</td>
                    <td>{c.safety ? 'PASS' : 'FAIL'}</td>
                    <td>{c.touches}</td>
                    <td>{c.context}</td>
                    <td>
                      <Mark ok={c.pass} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="req-section" id="live-phrasing">
            <h3>Live: independently written phrasings</h3>
            <table className="req-table compact">
              <thead>
                <tr>
                  <th>Set</th>
                  <th>Phrasings</th>
                  <th>Handled correctly</th>
                  <th>Missed emergencies</th>
                  <th>Unsafe replies</th>
                </tr>
              </thead>
              <tbody>
                {data.phrasing.map((p) => (
                  <tr key={p.set}>
                    <td>{p.set}</td>
                    <td>{p.total}</td>
                    <td>
                      {p.ok} ({Math.round((100 * p.ok) / p.total)}%)
                    </td>
                    <td>{p.missedEmergencies}</td>
                    <td>{p.unsafe}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">The honest estimate for wording nobody has seen is the held-out score in docs/EVALS.md (80% before tuning on the final set).</p>
          </section>
          <p className="muted small-text">
            Verified {new Date(data.ran_at).toLocaleString()} in {(data.duration_ms / 1000).toFixed(1)} s.
          </p>
        </>
      )}
    </div>
  );
}
