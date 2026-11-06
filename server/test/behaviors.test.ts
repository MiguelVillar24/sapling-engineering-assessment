import { describe, expect, it } from 'vitest';
import { clinic, CLINIC_OFFER, firstConversation, patient, runScript, TIMELINE, testCore } from './helpers.js';

/** Behaviors beyond the scripted steps: duplicates, follow-ups, staff updates, clock changes, new conversations. */
describe('agent behaviors', () => {
  it('a repeated refill ask updates the existing refill instead of creating a duplicate', async () => {
    const core = testCore();
    await patient(core, 'can I get a refill on my BP med');
    const r = await patient(core, 'I need a refill of my lisinopril please');
    expect(r.reply.body).toMatch(/already with clinic staff/);
    const refills = core.requests.list().filter((q) => q.type === 'refill');
    expect(refills).toHaveLength(1);
    expect(refills[0].source_message_ids).toHaveLength(2);
  });

  it('"yes" to the Aetna offer files an `other` request with the question and both message ids', async () => {
    const core = testCore();
    const q = await patient(core, 'do you take Aetna?');
    const r = await patient(core, 'yes please');
    expect(r.inbound.in_reply_to).toBe(q.reply.id);
    expect(r.reply.body).toMatch(/passed your question to clinic staff: "Does the clinic accept Aetna\?"/);
    const [other] = core.requests.list();
    expect(other).toMatchObject({
      type: 'other',
      status: 'pending_staff',
      details: { reason: 'insurance_question', question: 'Does the clinic accept Aetna?', context: { insurance_on_file: 'Blue Shield of California PPO' } },
      source_message_ids: [q.inbound.id, r.inbound.id],
    });
  });

  it('"no" to the clinic offer creates nothing', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    const r = await patient(core, 'no thanks');
    expect(r.reply.body).toMatch(/won't request a time/);
    expect(core.requests.list()).toEqual([]);
  });

  it('picking a specific listed time records the slot (and says it is not reserved yet)', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    await patient(core, 'yes');
    const r = await patient(core, 'Thursday at 4 works');
    expect(r.reply.body).toMatch(/Thursday, Nov 12 at 4:00 p\.m\./);
    expect(r.reply.body).toMatch(/isn't reserved until staff book it/);
    expect(core.requests.list()[0].details.preferred_slot).toMatchObject({ date: '2026-11-12', start: '16:00' });
  });

  it('a weekend preference is explained (FAQ hours) and nothing is filed until a valid day is given', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    await patient(core, 'yes');
    const r = await patient(core, 'Saturday morning?');
    expect(r.reply.body).toMatch(/closed on weekends/);
    expect(core.requests.list()).toEqual([]);
    await patient(core, 'ok Tuesday afternoon then');
    expect(core.requests.list()).toHaveLength(1);
  });

  it('Track A phrasing in one message ("I need my blood pressure rechecked. Tuesday works.") then a change', async () => {
    const core = testCore();
    const r = await patient(core, 'I need my blood pressure rechecked. Tuesday works.');
    expect(r.reply.body).toContain('Tuesday, Nov 10');
    const r2 = await patient(core, 'actually Thursday afternoon');
    expect(r2.reply.body).toMatch(/updated your blood pressure recheck request to Thursday, Nov 12, in the afternoon/);
    const reqs = core.requests.list();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].details).toMatchObject({ reason: 'Blood pressure recheck', provider: 'Dr. Priya Lee', preferred_date: '2026-11-12' });
  });

  it('a request filed in one conversation is found (and not duplicated) from a new conversation', async () => {
    const core = testCore();
    await runScript(core, 0, 3);
    const conv2 = core.messaging.createConversation().id;
    const s = await patient(core, 'is my appointment booked yet?', conv2);
    expect(s.reply.body).toMatch(/Not yet\. .*Thursday, Nov 12/);
    const r = await patient(core, 'can we do Tuesday instead', conv2);
    expect(r.reply.body).toMatch(/updated/);
    expect(core.requests.list().filter((q) => q.type === 'appointment_request')).toHaveLength(1);
  });

  it('status answers follow what staff actually recorded', async () => {
    const core = testCore();
    await runScript(core, 0, 3);
    const req = core.requests.list()[0];
    core.requests.setStatus(req.id, 'in_progress');
    expect((await patient(core, 'is it booked yet?')).reply.body).toMatch(/^Not yet\. Clinic staff are working on/);
    core.requests.setStatus(req.id, 'completed', 'Booked Thu Nov 12 at 1:30 p.m.');
    const done = await patient(core, 'any update on my appointment?');
    expect(done.reply.body).toMatch(/marked your request .* as completed\. Staff note: "Booked Thu Nov 12 at 1:30 p\.m\."/);
    expect(done.reply.body).not.toMatch(TIMELINE);
  });

  it('cancelling the booked physical files a cancel request; the appointment stays booked; FAQ policy quoted', async () => {
    const core = testCore();
    const r = await patient(core, 'I need to cancel my physical in January');
    expect(r.reply.body).toMatch(/can't cancel appointments myself/);
    expect(r.reply.body).toMatch(/stays booked until staff process the cancellation/);
    expect(r.reply.body).toMatch(/24 hours' notice/);
    expect(core.requests.list()[0].details).toMatchObject({ action: 'cancel', related_appointment: { date: '2027-01-14', time: '09:30' } });
  });

  it('the clock is a setting: closing-time answers change with "now"', async () => {
    const core = testCore();
    core.clock.set({ now: '2026-11-07T11:00:00' }); // Saturday
    expect((await patient(core, 'what time do you close today?')).reply.body).toMatch(/closed today \(Saturday\); the clinic is closed on weekends\. We're open again on Monday, Nov 9 from 9:00 a\.m\./);
    core.clock.set({ now: '2026-11-04T18:30:00' }); // Wednesday evening
    expect((await patient(core, 'what time do you close today?')).reply.body).toMatch(/We closed at 5:00 p\.m\. Pacific today\. We're open again tomorrow/);
    core.clock.set({ now: '2026-11-11T09:30:00' }); // Veterans Day
    expect((await patient(core, 'are you open today?')).reply.body).toMatch(/closed today for Veterans Day/);
  });

  it('a free-form question from staff gets the reply forwarded back to staff, linked to their message', async () => {
    const core = testCore();
    const q = clinic(core, 'Hi Alex, are you still taking your lisinopril every morning?');
    const r = await patient(core, 'yes every morning');
    expect(r.inbound.in_reply_to).toBe(q.id);
    expect(core.requests.list()[0]).toMatchObject({ type: 'other', details: { reason: 'reply_to_staff_message' }, source_message_ids: [q.id, r.inbound.id] });
  });

  it('answers several things in one text and files only what needs staff', async () => {
    const core = testCore();
    const r = await patient(core, 'what time do you close today? also can I get a refill on my lisinopril');
    expect(r.reply.body).toMatch(/Lisinopril 10 mg/);
    expect(r.reply.body).toMatch(/5:00 p\.m\./);
    expect(core.requests.list().map((q) => q.type)).toEqual(['refill']);
  });

  it('"cancel my appointment" with both a pending request and a booked physical asks which, then acts on the answer', async () => {
    const core = testCore();
    await runScript(core, 0, 3);
    const ask = await patient(core, 'can you cancel my appointment');
    expect(ask.reply.body).toMatch(/withdraw your blood pressure recheck request .* or cancel your annual physical/);
    expect(core.requests.list()).toHaveLength(1);
    const r = await patient(core, 'the recheck');
    expect(r.reply.body).toMatch(/no longer need your blood pressure recheck request/);
    expect(core.requests.list()[0].details.withdrawn_by_patient).toBe(true);
    expect(core.requests.list().filter((q) => q.details.action === 'cancel')).toHaveLength(0);
  });

  it('"Tuesday doesn\'t work" re-asks without suggesting Tuesday again', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    await patient(core, 'yes');
    const r = await patient(core, "Tuesday doesn't work for me");
    expect(r.reply.body).toMatch(/also has openings on Thursday, Nov 12/);
    expect(r.reply.body).not.toMatch(/Tuesday/);
    expect(core.requests.list()).toEqual([]);
  });

  it('farewells and past-tense dates are not scheduling preferences', async () => {
    const core = testCore();
    await runScript(core, 0, 2);
    await patient(core, 'thanks, see you Thursday');
    expect(core.requests.list()[0]).toMatchObject({ revision: 1, details: { preferred_date: '2026-11-10' } });
  });

  it('times outside clinic hours are explained with the FAQ hours', async () => {
    const core = testCore();
    clinic(core, CLINIC_OFFER);
    await patient(core, 'yes');
    const r = await patient(core, 'Thursday evening');
    expect(r.reply.body).toMatch(/^The clinic is open Monday–Friday, 9:00 a\.m\.–5:00 p\.m\. Pacific, so evening won't work\./);
  });

  it('"the week of Jan 18" for the physical is a date range, not the MLK holiday', async () => {
    const core = testCore();
    await patient(core, 'I want to reschedule my physical');
    const r = await patient(core, 'any time the week of Jan 18');
    expect(r.reply.body).toMatch(/move your annual physical .* to the week of Monday, Jan 18, 2027/);
    expect(core.requests.list()[0].details).toMatchObject({ action: 'reschedule', date_range: { start: '2027-01-18', end: '2027-01-22' } });
  });

  it('a refill to a different pharmacy records that pharmacy (not the one on file)', async () => {
    const core = testCore();
    const r = await patient(core, 'can you send my lisinopril refill to CVS?');
    expect(r.reply.body).toMatch(/to go to CVS \(instead of Elm Street Pharmacy on file\)/);
    expect(core.requests.list()[0].details).toMatchObject({ pharmacy: 'CVS', pharmacy_on_file: 'Elm Street Pharmacy, (555) 010-0142', patient_requested_pharmacy: true });
  });

  it('holiday hours come from the FAQ rule + the federal calendar', async () => {
    const core = testCore();
    expect((await patient(core, 'is the clinic open on Thanksgiving?')).reply.body).toBe(
      "We're closed on Thursday, Nov 26 for Thanksgiving Day. Our regular hours are Monday–Friday, 9:00 a.m.–5:00 p.m. Pacific.",
    );
  });

  it('readings without a question are described as readings', async () => {
    const core = testCore();
    const r = await patient(core, 'my bp was 130/85 this morning');
    expect(r.reply.body).toMatch(/sent your readings \(130\/85 this morning\) to the clinical team\. A clinician will review them\./);
  });

  it('does not understand gibberish: offers staff instead of guessing', async () => {
    const core = testCore();
    const r = await patient(core, 'asdf qwerty');
    expect(r.reply.body).toMatch(/not sure I understood/);
    expect(core.requests.list()).toEqual([]);
    expect(firstConversation(core)).toBe('conv_001');
  });
});
