import { DateTime } from 'luxon';
import type { BillingDetailsT } from '../../requests/request-types.js';
import { formatMoney } from '../text.js';
import type { Turn } from '../turn.js';

/** Billing questions are answered from the record + FAQ; disputes and payment plans go to staff. */

export function balanceExplanation(turn: Turn): string {
  const p = turn.ctx.patient;
  const { amount, reason } = p.balance;
  if (amount <= 0) return "Your record shows you don't have a balance right now.";
  const copay = reason.match(/^copay for (.+?) visit$/i);
  if (copay) {
    const visitDate = DateTime.fromFormat(copay[1], 'LLL d, yyyy');
    const lastVisitMatches = visitDate.isValid && visitDate.toISODate() === p.last_visit.date;
    const extra = lastVisitMatches ? ` (${p.last_visit.reason.toLowerCase()} with ${p.last_visit.provider})` : '';
    return `Your ${formatMoney(amount)} balance is the copay for your ${copay[1]} visit${extra}.`;
  }
  return `Your ${formatMoney(amount)} balance is for: ${reason}.`;
}

function paymentOptions(turn: Turn): string {
  const { paymentUrl, phoneDisplay } = turn.ctx.clinic;
  const online = paymentUrl ? `online at ${paymentUrl}` : null;
  const phone = phoneDisplay ? `by phone at ${phoneDisplay} during business hours` : 'by phone during business hours';
  return `You can pay ${online ? `${online}, or ` : ''}${phone}.`;
}

export function handleBilling(turn: Turn): void {
  const { ctx } = turn;
  const p = ctx.patient;
  const issue = turn.intent('billing_issue');
  const question = turn.intent('billing_question');
  const payHow = turn.interpretation.intents.some((i) => i.type === 'faq' && i.topic === 'payment');

  if (issue) {
    const existing = turn.openRequests('billing')[0];
    if (existing) {
      turn.tools.amendRequest(existing.id, { patient_statement: `${(existing.details as BillingDetailsT).patient_statement}\n${ctx.inbound.body}` }, [ctx.inbound.id]);
      turn.record({ kind: 'request_updated', topic: 'billing', request_id: existing.id });
      turn.say("I've added this to your billing question that's already with clinic staff. It's pending staff review.");
    } else {
      const details: BillingDetailsT = {
        issue: issue.issue,
        patient_statement: ctx.inbound.body,
        balance_on_file: p.balance.amount > 0 ? p.balance : null,
        payment_link_shared: null,
      };
      const req = turn.tools.createRequest('billing', details, [ctx.inbound.id]);
      turn.record({ kind: 'request_created', topic: 'billing', request_id: req.id });
      turn.say(
        `I've passed your billing question to clinic staff along with your account details (balance on file: ${formatMoney(p.balance.amount)}, ${p.balance.reason.toLowerCase()}). It's pending staff review.`,
      );
    }
    turn.reviewNote = true;
    return;
  }

  if (question) {
    let s = balanceExplanation(turn);
    if (question.amount !== null && Math.abs(question.amount - p.balance.amount) > 0.005) {
      s += ` (Our records show ${formatMoney(p.balance.amount)}, not ${formatMoney(question.amount)}.)`;
    }
    if (p.balance.amount > 0) s += ` ${paymentOptions(turn)}`;
    turn.say(s);
    turn.record({ kind: 'answered', topic: 'billing', source: 'record:balance + faq:payment' });
    return;
  }

  if (payHow) {
    const owed = p.balance.amount > 0 ? ` ${balanceExplanation(turn)}` : '';
    turn.say(`${paymentOptions(turn)}${owed}`);
    turn.record({ kind: 'answered', topic: 'payment', source: 'faq:payment' });
  }
}
