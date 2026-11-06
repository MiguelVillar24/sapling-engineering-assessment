import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EMERGENCY_RESPONSE } from '../src/core/agent/safety.js';
import { firstConversation, patient, runScript, testCore } from './helpers.js';

/** "After a process restart, a reviewer can inspect every record and keep going in the same conversation." */
describe('persistence across a process restart (SQLite file)', () => {
  const dirs: string[] = [];
  const tmpDb = () => {
    const dir = mkdtempSync(join(tmpdir(), 'sapling-test-'));
    dirs.push(dir);
    return join(dir, 'sapling.db');
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('keeps the thread, requests, events and clock, and continues the same conversation after restart', async () => {
    const dbPath = tmpDb();
    const a = testCore({ dbPath });
    await runScript(a, 0, 5);
    a.clock.set({ now: '2026-11-04T10:30:00' });
    const before = a.snapshot();
    a.close();

    const b = testCore({ dbPath }); // "restart"
    const after = b.snapshot();
    expect(after.messages).toEqual(before.messages);
    expect(after.requests).toEqual(before.requests);
    expect(after.conversations).toEqual(before.conversations);
    expect(b.clock.now().toISO()).toBe('2026-11-04T10:30:00.000-08:00');

    // Keep going in the same conversation: status still read from the persisted request.
    const conv = firstConversation(b);
    const status = await patient(b, 'is it booked yet?', conv);
    expect(status.reply.body).toMatch(/Not yet\. .*Thursday, Nov 12, in the afternoon is still pending staff review/);
    const replies = await runScript(b, 6, 11, conv);
    expect(replies.get(11)).toBe(EMERGENCY_RESPONSE);
    expect(b.requests.list().map((r) => r.id)).toEqual(['req_001', 'req_002', 'req_003', 'req_004']);
    // Ids continue after restart (no collisions).
    const ids = b.repos.messages.all().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    b.close();
  });

  it('resumes a half-finished dialogue: restart between "yes" and "Tuesday afternoon works"', async () => {
    const dbPath = tmpDb();
    const a = testCore({ dbPath });
    await runScript(a, 0, 1); // clinic offer + "yes" -> agent asked for a time
    a.close();

    const b = testCore({ dbPath });
    const r = await patient(b, 'Tuesday afternoon works');
    expect(r.reply.body).toContain('Tuesday, Nov 10');
    const [req] = b.requests.list();
    expect(req).toMatchObject({ type: 'appointment_request', details: { reason: 'Blood pressure recheck', preferred_date: '2026-11-10' } });
    expect(req.source_message_ids).toEqual(['msg_0001', 'msg_0002', r.inbound.id]);
    b.close();
  });
});
