import type { OtherDetailsT } from '../../requests/request-types.js';
import type { OpenExpectation } from '../dialogue.js';
import { lowerFirst } from '../text.js';
import type { Turn } from '../turn.js';

/** Staff handoffs that come from conversation itself, plus small talk and fallbacks. */

export function handleStaffHandoffs(turn: Turn, ack: OpenExpectation | undefined): void {
  const { ctx } = turn;

  // Yes / no to "Would you like me to pass this question to clinic staff?"
  if (ack?.expectation.kind === 'staff_handoff_offer') {
    const e = ack.expectation;
    if (turn.has('affirm') && !turn.has('deny')) {
      turn.answer(ack);
      const offerMsg = ctx.thread.find((m) => m.id === ack.messageId);
      const sources = [offerMsg?.in_reply_to, ctx.inbound.id].filter((x): x is string => !!x);
      const details = e.request.details as OtherDetailsT;
      const dup = turn
        .openRequests(e.request.type)
        .find((r) => (r.details as OtherDetailsT).reason === details.reason && (r.details as OtherDetailsT).question === details.question);
      if (dup) {
        turn.tools.amendRequest(dup.id, {}, sources);
        turn.say('That question is already with clinic staff and is pending review.');
        turn.record({ kind: 'request_status', topic: e.request.type, request_id: dup.id });
      } else {
        const req = turn.tools.createRequest(e.request.type, e.request.details, sources);
        turn.say(`Okay, I've passed your question to clinic staff${details.question ? `: "${details.question}"` : ''}. It's pending staff review.`);
        turn.record({ kind: 'request_created', topic: e.request.type, request_id: req.id });
      }
      turn.reviewNote = true;
    } else if (turn.has('deny')) {
      turn.answer(ack);
      turn.say("Okay, I won't pass it along. Let me know if there's anything else I can help with.");
      turn.record({ kind: 'acknowledged', topic: 'declined_staff_handoff' });
    }
  }

  // A reply to a free-form question that clinic staff typed: forward it to staff.
  const sq = turn.firstOpen(['staff_question'], 3);
  if (sq?.expectation.kind === 'staff_question' && sq.author === 'clinic_staff') {
    turn.answer(sq);
    const req = turn.tools.createRequest(
      'other',
      {
        reason: 'reply_to_staff_message',
        question: sq.expectation.question,
        patient_message: ctx.inbound.body,
        context: { staff_message_id: sq.messageId },
      },
      [sq.messageId, ctx.inbound.id],
    );
    turn.say(`Thanks, ${turn.name}. I've passed your reply on to the clinic staff.`);
    turn.record({ kind: 'request_created', topic: 'other', request_id: req.id });
    turn.reviewNote = true;
  }

  if (turn.has('talk_to_staff')) {
    const existing = turn.openRequests('other').find((r) => (r.details as OtherDetailsT).reason === 'patient_requested_staff_contact');
    if (existing) {
      turn.tools.amendRequest(existing.id, {}, [ctx.inbound.id]);
      turn.record({ kind: 'request_updated', topic: 'other', request_id: existing.id });
    } else {
      const req = turn.tools.createRequest(
        'other',
        { reason: 'patient_requested_staff_contact', question: null, patient_message: ctx.inbound.body, context: {} },
        [ctx.inbound.id],
      );
      turn.record({ kind: 'request_created', topic: 'other', request_id: req.id });
    }
    turn.say(
      `I've let clinic staff know you'd like to talk with someone; it's pending staff review. You can also call the clinic at ${ctx.clinic.phoneDisplay ?? 'the clinic number'} during business hours.`,
    );
    turn.reviewNote = true;
  }
}

export function handleSmallTalk(turn: Turn): void {
  if (turn.spoke) return;
  const { ctx } = turn;
  if (turn.has('greeting') && !turn.has('unknown')) {
    turn.say(
      `Hi ${turn.name}! How can I help? I can answer questions about your appointments, balance and clinic hours, or pass requests like refills to clinic staff.`,
    );
    turn.record({ kind: 'acknowledged', topic: 'greeting' });
    return;
  }
  if (turn.has('thanks')) {
    turn.say(`You're welcome, ${turn.name}!`);
    turn.record({ kind: 'acknowledged', topic: 'thanks' });
    return;
  }
  if (turn.has('goodbye')) {
    turn.say(`Take care, ${turn.name}!`);
    turn.record({ kind: 'acknowledged', topic: 'goodbye' });
    return;
  }
  if (turn.has('affirm') || turn.has('deny')) {
    turn.say(turn.has('affirm') ? 'Got it. Is there anything I can help you with?' : "Okay. Let me know if there's anything I can help with.");
    turn.record({ kind: 'acknowledged', topic: 'yes_no_without_question' });
    return;
  }
  // Not understood, right after the clinic's offer: re-ask the offer instead of derailing to staff.
  const offer = turn.firstOpen(['appointment_offer'], 1);
  if (offer?.expectation.kind === 'appointment_offer') {
    turn.say(
      `Sorry, I didn't quite catch that. Would you like us to request a time for your ${lowerFirst(offer.expectation.flow.reason)}? You can reply "yes" or "no".`,
    );
    turn.expects = offer.expectation;
    turn.record({ kind: 'asked_followup', topic: 'appointment_offer' });
    return;
  }
  const waiting = turn.firstOpen(['time_preference'], 2);
  if (waiting?.expectation.kind === 'time_preference') {
    turn.say(
      `Whenever you're ready, just reply with a day and time that work for your ${lowerFirst(waiting.expectation.flow.reason)} (for example, "Tuesday afternoon").`,
    );
    turn.record({ kind: 'asked_followup', topic: 'appointment_time' });
    return;
  }
  turn.say(
    "I'm sorry, I'm not sure I understood. I can help with appointment requests, refills, billing questions and clinic information. Would you like me to pass your message to clinic staff?",
  );
  turn.expects = {
    kind: 'staff_handoff_offer',
    topic: 'general',
    request: { type: 'other', details: { reason: 'general_question', question: null, patient_message: ctx.inbound.body, context: {} } },
  };
  turn.record({ kind: 'not_understood', topic: 'unknown' });
}
