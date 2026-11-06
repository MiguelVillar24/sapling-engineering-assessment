import type { Turn } from '../turn.js';
import { handleBilling } from './billing.js';
import { handleClinical } from './clinical.js';
import { handleSmallTalk, handleStaffHandoffs } from './conversation.js';
import { handleInfo } from './info.js';
import { handleRefill } from './refill.js';
import { handleScheduling } from './scheduling.js';
import { handleStatus } from './status.js';

/**
 * Runs every policy over one interpreted message. Each policy reads the intents
 * it owns, may call tools, and adds a paragraph to the reply, so one text can
 * be answered on several topics. Order = order of paragraphs in the reply.
 */
export function respond(turn: Turn): void {
  // A bare yes/no answers the newest open question in the thread (clinic or agent).
  const ack = (turn.has('affirm') || turn.has('deny')) && !turn.has('time_preference') ? turn.open[0] : undefined;
  handleClinical(turn);
  handleScheduling(turn, ack);
  handleStatus(turn);
  handleRefill(turn);
  handleBilling(turn);
  handleInfo(turn);
  handleStaffHandoffs(turn, ack);
  handleSmallTalk(turn);
}
