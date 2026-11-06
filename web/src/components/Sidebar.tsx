import { fmtDate } from '../lib/format';
import type { Conversation, Patient, ScriptStep } from '../types';

interface Props {
  patient: Patient;
  conversations: Conversation[];
  activeId: string | null;
  script: ScriptStep[];
  onSelect(id: string): void;
  onNew(): void;
  onUseStep(step: ScriptStep): void;
  onPlay(): void;
  playing: boolean;
}

export function Sidebar({ patient, conversations, activeId, script, onSelect, onNew, onUseStep, onPlay, playing }: Props) {
  const med = patient.medications[0];
  const next = patient.upcoming_appointments.find((a) => a.status === 'booked');
  return (
    <aside className="sidebar">
      <section className="card patient">
        <h3>Patient record</h3>
        <div className="patient-name">
          {patient.name} <span className="muted">({patient.patient_id})</span>
        </div>
        <dl>
          <dt>Phone</dt>
          <dd>{patient.phone}</dd>
          <dt>DOB</dt>
          <dd>{patient.date_of_birth}</dd>
          <dt>Conditions</dt>
          <dd>{patient.conditions.join(', ')}</dd>
          <dt>Medication</dt>
          <dd>{med ? `${med.name} ${med.dose}, ${med.frequency} (${med.refills_remaining} refills)` : '—'}</dd>
          <dt>Pharmacy</dt>
          <dd>{patient.pharmacy}</dd>
          <dt>Insurance</dt>
          <dd>
            {patient.insurance.payer} {patient.insurance.plan}
          </dd>
          <dt>Last visit</dt>
          <dd>
            {fmtDate(patient.last_visit.date)}, {patient.last_visit.provider}: “{patient.last_visit.plan_note}”
          </dd>
          <dt>Booked</dt>
          <dd>{next ? `${next.type}, ${fmtDate(next.date)} ${next.time} (${next.provider})` : 'none'}</dd>
          <dt>Balance</dt>
          <dd>
            ${patient.balance.amount.toFixed(2)} ({patient.balance.reason})
          </dd>
        </dl>
        <p className="hint">Read-only supplied data. The agent never edits the record.</p>
      </section>

      <section className="card">
        <div className="row-between">
          <h3>Conversations</h3>
          <button className="small" onClick={onNew} title="Either side can start a new conversation">
            + New
          </button>
        </div>
        <ul className="conv-list">
          {conversations.map((c) => (
            <li key={c.id}>
              <button className={c.id === activeId ? 'active' : ''} onClick={() => onSelect(c.id)}>
                <span>{c.id}</span>
                <span className="muted">{c.started_by ? `started by ${c.started_by}` : 'empty'}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card script">
        <div className="row-between">
          <h3>Phase 1 script</h3>
          <button className="small" onClick={onPlay} disabled={playing} title="Resets the demo, then sends steps 0–11 one by one">
            {playing ? 'Playing…' : '▶ Play all steps'}
          </button>
        </div>
        <p className="hint">Click a step to put it in the composer (you still press Send), or play the whole script.</p>
        <ol>
          {script.map((s) => (
            <li key={s.step}>
              <button className="script-step" onClick={() => onUseStep(s)} title={`Expected: ${s.expected}`}>
                <span className={`who ${s.from}`}>{s.step}</span>
                <span className="script-text">{s.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
