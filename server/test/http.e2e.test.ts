import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/create-core.js';
import { AppModule } from '../src/http/app.module.js';
import { CLINIC_OFFER, testCore } from './helpers.js';

describe('HTTP API (NestJS)', () => {
  let app: INestApplication;
  let core: Core;

  beforeAll(async () => {
    core = testCore();
    const mod = await Test.createTestingModule({ imports: [AppModule.register(core)] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    core.close();
  });

  const http = () => request(app.getHttpServer());

  it('GET /api/state returns clinic, patient, settings and a ready conversation', async () => {
    const res = await http().get('/api/state').expect(200);
    expect(res.body.clinic.name).toBe('Sapling Family Clinic');
    expect(res.body.settings).toMatchObject({ agent_mode: 'rules', clock: { now: '2026-11-04T10:00:00.000-08:00', mode: 'frozen' } });
    expect(res.body.conversations).toHaveLength(1);
  });

  it('clinic outbound then patient reply, persisted and linked', async () => {
    const conv = 'conv_001';
    const c = await http().post(`/api/conversations/${conv}/messages`).send({ from: 'clinic', body: CLINIC_OFFER }).expect(201);
    expect(c.body.message.meta.simulated_sms).toBe(true);
    const p = await http().post(`/api/conversations/${conv}/messages`).send({ from: 'patient', body: 'yes' }).expect(201);
    expect(p.body.inbound.in_reply_to).toBe(c.body.message.id);
    expect(p.body.reply.author).toBe('agent');
    await http().post(`/api/conversations/${conv}/messages`).send({ from: 'patient', body: 'Tuesday afternoon works' }).expect(201);
    const thread = await http().get(`/api/conversations/${conv}`).expect(200);
    expect(thread.body.messages).toHaveLength(5);
    expect(thread.body.agent_runs).toHaveLength(2);
  });

  it('lists requests with their audit events; staff can update status and note', async () => {
    const list = await http().get('/api/requests').expect(200);
    expect(list.body).toHaveLength(1);
    const id = list.body[0].id;
    expect(list.body[0].events[0].kind).toBe('created');
    const upd = await http().patch(`/api/requests/${id}`).send({ status: 'in_progress', staff_note: 'Calling to book' }).expect(200);
    expect(upd.body).toMatchObject({ status: 'in_progress', staff_note: 'Calling to book' });
    await http().get('/api/requests?status=pending_staff').expect(200).expect((r) => expect(r.body).toHaveLength(0));
  });

  it('validates input and maps errors to status codes', async () => {
    await http().post('/api/conversations/conv_001/messages').send({ from: 'patient', body: '' }).expect(400);
    await http().post('/api/conversations/conv_001/messages').send({ from: 'robot', body: 'hi' }).expect(400);
    await http().post('/api/conversations/conv_404/messages').send({ from: 'patient', body: 'hi' }).expect(404);
    await http().patch('/api/requests/req_001').send({ status: 'booked' }).expect(400);
    await http().patch('/api/requests/req_404').send({ status: 'completed' }).expect(404);
    await http().get('/api/requests/req_404').expect(404);
  });

  it('the scenario clock can be changed and reset over HTTP', async () => {
    const set = await http().put('/api/settings/clock').send({ now: '2026-11-07T11:00:00' }).expect(200);
    expect(set.body.clock.now).toBe('2026-11-07T11:00:00.000-08:00');
    const reply = await http().post('/api/conversations/conv_001/messages').send({ from: 'patient', body: 'are you open today?' }).expect(201);
    expect(reply.body.reply.body).toMatch(/closed today \(Saturday\)/);
    const reset = await http().put('/api/settings/clock').send({ reset: true }).expect(200);
    expect(reset.body.clock.now).toBe('2026-11-04T10:00:00.000-08:00');
    await http().put('/api/settings/clock').send({ now: 'not a date' }).expect(400);
  });

  it('export returns every record; reset wipes the demo', async () => {
    const snap = await http().get('/api/export').expect(200);
    expect(snap.body.messages.length).toBeGreaterThan(0);
    expect(snap.body.requests[0].events.length).toBeGreaterThan(0);
    await http().post('/api/admin/reset').expect(200);
    const after = await http().get('/api/export').expect(200);
    expect(after.body.messages).toEqual([]);
    expect(after.body.conversations).toHaveLength(1);
  });
});
