import { useCallback, useEffect, useState } from 'react';
import { Composer, type Draft } from './components/Composer';
import { HandoffPanel } from './components/HandoffPanel';
import { Header, type Tab } from './components/Header';
import { Records } from './components/Records';
import { Requirements } from './components/Requirements';
import { Sidebar } from './components/Sidebar';
import { StaffQueue } from './components/StaffQueue';
import { Thread } from './components/Thread';
import * as api from './lib/api';
import type { AppState, HandoffRequest, ThreadResponse } from './types';

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [requests, setRequests] = useState<HandoffRequest[]>([]);
  const [tab, setTab] = useState<Tab>('conversation');
  const [draft, setDraft] = useState<Draft>({ from: 'clinic', text: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const load = useCallback(async (preferred?: string | null) => {
    const s = await api.getState();
    const id = preferred && s.conversations.some((c) => c.id === preferred) ? preferred : (s.conversations.at(-1)?.id ?? null);
    const [t, reqs] = await Promise.all([id ? api.getThread(id) : Promise.resolve(null), api.listRequests()]);
    setState(s);
    setConvId(id);
    setThread(t);
    setRequests(reqs);
    return t;
  }, []);

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    guard(async () => {
      const t = await load(null);
      if (t?.messages.length) setDraft((d) => ({ ...d, from: 'patient' }));
    });
  }, [guard, load]);

  if (!state) return <div className="loading">{error ? `Could not reach the API: ${error}` : 'Loading…'}</div>;

  const conversation = state.conversations.find((c) => c.id === convId);
  const pendingCount = requests.filter((r) => ['pending_staff', 'in_progress'].includes(r.status)).length;

  const send = () =>
    guard(async () => {
      if (!convId) return;
      setBusy(true);
      try {
        await api.sendMessage(convId, draft.from, draft.text);
        // After the clinic's outbound message, the natural next turn is Alex's reply.
        setDraft({ from: 'patient', text: '' });
        await load(convId);
      } finally {
        setBusy(false);
      }
    });

  /** Resets the demo and sends the Phase 1 script one step at a time so the audience can follow along. */
  const playScript = () =>
    guard(async () => {
      if (!window.confirm('Play the Phase 1 script? This resets the demo data first, then sends steps 0–11 one by one.')) return;
      setPlaying(true);
      try {
        await api.resetDemo();
        let t = await load(null);
        const conv = t?.conversation.id;
        if (!conv) return;
        for (const step of state!.script) {
          setDraft({ from: step.from, text: step.text });
          await new Promise((r) => setTimeout(r, 900));
          await api.sendMessage(conv, step.from, step.text);
          t = await load(conv);
          await new Promise((r) => setTimeout(r, 1300));
        }
        setDraft({ from: 'patient', text: '' });
      } finally {
        setPlaying(false);
      }
    });

  const showMessage = (id: string) => {
    const conv = thread?.messages.some((m) => m.id === id) ? convId : null;
    setTab('conversation');
    if (!conv) {
      // The message may live in another conversation (requests are per patient, not per thread).
      guard(async () => {
        for (const c of state.conversations) {
          const t = await api.getThread(c.id);
          if (t.messages.some((m) => m.id === id)) {
            setConvId(c.id);
            setThread(t);
            break;
          }
        }
      });
    }
    setHighlight(id);
    setTimeout(() => setHighlight((h) => (h === id ? null : h)), 2500);
  };

  return (
    <div className="app">
      <Header
        clinicName={state.clinic.name}
        settings={state.settings}
        tab={tab}
        pendingCount={pendingCount}
        onTab={setTab}
        onSetClock={(input) => guard(async () => (await api.setClock(input), await load(convId)))}
        onReset={() =>
          guard(async () => {
            await api.resetDemo();
            setDraft({ from: 'clinic', text: '' });
            await load(null);
          })
        }
      />
      {error && (
        <div className="error-bar" role="alert">
          {error} <button className="link" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {tab === 'conversation' && (
        <main className="layout">
          <Sidebar
            patient={state.patient}
            conversations={state.conversations}
            activeId={convId}
            script={state.script}
            onSelect={(id) => guard(() => load(id))}
            onNew={() =>
              guard(async () => {
                const c = await api.createConversation();
                setDraft({ from: 'patient', text: '' });
                await load(c.id);
              })
            }
            onUseStep={(s) => setDraft({ from: s.from, text: s.text })}
            onPlay={playScript}
            playing={playing}
          />
          <section className="center">
            <div className="thread-head">
              <div>
                <b>{conversation?.id ?? '—'}</b> · SMS thread with {state.patient.name} ({state.patient.phone})
              </div>
              <div className="muted small-text">Clinic number {state.clinic.sms_number} · nothing here is actually sent</div>
            </div>
            <Thread messages={thread?.messages ?? []} runs={thread?.agent_runs ?? []} highlight={highlight} />
            <Composer
              draft={draft}
              busy={busy}
              patientNumber={state.patient.phone}
              clinicNumber={state.clinic.sms_number}
              onChange={setDraft}
              onSend={send}
            />
          </section>
          <HandoffPanel requests={requests} messages={thread?.messages ?? []} onShowMessage={showMessage} />
        </main>
      )}

      {tab === 'staff' && (
        <StaffQueue
          requests={requests}
          onShowMessage={showMessage}
          onUpdate={(id, patch) => guard(async () => (await api.updateRequest(id, patch), await load(convId)))}
        />
      )}

      {tab === 'records' && <Records />}

      {tab === 'requirements' && <Requirements onNavigate={setTab} />}
    </div>
  );
}
