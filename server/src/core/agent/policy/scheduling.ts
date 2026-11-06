import { DateTime } from 'luxon';
import type { Appointment, OpenSlot } from '../../clinic-data/types.js';
import { findFaq, hoursSummary } from '../../clinic-data/faq.js';
import type { AppointmentFlow, HandoffRequest } from '../../domain.js';
import type { AppointmentRequestDetailsT } from '../../requests/request-types.js';
import { formatDate, formatTime, slotDateTime, weekdayName } from '../../time/calendar.js';
import {
  type AppointmentPreference,
  describePreference,
  describeSlots,
  type PreferenceIssue,
  type ResolvedPreference,
  resolvePreference,
  slotTimesPhrase,
  type WhenSpec,
} from '../../time/when.js';
import { planCallsForBpRecheck, recheckContext } from '../clinic-message.js';
import { type OpenExpectation, offeredSlots } from '../dialogue.js';
import type { Intent } from '../interpreter.js';
import { capitalize, lowerFirst, period } from '../text.js';
import type { Turn } from '../turn.js';

/**
 * Appointment requests: the clinic's offer, the patient's "yes", the day and
 * window, later changes ("Thursday instead"), cancellations and reschedules.
 * The agent never books anything: every outcome is a request pending staff review.
 */

const uniq = (ids: string[]) => [...new Set(ids)];
const withArticle = (s: string) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);

export function providerShort(provider: string | null): string {
  if (!provider) return 'the clinic';
  return `Dr. ${provider.replace(/^dr\.?\s+/i, '').split(/\s+/).at(-1)}`;
}

export function hoursPhrase(turn: Turn): string {
  return hoursSummary(turn.ctx.clinic.faq);
}

function sameReason(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
  const bp = (s: string) => /blood pressure|\bbp\b/.test(n(s));
  return n(a) === n(b) || (bp(a) && bp(b));
}

export function preferenceOf(d: AppointmentRequestDetailsT): AppointmentPreference {
  return {
    preferred_date: d.preferred_date,
    alternative_dates: d.alternative_dates,
    date_range: d.date_range,
    time_window: d.time_window,
    preferred_time: d.preferred_time,
    preferred_slot: d.preferred_slot,
  };
}

function flowOfRequest(req: HandoffRequest, extraSources: string[]): AppointmentFlow {
  const d = req.details as AppointmentRequestDetailsT;
  return {
    action: d.action,
    reason: d.reason,
    provider: d.provider,
    context: d.clinical_context,
    related_appointment: d.related_appointment,
    origin_message_ids: extraSources,
  };
}

export function latestOpenAppointment(turn: Turn): HandoffRequest | undefined {
  return turn.openRequests('appointment_request').find((r) => {
    const d = r.details as AppointmentRequestDetailsT;
    return d.action !== 'cancel' && !d.withdrawn_by_patient;
  });
}

function futureSlots(turn: Turn, provider: string | null): OpenSlot[] {
  const { now, clinic } = turn.ctx;
  return clinic.slots.filter((s) => slotDateTime(s, now.zoneName ?? undefined) > now && (!provider || s.provider === provider));
}

function flexibility(res: ResolvedPreference, now: DateTime): string {
  const p = res.preference;
  if (p.preferred_slot) return 'Patient chose this specific listed opening.';
  const m = res.matchingSlots;
  if (m.length > 1) return period(`Patient is flexible within the stated preference; any matching listed opening works: ${describeSlots(m, now, 'and').join('; ')}`);
  if (m.length === 1) return period(`The one matching listed opening works for the patient: ${describeSlots(m, now).join('')}`);
  return `No listed opening matches; patient prefers ${describePreference(p, now)}. Staff to find a time that fits.`;
}

function buildDetails(flow: AppointmentFlow, res: ResolvedPreference, now: DateTime): AppointmentRequestDetailsT {
  return {
    action: flow.action,
    reason: flow.reason,
    provider: flow.provider,
    ...res.preference,
    matching_open_slots: res.matchingSlots,
    patient_flexibility: flexibility(res, now),
    related_appointment: flow.related_appointment,
    clinical_context: flow.context,
    withdrawn_by_patient: false,
  };
}

/** "Dr. Lee has openings at 2:00 and 3:30 p.m. that day." */
function openingsSentence(res: ResolvedPreference, provider: string | null, now: DateTime, onCreate: boolean): string {
  const p = res.preference;
  const who = provider ? providerShort(provider) : 'The clinic';
  if (p.preferred_slot) return "That time is listed as open, but it isn't reserved until staff book it.";
  const m = res.matchingSlots;
  if (!m.length) return "I don't see a listed opening that matches, so staff will look for a time that fits.";
  const dates = [...new Set(m.map((s) => s.date))];
  const singleDay = dates.length === 1 && dates[0] === p.preferred_date;
  if (m.length === 1) {
    return singleDay
      ? `${who} has an opening at ${formatTime(m[0].start)} that day.`
      : period(`${who} has an opening on ${describeSlots(m, now).join('')}`);
  }
  const list = singleDay ? `at ${slotTimesPhrase(m, 'and')} that day` : `on ${describeSlots(m, now, 'and').join(' and ')}`;
  const hint = onCreate ? ` Staff can book ${m.length === 2 ? 'either one' : 'any of those'}; if only one works for you, just reply with that time.` : '';
  return `${period(`${who} has openings ${list}`)}${hint}`;
}

function issueText(issue: PreferenceIssue, turn: Turn): string {
  const { now } = turn.ctx;
  switch (issue.kind) {
    case 'past_date':
      return `${formatDate(issue.date, now)} has already passed.`;
    case 'clinic_closed':
      if (issue.reason === 'holiday') return `The clinic is closed on ${formatDate(issue.date, now)} for ${issue.holiday}.`;
      if (issue.reason === 'weekend') return `The clinic is closed on weekends, so ${formatDate(issue.date, now)} won't work.`;
      return `The clinic isn't open on ${weekdayName(DateTime.fromISO(issue.date).weekday)}s.`;
    case 'outside_hours':
      return `The clinic is open ${hoursPhrase(turn)}, so ${issue.label} won't work.`;
  }
}

function askAgain(turn: Turn, lead: string, flow: AppointmentFlow): void {
  const slots = futureSlots(turn, flow.provider);
  const who = flow.provider ? providerShort(flow.provider) : 'The clinic';
  const suggestion = slots.length ? ` ${period(`${who} has openings on ${describeSlots(slots, turn.ctx.now).join('; ')}`)}` : '';
  turn.say(`${lead} Could you pick another day or time?${suggestion}`);
  turn.expects = { kind: 'time_preference', flow, offered_slots: slots };
  turn.record({ kind: 'asked_followup', topic: 'appointment_time' });
}

function askForTime(turn: Turn, flow: AppointmentFlow, ack?: OpenExpectation): void {
  const { ctx } = turn;
  if (ack) turn.answer(ack);
  const slots = futureSlots(turn, flow.provider);
  const f: AppointmentFlow = { ...flow, origin_message_ids: uniq([...flow.origin_message_ids, ctx.inbound.id]) };
  const intro = ack ? `Great, ${turn.name}!` : `Happy to help, ${turn.name}.`;
  const reason = lowerFirst(flow.reason);
  if (slots.length) {
    const who = flow.provider ? providerShort(flow.provider) : 'We';
    const list = describeSlots(slots, ctx.now).map((s) => `• ${s}`).join('\n');
    const lead =
      flow.action === 'reschedule'
        ? `${intro} These are ${flow.provider ? `${providerShort(flow.provider)}'s` : 'the'} currently listed openings:`
        : `${intro} ${who} ${flow.provider ? 'has' : 'have'} these openings for your ${reason}:`;
    turn.say(`${lead}\n${list}\nWhich day and time work best for you? If none of these work, just tell me what does and I'll pass it to staff.`);
  } else {
    turn.say(`${intro} What days and times work best for your ${reason}? I'll pass your preference to staff to schedule.`);
  }
  turn.expects = { kind: 'time_preference', flow: f, offered_slots: slots };
  turn.record({ kind: 'asked_followup', topic: 'appointment_time' });
}

function reaskTime(turn: Turn, ack: OpenExpectation | undefined, flow: AppointmentFlow, rejected: number[] = []): void {
  if (ack) turn.answer(ack);
  const prior = ack?.expectation.kind === 'time_preference' ? ack.expectation.offered_slots : futureSlots(turn, flow.provider);
  const weekday = (s: OpenSlot) => DateTime.fromISO(s.date).weekday;
  const remaining = prior.filter((s) => !rejected.includes(weekday(s)));
  if (rejected.length) {
    const who = flow.provider ? providerShort(flow.provider) : 'The clinic';
    const others = remaining.length ? ` ${period(`${who} also has openings on ${describeSlots(remaining, turn.ctx.now).join('; ')}`)}` : '';
    turn.say(`No problem.${others} Which day and time would work for you instead?`);
  } else {
    const ex = remaining[0] ? `"${weekdayName(weekday(remaining[0]))} afternoon"` : '"Tuesday afternoon"';
    turn.say(`Which day and time work best for you? For example, ${ex} or a specific time like "${remaining[1] ? `${weekdayName(weekday(remaining[1]))} at ${formatTime(remaining[1].start).replace(/ [ap]\.m\.$/, '')}` : 'Thursday at 1:30'}".`);
  }
  turn.expects = { kind: 'time_preference', flow, offered_slots: remaining.length ? remaining : prior };
  turn.record({ kind: 'asked_followup', topic: 'appointment_time' });
}

function confirmation(turn: Turn, flow: AppointmentFlow, res: ResolvedPreference): string {
  const { now } = turn.ctx;
  const when = describePreference(res.preference, now);
  const who = flow.provider ? ` with ${flow.provider}` : '';
  const appt = flow.related_appointment;
  let s =
    flow.action === 'reschedule' && appt
      ? period(`Thanks, ${turn.name}! I've sent a request to move your ${lowerFirst(appt.type)} (currently ${formatDate(appt.date, now)} at ${formatTime(appt.time)}) to ${when}`)
      : period(`Thanks, ${turn.name}! I've requested ${withArticle(lowerFirst(flow.reason))}${who} for ${when}`);
  s += ` ${openingsSentence(res, flow.provider, now, true)}`;
  if (res.skippedNearest && res.preference.preferred_date) {
    s += ` (I chose ${formatDate(res.preference.preferred_date, now)} because ${formatDate(res.skippedNearest, now)} has no listed openings. If you meant ${formatDate(res.skippedNearest, now)}, just reply and I'll change it.)`;
  }
  if (flow.action === 'reschedule') s += ' Your current appointment stays booked until staff confirm the change.';
  return `${s} This is a request, not a booking yet: it's pending review by clinic staff.`;
}

function updateFromPreference(turn: Turn, req: HandoffRequest, when: WhenSpec, extraSources: string[] = []): void {
  const { ctx } = turn;
  const d = req.details as AppointmentRequestDetailsT;
  const current = preferenceOf(d);
  const res = resolvePreference(when, {
    now: ctx.now,
    hours: ctx.clinic.hours,
    openSlots: ctx.clinic.slots,
    offeredSlots: offeredSlots(ctx.thread),
    provider: d.provider,
    current,
  });
  const flow = flowOfRequest(req, uniq([...extraSources, ctx.inbound.id]));
  if (!res.usable) return reaskTime(turn, undefined, flow, when.rejectedWeekdays);
  if (res.issues.length) return askAgain(turn, res.issues.map((i) => issueText(i, turn)).join(' '), flow);

  const reason = lowerFirst(d.reason);
  if (JSON.stringify(current) === JSON.stringify(res.preference)) {
    turn.linkTo(req.id);
    turn.say(`${period(`Your ${reason} request is already for ${describePreference(current, ctx.now)}`)} It's still pending staff review and isn't booked yet.`);
    turn.record({ kind: 'request_status', topic: 'appointment_request', request_id: req.id });
    return;
  }
  const details = buildDetails(flow, res, ctx.now);
  turn.linkTo(req.id);
  turn.tools.amendRequest(req.id, details, flow.origin_message_ids, `Patient changed preference to ${describePreference(res.preference, ctx.now)}`);
  turn.record({ kind: 'request_updated', topic: 'appointment_request', request_id: req.id });
  turn.say(
    `${period(`No problem, I've updated your ${reason} request to ${describePreference(res.preference, ctx.now)}`)} ${openingsSentence(res, d.provider, ctx.now, false)} It's still pending staff review and isn't booked yet.`,
  );
}

function createFromFlow(turn: Turn, flow: AppointmentFlow, when: WhenSpec, exp?: OpenExpectation): void {
  const { ctx } = turn;
  if (exp) turn.answer(exp);
  // Never file a duplicate: an open request for the same visit is updated instead.
  const dup = turn.openRequests('appointment_request').find((r) => {
    const d = r.details as AppointmentRequestDetailsT;
    return d.action === flow.action && !d.withdrawn_by_patient && sameReason(d.reason, flow.reason);
  });
  if (dup) return updateFromPreference(turn, dup, when, flow.origin_message_ids);

  const flexibleOnly =
    when.anyTime && !when.weekdays.length && !when.dates.length && !when.dayOfMonth && !when.relative && !when.range && !when.window && !when.time && !when.ordinal;
  if (flexibleOnly && exp?.expectation.kind === 'appointment_offer') return askForTime(turn, flow);
  const offered = exp?.expectation.kind === 'time_preference' ? exp.expectation.offered_slots : offeredSlots(ctx.thread);
  const res = resolvePreference(when, {
    now: ctx.now,
    hours: ctx.clinic.hours,
    openSlots: ctx.clinic.slots,
    offeredSlots: offered,
    provider: flow.provider,
    current: null,
  });
  const f: AppointmentFlow = { ...flow, origin_message_ids: uniq([...flow.origin_message_ids, ctx.inbound.id]) };
  if (!res.usable) return reaskTime(turn, undefined, f, when.rejectedWeekdays);
  if (res.issues.length) return askAgain(turn, res.issues.map((i) => issueText(i, turn)).join(' '), f);

  const req = turn.tools.createRequest('appointment_request', buildDetails(flow, res, ctx.now), f.origin_message_ids);
  turn.record({ kind: 'request_created', topic: 'appointment_request', request_id: req.id });
  turn.say(confirmation(turn, flow, res));
  turn.reviewNote = true;
}

function bpRecheckFlow(turn: Turn, origin: string[]): AppointmentFlow {
  const p = turn.ctx.patient;
  return {
    action: 'schedule',
    reason: 'Blood pressure recheck',
    provider: p.last_visit.provider,
    context: recheckContext(p),
    related_appointment: null,
    origin_message_ids: origin,
  };
}

function askReason(turn: Turn, when: WhenSpec | null, offerSuggestion: boolean): void {
  const { ctx } = turn;
  const p = ctx.patient;
  const hasRecheck = ctx.requests.some(
    (r) => r.type === 'appointment_request' && sameReason(String(r.details.reason), 'blood pressure') && !['declined', 'cancelled'].includes(r.status),
  );
  if (offerSuggestion && planCallsForBpRecheck(p) && !hasRecheck) {
    const visit = DateTime.fromISO(p.last_visit.date).toFormat('LLL d');
    turn.say(`Happy to help, ${turn.name}. Is this for the blood pressure recheck ${providerShort(p.last_visit.provider)} asked for after your ${visit} visit, or for something else?`);
    turn.expects = {
      kind: 'appointment_reason',
      suggested_reason: 'Blood pressure recheck',
      provider: p.last_visit.provider,
      context: recheckContext(p),
      pending_when: when,
      origin_message_ids: [ctx.inbound.id],
    };
  } else {
    turn.say(`Happy to help, ${turn.name}. What is the visit for?`);
    turn.expects = { kind: 'appointment_reason', suggested_reason: null, provider: null, context: null, pending_when: when, origin_message_ids: [ctx.inbound.id] };
  }
  turn.record({ kind: 'asked_followup', topic: 'appointment_reason' });
}

function withdrawAppointment(turn: Turn): void {
  const req = latestOpenAppointment(turn);
  if (!req) {
    turn.say("I don't see an open appointment request to withdraw.");
    turn.record({ kind: 'answered', topic: 'withdraw_request', source: 'requests' });
    return;
  }
  const d = req.details as AppointmentRequestDetailsT;
  turn.linkTo(req.id);
  turn.tools.amendRequest(req.id, { withdrawn_by_patient: true }, [turn.ctx.inbound.id], 'Patient withdrew the request');
  turn.record({ kind: 'request_updated', topic: 'appointment_request', request_id: req.id });
  turn.say(`Okay, I've let staff know you no longer need your ${lowerFirst(d.reason)} request (${describePreference(preferenceOf(d), turn.ctx.now)}).`);
}

function bookedAppointments(turn: Turn): Appointment[] {
  const today = turn.ctx.now.toISODate()!;
  return turn.ctx.patient.upcoming_appointments
    .filter((a) => a.status === 'booked' && a.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** True when the agent's last message in the thread was about `requestId` (so "cancel that" means it). */
function lastAgentMessageWasAbout(turn: Turn, requestId: string): boolean {
  const last = [...turn.ctx.thread].reverse().find((m) => m.author === 'agent' && m.id !== turn.ctx.inbound.id);
  return !!last?.meta.items?.some((i) => i.request_id === requestId);
}

function cancelBooked(turn: Turn, sched: Extract<Intent, { type: 'schedule' }> | null): void {
  const { ctx } = turn;
  const openReq = latestOpenAppointment(turn);
  const appt = bookedAppointments(turn)[0];
  if (sched && openReq) {
    const aboutRequest = /\b(recheck|request|blood pressure|bp)\b/.test(sched.text);
    const pronoun = /\bcancel (it|that|this)\b/.test(sched.text);
    if (aboutRequest || (pronoun && lastAgentMessageWasAbout(turn, openReq.id)) || !appt) return withdrawAppointment(turn);
    if (!sched.mentionsPhysical) {
      // Both a pending request and a booked appointment exist: ask instead of guessing.
      const d = openReq.details as AppointmentRequestDetailsT;
      turn.say(
        `Just to make sure I get this right: do you want to withdraw your ${lowerFirst(d.reason)} request (${describePreference(preferenceOf(d), ctx.now)}), or cancel your ${lowerFirst(appt.type)} on ${formatDate(appt.date, ctx.now)} at ${formatTime(appt.time)}?`,
      );
      turn.expects = { kind: 'cancel_target', request_id: openReq.id, appointment: appt };
      turn.record({ kind: 'asked_followup', topic: 'cancel_target' });
      return;
    }
  }
  if (!appt) {
    turn.say("I don't see any booked appointments on your record to cancel.");
    turn.record({ kind: 'answered', topic: 'cancel_appointment', source: 'record:upcoming_appointments' });
    return;
  }
  const when = `${formatDate(appt.date, ctx.now)} at ${formatTime(appt.time)}`;
  const policy = findFaq(ctx.clinic.faq, 'cancellations')?.text;
  const policyText = policy ? ` Cancellation policy: ${policy}` : '';
  const dup = turn.openRequests('appointment_request').find((r) => {
    const d = r.details as AppointmentRequestDetailsT;
    return d.action === 'cancel' && d.related_appointment?.date === appt.date && d.related_appointment?.time === appt.time;
  });
  if (dup) {
    turn.tools.amendRequest(dup.id, {}, [ctx.inbound.id]);
    turn.say(`Your request to cancel your ${lowerFirst(appt.type)} on ${when} is already with clinic staff, pending review. It stays booked until staff process the cancellation.`);
    turn.record({ kind: 'request_status', topic: 'appointment_request', request_id: dup.id });
    return;
  }
  const req = turn.tools.createRequest(
    'appointment_request',
    {
      action: 'cancel',
      reason: appt.type,
      provider: appt.provider,
      preferred_date: null,
      time_window: null,
      related_appointment: appt,
      patient_flexibility: '',
      clinical_context: null,
    },
    [ctx.inbound.id],
  );
  turn.record({ kind: 'request_created', topic: 'appointment_request', request_id: req.id });
  turn.say(
    `I can't cancel appointments myself, but I've sent your request to cancel your ${lowerFirst(appt.type)} with ${appt.provider} on ${when} to clinic staff. It stays booked until staff process the cancellation.${policyText}`,
  );
  turn.reviewNote = true;
}

function rescheduleBooked(turn: Turn, when: WhenSpec | null): void {
  const appt = bookedAppointments(turn)[0];
  if (!appt) {
    turn.say("I don't see any booked appointments on your record to reschedule. Would you like to request a new appointment instead?");
    turn.record({ kind: 'answered', topic: 'reschedule_appointment', source: 'record:upcoming_appointments' });
    return;
  }
  const flow: AppointmentFlow = {
    action: 'reschedule',
    reason: appt.type,
    provider: appt.provider,
    context: null,
    related_appointment: appt,
    origin_message_ids: [turn.ctx.inbound.id],
  };
  if (when) return createFromFlow(turn, flow, when);
  askForTime(turn, flow);
}

const APPT_KINDS = ['appointment_offer', 'time_preference', 'appointment_reason'];

export function isAppointmentExpectation(o: OpenExpectation | undefined): boolean {
  return !!o && APPT_KINDS.includes(o.expectation.kind);
}

/** Entry point. `ack` is the newest open question when the patient replied yes/no. */
export function handleScheduling(turn: Turn, ack: OpenExpectation | undefined): void {
  const { ctx } = turn;
  const pref = turn.intent('time_preference');
  const sched = turn.intent('schedule');
  const withdraw = turn.intent('withdraw_request');
  const ackAppt = isAppointmentExpectation(ack) ? ack : undefined;

  // Answer to "withdraw the request, or cancel the booked appointment?"
  const ct = turn.firstOpen(['cancel_target'], 0);
  if (ct?.expectation.kind === 'cancel_target') {
    const t = turn.interpretation.normalized;
    if (/\b(physical|annual|january|jan|appointment on)\b/.test(t)) {
      turn.answer(ct);
      return cancelBooked(turn, null);
    }
    if (/\b(recheck|request|blood pressure|bp|withdraw|november|nov)\b/.test(t)) {
      turn.answer(ct);
      return withdrawAppointment(turn);
    }
    if (turn.has('deny')) {
      turn.answer(ct);
      turn.say("Okay, I won't change anything.");
      turn.record({ kind: 'acknowledged', topic: 'cancel_target' });
      return;
    }
  }

  if (withdraw && withdraw.about !== 'refill' && !pref) {
    if (!withdraw.weak) return withdrawAppointment(turn);
    // "nvm / scratch that" withdraws only when nothing is being asked and we just discussed the request.
    const openReq = latestOpenAppointment(turn);
    if (!ack && openReq && lastAgentMessageWasAbout(turn, openReq.id)) return withdrawAppointment(turn);
  }
  if (sched?.action === 'cancel') return cancelBooked(turn, sched);
  if (sched?.action === 'reschedule') {
    const openReq = latestOpenAppointment(turn);
    if (sched.mentionsPhysical || !openReq) return rescheduleBooked(turn, pref?.when ?? null);
    if (pref) return updateFromPreference(turn, openReq, pref.when);
  }

  // Free-text answer to "What is the visit for?"
  const reasonExp = turn.firstOpen(['appointment_reason'], 0);
  if (
    reasonExp?.expectation.kind === 'appointment_reason' &&
    !reasonExp.expectation.suggested_reason &&
    !turn.has('affirm') &&
    !turn.has('deny') &&
    (turn.has('unknown') || turn.has('clinical_question'))
  ) {
    const e = reasonExp.expectation;
    turn.answer(reasonExp);
    const flow: AppointmentFlow = {
      action: 'schedule',
      reason: capitalize(ctx.inbound.body.trim().replace(/[.!?]+$/, '')).slice(0, 120),
      provider: e.provider,
      context: null,
      related_appointment: null,
      origin_message_ids: uniq([...e.origin_message_ids, ctx.inbound.id]),
    };
    return e.pending_when ? createFromFlow(turn, flow, e.pending_when) : askForTime(turn, flow);
  }

  if (!pref && ackAppt) {
    const e = ackAppt.expectation;
    const denied = turn.has('deny') && !turn.has('affirm');
    if (e.kind === 'appointment_reason') {
      turn.answer(ackAppt);
      if (denied || !e.suggested_reason) return askReason(turn, e.pending_when, false);
      const flow: AppointmentFlow = {
        action: 'schedule',
        reason: e.suggested_reason,
        provider: e.provider,
        context: e.context,
        related_appointment: null,
        origin_message_ids: uniq([...e.origin_message_ids, ctx.inbound.id]),
      };
      return e.pending_when ? createFromFlow(turn, flow, e.pending_when) : askForTime(turn, flow);
    }
    if (e.kind === 'appointment_offer' || e.kind === 'time_preference') {
      if (denied) {
        turn.answer(ackAppt);
        turn.say(`No problem, I won't request a time for now. If you'd like to schedule your ${lowerFirst(e.flow.reason)} later, just text us here.`);
        turn.record({ kind: 'acknowledged', topic: 'declined_appointment_offer' });
        return;
      }
      return e.kind === 'appointment_offer' ? askForTime(turn, e.flow, ackAppt) : reaskTime(turn, ackAppt, e.flow);
    }
  }

  const openReq = latestOpenAppointment(turn);
  if (pref) {
    const exp = turn.firstOpen(['time_preference', 'appointment_offer']);
    if (exp && (exp.expectation.kind === 'time_preference' || exp.expectation.kind === 'appointment_offer')) {
      return createFromFlow(turn, exp.expectation.flow, pref.when, exp);
    }
    const reasonOpen = turn.firstOpen(['appointment_reason'], 2);
    if (reasonOpen?.expectation.kind === 'appointment_reason' && turn.has('affirm') && reasonOpen.expectation.suggested_reason) {
      turn.answer(reasonOpen);
      const e = reasonOpen.expectation;
      return createFromFlow(turn, { ...bpRecheckFlow(turn, uniq([...e.origin_message_ids, ctx.inbound.id])), reason: e.suggested_reason! }, pref.when);
    }
    if (openReq && !sched?.explicitNew) return updateFromPreference(turn, openReq, pref.when);
    if (sched?.mentionsBp) return createFromFlow(turn, bpRecheckFlow(turn, [ctx.inbound.id]), pref.when);
    return askReason(turn, pref.when, true);
  }

  if (sched) {
    if (openReq && !sched.explicitNew) {
      const d = openReq.details as AppointmentRequestDetailsT;
      turn.say(
        `You already have a request for ${withArticle(lowerFirst(d.reason))} on ${describePreference(preferenceOf(d), ctx.now)}; it's pending staff review and isn't booked yet. If you'd like a different day or time, just let me know.`,
      );
      turn.record({ kind: 'request_status', topic: 'appointment_request', request_id: openReq.id });
      return;
    }
    const offer = turn.firstOpen(['appointment_offer']);
    if (offer?.expectation.kind === 'appointment_offer') return askForTime(turn, offer.expectation.flow, offer);
    if (sched.mentionsBp) return askForTime(turn, bpRecheckFlow(turn, [ctx.inbound.id]));
    return askReason(turn, null, true);
  }
}
