import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { findFaq, parseBusinessHours, parseFaq } from './faq.js';
import { type ClinicData, OpenSlotSchema, PatientRecordSchema } from './types.js';

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Loads the supplied, read-only clinic data from `dataDir`. Nothing in the app
 * writes these files: the agent never changes the patient's clinical record.
 */
export function loadClinicData(dataDir: string): ClinicData {
  const patient = PatientRecordSchema.parse(readJson(join(dataDir, 'alex_morgan.json')));
  const slots = z.array(OpenSlotSchema).parse(readJson(join(dataDir, 'open_slots.json')));
  const faq = parseFaq(readFileSync(join(dataDir, 'clinic_faq.md'), 'utf8'));

  const hoursEntry = findFaq(faq, 'hours');
  const hours = hoursEntry ? parseBusinessHours(hoursEntry.text) : null;
  const paymentUrl = findFaq(faq, 'payment')?.text.match(/https?:\/\/[^\s,;)]+[^\s,;).]/)?.[0] ?? null;
  const phoneDisplay = findFaq(faq, 'phone')?.text.match(/\(\d{3}\)\s*\d{3}-\d{4}/)?.[0] ?? null;
  const smsDigits = phoneDisplay?.replace(/\D/g, '') ?? '5550100100';

  return {
    clinicName: 'Sapling Family Clinic',
    clinicSmsNumber: `+1-${smsDigits.slice(0, 3)}-${smsDigits.slice(3, 6)}-${smsDigits.slice(6)}`,
    timezone: hours?.zone ?? 'America/Los_Angeles',
    patients: [patient],
    faq,
    hours,
    slots: [...slots].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)),
    paymentUrl,
    phoneDisplay,
  };
}
