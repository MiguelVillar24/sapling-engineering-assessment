import { z } from 'zod';

/**
 * Read-only clinic data supplied with the exercise. These schemas validate the
 * files at startup so a malformed record fails fast instead of producing a
 * wrong answer to a patient later.
 */
export const MedicationSchema = z.object({
  name: z.string().min(1),
  dose: z.string().min(1),
  frequency: z.string().min(1),
  refills_remaining: z.number().int().nonnegative(),
});

export const AppointmentSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  provider: z.string().min(1),
  type: z.string().min(1),
  status: z.string().min(1),
});

export const PatientRecordSchema = z.object({
  patient_id: z.string().min(1),
  name: z.string().min(1),
  preferred_name: z.string().min(1),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  language: z.string().min(2),
  phone: z.string().min(7),
  conditions: z.array(z.string()),
  medications: z.array(MedicationSchema),
  pharmacy: z.string().min(1),
  insurance: z.object({ payer: z.string().min(1), plan: z.string().min(1) }),
  last_visit: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    provider: z.string().min(1),
    reason: z.string().min(1),
    plan_note: z.string(),
  }),
  upcoming_appointments: z.array(AppointmentSchema),
  balance: z.object({ amount: z.number().nonnegative(), reason: z.string() }),
});

export const OpenSlotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  provider: z.string().min(1),
});

export type Medication = z.infer<typeof MedicationSchema>;
export type Appointment = z.infer<typeof AppointmentSchema>;
export type PatientRecord = z.infer<typeof PatientRecordSchema>;
export type OpenSlot = z.infer<typeof OpenSlotSchema>;

/** Known FAQ topics. Unknown FAQ headings are still loaded under a slug key. */
export type FaqKey =
  | 'hours'
  | 'address'
  | 'phone'
  | 'texting'
  | 'payment'
  | 'what_to_bring'
  | 'cancellations'
  | (string & {});

export interface FaqEntry {
  key: FaqKey;
  title: string;
  text: string;
}

/** Business hours parsed from the FAQ "Hours" entry (the FAQ stays the source of truth). */
export interface BusinessHours {
  /** ISO weekdays the clinic is open (1 = Monday ... 7 = Sunday). */
  days: number[];
  /** "HH:mm" in the clinic time zone. */
  open: string;
  close: string;
  zone: string;
  closedOnFederalHolidays: boolean;
}

export interface ClinicData {
  clinicName: string;
  /** Simulated SMS number the clinic texts from (the FAQ phone number). */
  clinicSmsNumber: string;
  timezone: string;
  patients: PatientRecord[];
  faq: FaqEntry[];
  /** Null if the FAQ hours line could not be parsed; answers then quote the FAQ verbatim. */
  hours: BusinessHours | null;
  slots: OpenSlot[];
  paymentUrl: string | null;
  phoneDisplay: string | null;
}
