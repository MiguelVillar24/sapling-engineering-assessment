import { useEffect, useRef, useState } from 'react';
import { fmtTime, itemChip } from '../lib/format';
import type { AgentRun, Message } from '../types';

interface Props {
  messages: Message[];
  runs: AgentRun[];
  highlight: string | null;
}

const AUTHOR_LABEL: Record<Message['author'], string> = {
  patient: 'Alex (patient)',
  clinic_staff: 'Clinic staff',
  agent: 'Clinic agent (automated)',
};

function snippet(text: string, n = 70): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

export function Thread({ messages, runs, highlight }: Props) {
  const end = useRef<HTMLDivElement>(null);
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const byId = new Map(messages.map((m) => [m.id, m]));

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  useEffect(() => {
    if (highlight) document.getElementById(`msg-${highlight}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlight]);

  if (!messages.length) {
    return (
      <div className="thread empty">
        <p>No messages yet.</p>
        <p className="muted">
          Start as <b>Clinic staff</b> with the step 0 outbound message, or as <b>Alex</b> to have the patient start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div className="thread">
      {messages.map((m) => {
        const replyTo = m.in_reply_to ? byId.get(m.in_reply_to) : undefined;
        const run = m.meta.agent_run_id ? runs.find((r) => r.id === m.meta.agent_run_id) : undefined;
        const side = m.author === 'patient' ? 'left' : 'right';
        return (
          <div key={m.id} id={`msg-${m.id}`} className={`msg ${side} ${m.author} ${highlight === m.id ? 'highlight' : ''}`}>
            <div className="msg-meta">
              <span className="author">{AUTHOR_LABEL[m.author]}</span>
              <span className="muted">
                {m.id} · {fmtTime(m.created_at)}
              </span>
            </div>
            {replyTo && m.author === 'patient' && (
              <div className="reply-to" title={replyTo.body}>
                ↩ reply to {replyTo.id}: “{snippet(replyTo.body)}”
              </div>
            )}
            <div className="bubble">{m.body}</div>
            <div className="chips">
              {m.meta.simulated_sms && <span className="chip muted">simulated · no SMS sent</span>}
              {m.author === 'clinic_staff' && m.meta.expects && (
                <span className="chip info">agent reads this as: {m.meta.expects.kind.replace(/_/g, ' ')}</span>
              )}
              {m.meta.fallback && <span className="chip danger">agent error · nothing filed</span>}
              {(m.meta.items ?? []).map((i, idx) => {
                const c = itemChip(i);
                return (
                  <span key={idx} className={`chip ${c.tone}`}>
                    {c.text}
                  </span>
                );
              })}
              {run && (
                <button className="chip link" onClick={() => setOpenTrace(openTrace === m.id ? null : m.id)}>
                  {openTrace === m.id ? 'hide trace' : 'why?'}
                </button>
              )}
            </div>
            {run && openTrace === m.id && (
              <pre className="trace">
                {JSON.stringify({ run: run.id, mode: run.mode, error: run.error, ...run.trace }, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
