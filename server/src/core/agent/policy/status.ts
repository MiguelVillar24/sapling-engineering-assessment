import type { HandoffRequest } from '../../domain.js';
import type { AppointmentRequestDetailsT, OtherDetailsT, RefillDetailsT } from '../../requests/request-types.js';
import { formatDate, formatTime } from '../../time/calendar.js';
import { describePreference } from '../../time/when.js';
import { lowerFirst, period } from '../text.js';
import { REVIEW_NOTE, type Turn } from '../turn.js';
import { preferenceOf } from './scheduling.js';

/**
 * "Is it booked yet?" and "When is my next appointment?" are answered from the
 * request's actual stored status and the record's booked appointments, and the
 * two are always kept apart: a pending request is never called an appointment.
 */

function describeRequest(req: HandoffRequest, turn: Turn): string {
  const now = turn.ctx.now;
  switch (req.type) {
    case 'appointment_request': {
      const d = req.details as AppointmentRequestDetailsT;
      if (d.action === 'cancel' && d.related_appointment) {
        return `request to cancel your ${lowerFirst(d.related_appointment.type)} on ${formatDate(d.related_appointment.date, now)}`;
      }
      const who = d.provider ? ` with ${d.provider}` : '';
      return `request for ${/^[aeiou]/i.test(d.reason) ? 'an' : 'a'} ${lowerFirst(d.reason)}${who} on ${describePreference(preferenceOf(d), now)}`;
    }
    case 'refill': {
      const d = req.details as RefillDetailsT;
      return `refill request for ${d.medication} ${d.dose}`;
    }
    case 'clinical_question':
      return 'question for a clinician';
    case 'other': {
      const d = req.details as OtherDetailsT;
      return d.question ? `question for staff ("${d.question}")` : 'message for staff';
    }
    default:
      return `${req.type.replace(/_/g, ' ')} request`;
  }
}

function statusSentence(req: HandoffRequest, turn: Turn, askedBooked: boolean): string {
  const what = describeRequest(req, turn);
  const note = req.staff_note ? ` Staff note: "${req.staff_note}"` : '';
  const isAppt = req.type === 'appointment_request';
  switch (req.status) {
    case 'pending_staff':
      if (isAppt) return `${askedBooked ? 'Not yet. ' : ''}Your ${what} is still pending staff review, so it isn't booked yet.`;
      if (req.type === 'refill') return `Your ${what} is still pending staff review; it hasn't been approved yet.`;
      if (req.type === 'clinical_question') return `Your ${what} is still waiting for a clinician to review it.`;
      return `Your ${what} is still pending staff review.`;
    case 'in_progress':
      return `${askedBooked && isAppt ? 'Not yet. ' : ''}Clinic staff are working on your ${what}${isAppt ? ", but it isn't booked until they confirm it" : ''}.${note}`;
    case 'completed':
      return `Clinic staff marked your ${what} as completed.${note}`;
    case 'declined':
      return `Clinic staff weren't able to complete your ${what}.${note}`;
    case 'cancelled':
      return `Your ${what} was closed by clinic staff.${note}`;
  }
}

export function handleStatus(turn: Turn): void {
  const { ctx } = turn;
  const st = turn.intent('request_status');
  if (st) {
    const askedBooked = /\b(booked|scheduled|confirmed|book|schedule)\b/.test(turn.interpretation.normalized);
    const nonEmergency = (r: HandoffRequest) => r.type !== 'emergency';
    const byType =
      st.about === 'refill'
        ? 'refill'
        : st.about === 'clinical'
          ? 'clinical_question'
          : st.about === 'appointment'
            ? 'appointment_request'
            : undefined;
    const req =
      turn.openRequests(byType).find(nonEmergency) ??
      (byType ? turn.latestRequest(byType) : turn.openRequests().find(nonEmergency) ?? turn.latestRequest());
    if (!req || req.type === 'emergency') {
      const today = ctx.now.toISODate()!;
      const booked = ctx.patient.upcoming_appointments
        .filter((a) => a.status === 'booked' && a.date >= today)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
      const bookedNote = booked
        ? ` Your ${lowerFirst(booked.type)} with ${booked.provider} on ${formatDate(booked.date, ctx.now)} at ${formatTime(booked.time)} is booked.`
        : '';
      turn.say(
        st.about === 'appointment'
          ? `I don't see a pending appointment request from you, so there's nothing waiting to be booked.${bookedNote}`
          : `I don't see any requests from you that are waiting on staff right now.${bookedNote}`,
      );
      turn.record({ kind: 'answered', topic: 'request_status', source: 'requests + record:upcoming_appointments' });
    } else {
      turn.linkTo(req.id);
      const open = req.status === 'pending_staff' || req.status === 'in_progress';
      turn.say(
        `${statusSentence(req, turn, askedBooked)}${open ? ` ${REVIEW_NOTE.replace(/\.$/, '')}, so I can't say exactly when staff will get to it.` : ''}`,
      );
      turn.record({ kind: 'request_status', topic: req.type, request_id: req.id, source: 'requests' });
    }
  }

  if (turn.has('next_appointment')) {
    const today = ctx.now.toISODate()!;
    const booked = ctx.patient.upcoming_appointments
      .filter((a) => a.status === 'booked' && a.date >= today)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const next = booked[0];
    let s = next
      ? period(`Your next booked appointment is your ${lowerFirst(next.type)} with ${next.provider} on ${formatDate(next.date, ctx.now)} at ${formatTime(next.time)}`)
      : "You don't have any booked appointments on file.";
    const pending = turn.openRequests('appointment_request').filter((r) => {
      const d = r.details as AppointmentRequestDetailsT;
      return d.action !== 'cancel' && !d.withdrawn_by_patient;
    });
    for (const r of pending) {
      const d = r.details as AppointmentRequestDetailsT;
      s += ` Separately, your ${lowerFirst(d.reason)} isn't booked yet: it's still a request (for ${describePreference(preferenceOf(d), ctx.now)}) pending staff review.`;
    }
    turn.say(s);
    turn.record({ kind: 'answered', topic: 'next_appointment', source: 'record:upcoming_appointments' });
  }
}
