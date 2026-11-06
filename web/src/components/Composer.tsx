import { useEffect, useRef } from 'react';

export interface Draft {
  from: 'patient' | 'clinic';
  text: string;
}

interface Props {
  draft: Draft;
  busy: boolean;
  patientNumber: string;
  clinicNumber: string;
  onChange(d: Draft): void;
  onSend(): void;
}

export function Composer({ draft, busy, patientNumber, clinicNumber, onChange, onSend }: Props) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), [draft.from]);

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.text.trim() && !busy) onSend();
      }}
    >
      <div className="composer-top">
        <div className="segmented" role="radiogroup" aria-label="Send as">
          <button type="button" className={draft.from === 'clinic' ? 'active' : ''} onClick={() => onChange({ ...draft, from: 'clinic' })}>
            Clinic staff (outbound)
          </button>
          <button type="button" className={draft.from === 'patient' ? 'active' : ''} onClick={() => onChange({ ...draft, from: 'patient' })}>
            Alex (patient reply)
          </button>
        </div>
        <span className="muted small-text">
          {draft.from === 'patient' ? `from ${patientNumber} (number on file) → clinic` : `from clinic ${clinicNumber} → ${patientNumber} · simulated, not sent`}
        </span>
      </div>
      <div className="composer-row">
        <textarea
          ref={box}
          rows={2}
          value={draft.text}
          placeholder={draft.from === 'patient' ? 'Type Alex’s text…' : 'Type the clinic’s outbound message…'}
          onChange={(e) => onChange({ ...draft, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (draft.text.trim() && !busy) onSend();
            }
          }}
        />
        <button type="submit" disabled={busy || !draft.text.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
