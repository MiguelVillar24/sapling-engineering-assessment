import { describe, expect, it } from 'vitest';
import { appConfig } from '../src/config.js';
import { RuleBasedInterpreter } from '../src/core/agent/interpreter.js';
import { loadClinicData } from '../src/core/clinic-data/load.js';

const patient = loadClinicData(appConfig.dataDir).patients[0];
const types = (text: string) => new RuleBasedInterpreter().interpret(text, { patient }).intents.map((i) => i.type);

describe('rule-based interpreter', () => {
  it.each([
    ['yes', ['affirm']],
    ['Tuesday afternoon works', ['time_preference']],
    ['actually can we do Thursday instead', ['time_preference']],
    ['is it booked yet?', ['request_status']],
    ['when is my next appointment?', ['next_appointment']],
    ['what time do you close today?', ['clinic_hours']],
    ['do you take Aetna?', ['insurance_accepted']],
    ['can I get a refill on my BP med', ['refill']],
    ['my readings have been around 150/95 all week, should I take two pills?', ['clinical_question']],
    ['why do I owe $40?', ['billing_question']],
  ])('script line "%s" -> %j', (text, expected) => {
    expect(types(text)).toEqual(expected);
  });

  it.each([
    ['yep that works', 'affirm'],
    ['sure, tues pm', 'time_preference'],
    ['any update on my appointment?', 'request_status'],
    ['are you open on saturday?', 'clinic_hours'],
    ['where are you located?', 'faq'],
    ['I ran out of my lisinopril', 'refill'],
    ['is 150/95 bad?', 'clinical_question'],
    ['I already paid that bill', 'billing_issue'],
    ['is this a real person?', 'identity'],
    ['can I talk to someone', 'talk_to_staff'],
  ])('paraphrase "%s" includes %s', (text, expected) => {
    expect(types(text)).toContain(expected);
  });

  it('does not treat "close today" or symptoms with dates as scheduling preferences', () => {
    expect(types('what time do you close today?')).not.toContain('time_preference');
    expect(types('I have been dizzy since Tuesday')).not.toContain('time_preference');
  });
});
