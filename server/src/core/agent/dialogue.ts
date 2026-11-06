import type { OpenSlot } from '../clinic-data/types.js';
import type { Expectation, Message } from '../domain.js';

/**
 * Dialogue state is derived from the persisted thread, not held in memory, so a
 * restart never loses track of what the patient is replying to.
 */

export interface OpenExpectation {
  messageId: string;
  expectation: Expectation;
  author: Message['author'];
  /** How many messages back (0 = the message right before the inbound one). */
  distance: number;
}

/** Unanswered outbound questions/offers, newest first, within a bounded lookback. */
export function openExpectations(thread: Message[], inboundId: string, lookback = 14): OpenExpectation[] {
  const idx = thread.findIndex((m) => m.id === inboundId);
  const prior = idx === -1 ? thread : thread.slice(0, idx);
  const resolved = new Set(prior.filter((m) => m.direction === 'inbound').flatMap((m) => m.meta.resolves ?? []));
  const out: OpenExpectation[] = [];
  for (let i = prior.length - 1, distance = 0; i >= 0 && distance < lookback; i--, distance++) {
    const m = prior[i];
    if (m.direction === 'outbound' && m.meta.expects && !resolved.has(m.id)) {
      out.push({ messageId: m.id, expectation: m.meta.expects, author: m.author, distance });
    }
  }
  return out;
}

/** Every slot the agent has offered in this thread, most recent offer first. */
export function offeredSlots(thread: Message[]): OpenSlot[] {
  const seen = new Set<string>();
  const out: OpenSlot[] = [];
  for (const m of [...thread].reverse()) {
    const e = m.meta.expects;
    if (m.author === 'agent' && e?.kind === 'time_preference') {
      for (const s of e.offered_slots) {
        const key = `${s.date}T${s.start}|${s.provider}`;
        if (!seen.has(key)) (seen.add(key), out.push(s));
      }
    }
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
