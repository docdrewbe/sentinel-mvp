import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettled,
  beginContext,
  canAct,
  initialPanels,
  panelData,
  pickerOrgIds,
  reopenBlockReason,
  requiredEvidenceFor,
  resolveOrgId,
  settlePanels,
  startBlockReason,
  submitBlockReason,
  submitStatusReason,
  verifyBlockReason,
  verifyEvidenceReason,
  verifyStatusReason
} from '../dashboard.js';
import type { ComplianceTask, DemoUser, Organization } from '../../shared/types.js';

const orgs: Organization[] = [
  { id: 'org-cah', name: 'Hospital', kind: 'hospital', beds: 25, location: 'x', createdAt: 't' },
  { id: 'org-clinic', name: 'Clinic', kind: 'clinic', location: 'x', createdAt: 't' },
  { id: 'org-canna', name: 'Cannabis', kind: 'cannabis_microbusiness', location: 'x', createdAt: 't' }
];

const user = (over: Partial<DemoUser> = {}): DemoUser => ({
  id: 'u',
  orgId: 'org-cah',
  name: 'N',
  role: 'staff',
  department: 'd',
  ...over
});

describe('org picker visibility (F3)', () => {
  it('shows scoped users only their own org', () => {
    assert.deepEqual(
      pickerOrgIds(orgs, user({ role: 'department_manager', orgId: 'org-cah' })),
      ['org-cah']
    );
    assert.deepEqual(
      pickerOrgIds(orgs, user({ id: 'u-clinic-staff', role: 'staff', orgId: 'org-clinic' })),
      ['org-clinic']
    );
    assert.deepEqual(
      pickerOrgIds(orgs, user({ id: 'u-canna-mgr', role: 'department_manager', orgId: 'org-canna' })),
      ['org-canna']
    );
  });

  it('shows all orgs to admin and officer', () => {
    assert.deepEqual(pickerOrgIds(orgs, user({ role: 'administrator' })), [
      'org-cah',
      'org-clinic',
      'org-canna'
    ]);
    assert.deepEqual(pickerOrgIds(orgs, user({ role: 'compliance_officer' })), [
      'org-cah',
      'org-clinic',
      'org-canna'
    ]);
  });

  it('shows all orgs while the user is still loading', () => {
    assert.deepEqual(pickerOrgIds(orgs, null), ['org-cah', 'org-clinic', 'org-canna']);
  });
});

describe('user-switch org resolution (F3)', () => {
  it('moves hospital -> clinic staff to the clinic', () => {
    const clinicStaff = user({ id: 'u-clinic-staff', role: 'staff', orgId: 'org-clinic' });
    assert.equal(resolveOrgId(orgs, clinicStaff, 'org-cah'), 'org-clinic');
  });

  it('moves hospital -> cannabis manager to the cannabis org', () => {
    const cannaMgr = user({ id: 'u-canna-mgr', role: 'department_manager', orgId: 'org-canna' });
    assert.equal(resolveOrgId(orgs, cannaMgr, 'org-cah'), 'org-canna');
  });

  it('keeps admin and officer on a foreign org', () => {
    assert.equal(
      resolveOrgId(orgs, user({ role: 'administrator', orgId: 'org-cah' }), 'org-clinic'),
      'org-clinic'
    );
    assert.equal(
      resolveOrgId(orgs, user({ role: 'compliance_officer', orgId: 'org-cah' }), 'org-canna'),
      'org-canna'
    );
  });

  it('keeps visible orgs and passes through while loading', () => {
    const mgr = user({ role: 'department_manager', orgId: 'org-cah' });
    assert.equal(resolveOrgId(orgs, mgr, 'org-cah'), 'org-cah');
    assert.equal(resolveOrgId(orgs, null, 'org-cah'), 'org-cah');
    assert.equal(resolveOrgId([], mgr, ''), '');
  });
});

describe('settled panel merge (F3)', () => {
  it('keeps fulfilled panels and reports only the failed ones', () => {
    const { values, errors } = settlePanels(
      { status: 'rejected', reason: new Error("Organization not visible to role 'staff'.") },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] }
    );
    assert.ok(!('tasks' in values), 'failed panel must not overwrite prior tasks');
    assert.deepEqual(values.domains, []);
    assert.deepEqual(values.audit, []);
    assert.deepEqual(values.templates, []);
    assert.deepEqual(Object.keys(errors), ['tasks']);
    assert.match(errors.tasks as string, /not visible/);
  });

  it('preserves prior state when panels fail', () => {
    const prior: { tasks: unknown; domains: unknown } = { tasks: ['old'], domains: ['old'] };
    const { values, errors } = settlePanels(
      { status: 'rejected', reason: 'boom' },
      { status: 'rejected', reason: 'boom' },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] }
    );
    const next = { ...prior };
    if (values.tasks !== undefined) next.tasks = values.tasks;
    if (values.domains !== undefined) next.domains = values.domains;
    assert.deepEqual(next, prior);
    assert.deepEqual(errors.tasks, 'Load failed.');
  });

  it('reports no errors when everything loads', () => {
    const { values, errors } = settlePanels(
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] }
    );
    assert.deepEqual(errors, {});
    assert.equal(Object.keys(values).length, 4);
  });
});

describe('context-keyed panels (F3a)', () => {
  const KEY_A = 'u-admin|org-cah';
  const KEY_B = 'u-staff|org-clinic';

  const row = (id: string): ComplianceTask => ({ id }) as unknown as ComplianceTask;
  const fail = (message: string): { status: 'rejected'; reason: Error } => ({
    status: 'rejected',
    reason: new Error(message)
  });

  const loaded = (key: string) =>
    applySettled(beginContext('', key, initialPanels()), key, 1, key, 1,
      { status: 'fulfilled', value: [row('t1')] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });

  it('beginContext clears on change, preserves on same key', () => {
    const before = loaded(KEY_A);
    const cleared = beginContext(KEY_A, KEY_B, before);
    for (const name of ['tasks', 'domains', 'audit', 'templates'] as const) {
      assert.equal(cleared[name].key, KEY_B);
      assert.equal(cleared[name].status, 'loading');
      assert.deepEqual(cleared[name].data, []);
    }
    assert.strictEqual(beginContext(KEY_A, KEY_A, before), before);
  });

  it('applySettled after a change empties failed panels, loads the rest', () => {
    const cleared = beginContext(KEY_A, KEY_B, loaded(KEY_A));
    const next = applySettled(cleared, KEY_B, 2, KEY_B, 2,
      fail('boom'),
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });
    assert.equal(next.tasks.status, 'error');
    assert.deepEqual(next.tasks.data, []);
    assert.equal(next.tasks.error, 'boom');
    assert.equal(next.domains.status, 'loaded');
    assert.equal(next.audit.status, 'loaded');
    assert.equal(next.templates.status, 'loaded');
  });

  it('applySettled on a same-key refresh keeps prior rows and flags the error', () => {
    const before = loaded(KEY_A);
    const next = applySettled(before, KEY_A, 2, KEY_A, 2,
      fail('boom'),
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });
    assert.equal(next.tasks.status, 'loaded');
    assert.deepEqual(next.tasks.data, [{ id: 't1' }]);
    assert.equal(next.tasks.error, 'boom');
  });

  it('ignores responses for a stale context', () => {
    const current = beginContext(KEY_A, KEY_B, loaded(KEY_A));
    const next = applySettled(current, KEY_A, 1, KEY_B, 2,
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });
    assert.strictEqual(next, current);
  });

  it('ignores out-of-order responses for the same context', () => {
    const current = loaded(KEY_A);
    const late = applySettled(current, KEY_A, 1, KEY_A, 2,
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });
    assert.strictEqual(late, current);
  });

  it('gates rows and actions on loaded current-context panels', () => {
    const current = loaded(KEY_A);
    assert.deepEqual(panelData(current.tasks, KEY_A), [{ id: 't1' }]);
    assert.deepEqual(panelData(current.tasks, KEY_B), []);
    assert.equal(canAct(current.tasks, KEY_A), true);
    assert.equal(canAct(current.tasks, KEY_B), false);
    const cleared = beginContext(KEY_A, KEY_B, current);
    assert.deepEqual(panelData(cleared.tasks, KEY_B), []);
    assert.equal(canAct(cleared.tasks, KEY_B), false);
    const failed = applySettled(cleared, KEY_B, 2, KEY_B, 2,
      fail('x'),
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });
    assert.equal(canAct(failed.tasks, KEY_B), false);
    const staleOk = applySettled(current, KEY_A, 2, KEY_A, 2,
      fail('x'),
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });
    assert.deepEqual(panelData(staleOk.tasks, KEY_A), [{ id: 't1' }]);
    assert.equal(canAct(staleOk.tasks, KEY_A), false);
  });
});

describe('D4c authoritative evidence requirement (unit)', () => {
  it('uses the server count when present', () => {
    assert.equal(requiredEvidenceFor({ requiredEvidence: 1 }), 1);
    assert.equal(requiredEvidenceFor({ requiredEvidence: 2 }), 2);
  });

  it('returns unavailable (never a guessed 1) when absent', () => {
    assert.equal(requiredEvidenceFor({}), null);
    assert.equal(requiredEvidenceFor({ requiredEvidence: undefined }), null);
  });
});

describe('D4d submit tooltip (unit)', () => {
  it('uses singular wording for a shortfall of one', () => {
    assert.equal(
      submitBlockReason({ evidence: [], requiredEvidence: 1 }),
      'Add 1 more evidence item (1 required, 0 attached)'
    );
  });

  it('uses plural wording for larger shortfalls', () => {
    assert.equal(
      submitBlockReason({ evidence: [], requiredEvidence: 2 }),
      'Add 2 more evidence items (2 required, 0 attached)'
    );
  });

  it('never doubles the Requires prefix and clears when satisfied', () => {
    const reason = submitBlockReason({ evidence: [], requiredEvidence: 2 });
    assert.ok(reason && !reason.includes('Requires'));
    assert.equal(submitBlockReason({ evidence: [{}, {}], requiredEvidence: 2 }), null);
    assert.equal(submitBlockReason({ evidence: [] }), null);
  });
});

describe('D5 separation-of-duties hint (unit)', () => {
  const MSG = 'Separation of duties: verifier must differ from owner/submitter.';

  it('blocks the owner and the submitter of a submitted task', () => {
    const task = {
      ownerId: 'u-nurse-mgr',
      submittedBy: 'u-officer',
      submissions: [
        { seq: 1, submittedBy: 'u-officer', ownerAtSubmission: 'u-nurse-mgr', at: '2026-10-26T00:00:00.000Z' }
      ],
      status: 'submitted' as const
    };
    assert.equal(verifyBlockReason({ id: 'u-nurse-mgr' }, task), MSG);
    assert.equal(verifyBlockReason({ id: 'u-officer' }, task), MSG);
  });

  it('allows an independent verifier once a submission is recorded', () => {
    assert.equal(
      verifyBlockReason(
        { id: 'u-admin' },
        {
          ownerId: 'u-nurse-mgr',
          submittedBy: 'u-officer',
          submissions: [
            { seq: 1, submittedBy: 'u-officer', ownerAtSubmission: 'u-nurse-mgr', at: '2026-10-26T00:00:00.000Z' }
          ],
          status: 'submitted'
        }
      ),
      null
    );
  });

  it('D5c: fails closed on submitted tasks without submission history', () => {
    const unknown = 'Submitter unknown for this task — send it back and resubmit to establish a verifiable submission.';
    assert.equal(
      verifyBlockReason({ id: 'u-officer' }, { ownerId: 'u-staff', status: 'submitted' }),
      unknown
    );
    assert.equal(
      verifyBlockReason(
        { id: 'u-officer' },
        { ownerId: 'u-staff', submittedBy: 'u-staff', submissions: [], status: 'submitted' }
      ),
      unknown
    );
  });

  it('stays silent unless the task is submitted', () => {
    const own = { ownerId: 'u-officer', submittedBy: 'u-officer', status: 'open' as const };
    assert.equal(verifyBlockReason({ id: 'u-officer' }, own), null);
  });

  it('D5a: blocks owners at submission and while submitted, not just current', () => {
    const task = {
      ownerId: 'u-nurse-mgr',
      submittedBy: 'u-nurse-mgr',
      submissions: [
        { seq: 1, submittedBy: 'u-nurse-mgr', ownerAtSubmission: 'u-officer', at: '2026-10-26T00:00:00.000Z' }
      ],
      ownersWhileSubmitted: ['u-officer', 'u-nurse-mgr'],
      status: 'submitted' as const
    };
    assert.equal(verifyBlockReason({ id: 'u-officer' }, task), MSG);
    assert.equal(verifyBlockReason({ id: 'u-nurse-mgr' }, task), MSG);
    assert.equal(verifyBlockReason({ id: 'u-admin' }, task), null);
  });

  it('D5a: a handover before submission keeps the prior owner eligible', () => {
    const task = {
      ownerId: 'u-staff',
      submittedBy: 'u-staff',
      submissions: [
        { seq: 1, submittedBy: 'u-staff', ownerAtSubmission: 'u-staff', at: '2026-10-26T00:00:00.000Z' }
      ],
      status: 'submitted' as const
    };
    assert.equal(verifyBlockReason({ id: 'u-officer' }, task), null);
  });

  it('D5b: reports the deadlock when no privileged user remains eligible', () => {
    const task = {
      ownerId: 'u-staff',
      submittedBy: 'u-staff',
      submissions: [
        { seq: 1, submittedBy: 'u-admin', ownerAtSubmission: 'u-staff', at: '2026-10-26T00:00:00.000Z' },
        { seq: 2, submittedBy: 'u-officer', ownerAtSubmission: 'u-staff', at: '2026-10-26T00:00:00.000Z' }
      ],
      status: 'submitted' as const
    };
    const deadlocked = 'No eligible independent verifier: all privileged users submitted or owned this task.';
    assert.equal(verifyBlockReason({ id: 'u-admin' }, task, ['u-admin', 'u-officer']), deadlocked);
    assert.equal(verifyBlockReason({ id: 'u-officer' }, task, ['u-admin', 'u-officer']), deadlocked);
  });

  it('D5b: falls back to the SoD message when someone else could verify', () => {
    const task = {
      ownerId: 'u-staff',
      submittedBy: 'u-officer',
      submissions: [
        { seq: 1, submittedBy: 'u-officer', ownerAtSubmission: 'u-staff', at: '2026-10-26T00:00:00.000Z' }
      ],
      status: 'submitted' as const
    };
    assert.equal(verifyBlockReason({ id: 'u-officer' }, task, ['u-admin', 'u-officer']), MSG);
    assert.equal(verifyBlockReason({ id: 'u-officer' }, task), MSG);
    assert.equal(verifyBlockReason({ id: 'u-admin' }, task, ['u-admin', 'u-officer']), null);
  });
});

describe('action-button states (unit)', () => {
  it('Start is allowed from open and as a send-back from submitted', () => {
    assert.equal(startBlockReason({ status: 'open' }), null);
    assert.equal(startBlockReason({ status: 'submitted' }), null);
    assert.equal(startBlockReason({ status: 'in_progress' }), 'Already in progress.');
    assert.equal(startBlockReason({ status: 'verified' }), 'Verified records are locked.');
  });

  it('Submit status gate matches the legal transitions', () => {
    assert.equal(submitStatusReason({ status: 'open' }), null);
    assert.equal(submitStatusReason({ status: 'in_progress' }), null);
    assert.equal(submitStatusReason({ status: 'submitted' }), 'Already submitted.');
    assert.equal(submitStatusReason({ status: 'verified' }), 'Verified records are locked.');
  });

  it('Verify status gate allows submitted tasks only', () => {
    assert.equal(verifyStatusReason({ status: 'submitted' }), null);
    assert.equal(verifyStatusReason({ status: 'open' }), 'Only submitted tasks can be verified.');
    assert.equal(verifyStatusReason({ status: 'in_progress' }), 'Only submitted tasks can be verified.');
    assert.equal(verifyStatusReason({ status: 'verified' }), 'Already verified.');
  });

  it('Reopen is allowed from in-progress and submitted only', () => {
    assert.equal(reopenBlockReason({ status: 'in_progress' }), null);
    assert.equal(reopenBlockReason({ status: 'submitted' }), null);
    assert.equal(reopenBlockReason({ status: 'open' }), 'Already open.');
    assert.equal(reopenBlockReason({ status: 'verified' }), 'Verified records are locked.');
  });

  it('Verify evidence reason mirrors the server gate with singular/plural', () => {
    assert.equal(
      verifyEvidenceReason({ status: 'submitted', evidence: [], requiredEvidence: 1 }),
      'Needs 1 more evidence item before verification (1 required, 0 attached)'
    );
    assert.equal(
      verifyEvidenceReason({ status: 'submitted', evidence: [{}], requiredEvidence: 2 }),
      'Needs 1 more evidence item before verification (2 required, 1 attached)'
    );
    assert.equal(
      verifyEvidenceReason({ status: 'submitted', evidence: [], requiredEvidence: 2 }),
      'Needs 2 more evidence items before verification (2 required, 0 attached)'
    );
  });

  it('Verify evidence reason clears when satisfied, unknown, or not submitted', () => {
    assert.equal(
      verifyEvidenceReason({ status: 'submitted', evidence: [{}, {}], requiredEvidence: 2 }),
      null
    );
    assert.equal(verifyEvidenceReason({ status: 'submitted', evidence: [] }), null);
    assert.equal(verifyEvidenceReason({ status: 'open', evidence: [], requiredEvidence: 1 }), null);
  });
});
