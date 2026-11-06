import { useState } from 'react';
import { fmtDateTime, pretty, STATUS_LABEL, TYPE_LABEL } from '../lib/format';
import { REQUEST_STATUSES, type HandoffRequest, type RequestStatus } from '../types';

interface Props {
  request: HandoffRequest;
  staffActions?: boolean;
  defaultOpen?: boolean;
  onShowMessage?(id: string): void;
  onUpdate?(id: string, patch: { status?: RequestStatus; staff_note?: string | null }): Promise<void>;
}

export function RequestCard({ request: r, staffActions, defaultOpen, onShowMessage, onUpdate }: Props) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [status, setStatus] = useState<RequestStatus>(r.status);
  const [note, setNote] = useState(r.staff_note ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = status !== r.status || note !== (r.staff_note ?? '');

  return (
    <div className={`req ${r.type} ${r.priority} status-${r.status}`}>
      <button className="req-head" onClick={() => setOpen(!open)}>
        <span className={`type-badge ${r.type}`}>{TYPE_LABEL[r.type] ?? r.type}</span>
        <span className="req-id">{r.id}</span>
        <span className={`pill status ${r.status}`}>{STATUS_LABEL[r.status]}</span>
        <span className="caret">{open ? '▾' : '▸'}</span>
      </button>
      <div className="req-summary">{r.summary}</div>
      <div className="req-meta muted">
        rev {r.revision} · created {fmtDateTime(r.created_at)}
        {r.updated_at !== r.created_at ? ` · updated ${fmtDateTime(r.updated_at)}` : ''}
      </div>
      {open && (
        <div className="req-body">
          <table className="details">
            <tbody>
              <tr>
                <th>id / patient_id</th>
                <td>
                  {r.id} / {r.patient_id}
                </td>
              </tr>
              <tr>
                <th>type / status</th>
                <td>
                  {r.type} / {r.status}
                </td>
              </tr>
              {Object.entries(r.details).map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{pretty(v)}</td>
                </tr>
              ))}
              <tr>
                <th>source_message_ids</th>
                <td>
                  {r.source_message_ids.map((id) => (
                    <button key={id} className="chip link" onClick={() => onShowMessage?.(id)}>
                      {id}
                    </button>
                  ))}
                </td>
              </tr>
              <tr>
                <th>created_at / updated_at</th>
                <td>
                  {r.created_at} / {r.updated_at}
                </td>
              </tr>
              {r.staff_note && (
                <tr>
                  <th>staff_note</th>
                  <td>{r.staff_note}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="history">
            <div className="history-title">History</div>
            <ol>
              {r.events.map((e) => (
                <li key={e.id}>
                  <b>{e.kind}</b> by {e.actor}
                  {e.message_id ? ` (from ${e.message_id})` : ''}
                  {e.note ? ` — ${e.note}` : ''}
                  {Object.keys(e.changes).length > 0 && (
                    <ul>
                      {Object.entries(e.changes)
                        .filter(([k]) => !['matching_open_slots', 'patient_flexibility'].includes(k))
                        .map(([k, c]) => (
                          <li key={k} className="muted">
                            {k}: {pretty(c.from)} → {pretty(c.to)}
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
      {staffActions && onUpdate && (
        <form
          className="staff-actions"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            try {
              await onUpdate(r.id, { status, staff_note: note.trim() ? note.trim() : null });
            } finally {
              setSaving(false);
            }
          }}
        >
          <select value={status} onChange={(e) => setStatus(e.target.value as RequestStatus)}>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <input value={note} placeholder="Staff note (the agent can relay it, e.g. “Booked Thu 1:30 p.m.”)" onChange={(e) => setNote(e.target.value)} />
          <button type="submit" disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </div>
  );
}
