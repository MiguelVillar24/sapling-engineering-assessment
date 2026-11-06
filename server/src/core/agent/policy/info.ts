import type { DateTime } from 'luxon';
import { findFaq, hoursSummary } from '../../clinic-data/faq.js';
import { DateTime as LuxonDateTime } from 'luxon';
import { clinicDayStatus, type DayStatus, federalHolidays, formatDate, formatTime, minutesOf, nextOpenDay, weekdayName } from '../../time/calendar.js';
import type { DayRef } from '../interpreter.js';
import { capitalize } from '../text.js';
import type { Turn } from '../turn.js';
import { balanceExplanation } from './billing.js';

/**
 * Answers that come straight from the FAQ or the patient record. The FAQ is the
 * only source of clinic policy: anything it does not cover is "unavailable".
 */

function resolveDay(now: DateTime, day: DayRef | null): DateTime {
  if (!day || day.kind === 'today') return now;
  if (day.kind === 'holiday') {
    const today = now.toISODate()!;
    const next = [...federalHolidays(now.year), ...federalHolidays(now.year + 1)].find((h) => h.name === day.name && h.date >= today);
    return next ? LuxonDateTime.fromISO(next.date, { zone: now.zoneName ?? undefined }) : now;
  }
  if (day.kind === 'tomorrow') return now.plus({ days: 1 }).startOf('day');
  let d = now.startOf('day');
  while (d.weekday !== day.day) d = d.plus({ days: 1 });
  return d;
}

/** Why the clinic is closed that day; the weekday is named only when the label doesn't already say it. */
function closedReason(d: DateTime, st: Extract<DayStatus, { open: false }>, labelHasWeekday: boolean): string {
  const day = labelHasWeekday ? '' : `(${weekdayName(d.weekday)})`;
  if (st.reason === 'holiday') return `for ${st.holiday}`;
  if (st.reason === 'weekend') return day ? `${day}; the clinic is closed on weekends` : '; the clinic is closed on weekends';
  return day;
}

function handleHours(turn: Turn): void {
  const ask = turn.intent('clinic_hours');
  if (!ask) return;
  const { ctx } = turn;
  const faqHours = findFaq(ctx.clinic.faq, 'hours');
  const hours = ctx.clinic.hours;
  turn.record({ kind: 'answered', topic: 'clinic_hours', source: 'faq:hours' });
  if (!hours) {
    turn.say(`Our hours: ${faqHours?.text ?? 'please call the clinic during business hours.'}`);
    return;
  }
  const now = ctx.now;
  const d = resolveDay(now, ask.day);
  const isToday = d.hasSame(now, 'day');
  const label = isToday ? 'today' : d.hasSame(now.plus({ days: 1 }), 'day') ? 'tomorrow' : `on ${formatDate(d.toISODate()!, now)}`;
  /** "today"/"tomorrow" need the weekday spelled out; "on Saturday, Nov 7" already has it. */
  const relative = label === 'today' || label === 'tomorrow';
  const sep = (reason: string) => (!reason ? '' : reason.startsWith(';') ? reason : ` ${reason}`);
  const st = clinicDayStatus(d, hours);
  const open = formatTime(hours.open);
  const close = formatTime(hours.close);
  const nowMin = now.hour * 60 + now.minute;
  const next = nextOpenDay(d, hours);
  const nextText = next
    ? ` We're open again ${next.hasSame(now.plus({ days: 1 }), 'day') ? 'tomorrow' : `on ${formatDate(next.toISODate()!, now)}`} from ${open} Pacific.`
    : '';

  if (ask.ask === 'hours') {
    let s = `Our hours are ${faqHours!.text}`;
    if (ask.day) s += st.open ? ` ${capitalize(label)}, we're open ${open}–${close} Pacific.` : ` We're closed ${label}${sep(closedReason(d, st, !relative))}.`;
    turn.say(s);
    return;
  }
  if (!st.open) {
    const regular = relative ? '' : ` Our regular hours are ${hoursSummary(ctx.clinic.faq)}.`;
    turn.say(`We're closed ${label}${sep(closedReason(d, st, !relative))}.${isToday || ask.ask !== 'open_on_day' ? nextText : ''}${regular}`);
    return;
  }
  if (!isToday) {
    if (ask.ask === 'close_time') turn.say(`${capitalize(label)}, we close at ${close} Pacific (we're open ${open}–${close}).`);
    else if (ask.ask === 'open_time') turn.say(`${capitalize(label)}, we open at ${open} Pacific (we're open ${open}–${close}).`);
    else turn.say(`Yes, we're open ${label}, ${open}–${close} Pacific.`);
    return;
  }
  const beforeOpen = nowMin < minutesOf(hours.open);
  const afterClose = nowMin >= minutesOf(hours.close);
  if (ask.ask === 'close_time') {
    turn.say(afterClose ? `We closed at ${close} Pacific today.${nextText}` : `We close at ${close} Pacific today (${weekdayName(now.weekday)}).`);
  } else if (ask.ask === 'open_time') {
    turn.say(beforeOpen ? `We open at ${open} Pacific today.` : afterClose ? `We're closed for the day (we closed at ${close} Pacific).${nextText}` : `We're open now, until ${close} Pacific today.`);
  } else {
    turn.say(beforeOpen ? `We open at ${open} Pacific today and close at ${close} Pacific.` : afterClose ? `We're closed for the day; we closed at ${close} Pacific.${nextText}` : `Yes, we're open now, until ${close} Pacific today.`);
  }
}

function handleFaqTopics(turn: Turn): void {
  const { ctx } = turn;
  const faq = (key: string) => findFaq(ctx.clinic.faq, key)?.text;
  for (const i of turn.intents('faq')) {
    if (i.topic === 'payment') continue; // answered with the balance in billing.ts
    const text = faq(i.topic === 'parking' ? 'address' : i.topic);
    if (!text) continue;
    switch (i.topic) {
      case 'address':
        turn.say(`Our address is ${text}`);
        break;
      case 'parking': {
        const parking = text.split(/(?<=\.)\s+/).find((s) => /park/i.test(s)) ?? text;
        turn.say(`${parking} Our address is ${text.split(/(?<=\.)\s+/)[0]}`);
        break;
      }
      case 'phone':
        turn.say(`You can call the clinic at ${ctx.clinic.phoneDisplay ?? text} during business hours (${hoursSummary(ctx.clinic.faq)}).`);
        break;
      case 'texting':
        turn.say(capitalize(text));
        break;
      case 'what_to_bring':
        turn.say(`Please bring ${text}`);
        break;
      case 'cancellations':
        turn.say(`For cancellations, ${text}`);
        break;
    }
    turn.record({ kind: 'answered', topic: i.topic, source: `faq:${i.topic === 'parking' ? 'address' : i.topic}` });
  }
}

function handleRecordInfo(turn: Turn): void {
  const { ctx } = turn;
  const p = ctx.patient;
  for (const i of turn.intents('record_info')) {
    switch (i.field) {
      case 'medications':
        turn.say(
          p.medications.length
            ? `Your record lists ${p.medications.map((m) => `${m.name} ${m.dose}, ${m.frequency}`).join('; ')}. If you have questions about a medication, I can pass them to a clinician.`
            : "I don't see any medications on your record.",
        );
        break;
      case 'pharmacy':
        turn.say(`Your pharmacy on file is ${p.pharmacy}.`);
        break;
      case 'insurance':
        turn.say(`We have ${p.insurance.payer} (${p.insurance.plan}) on file for you.`);
        break;
      case 'last_visit':
        turn.say(`Your last visit was on ${formatDate(p.last_visit.date, ctx.now)} with ${p.last_visit.provider} (${p.last_visit.reason.toLowerCase()}).`);
        break;
      case 'balance':
        turn.say(balanceExplanation(turn));
        break;
    }
    turn.record({ kind: 'answered', topic: i.field, source: `record:${i.field}` });
  }
  if (turn.has('identity')) {
    turn.say(
      "I'm Sapling Family Clinic's automated text assistant. I can answer questions from your record and the clinic FAQ, and pass requests to clinic staff. Texts are read by staff during business hours and aren't monitored continuously.",
    );
    turn.record({ kind: 'answered', topic: 'identity', source: 'faq:texting' });
  }
}

/** "Do you take Aetna?" — not in the FAQ, so: unavailable, no guessing, offer to ask staff. */
function handleInsurance(turn: Turn): void {
  const ins = turn.intent('insurance_accepted');
  if (!ins) return;
  const p = turn.ctx.patient;
  const onFile = `${p.insurance.payer} ${p.insurance.plan}`;
  const payer = ins.payer ?? (ins.mine ? onFile : null);
  const which = payer ? `, so I can't say whether ${payer} is accepted` : '';
  turn.say(
    `I'm sorry, I don't have information about which insurance plans the clinic accepts${which}.${ins.mine && !ins.payer ? ` (We have ${onFile} on file for you.)` : ''} Would you like me to pass this question to clinic staff?`,
  );
  turn.expects = {
    kind: 'staff_handoff_offer',
    topic: 'insurance',
    request: {
      type: 'other',
      details: {
        reason: 'insurance_question',
        question: `Does the clinic accept ${payer ?? "the patient's insurance plan"}?`,
        patient_message: turn.ctx.inbound.body,
        context: { payer_asked_about: payer, insurance_on_file: onFile },
      },
    },
  };
  turn.record({ kind: 'offered_handoff', topic: 'insurance', source: 'faq (not covered)' });
}

export function handleInfo(turn: Turn): void {
  handleInsurance(turn);
  handleHours(turn);
  handleFaqTopics(turn);
  handleRecordInfo(turn);
}
