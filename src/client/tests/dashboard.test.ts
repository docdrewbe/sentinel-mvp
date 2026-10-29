import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCAUDIT_KEYS_UNAVAILABLE_CODE,
  DOCAUDIT_SAMPLE_A,
  DOCAUDIT_SAMPLE_B,
  DOCAUDIT_SUMMARY_MAX,
  DOCAUDIT_TASK_TITLE_MAX,
  DOCAUDIT_TEXT_MAX,
  FOLLOWUP_EVIDENCE_NOTE,
  applyOneSettled,
  applySettled,
  beginContext,
  buildFollowupPreview,
  canAct,
  calendarBucket,
  capaAdvanceBlockReason,
  capaReviewBlockReason,
  findingBlockers,
  findingKindLabel,
  followupSettleAction,
  initialPanels,
  occurrenceLabel,
  occurrencesTruncated,
  resolveFollowupKey,
  shouldApplyDocAuditResponse,
  evidenceLockedReason,
  isDueSoonWork,
  isOverdueWork,
  linkedCapaLine,
  newObligationBlockReason,
  overdueBadgeLabel,
  panelData,
  pickerOrgIds,
  reopenBlockReason,
  requiredEvidenceFor,
  resolveOrgId,
  reviewEvidenceLabels,
  settlePanels,
  startBlockReason,
  startButtonLabel,
  submitBlockReason,
  submitStatusReason,
  triageUsersFor,
  verifyBlockReason,
  verifyEvidenceReason,
  verifyStatusReason,
  verifiedLockNoteId
} from '../dashboard.js';
// Test-only cross-layer pin: the client mirrors these server constants.
import {
  DOCAUDIT_MAX_SUMMARY_CHARS,
  DOCAUDIT_MAX_TEXT_CHARS,
  FOLLOWUPS_UNAVAILABLE_CODE
} from '../../server/docaudit.js';
import type { CapaRecord, CapaStatus, ComplianceTask, DemoUser, Organization } from '../../shared/types.js';

const orgs: Organization[] = [
  { id: 'org-cah', name: 'Hospital', kind: 'hospital', beds: 25, location: 'x', timeZone: 'America/Chicago', createdAt: 't' },
  { id: 'org-clinic', name: 'Clinic', kind: 'clinic', location: 'x', timeZone: 'America/Chicago', createdAt: 't' },
  { id: 'org-canna', name: 'Cannabis', kind: 'cannabis_microbusiness', location: 'x', timeZone: 'America/Chicago', createdAt: 't' }
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
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] }
    );
    assert.ok(!('tasks' in values), 'failed panel must not overwrite prior tasks');
    assert.deepEqual(values.domains, []);
    assert.deepEqual(values.audit, []);
    assert.deepEqual(values.templates, []);
    assert.deepEqual(values.capas, []);
    assert.deepEqual(values.obligations, []);
    assert.deepEqual(Object.keys(errors), ['tasks']);
    assert.match(errors.tasks as string, /not visible/);
  });

  it('preserves prior state when panels fail', () => {
    const prior: { tasks: unknown; domains: unknown } = { tasks: ['old'], domains: ['old'] };
    const { values, errors } = settlePanels(
      { status: 'rejected', reason: 'boom' },
      { status: 'rejected', reason: 'boom' },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
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
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] }
    );
    assert.deepEqual(errors, {});
    assert.equal(Object.keys(values).length, 6);
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
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });

  it('beginContext clears on change, preserves on same key', () => {
    const before = loaded(KEY_A);
    const cleared = beginContext(KEY_A, KEY_B, before);
    for (const name of ['tasks', 'domains', 'audit', 'templates', 'capas', 'obligations'] as const) {
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
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] });
    assert.equal(canAct(failed.tasks, KEY_B), false);
    const staleOk = applySettled(current, KEY_A, 2, KEY_A, 2,
      fail('x'),
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
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

describe('CAPA review gate and send-back label (unit)', () => {
  const SOD = 'Separation of duties: the reviewer closing a CAPA must not have owned it or contributed to its work.';
  const check = (genesis: string) => ({
    id: 'ev-check',
    label: 'check',
    holder: 'Case File',
    kind: 'effectiveness' as const,
    custody: [{ seq: 1, fromHolder: null, toHolder: 'Case File', byUserId: 'u-mgr', at: genesis }],
    updatedAt: genesis
  });
  const history = [{ status: 'effectiveness_review' as const, at: '2026-10-20T00:00:00.000Z', byUserId: 'u-mgr' }];

  it('Review requires the review state, independence, and current-cycle evidence', () => {
    assert.equal(
      capaReviewBlockReason({ id: 'u-officer' }, { ownerId: 'u-staff', status: 'action_in_progress', evidence: [], statusHistory: [] }),
      'Only CAPAs in effectiveness review can be reviewed.'
    );
    assert.equal(
      capaReviewBlockReason(
        { id: 'u-staff' },
        { ownerId: 'u-staff', status: 'effectiveness_review', evidence: [check('2026-10-21T00:00:00.000Z')], statusHistory: history }
      ),
      SOD
    );
    assert.equal(
      capaReviewBlockReason({ id: 'u-officer' }, { ownerId: 'u-staff', status: 'effectiveness_review', evidence: [], statusHistory: history }),
      'At least 1 current-cycle effectiveness evidence item is required to review.'
    );
    assert.equal(
      capaReviewBlockReason(
        { id: 'u-officer' },
        { ownerId: 'u-staff', status: 'effectiveness_review', evidence: [check('2026-10-21T00:00:00.000Z')], statusHistory: history }
      ),
      null
    );
  });

  it('C3: past owners, creators, and contributors cannot review', () => {
    const capa = {
      ownerId: 'u-nurse-mgr',
      createdBy: 'u-admin',
      ownerHistory: [
        { ownerId: 'u-officer2', from: 'initial' as const, byUserId: 'u-admin', at: '2026-10-19T00:00:00.000Z' },
        { ownerId: 'u-nurse-mgr', from: 'reassignment' as const, byUserId: 'u-officer2', at: '2026-10-20T00:00:00.000Z' }
      ],
      actionsBy: ['u-officer'],
      status: 'effectiveness_review' as const,
      evidence: [check('2026-10-21T00:00:00.000Z')],
      statusHistory: history
    };
    for (const id of ['u-officer2', 'u-nurse-mgr', 'u-admin', 'u-officer']) {
      assert.equal(capaReviewBlockReason({ id }, capa), SOD);
    }
    assert.equal(capaReviewBlockReason({ id: 'u-staff' }, capa, ['u-admin', 'u-officer', 'u-officer2']), null);
  });

  it('C3: reports the deadlock when no privileged user remains eligible', () => {
    const capa = {
      ownerId: 'u-nurse-mgr',
      createdBy: 'u-admin',
      ownerHistory: [],
      actionsBy: ['u-officer', 'u-officer2'],
      status: 'effectiveness_review' as const,
      evidence: [check('2026-10-21T00:00:00.000Z')],
      statusHistory: history
    };
    assert.equal(
      capaReviewBlockReason({ id: 'u-admin' }, capa, ['u-admin', 'u-officer', 'u-officer2']),
      'No eligible independent reviewer: all privileged users contributed to or owned this CAPA.'
    );
    assert.equal(capaReviewBlockReason({ id: 'u-admin' }, capa), SOD);
  });

  it('Start reads as Send back on submitted tasks', () => {
    assert.equal(startButtonLabel({ status: 'submitted' }), 'Send back');
    assert.equal(startButtonLabel({ status: 'open' }), 'Start');
    assert.equal(startButtonLabel({ status: 'in_progress' }), 'Start');
    assert.equal(startButtonLabel({ status: 'verified' }), 'Start');
  });
});

describe('CAPA advance gate (C5)', () => {
  const capa = (over: Partial<CapaRecord> & { status: CapaStatus }): CapaRecord => ({
    id: 'c',
    orgId: 'org-cah',
    domainId: 'dom-osha-h',
    finding: 'F (simulated).',
    severity: 'medium',
    ownerId: 'u-staff',
    dueDate: '2026-12-01',
    evidence: [],
    createdAt: 't',
    updatedAt: 't',
    ...over
  });
  const gated = {
    containment: 'Held (simulated).',
    rootCause: 'Found (simulated).',
    correctivePlan: 'Fix (simulated).',
    preventivePlan: 'Prevent (simulated).',
    effectivenessCriteria: 'No recurrence in 30 days (simulated).'
  };
  const proof = {
    id: 'e',
    label: 'proof (simulated)',
    holder: 'H',
    custody: [{ seq: 1, fromHolder: null, toHolder: 'H', byUserId: 'u-staff', at: 't' }],
    updatedAt: 't',
    kind: 'implementation' as const
  };
  const staff = user({ id: 'u-staff', role: 'staff', orgId: 'org-cah' });
  const mgr = user({ id: 'u-nurse-mgr', role: 'department_manager', orgId: 'org-cah' });

  it('owner-staff advance early phases but never request review', () => {
    assert.equal(capaAdvanceBlockReason(staff, capa({ status: 'open', ...gated })), null);
    assert.equal(
      capaAdvanceBlockReason(staff, capa({ status: 'action_in_progress', ...gated, evidence: [proof] })),
      'Requires: manager / compliance officer / admin'
    );
    assert.equal(capaAdvanceBlockReason(mgr, capa({ status: 'action_in_progress', ...gated, evidence: [proof] })), null);
  });

  it('reports missing gates verbatim after the role check', () => {
    assert.equal(
      capaAdvanceBlockReason(staff, capa({ status: 'open', ownerId: 'u-staff' })),
      'Containment is required to start the investigation.'
    );
    // Role first: a non-owner staffer sees the authority hint, not the gate.
    assert.equal(
      capaAdvanceBlockReason(user({ id: 'u-other', role: 'staff', orgId: 'org-cah' }), capa({ status: 'open' })),
      'Requires: owner / manager / officer / admin'
    );
  });

  it('locks closed CAPAs and defers review closure to the review form', () => {
    assert.equal(capaAdvanceBlockReason(mgr, capa({ status: 'closed', ...gated })), 'Closed CAPA records are locked.');
    assert.equal(
      capaAdvanceBlockReason(mgr, capa({ status: 'effectiveness_review', ...gated })),
      'Close via an effectiveness review.'
    );
  });
});

describe('calendar buckets (calendar slice 1)', () => {
  const today = '2026-10-26';

  it('buckets work by status first, then due date', () => {
    assert.equal(calendarBucket({ dueDate: '2026-10-20', status: 'open' }, today), 'overdue');
    assert.equal(calendarBucket({ dueDate: '2026-10-20', status: 'in_progress' }, today), 'overdue');
    assert.equal(calendarBucket({ dueDate: '2026-10-20', status: 'submitted' }, today), 'submitted');
    assert.equal(calendarBucket({ dueDate: '2026-10-20', status: 'verified' }, today), 'verified');
    assert.equal(calendarBucket({ dueDate: '2026-10-26', status: 'open' }, today), 'dueSoon');
    assert.equal(calendarBucket({ dueDate: '2026-11-02', status: 'in_progress' }, today), 'dueSoon');
    assert.equal(calendarBucket({ dueDate: '2026-11-03', status: 'open' }, today), 'upcoming');
    assert.equal(calendarBucket({ dueDate: '2027-01-01', status: 'open' }, today), 'upcoming');
  });

  it('flips overdue exactly on the org-local midnight boundary (CAL3)', () => {
    // A task due Nov 2 is still due-soon at 11:59 PM CST Nov 2 and overdue
    // one minute later; the org-local today string decides.
    assert.equal(calendarBucket({ dueDate: '2027-11-02', status: 'open' }, '2027-11-02'), 'dueSoon');
    assert.equal(calendarBucket({ dueDate: '2027-11-02', status: 'open' }, '2027-11-03'), 'overdue');
  });
});

describe('review history evidence traceability (P4)', () => {
  const evidence = [
    { id: 'e1', label: '30-day log audit (simulated)' },
    { id: 'e2', label: 'Supervisor spot-check (simulated)' }
  ];

  it('names each supporting item, falling back to the id', () => {
    assert.deepEqual(reviewEvidenceLabels(evidence, ['e1', 'e2']), [
      '30-day log audit (simulated)',
      'Supervisor spot-check (simulated)'
    ]);
    assert.deepEqual(reviewEvidenceLabels(evidence, ['e2', 'e-gone']), [
      'Supervisor spot-check (simulated)',
      'e-gone'
    ]);
    assert.deepEqual(reviewEvidenceLabels(evidence, []), []);
  });
});

describe('calendar polish M-CAL3/M-CAL4 (unit)', () => {
  it('M-CAL4: submitted work past its target reads as awaiting verification', () => {
    const today = '2026-11-03';
    assert.equal(
      overdueBadgeLabel({ dueDate: '2026-11-02', status: 'submitted' }, today),
      'Awaiting verification — past target'
    );
    assert.equal(overdueBadgeLabel({ dueDate: '2026-11-02', status: 'open' }, today), 'Overdue');
    assert.equal(
      overdueBadgeLabel({ dueDate: '2026-11-02', status: 'in_progress' }, today),
      'Overdue'
    );
    assert.equal(overdueBadgeLabel({ dueDate: '2026-11-02', status: 'verified' }, today), null);
    assert.equal(overdueBadgeLabel({ dueDate: '2026-11-03', status: 'submitted' }, today), null);
    assert.equal(overdueBadgeLabel({ dueDate: '2026-11-10', status: 'open' }, today), null);
  });

  it('M-CAL3: New obligation is blocked only when no active template exists', () => {
    assert.equal(newObligationBlockReason([]), 'No templates available for this organization.');
    assert.equal(
      newObligationBlockReason([{ active: false }]),
      'No templates available for this organization.'
    );
    assert.equal(newObligationBlockReason([{ active: true }]), null);
    assert.equal(newObligationBlockReason([{ active: false }, { active: true }]), null);
  });
});

describe('overdue KPI consistency (M-CAL12)', () => {
  it('counts open and in-progress past-due only; submitted and verified excluded', () => {
    const today = '2026-11-11';
    const openPast = { dueDate: '2026-11-10', status: 'open' as const };
    const inProgressPast = { dueDate: '2026-11-10', status: 'in_progress' as const };
    const submittedPast = { dueDate: '2026-11-10', status: 'submitted' as const };
    const verifiedPast = { dueDate: '2026-11-10', status: 'verified' as const };
    const openToday = { dueDate: '2026-11-11', status: 'open' as const };
    assert.equal(isOverdueWork(openPast, today), true);
    assert.equal(isOverdueWork(inProgressPast, today), true);
    assert.equal(isOverdueWork(submittedPast, today), false);
    assert.equal(isOverdueWork(verifiedPast, today), false);
    assert.equal(isOverdueWork(openToday, today), false);
    // The KPI count uses the same bucket as the Overdue filter, so they match.
    const rows = [openPast, inProgressPast, submittedPast, verifiedPast, openToday];
    const kpi = rows.filter((t) => isOverdueWork(t, today)).length;
    const filter = rows.filter((t) => calendarBucket(t, today) === 'overdue').length;
    assert.equal(kpi, 2);
    assert.equal(filter, kpi);
    // Badges still distinguish submitted past-due from actionable overdue.
    assert.equal(overdueBadgeLabel(submittedPast, today), 'Awaiting verification — past target');
    assert.equal(overdueBadgeLabel(openPast, today), 'Overdue');
    assert.equal(overdueBadgeLabel(verifiedPast, today), null);
  });
});

describe('due-soon KPI consistency (M-CAL15)', () => {
  it('counts open and in-progress within the 7-day window only', () => {
    const today = '2026-11-10';
    const openToday = { dueDate: '2026-11-10', status: 'open' as const };
    const inProgressEdge = { dueDate: '2026-11-17', status: 'in_progress' as const };
    const openBeyond = { dueDate: '2026-11-18', status: 'open' as const };
    const openPast = { dueDate: '2026-11-09', status: 'open' as const };
    const submittedSoon = { dueDate: '2026-11-12', status: 'submitted' as const };
    const verifiedSoon = { dueDate: '2026-11-12', status: 'verified' as const };
    assert.equal(isDueSoonWork(openToday, today), true);
    assert.equal(isDueSoonWork(inProgressEdge, today), true);
    assert.equal(isDueSoonWork(openBeyond, today), false);
    assert.equal(isDueSoonWork(openPast, today), false);
    assert.equal(isDueSoonWork(submittedSoon, today), false);
    assert.equal(isDueSoonWork(verifiedSoon, today), false);
    // The KPI count uses the same bucket as the due-soon filters, so they match.
    const rows = [openToday, inProgressEdge, openBeyond, openPast, submittedSoon, verifiedSoon];
    const kpi = rows.filter((t) => isDueSoonWork(t, today)).length;
    const filter = rows.filter((t) => calendarBucket(t, today) === 'dueSoon').length;
    assert.equal(kpi, 2);
    assert.equal(filter, kpi);
  });
});

describe('verified-record evidence lock hint (M-UI1)', () => {
  it('reports the lock for verified tasks only', () => {
    assert.equal(evidenceLockedReason({ status: 'verified' }), 'Verified records are locked.');
    assert.equal(evidenceLockedReason({ status: 'open' }), null);
    assert.equal(evidenceLockedReason({ status: 'in_progress' }), null);
    assert.equal(evidenceLockedReason({ status: 'submitted' }), null);
  });

  it('names a stable note id for verified tasks only', () => {
    assert.equal(verifiedLockNoteId({ id: 'task-1', status: 'verified' }), 'verified-lock-task-1');
    assert.equal(verifiedLockNoteId({ id: 'task-1', status: 'open' }), null);
    assert.equal(verifiedLockNoteId({ id: 'task-1', status: 'in_progress' }), null);
    assert.equal(verifiedLockNoteId({ id: 'task-1', status: 'submitted' }), null);
  });

  it('keeps the lock message and note id in sync across statuses', () => {
    // The visible note must exist exactly when locked controls reference it.
    for (const status of ['open', 'in_progress', 'submitted', 'verified'] as const) {
      const reasoned = evidenceLockedReason({ status }) !== null;
      const noted = verifiedLockNoteId({ id: 't', status }) !== null;
      assert.equal(noted, reasoned, status);
    }
  });
});

describe('document-audit review helpers (WM2 client)', () => {
  it('mirrors the server caps and diagnostic code exactly', () => {
    assert.equal(DOCAUDIT_TEXT_MAX, DOCAUDIT_MAX_TEXT_CHARS);
    assert.equal(DOCAUDIT_SUMMARY_MAX, DOCAUDIT_MAX_SUMMARY_CHARS);
    assert.equal(DOCAUDIT_TASK_TITLE_MAX, 200);
    assert.equal(DOCAUDIT_KEYS_UNAVAILABLE_CODE, FOLLOWUPS_UNAVAILABLE_CODE);
    assert.equal(FOLLOWUP_EVIDENCE_NOTE, 'Saved passages are review source material. They do not count as completion evidence.');
  });

  it('ships fixed synthetic sample texts within caps', () => {
    for (const [name, text] of [['A', DOCAUDIT_SAMPLE_A], ['B', DOCAUDIT_SAMPLE_B]] as const) {
      assert.ok(text.trim().length > 0, name);
      assert.ok(text.length <= DOCAUDIT_TEXT_MAX, name);
    }
    assert.notEqual(DOCAUDIT_SAMPLE_A, DOCAUDIT_SAMPLE_B);
  });

  it('labels kinds and occurrence locations for reviewers', () => {
    assert.equal(findingKindLabel('difference'), 'Difference');
    assert.equal(findingKindLabel('missing_in_a'), 'Only in second text');
    assert.equal(findingKindLabel('missing_in_b'), 'Only in first text');
    assert.equal(occurrenceLabel(1, 3, 14, 27), 'Location 2 of 3 — characters 14–27');
    const one = { start: 0, end: 3, contextBefore: '', contextAfter: '' };
    assert.equal(occurrencesTruncated({ occurrences: [one, one], totalOccurrences: 2 }), false);
    assert.equal(occurrencesTruncated({ occurrences: [one], totalOccurrences: 30 }), true);
  });

  it('applies docaudit responses only for the current context and request', () => {
    assert.equal(shouldApplyDocAuditResponse('u|o', 3, 'u|o', 3), true);
    assert.equal(shouldApplyDocAuditResponse('u|o', 2, 'u|o', 3), false);
    assert.equal(shouldApplyDocAuditResponse('u|o', 3, 'u|other', 3), false);
    assert.equal(shouldApplyDocAuditResponse('u|o', 3, 'someone|o', 3), false);
  });

  it('classifies follow-up settles: apply, same-context refresh, or ignore (WM2C-1)', () => {
    // Current context and request: apply (state, refresh, alerts allowed).
    assert.equal(followupSettleAction('u-officer|org-cah', 3, 'u-officer|org-cah', 3), 'apply');
    // Same context, superseded request: refresh current panels only.
    assert.equal(followupSettleAction('u-officer|org-cah', 2, 'u-officer|org-cah', 3), 'refresh');
    // Abandoned context: a late response must never touch the current view.
    assert.equal(followupSettleAction('u-officer|org-cah', 3, 'u-officer|org-clinic', 3), 'ignore');
    assert.equal(followupSettleAction('u-officer|org-cah', 3, 'u-nurse-mgr|org-cah', 3), 'ignore');
    assert.equal(followupSettleAction('u-officer|org-cah', 2, 'u-nurse-mgr|org-clinic', 9), 'ignore');
  });

  it('reuses the key only for byte-identical payloads', () => {
    const prior = { contentJson: '{"a":1}', key: 'key-1' };
    assert.equal(resolveFollowupKey('{"a":1}', prior), 'key-1');
    assert.equal(resolveFollowupKey('{"a":2}', prior), null);
    assert.equal(resolveFollowupKey('{"a":1}', null), null);
  });

  it('blocks creation until accepted, located, and uncompleted', () => {
    const passage = { text: 'q', occurrences: [], totalOccurrences: 1 };
    const twoSided = { passageA: passage, passageB: passage };
    assert.deepEqual(
      findingBlockers({ verdict: undefined, finding: twoSided, selectionA: 0, selectionB: 0, completed: false }),
      ['Accept this finding to proceed.']
    );
    assert.deepEqual(
      findingBlockers({ verdict: 'dismissed', finding: twoSided, selectionA: 0, selectionB: 0, completed: false }),
      ['This finding was dismissed.']
    );
    assert.deepEqual(
      findingBlockers({ verdict: 'accepted', finding: twoSided, selectionA: undefined, selectionB: 1, completed: false }),
      ['Choose a location for the source text A passage.']
    );
    assert.deepEqual(
      findingBlockers({ verdict: 'accepted', finding: { passageA: null, passageB: passage }, selectionA: undefined, selectionB: 0, completed: false }),
      []
    );
    assert.deepEqual(
      findingBlockers({ verdict: 'accepted', finding: twoSided, selectionA: 0, selectionB: 0, completed: true }),
      ['A follow-up task was already created for this finding.']
    );
  });

  const PREVIEW_FINDING = {
    id: 'f1',
    kind: 'difference' as const,
    summary: 'Logging method differs between drafts.',
    passageA: {
      text: 'logged by hand',
      occurrences: [{ start: 62, end: 76, contextBefore: 'counts are ', contextAfter: '.' }],
      totalOccurrences: 1
    },
    passageB: {
      text: 'logged by scanner',
      occurrences: [
        { start: 62, end: 79, contextBefore: 'counts are ', contextAfter: '.' },
        { start: 120, end: 137, contextBefore: 'again ', contextAfter: '.' }
      ],
      totalOccurrences: 2
    }
  };

  function previewInput(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      orgId: 'org-cah',
      orgName: 'North Pine Critical Access Hospital',
      domainId: 'dom-hipaa-h',
      domainName: 'HIPAA — HIPAA Privacy & Security',
      title: 'Recheck nightly fuel counts',
      ownerId: 'u-nurse-mgr',
      ownerName: 'M. Lee (Department Manager)',
      dueDate: '2027-03-01',
      finding: PREVIEW_FINDING,
      summary: 'Logging method differs between drafts.',
      selectionA: 0,
      selectionB: 1,
      textA: 'Text A body.',
      textB: 'Text B body.',
      ...over
    };
  }

  it('builds the exact saved content with one row per field', () => {
    const preview = buildFollowupPreview(previewInput() as never);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.deepEqual(preview.content, {
      orgId: 'org-cah',
      domainId: 'dom-hipaa-h',
      title: 'Recheck nightly fuel counts',
      ownerId: 'u-nurse-mgr',
      dueDate: '2027-03-01',
      findingId: 'f1',
      kind: 'difference',
      summary: 'Logging method differs between drafts.',
      textA: 'Text A body.',
      textB: 'Text B body.',
      passages: [
        { side: 'A', text: 'logged by hand', start: 62, end: 76, occurrenceIndex: 0 },
        { side: 'B', text: 'logged by scanner', start: 120, end: 137, occurrenceIndex: 1 }
      ]
    });
    // The binding JSON excludes the key so identical retries rebind.
    assert.ok(!preview.contentJson.includes('idempotencyKey'));
    assert.deepEqual(JSON.parse(preview.contentJson), preview.content);
    assert.deepEqual(
      preview.rows.map((r) => r.label),
      ['Organization', 'Regulatory domain', 'Title', 'Owner', 'Due date', 'Finding', 'Summary', 'Passage 1 (source text A)', 'Passage 2 (source text B)']
    );
    assert.ok(preview.rows.some((r) => r.label === 'Summary' && r.value === 'Logging method differs between drafts.'));
    assert.ok(preview.rows.some((r) => r.value.includes('characters 120–137 (location 2)')));
  });

  it('rejects incomplete drafts with every error at once', () => {
    const preview = buildFollowupPreview(
      previewInput({ domainId: '', title: '  ', ownerId: '', dueDate: '2027-02-30', summary: '', selectionB: undefined }) as never
    );
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.deepEqual(preview.errors, [
      'Choose a regulatory domain.',
      'Enter a task title.',
      'Choose a task owner.',
      'Enter a real due date (YYYY-MM-DD).',
      'Finding summary must not be empty.',
      'Choose a location for the source text B passage.'
    ]);
  });

  it('rejects over-long titles/summaries and unavailable locations', () => {
    const long = buildFollowupPreview(previewInput({ title: 't'.repeat(201), summary: 's'.repeat(201) }) as never);
    assert.equal(long.ok, false);
    if (long.ok) return;
    assert.deepEqual(long.errors, ['Title exceeds 200 characters.', 'Summary exceeds 200 characters.']);
    const stale = buildFollowupPreview(previewInput({ selectionB: 7 }) as never);
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.deepEqual(stale.errors, ['Selected location for source text B is not available.']);
  });
});

describe('concern panels (slice 1)', () => {
  const KEY = 'u-staff|org-cah';
  const loading = { key: KEY, status: 'loading' as const, data: [] as string[] };

  it('applyOneSettled loads only the current context and latest request', () => {
    const loaded = applyOneSettled(loading, KEY, 2, KEY, 2, {
      status: 'fulfilled',
      value: ['a']
    });
    assert.deepEqual(loaded, { key: KEY, status: 'loaded', data: ['a'] });
    // Stale context or superseded sequence leaves state untouched.
    assert.equal(applyOneSettled(loading, 'other|org', 2, KEY, 2, { status: 'fulfilled', value: ['x'] }), loading);
    assert.equal(applyOneSettled(loading, KEY, 1, KEY, 2, { status: 'fulfilled', value: ['x'] }), loading);
  });

  it('applyOneSettled reports failures without painting stale rows', () => {
    const failed = applyOneSettled(loading, KEY, 2, KEY, 2, {
      status: 'rejected',
      reason: new Error('boom')
    });
    assert.deepEqual(failed, { key: KEY, status: 'error', data: [], error: 'boom' });
  });

  it('triageUsersFor offers managers of the org plus officers and admins', () => {
    const users = [
      user({ id: 'u-staff', role: 'staff', orgId: 'org-cah' }),
      user({ id: 'u-mgr', role: 'department_manager', orgId: 'org-cah' }),
      user({ id: 'u-foreign-mgr', role: 'department_manager', orgId: 'org-clinic' }),
      user({ id: 'u-officer', role: 'compliance_officer', orgId: 'org-cah' }),
      user({ id: 'u-admin', role: 'administrator', orgId: 'org-cah' })
    ];
    assert.deepEqual(
      triageUsersFor(users, 'org-cah').map((u) => u.id),
      ['u-mgr', 'u-officer', 'u-admin']
    );
    assert.deepEqual(
      triageUsersFor(users, 'org-clinic').map((u) => u.id),
      ['u-foreign-mgr', 'u-officer', 'u-admin']
    );
  });

  it('linkedCapaLine renders the server summary, never inventing status', () => {
    assert.equal(linkedCapaLine({}), 'None');
    assert.equal(
      linkedCapaLine({ capaId: 'capa-temp-log', linkedCapa: { id: 'capa-temp-log', status: 'investigation' } }),
      'capa-temp-log (Investigation)'
    );
    const uuid = '12345678-90ab-cdef-1234-567890abcdef';
    assert.equal(
      linkedCapaLine({ capaId: uuid, linkedCapa: { id: uuid, status: 'action_in_progress' } }),
      '12345678… (Action In Progress)'
    );
    // Stale or mismatched links report honestly.
    assert.equal(
      linkedCapaLine({ capaId: 'capa-temp-log' }),
      'capa-temp-log (status unavailable)'
    );
    assert.equal(
      linkedCapaLine({ capaId: 'capa-temp-log', linkedCapa: { id: 'capa-other', status: 'closed' } }),
      'capa-temp-log (status unavailable)'
    );
  });
});
