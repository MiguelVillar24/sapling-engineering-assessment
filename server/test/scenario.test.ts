import { beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/create-core.js';
import type { Message } from '../src/core/domain.js';
import { EMERGENCY_RESPONSE } from '../src/core/agent/safety.js';
import { PHASE1_SCRIPT } from '../src/scenario.js';
import { ADVICE, BOOKED_CLAIM, TIMELINE, firstConversation, testCore } from './helpers.js';

/**
 * The Phase 1 acceptance script, run in order in one conversation (steps 0–11).
 * Each `it` maps to one row of the step table in the brief.
 */
describe('Phase 1 scenario script (single conversation)', () => {
  let core: Core;
  let conv: string;
  const msgs: Record<number, { inbound?: Message; reply?: Message; clinic?: Message }> = {};

  const send = async (step: number) => {
    const s = PHASE1_SCRIPT[step];
    if (s.from === 'clinic') msgs[step] = { clinic: core.messaging.sendClinicMessage(conv, s.text) };
    else {
      const r = await core.messaging.receivePatientMessage(conv, s.text);
      msgs[step] = { inbound: r.inbound, reply: r.reply };
    }
    return msgs[step];
  };
  const appointmentRequests = () => core.requests.list().filter((r) => r.type === 'appointment_request');

  beforeAll(() => {
    core = testCore();
    conv = firstConversation(core);
  });

  it('step 0: clinic outbound is displayed and saved locally; nothing is sent; no agent reply', async () => {
    const { clinic } = await send(0);
    expect(clinic!.author).toBe('clinic_staff');
    expect(clinic!.meta.simulated_sms).toBe(true);
    expect(clinic!.meta.expects).toMatchObject({ kind: 'appointment_offer', flow: { reason: 'Blood pressure recheck', provider: 'Dr. Priya Lee' } });
    expect(core.messaging.thread(conv)).toHaveLength(1);
    expect(core.requests.list()).toHaveLength(0);
  });

  it('step 1: "yes" is matched to message 0; asks when (suggesting real open slots); does not ask the reason', async () => {
    const { inbound, reply } = await send(1);
    expect(inbound!.in_reply_to).toBe(msgs[0].clinic!.id);
    expect(reply!.body).toMatch(/Tuesday, Nov 10 at 2:00 or 3:30 p\.m\./);
    expect(reply!.body).toMatch(/Thursday, Nov 12 at 1:30 or 4:00 p\.m\./);
    expect(reply!.body).toMatch(/which day and time/i);
    expect(reply!.body).not.toMatch(/\b(reason|what is the visit for|what.*for\?)/i);
    expect(core.requests.list()).toHaveLength(0);
  });

  it('step 2: resolves Tuesday afternoon to Tue Nov 10, says the date back, creates ONE pending appointment_request', async () => {
    const { inbound, reply } = await send(2);
    expect(inbound!.in_reply_to).toBe(msgs[1].reply!.id);
    expect(reply!.body).toContain('Tuesday, Nov 10');
    expect(reply!.body).toMatch(/pending review by clinic staff/);
    expect(reply!.body).not.toMatch(BOOKED_CLAIM);
    const reqs = appointmentRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      status: 'pending_staff',
      patient_id: 'pt_001',
      details: {
        action: 'schedule',
        reason: 'Blood pressure recheck',
        provider: 'Dr. Priya Lee',
        preferred_date: '2026-11-10',
        time_window: { label: 'afternoon', start: '12:00', end: '17:00' },
        preferred_slot: null,
      },
    });
    expect((reqs[0].details.matching_open_slots as Array<{ start: string }>).map((s) => s.start)).toEqual(['14:00', '15:30']);
    expect(reqs[0].source_message_ids).toEqual([msgs[0].clinic!.id, msgs[1].inbound!.id, msgs[2].inbound!.id]);
  });

  it('step 3: "Thursday instead" updates the SAME request to Thu Nov 12, keeping the afternoon window', async () => {
    const before = appointmentRequests()[0];
    const { reply } = await send(3);
    const reqs = appointmentRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].id).toBe(before.id);
    expect(reqs[0].revision).toBe(before.revision + 1);
    expect(reqs[0].status).toBe('pending_staff');
    expect(reqs[0].details).toMatchObject({ preferred_date: '2026-11-12', time_window: { label: 'afternoon' } });
    expect(reqs[0].source_message_ids).toContain(msgs[3].inbound!.id);
    expect(reply!.body).toContain('Thursday, Nov 12');
    expect(reply!.body).toMatch(/still pending staff review/);
    const events = core.requests.events(reqs[0].id);
    expect(events.map((e) => e.kind)).toEqual(['created', 'updated']);
    expect(events[1].changes.preferred_date).toEqual({ from: '2026-11-10', to: '2026-11-12' });
  });

  it('step 4: reads the actual status (pending, not booked), says texts are not monitored, gives no timeline', async () => {
    const { reply } = await send(4);
    expect(reply!.body).toMatch(/^Not yet\./);
    expect(reply!.body).toMatch(/pending staff review/);
    expect(reply!.body).toMatch(/aren't monitored continuously/);
    expect(reply!.body).not.toMatch(TIMELINE);
    expect(reply!.body).not.toMatch(BOOKED_CLAIM);
  });

  it('step 5: next booked appointment is the Jan 14, 2027 physical; the recheck is kept apart as a pending request', async () => {
    const { reply } = await send(5);
    expect(reply!.body).toMatch(/next booked appointment is your annual physical with Dr\. Priya Lee on Thursday, Jan 14, 2027 at 9:30 a\.m\./);
    expect(reply!.body).toMatch(/blood pressure recheck isn't booked yet: it's still a request/);
  });

  it('step 6: closing time today is 5:00 p.m. Pacific (a Wednesday)', async () => {
    const { reply } = await send(6);
    expect(reply!.body).toBe('We close at 5:00 p.m. Pacific today (Wednesday).');
  });

  it('step 7: Aetna is not in the FAQ: says it is unavailable, does not guess, offers to pass it to staff', async () => {
    const { reply } = await send(7);
    expect(reply!.body).toMatch(/don't have information about which insurance plans the clinic accepts/);
    expect(reply!.body).toMatch(/Would you like me to pass this question to clinic staff\?/);
    expect(reply!.body).not.toMatch(/\b(we (do )?(take|accept)|is accepted\.|in[- ]network)\b/i);
    expect(reply!.meta.expects?.kind).toBe('staff_handoff_offer');
    expect(core.requests.list().filter((r) => r.type === 'other')).toHaveLength(0);
  });

  it('step 8: refill handoff for Lisinopril 10 mg once daily to Elm Street Pharmacy, without asking for any of it', async () => {
    const { reply } = await send(8);
    const refills = core.requests.list().filter((r) => r.type === 'refill');
    expect(refills).toHaveLength(1);
    expect(refills[0]).toMatchObject({
      status: 'pending_staff',
      details: { medication: 'Lisinopril', dose: '10 mg', frequency: 'once daily', pharmacy: 'Elm Street Pharmacy, (555) 010-0142', refills_remaining: 0 },
    });
    expect(reply!.body).toMatch(/pending staff review/);
    expect(reply!.body).not.toContain('?');
  });

  it('step 9: no medical advice; clinical_question handoff captures readings + question; clinician will review', async () => {
    const { reply } = await send(9);
    const cq = core.requests.list().filter((r) => r.type === 'clinical_question');
    expect(cq).toHaveLength(1);
    expect(cq[0].details).toMatchObject({
      question: 'Should I take two pills?',
      reported_readings: [{ systolic: 150, diastolic: 95, timeframe: 'all week' }],
      routed_to: 'clinician',
      advice_given_to_patient: false,
    });
    expect(reply!.body).toMatch(/can't give medical advice/);
    expect(reply!.body).toMatch(/A clinician will review it/);
    expect(reply!.body).toMatch(/aren't monitored continuously/);
    expect(reply!.body).not.toMatch(ADVICE);
    expect(reply!.body).not.toMatch(TIMELINE);
  });

  it('step 10: explains the $40 from the record (Oct 6 copay) and gives the FAQ payment link', async () => {
    const { reply } = await send(10);
    expect(reply!.body).toMatch(/\$40\.00 balance is the copay for your Oct 6, 2026 visit/);
    expect(reply!.body).toContain('https://pay.example.test/sapling');
    expect(core.requests.list().filter((r) => r.type === 'billing')).toHaveLength(0);
  });

  it('step 11: emergency rule word for word, nothing else; an emergency handoff is logged', async () => {
    const { reply } = await send(11);
    expect(reply!.body).toBe(EMERGENCY_RESPONSE);
    const em = core.requests.list().filter((r) => r.type === 'emergency');
    expect(em).toHaveLength(1);
    expect(em[0]).toMatchObject({ status: 'pending_staff', priority: 'urgent', source_message_ids: [msgs[11].inbound!.id] });
    expect(em[0].details.response_message_ids).toEqual([reply!.id]);
  });

  it('end state: exactly four handoffs, all pending staff review, none duplicated; no reply claims a booking', () => {
    const reqs = core.requests.list();
    expect(reqs.map((r) => r.type).sort()).toEqual(['appointment_request', 'clinical_question', 'emergency', 'refill']);
    expect(reqs.every((r) => r.status === 'pending_staff')).toBe(true);
    const agentReplies = core.messaging.thread(conv).filter((m) => m.author === 'agent');
    expect(agentReplies).toHaveLength(11);
    for (const m of agentReplies) {
      expect(m.body).not.toMatch(BOOKED_CLAIM);
      expect(m.body).not.toMatch(TIMELINE);
      expect(m.body).not.toMatch(/\b(date of birth|what pharmacy|which pharmacy|what medication|which medication)\b/i);
    }
  });
});
