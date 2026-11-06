import { useState } from 'react';
import { fmtDateTime, toClinicLocalInput } from '../lib/format';
import type { Settings } from '../types';

export type Tab = 'conversation' | 'staff' | 'records';

interface Props {
  clinicName: string;
  settings: Settings;
  tab: Tab;
  pendingCount: number;
  onTab(tab: Tab): void;
  onSetClock(input: { now?: string; mode?: 'frozen' | 'running'; reset?: boolean }): Promise<void>;
  onReset(): Promise<void>;
}

export function Header({ clinicName, settings, tab, pendingCount, onTab, onSetClock, onReset }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(toClinicLocalInput(settings.clock.now));
  const [mode, setMode] = useState(settings.clock.mode);

  const open = () => {
    setValue(toClinicLocalInput(settings.clock.now));
    setMode(settings.clock.mode);
    setEditing(true);
  };

  return (
    <header className="header">
      <div className="brand">
        <span className="logo">🌱</span>
        <div>
          <div className="brand-name">{clinicName}</div>
          <div className="brand-sub">Two-way patient texting · local demo (no real SMS is sent)</div>
        </div>
      </div>

      <nav className="tabs">
        <button className={tab === 'conversation' ? 'active' : ''} onClick={() => onTab('conversation')}>
          Conversation
        </button>
        <button className={tab === 'staff' ? 'active' : ''} onClick={() => onTab('staff')}>
          Staff queue {pendingCount > 0 && <span className="count">{pendingCount}</span>}
        </button>
        <button className={tab === 'records' ? 'active' : ''} onClick={() => onTab('records')}>
          Records
        </button>
      </nav>

      <div className="header-right">
        <div className="clock" title="Scenario clock: the agent's notion of 'now' (a setting, not the computer clock)">
          {!editing ? (
            <>
              <span className="clock-label">Scenario now</span>
              <span className="clock-value">{fmtDateTime(settings.clock.now)}</span>
              <span className={`pill ${settings.clock.mode === 'frozen' ? 'muted' : 'info'}`}>{settings.clock.mode}</span>
              <button className="link" onClick={open}>
                change
              </button>
            </>
          ) : (
            <form
              className="clock-form"
              onSubmit={async (e) => {
                e.preventDefault();
                await onSetClock({ now: value, mode });
                setEditing(false);
              }}
            >
              <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} required />
              <span className="tz">Pacific</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'frozen' | 'running')}>
                <option value="frozen">frozen</option>
                <option value="running">running</option>
              </select>
              <button type="submit">Apply</button>
              <button
                type="button"
                className="secondary"
                onClick={async () => {
                  await onSetClock({ reset: true });
                  setEditing(false);
                }}
              >
                Scenario start
              </button>
              <button type="button" className="link" onClick={() => setEditing(false)}>
                cancel
              </button>
            </form>
          )}
        </div>
        <span className="pill ok" title="Deterministic local agent: no API keys, no network">
          agent: {settings.agent_mode === 'rules' ? 'local (rule-based)' : settings.agent_mode}
        </span>
        <button
          className="danger-outline"
          onClick={async () => {
            if (window.confirm('Delete all conversations, messages and requests and start the demo over?')) await onReset();
          }}
        >
          Reset demo
        </button>
      </div>
    </header>
  );
}
