import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/core/requests/request-service.js';
import { testCore } from './helpers.js';

const refillDetails = {
  medication: 'Lisinopril',
  dose: '10 mg',
  frequency: 'once daily',
  refills_remaining: 0,
  pharmacy: 'Elm Street Pharmacy, (555) 010-0142',
  needs_prescriber_approval: true,
  prescriber_context: null,
  patient_message: 'refill please',
};

describe('RequestService invariants', () => {
  it('new requests always start as pending_staff with an audit event', () => {
    const core = testCore();
    const r = core.requests.create({ patientId: 'pt_001', conversationId: null, type: 'refill', details: refillDetails, sourceMessageIds: ['m1', 'm1'] });
    expect(r).toMatchObject({ id: 'req_001', status: 'pending_staff', revision: 1, source_message_ids: ['m1'] });
    expect(core.requests.events(r.id)).toMatchObject([{ kind: 'created', actor: 'agent' }]);
  });

  it('rejects unknown request types and invalid details (structured fields are enforced)', () => {
    const core = testCore();
    const create = (type: string, details: Record<string, unknown>) =>
      core.requests.create({ patientId: 'pt_001', conversationId: null, type: type as 'refill', details, sourceMessageIds: [] });
    expect(() => create('booking', refillDetails)).toThrow(DomainError);
    expect(() => create('refill', { ...refillDetails, dose: undefined })).toThrow(/Invalid refill details/);
    expect(() => create('appointment_request', { action: 'book_it' })).toThrow(DomainError);
    expect(core.requests.list()).toEqual([]);
  });

  it('amend keeps the same id, bumps the revision, appends sources and records a diff', () => {
    const core = testCore();
    const r = core.requests.create({ patientId: 'pt_001', conversationId: null, type: 'refill', details: refillDetails, sourceMessageIds: ['m1'] });
    const u = core.requests.amend(r.id, { details: { patient_message: 'still need it' }, addSourceMessageIds: ['m2', 'm1'] });
    expect(u).toMatchObject({ id: r.id, revision: 2, source_message_ids: ['m1', 'm2'], status: 'pending_staff' });
    const ev = core.requests.events(r.id)[1];
    expect(ev.kind).toBe('updated');
    expect(ev.changes.patient_message).toEqual({ from: 'refill please', to: 'still need it' });
  });

  it('a patient change to an in-progress request sends it back to staff review', () => {
    const core = testCore();
    const r = core.requests.create({ patientId: 'pt_001', conversationId: null, type: 'refill', details: refillDetails, sourceMessageIds: ['m1'] });
    core.requests.setStatus(r.id, 'in_progress');
    expect(core.requests.amend(r.id, { addSourceMessageIds: ['m3'] }).status).toBe('pending_staff');
  });

  it('closed requests cannot be changed by the agent', () => {
    const core = testCore();
    const r = core.requests.create({ patientId: 'pt_001', conversationId: null, type: 'refill', details: refillDetails, sourceMessageIds: ['m1'] });
    core.requests.setStatus(r.id, 'completed', 'Sent to pharmacy');
    expect(() => core.requests.amend(r.id, { addSourceMessageIds: ['m2'] })).toThrow(/can no longer be changed/);
  });

  it('staff status changes are validated and audited', () => {
    const core = testCore();
    const r = core.requests.create({ patientId: 'pt_001', conversationId: null, type: 'refill', details: refillDetails, sourceMessageIds: ['m1'] });
    expect(() => core.requests.setStatus(r.id, 'booked')).toThrow(/Unknown status/);
    expect(() => core.requests.setStatus('req_999', 'completed')).toThrow(/not found/);
    const u = core.requests.setStatus(r.id, 'in_progress', 'Calling pharmacy');
    expect(u).toMatchObject({ status: 'in_progress', staff_note: 'Calling pharmacy' });
    expect(core.requests.events(r.id).at(-1)).toMatchObject({ actor: 'staff', kind: 'status_changed', changes: { status: { from: 'pending_staff', to: 'in_progress' } } });
  });
});
