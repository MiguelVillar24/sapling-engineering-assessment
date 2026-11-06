import { useState } from 'react';
import { STATUS_LABEL } from '../lib/format';
import type { HandoffRequest, RequestStatus } from '../types';
import { RequestCard } from './RequestCard';

interface Props {
  requests: HandoffRequest[];
  onUpdate(id: string, patch: { status?: RequestStatus; staff_note?: string | null }): Promise<void>;
  onShowMessage(id: string): void;
}

/** Optional staff view: review requests and update status / notes. Staff carry out the actual action. */
export function StaffQueue({ requests, onUpdate, onShowMessage }: Props) {
  const [filter, setFilter] = useState<'open' | 'all' | RequestStatus>('open');
  const shown = requests
    .filter((r) => (filter === 'all' ? true : filter === 'open' ? ['pending_staff', 'in_progress'].includes(r.status) : r.status === filter))
    .sort((a, b) => (a.priority === b.priority ? a.id.localeCompare(b.id) : a.priority === 'urgent' ? -1 : 1));

  return (
    <div className="staff">
      <div className="staff-head">
        <div>
          <h2>Staff queue</h2>
          <p className="muted">
            Each request holds what staff need to act without texting Alex again. Booking, approving refills and answering clinical questions
            happen in the clinic’s own systems; here staff record the status. The agent reads this status when Alex asks.
          </p>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="open">Open (pending + in progress)</option>
          <option value="all">All</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 && <p className="muted">No requests match.</p>}
      <div className="staff-grid">
        {shown.map((r) => (
          <RequestCard key={`${r.id}-${r.revision}`} request={r} staffActions defaultOpen onUpdate={onUpdate} onShowMessage={onShowMessage} />
        ))}
      </div>
    </div>
  );
}
