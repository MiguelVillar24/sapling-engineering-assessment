import type { DateTime } from 'luxon';
import { z } from 'zod';
import { AppointmentSchema, OpenSlotSchema } from '../clinic-data/types.js';
import type { RequestType } from '../domain.js';
import { describePreference } from '../time/when.js';

/**
 * Registry of handoff (request) types. Each entry owns the structured
 * `details` schema staff rely on and a one-line summary for the queue.
 *
 * Adding a request type = add its name to REQUEST_TYPES in domain.ts, add an
 * entry here, and add a policy handler that files it. No DB migration needed.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const TimeWindowSchema = z.object({ label: z.string(), start: hhmm, end: hhmm });

export const AppointmentRequestDetails = z.object({
  action: z.enum(['schedule', 'reschedule', 'cancel']),
  reason: z.string().min(1),
  provider: z.string().nullable(),
  preferred_date: isoDate.nullable(),
  alternative_dates: z.array(isoDate).default([]),
  date_range: z.object({ start: isoDate, end: isoDate }).nullable().default(null),
  time_window: TimeWindowSchema.nullable(),
  preferred_time: hhmm.nullable().default(null),
  /** Only set when the patient picked a time that is a listed open slot. */
  preferred_slot: OpenSlotSchema.nullable().default(null),
  /** Listed open slots that satisfy the preference; staff may book any of them. */
  matching_open_slots: z.array(OpenSlotSchema).default([]),
  patient_flexibility: z.string().default(''),
  /** For reschedule/cancel: the booked appointment this is about. */
  related_appointment: AppointmentSchema.nullable().default(null),
  clinical_context: z.string().nullable().default(null),
  withdrawn_by_patient: z.boolean().default(false),
});

export const RefillDetails = z.object({
  medication: z.string().min(1),
  dose: z.string().min(1),
  frequency: z.string().min(1),
  refills_remaining: z.number().int().nullable(),
  /** Where to send it: the pharmacy on file unless the patient named another one. */
  pharmacy: z.string().min(1),
  pharmacy_on_file: z.string().nullable().default(null),
  patient_requested_pharmacy: z.boolean().default(false),
  withdrawn_by_patient: z.boolean().default(false),
  needs_prescriber_approval: z.boolean(),
  prescriber_context: z.string().nullable(),
  patient_message: z.string(),
});

const ReadingSchema = z.object({
  systolic: z.number(),
  diastolic: z.number(),
  text: z.string(),
  timeframe: z.string().nullable(),
  message_id: z.string(),
});

export const ClinicalQuestionDetails = z.object({
  question: z.string().min(1),
  questions: z.array(z.object({ text: z.string(), message_id: z.string() })),
  reported_readings: z.array(ReadingSchema).default([]),
  symptoms_mentioned: z.array(z.string()).default([]),
  /** What "my pills" most likely refers to, from the record (for the clinician, not the patient). */
  related_medication: z.string().nullable(),
  medications_on_file: z.array(z.string()),
  conditions_on_file: z.array(z.string()),
  routed_to: z.literal('clinician'),
  advice_given_to_patient: z.literal(false),
});

export const BillingDetails = z.object({
  issue: z.enum(['dispute', 'payment_plan', 'insurance_billing', 'balance_question', 'other']),
  patient_statement: z.string(),
  balance_on_file: z.object({ amount: z.number(), reason: z.string() }).nullable(),
  payment_link_shared: z.string().nullable(),
});

export const OtherDetails = z.object({
  /** Machine-friendly reason, e.g. "insurance_question", "reply_to_staff_message". */
  reason: z.string().min(1),
  question: z.string().nullable(),
  patient_message: z.string(),
  context: z.record(z.string(), z.unknown()).default({}),
});

export const EmergencyDetails = z.object({
  detected_signals: z.array(z.string()).min(1),
  patient_messages: z.array(z.object({ message_id: z.string(), text: z.string() })).min(1),
  response_sent: z.string(),
  response_message_ids: z.array(z.string()),
  note: z.string(),
});

export interface RequestTypeDefinition<S extends z.ZodType = z.ZodType> {
  label: string;
  schema: S;
  defaultPriority: 'routine' | 'urgent';
  summarize(details: z.infer<S>, now: DateTime): string;
}

const define = <S extends z.ZodType>(d: RequestTypeDefinition<S>) => d;

const truncate = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const REQUEST_TYPE_REGISTRY: { [K in RequestType]: RequestTypeDefinition } = {
  appointment_request: define({
    label: 'Appointment request',
    schema: AppointmentRequestDetails,
    defaultPriority: 'routine',
    summarize: (d, now) => {
      const action = { schedule: 'Schedule', reschedule: 'Reschedule', cancel: 'Cancel' }[d.action];
      const who = d.provider ? ` with ${d.provider}` : '';
      const when =
        d.action === 'cancel'
          ? d.related_appointment
            ? ` (booked ${d.related_appointment.date} ${d.related_appointment.time})`
            : ''
          : ` — prefers ${describePreference(d, now)}`;
      return `${d.withdrawn_by_patient ? 'WITHDRAWN BY PATIENT — ' : ''}${action}: ${d.reason}${who}${when}`;
    },
  }),
  refill: define({
    label: 'Refill',
    schema: RefillDetails,
    defaultPriority: 'routine',
    summarize: (d) =>
      `Refill: ${d.medication} ${d.dose} ${d.frequency} to ${d.pharmacy.split(',')[0]}` +
      (d.refills_remaining === 0 ? ' (0 refills remaining, needs approval)' : ''),
  }),
  clinical_question: define({
    label: 'Clinical question',
    schema: ClinicalQuestionDetails,
    defaultPriority: 'routine',
    summarize: (d) => {
      const readings = d.reported_readings.map((r) => r.text).join(', ');
      return `Clinical question for a clinician: "${truncate(d.question, 70)}"${readings ? ` — reports BP ${readings}` : ''}`;
    },
  }),
  billing: define({
    label: 'Billing',
    schema: BillingDetails,
    defaultPriority: 'routine',
    summarize: (d) => `Billing (${d.issue.replace(/_/g, ' ')}): ${truncate(d.patient_statement)}`,
  }),
  other: define({
    label: 'Other',
    schema: OtherDetails,
    defaultPriority: 'routine',
    summarize: (d) => `${d.reason.replace(/_/g, ' ')}: ${truncate(d.question ?? d.patient_message)}`,
  }),
  emergency: define({
    label: 'Emergency',
    schema: EmergencyDetails,
    defaultPriority: 'urgent',
    summarize: (d) => `EMERGENCY: ${d.detected_signals.join('; ')} — 911/ER instructions sent`,
  }),
};

export type AppointmentRequestDetailsT = z.infer<typeof AppointmentRequestDetails>;
export type RefillDetailsT = z.infer<typeof RefillDetails>;
export type ClinicalQuestionDetailsT = z.infer<typeof ClinicalQuestionDetails>;
export type BillingDetailsT = z.infer<typeof BillingDetails>;
export type OtherDetailsT = z.infer<typeof OtherDetails>;
export type EmergencyDetailsT = z.infer<typeof EmergencyDetails>;
