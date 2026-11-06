import { describe, expect, it, vi } from 'vitest';
import type { Interpreter } from '../src/core/agent/interpreter.js';
import { EMERGENCY_RESPONSE } from '../src/core/agent/safety.js';
import { NotFoundError, ValidationError } from '../src/core/messaging/messaging-service.js';
import { clinic, CLINIC_OFFER, firstConversation, patient, testCore } from './helpers.js';

describe('failure handling: never claim a request was saved when it was not', () => {
  it('if saving the request fails, the turn rolls back and the reply says no request was created', async () => {
    const core = testCore();
    vi.spyOn(core.repos.requests, 'insert').mockImplementation(() => {
      throw new Error('disk full');
    });
    const r = await patient(core, 'can I get a refill on my BP med');
    expect(r.reply.body).toMatch(/couldn't process your message, so no request was created/);
    expect(r.reply.body).not.toMatch(/I've sent|pending staff review/);
    expect(r.reply.meta.fallback).toBe(true);
    expect(r.run.error).toMatch(/disk full/);
    expect(core.requests.list()).toEqual([]);
    // The patient's own message is never lost.
    expect(core.messaging.thread(firstConversation(core)).map((m) => m.body)).toContain('can I get a refill on my BP med');
  });

  it('if an update fails half-way, nothing from that turn is persisted (atomic turn)', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    await patient(core, 'yes');
    await patient(core, 'Tuesday afternoon works');
    const before = core.requests.list();
    vi.spyOn(core.repos.events, 'insert').mockImplementation(() => {
      throw new Error('event log unavailable');
    });
    const r = await patient(core, 'actually can we do Thursday instead');
    expect(r.reply.meta.fallback).toBe(true);
    expect(core.requests.list()).toEqual(before); // still Tuesday, revision 1
  });

  it('an emergency still gets the exact emergency text even if logging the handoff fails', async () => {
    const core = testCore();
    vi.spyOn(core.repos.requests, 'insert').mockImplementation(() => {
      throw new Error('db locked');
    });
    const r = await patient(core, 'I have chest pain and my left arm feels numb');
    expect(r.reply.body).toBe(EMERGENCY_RESPONSE);
    expect(r.run.error).toMatch(/db locked/);
  });

  it('an interpreter crash falls back safely', async () => {
    const broken: Interpreter = {
      name: 'broken',
      interpret: () => {
        throw new Error('model unavailable');
      },
    };
    const core = testCore({ interpreter: broken });
    const r = await patient(core, 'what time do you close today?');
    expect(r.reply.meta.fallback).toBe(true);
    expect(r.run).toMatchObject({ mode: 'broken', error: 'model unavailable' });
  });

  it('rejects empty/oversized messages and unknown conversations', async () => {
    const core = testCore();
    await expect(patient(core, '   ')).rejects.toBeInstanceOf(ValidationError);
    await expect(patient(core, 'x'.repeat(2000))).rejects.toBeInstanceOf(ValidationError);
    await expect(core.messaging.receivePatientMessage('conv_404', 'hi')).rejects.toBeInstanceOf(NotFoundError);
    expect(() => core.messaging.sendClinicMessage('conv_404', 'hi')).toThrow(NotFoundError);
  });

  it('processes messages in one conversation strictly in order', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    const [a, b] = await Promise.all([patient(core, 'yes'), patient(core, 'Tuesday afternoon works')]);
    expect(a.reply.body).toMatch(/these openings/);
    expect(b.reply.body).toContain('Tuesday, Nov 10');
    expect(core.requests.list()).toHaveLength(1);
  });
});
