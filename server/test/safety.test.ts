import { describe, expect, it } from 'vitest';
import { detectEmergency, EMERGENCY_RESPONSE } from '../src/core/agent/safety.js';
import { PHASE1_SCRIPT } from '../src/scenario.js';
import { ADVICE, clinic, CLINIC_OFFER, patient, testCore } from './helpers.js';

describe('emergency detection (deterministic, runs before any interpretation)', () => {
  it.each([
    'I have chest pain and my left arm feels numb',
    'my chest feels really tight',
    'there is a crushing pressure in my chest',
    "I can't breathe",
    'having trouble breathing since this morning',
    'my face is drooping and my speech is slurred',
    'I think I am having a stroke',
    'I passed out in the kitchen',
    'I want to kill myself',
    'I took too many pills',
    'my throat is closing up',
    'worst headache of my life',
    'this is an emergency',
    'my bp is 190/125 right now',
    'tengo dolor de pecho',
    'MY LEFT ARM IS NUMB',
  ])('flags: %s', (text) => {
    expect(detectEmergency(text)).not.toBeNull();
  });

  it.each([
    ...PHASE1_SCRIPT.filter((s) => s.step >= 1 && s.step <= 10).map((s) => s.text),
    'I got poison ivy on my hand',
    'my readings have been 150/95',
    'can I come in Thursday afternoon?',
  ])('does not flag: %s', (text) => {
    expect(detectEmergency(text)).toBeNull();
  });
});

describe('agent safety behavior', () => {
  it('sends the exact emergency text and NOTHING else, even when the message also asks for other things', async () => {
    const core = testCore();
    const r = await patient(core, 'I have chest pain. Also can I get a refill and what time do you close?');
    expect(r.reply.body).toBe(EMERGENCY_RESPONSE);
    expect(r.reply.body).not.toMatch(/staff|review/i);
    expect(core.requests.list().map((q) => q.type)).toEqual(['emergency']);
  });

  it('repeated emergency messages update the same open emergency handoff', async () => {
    const core = testCore();
    await patient(core, 'I have chest pain');
    const r2 = await patient(core, "now I can't breathe");
    expect(r2.reply.body).toBe(EMERGENCY_RESPONSE);
    const em = core.requests.list();
    expect(em).toHaveLength(1);
    expect(em[0].source_message_ids).toHaveLength(2);
    expect(em[0].details.detected_signals).toEqual(expect.arrayContaining(['chest pain or pressure', 'trouble breathing']));
  });

  it.each([
    'should I double my lisinopril?',
    'is 150/95 too high?',
    'can I take ibuprofen with my blood pressure medicine?',
    'I have been dizzy since I started the new dose, is that normal?',
    'should I stop taking my pills',
  ])('never gives clinical advice; files a clinical_question instead: %s', async (text) => {
    const core = testCore();
    const r = await patient(core, text);
    expect(r.reply.body).toMatch(/can't give medical advice/);
    expect(r.reply.body).not.toMatch(ADVICE);
    expect(core.requests.list().map((q) => q.type)).toEqual(['clinical_question']);
  });

  it('does not invent clinic policy: questions the FAQ cannot answer are offered to staff, not answered', async () => {
    const core = testCore();
    for (const q of ['do you take Cigna?', 'is Kaiser in network?']) {
      const r = await patient(core, q);
      expect(r.reply.body).toMatch(/don't have information/);
      expect(r.reply.body).not.toMatch(/\bwe (do )?(take|accept)\b/i);
    }
  });

  it('clinic messages never trigger the agent and are marked simulated', () => {
    const core = testCore();
    const m = clinic(core, CLINIC_OFFER);
    expect(m.meta.simulated_sms).toBe(true);
    expect(core.messaging.thread(m.conversation_id)).toHaveLength(1);
  });
});
