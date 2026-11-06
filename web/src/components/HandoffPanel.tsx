import { sourceLabel } from '../lib/format';
import type { HandoffRequest, Message } from '../types';
import { RequestCard } from './RequestCard';

interface Props {
  requests: HandoffRequest[];
  messages: Message[];
  onShowMessage(id: string): void;
}

const OPEN = ['pending_staff', 'in_progress'];

/** "Make the handoff visible": what the agent answered vs. what is waiting on staff. */
export function HandoffPanel({ requests, messages, onShowMessage }: Props) {
  const emergencies = requests.filter((r) => r.type === 'emergency' && OPEN.includes(r.status));
  const awaiting = requests.filter((r) => r.type !== 'emergency' && OPEN.includes(r.status));
  const closed = requests.filter((r) => !OPEN.includes(r.status));
  const byId = new Map(messages.map((m) => [m.id, m]));

  const unanswerable = messages
    .filter((m) => m.author === 'agent')
    .flatMap((m) =>
      (m.meta.items ?? [])
        .filter((i) => i.kind === 'offered_handoff' || i.kind === 'not_understood')
        .map((i, idx) => ({ key: `${m.id}-u${idx}`, reply: m, item: i, question: m.in_reply_to ? byId.get(m.in_reply_to) : undefined })),
    );

  const answered = messages
    .filter((m) => m.author === 'agent')
    .flatMap((m) =>
      (m.meta.items ?? [])
        .filter((i) => i.kind === 'answered' || i.kind === 'request_status')
        .map((i, idx) => ({ key: `${m.id}-${idx}`, reply: m, item: i, question: m.in_reply_to ? byId.get(m.in_reply_to) : undefined })),
    );

  return (
    <aside className="handoffs">
      {emergencies.length > 0 && (
        <section>
          <h3 className="danger-text">Emergency handoffs ({emergencies.length})</h3>
          <p className="hint">Logged for inspection. The patient got the exact emergency text and was not told staff would review it.</p>
          {emergencies.map((r) => (
            <RequestCard key={r.id} request={r} onShowMessage={onShowMessage} />
          ))}
        </section>
      )}

      <section>
        <h3>Awaiting staff review ({awaiting.length})</h3>
        <p className="hint">Saved as requests, not bookings. The patient was told staff must review them.</p>
        {awaiting.length === 0 && <p className="muted">Nothing waiting on staff.</p>}
        {awaiting.map((r) => (
          <RequestCard key={r.id} request={r} onShowMessage={onShowMessage} />
        ))}
      </section>

      <section>
        <h3>Answered by the agent ({answered.length})</h3>
        <p className="hint">Handled from the patient record, FAQ or stored request status: no staff work needed.</p>
        {answered.length === 0 && <p className="muted">No direct answers yet in this conversation.</p>}
        <ul className="answered">
          {answered.map(({ key, reply, item, question }) => (
            <li key={key}>
              <button className="link" onClick={() => onShowMessage(reply.id)}>
                “{question?.body ?? item.topic}”
              </button>
              <span className="muted">
                {' '}
                → {item.kind === 'request_status' ? `status of ${item.request_id}` : item.topic.replace(/_/g, ' ')}
                {item.source ? ` · ${sourceLabel(item.source)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {unanswerable.length > 0 && (
        <section>
          <h3>Not answerable from the data ({unanswerable.length})</h3>
          <p className="hint">Not covered by the FAQ or record, so the agent did not guess. It offered to pass these to staff; nothing is filed unless Alex says yes.</p>
          <ul className="answered">
            {unanswerable.map(({ key, reply, question }) => (
              <li key={key}>
                <button className="link" onClick={() => onShowMessage(reply.id)}>
                  “{question?.body ?? 'message'}”
                </button>
                <span className="muted"> → offered to ask staff</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {closed.length > 0 && (
        <section>
          <h3>Closed by staff ({closed.length})</h3>
          {closed.map((r) => (
            <RequestCard key={r.id} request={r} onShowMessage={onShowMessage} />
          ))}
        </section>
      )}
    </aside>
  );
}
