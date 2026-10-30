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
  UPDATE_OUTSIDE_HISTORY_NOTICE,
  applyFeedSettled,
  applyOneSettled,
  applySettled,
  auditEventDomId,
  beginContext,
  buildFollowupPreview,
  canAct,
  calendarBucket,
  capaAdvanceBlockReason,
  capaReviewBlockReason,
  concernStatusDomId,
  concernUpdateDomId,
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
  navFallbackNotice,
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
  compareTasksForPreview,
  contextOpObsolete,
  creationResponseSuperseded,
  FILTER_LABELS,
  filterBarState,
  resolveInstantiateTemplate,
  resolvePendingCreation,
  retainSelection,
  selectionSurvivesReconcile,
  shouldCloseFormOnCompletion,
  endSubmit,
  tryBeginSubmit,
  previewToggleIdForRegion,
  STAT_KEYS,
  STAT_LABELS,
  STAT_PREVIEW_SIZE,
  statMatches,
  statPreviewRegionId,
  statPreviewTasks,
  statPreviewToggleId,
  statTasks,
  statusFilterMatches,
  submitBlockReason,
  submitStatusReason,
  triageUsersFor,
  updateNavTarget,
  updatesViewState,
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
import type { CardTask, StatKey } from '../dashboard.js';

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

  it('updateNavTarget orders exact update, trail event, status item, then heading', () => {
    assert.deepEqual(
      updateNavTarget({ recordKind: 'concern', recordId: 'c1', seq: 41, updateSeq: 2 }),
      {
        recordKind: 'concern',
        recordId: 'c1',
        focusIds: ['concern-update-mine-2', 'audit-event-mine-41', 'my-concern-detail-heading']
      }
    );
    assert.deepEqual(
      updateNavTarget({ recordKind: 'concern', recordId: 'c1', seq: 40, statusIndex: 1 }),
      {
        recordKind: 'concern',
        recordId: 'c1',
        focusIds: ['audit-event-mine-40', 'concern-status-mine-1', 'my-concern-detail-heading']
      }
    );
    assert.deepEqual(
      updateNavTarget({ recordKind: 'concern', recordId: 'c1', seq: 40 }),
      {
        recordKind: 'concern',
        recordId: 'c1',
        focusIds: ['audit-event-mine-40', 'my-concern-detail-heading']
      }
    );
    assert.deepEqual(
      updateNavTarget({ recordKind: 'task', recordId: 't1', seq: 39 }),
      { recordKind: 'task', recordId: 't1', focusIds: ['audit-event-task-39', 'task-detail-heading'] }
    );
    // A status index on a task entry is ignored: tasks have no status history.
    assert.deepEqual(
      updateNavTarget({ recordKind: 'task', recordId: 't1', seq: 39, statusIndex: 0 }),
      { recordKind: 'task', recordId: 't1', focusIds: ['audit-event-task-39', 'task-detail-heading'] }
    );
  });

  it('focus-target ids stay unique when one concern renders in both views', () => {
    // Same record, same sequences: reporter and triage ids never collide.
    assert.notEqual(concernUpdateDomId('mine', 2), concernUpdateDomId('queue', 2));
    assert.notEqual(auditEventDomId('mine', 41), auditEventDomId('queue', 41));
    assert.notEqual(auditEventDomId('mine', 41), auditEventDomId('task', 41));
    assert.notEqual(concernStatusDomId('mine', 1), concernStatusDomId('queue', 1));
    // Navigation for a user's own concern resolves reporter-facing targets.
    const target = updateNavTarget({ recordKind: 'concern', recordId: 'c1', seq: 41, updateSeq: 2 });
    assert.ok(target.focusIds.every((id) => !id.includes('queue')));
    assert.ok(target.focusIds[0].startsWith('concern-update-mine-'));
    const statusTarget = updateNavTarget({ recordKind: 'concern', recordId: 'c1', seq: 40, statusIndex: 1 });
    assert.ok(statusTarget.focusIds.every((id) => !id.includes('queue')));
  });

  it('navFallbackNotice explains heading-only landings', () => {
    assert.equal(
      UPDATE_OUTSIDE_HISTORY_NOTICE,
      'This update is outside the currently loaded record history.'
    );
    const focusIds = ['audit-event-mine-40', 'concern-status-mine-1', 'my-concern-detail-heading'];
    assert.equal(navFallbackNotice('my-concern-detail-heading', focusIds), UPDATE_OUTSIDE_HISTORY_NOTICE);
    assert.equal(navFallbackNotice('audit-event-mine-40', focusIds), null);
    assert.equal(navFallbackNotice('concern-status-mine-1', focusIds), null);
    assert.equal(navFallbackNotice(null, focusIds), null);
  });

  it('updatesViewState errors only initial failures and keeps stale results', () => {
    const key = 'u-staff|org-cah';
    const row = {
      recordKind: 'task' as const,
      recordId: 't1',
      recordTitle: 'T',
      recordStatus: 'open',
      description: 'D',
      timestamp: '2026-10-29T00:00:00.000Z',
      seq: 1
    };
    assert.equal(
      updatesViewState({ key, status: 'loading', data: [] }, key),
      'loading'
    );
    // Initial failure with no successful result: error, never empty.
    assert.equal(
      updatesViewState({ key, status: 'error', data: [], error: 'boom' }, key),
      'error'
    );
    // Failed refresh after a successful load: retained entries stay listed
    // while PanelNotice carries the stale warning.
    assert.equal(
      updatesViewState({ key, status: 'loaded', data: [row], error: 'boom' }, key),
      'list'
    );
    // O-1: failed refresh after a successful empty load renders the
    // qualified stale-empty state with the warning — never the bare
    // "No updates yet." and never the error state.
    assert.equal(
      updatesViewState({ key, status: 'loaded', data: [], error: 'boom' }, key),
      'empty-stale'
    );
    assert.equal(
      updatesViewState({ key: 'other|org', status: 'loaded', data: [] }, key),
      'stale'
    );
    assert.equal(
      updatesViewState({ key, status: 'loaded', data: [] }, key),
      'empty'
    );
    assert.equal(
      updatesViewState({ key, status: 'loaded', data: [row] }, key),
      'list'
    );
  });

  it('applyFeedSettled retains same-context results and recovers on retry', () => {
    const key = 'u-staff|org-cah';
    const loading = { key, status: 'loading' as const, data: [] as string[] };
    // Initial failure: error state with no entries.
    const failed = applyFeedSettled(loading, key, 1, key, 1, {
      status: 'rejected',
      reason: new Error('boom')
    });
    assert.deepEqual(failed, { key, status: 'error', data: [], error: 'boom' });
    // Success after failure: fresh entries, marker cleared.
    const loaded = applyFeedSettled(failed, key, 2, key, 2, { status: 'fulfilled', value: ['e1'] });
    assert.deepEqual(loaded, { key, status: 'loaded', data: ['e1'] });
    // Failed refresh after success: entries retained with the stale marker.
    const stale = applyFeedSettled(loaded, key, 3, key, 3, {
      status: 'rejected',
      reason: new Error('boom')
    });
    assert.deepEqual(stale, { key, status: 'loaded', data: ['e1'], error: 'boom' });
    // Successful retry replaces the stale result and clears the notice.
    const recovered = applyFeedSettled(stale, key, 4, key, 4, { status: 'fulfilled', value: ['e2'] });
    assert.deepEqual(recovered, { key, status: 'loaded', data: ['e2'] });
    // Late or foreign responses never touch the current state.
    assert.equal(
      applyFeedSettled(loaded, 'other|org', 9, key, 4, { status: 'fulfilled', value: ['x'] }),
      loaded
    );
    assert.equal(
      applyFeedSettled(loaded, key, 1, key, 4, { status: 'fulfilled', value: ['x'] }),
      loaded
    );
    assert.equal(
      applyFeedSettled(loaded, key, 1, key, 4, { status: 'rejected', reason: new Error('x') }),
      loaded
    );
  });

  it('late feed responses from earlier contexts are discarded', () => {
    const key = 'u-staff|org-cah';
    const prev = { key, status: 'loading' as const, data: [] as unknown[] };
    // Current context applies; earlier context or superseded sequence does not.
    const applied = applyOneSettled(prev, key, 2, key, 2, { status: 'fulfilled', value: ['e1'] });
    assert.deepEqual(applied.data, ['e1']);
    assert.equal(
      applyOneSettled(prev, 'u-officer|org-cah', 2, key, 2, { status: 'fulfilled', value: ['x'] }),
      prev
    );
    assert.equal(
      applyOneSettled(applied, key, 1, key, 2, { status: 'fulfilled', value: ['stale'] }),
      applied
    );
  });
});

describe('summary card matching', () => {
  const today = '2026-10-29';
  const cardTask = (over: Partial<CardTask> & { id: string }): CardTask => ({
    title: over.id,
    dueDate: '2026-10-29',
    status: 'open',
    ...over
  });
  // One fixture exercising every status, the civil-window edges, and the
  // submitted/verified exclusions from due/overdue membership.
  const fixture: CardTask[] = [
    cardTask({ id: 'o-past', dueDate: '2026-10-28' }),
    cardTask({ id: 'o-today', dueDate: '2026-10-29' }),
    cardTask({ id: 'o-edge', dueDate: '2026-11-05' }),
    cardTask({ id: 'o-late', dueDate: '2026-11-06' }),
    cardTask({ id: 'p-past', status: 'in_progress', dueDate: '2026-10-01' }),
    cardTask({ id: 'p-soon', status: 'in_progress', dueDate: '2026-10-30' }),
    cardTask({ id: 's-soon', status: 'submitted', dueDate: '2026-10-30' }),
    cardTask({ id: 's-past', status: 'submitted', dueDate: '2026-10-01' }),
    cardTask({ id: 'v-past', status: 'verified', dueDate: '2026-10-01' }),
    cardTask({ id: 'v-any', status: 'verified', dueDate: '2026-12-01' })
  ];

  it('uses one matcher for counts, previews, and filtered rows', () => {
    assert.deepEqual(STAT_KEYS, ['open', 'in_progress', 'dueSoon', 'overdue', 'verified']);
    for (const stat of STAT_KEYS) {
      assert.equal(typeof STAT_LABELS[stat], 'string');
      // Card membership and dropdown/filtered membership are identical.
      assert.deepEqual(
        fixture.filter((t) => statusFilterMatches(stat, t, today)),
        statTasks(stat, fixture, today)
      );
      // The preview pool is a prefix of the same membership, never more.
      const preview = statPreviewTasks(stat, fixture, today);
      assert.ok(preview.length <= STAT_PREVIEW_SIZE);
      assert.ok(preview.every((t) => statMatches(stat, t, today)));
    }
    assert.deepEqual(
      statTasks('open', fixture, today).map((t) => t.id),
      ['o-past', 'o-today', 'o-edge', 'o-late']
    );
    assert.deepEqual(
      statTasks('dueSoon', fixture, today).map((t) => t.id),
      ['o-today', 'o-edge', 'p-soon']
    );
    assert.deepEqual(
      statTasks('overdue', fixture, today).map((t) => t.id),
      ['o-past', 'p-past']
    );
  });

  it('preserves date boundaries and submitted/verified exclusions', () => {
    // Window edges: today and today+7 are in, today+8 is out, yesterday is out.
    assert.equal(statMatches('dueSoon', cardTask({ id: 'a', dueDate: '2026-10-29' }), today), true);
    assert.equal(statMatches('dueSoon', cardTask({ id: 'b', dueDate: '2026-11-05' }), today), true);
    assert.equal(statMatches('dueSoon', cardTask({ id: 'c', dueDate: '2026-11-06' }), today), false);
    assert.equal(statMatches('dueSoon', cardTask({ id: 'd', dueDate: '2026-10-28' }), today), false);
    assert.equal(statMatches('overdue', cardTask({ id: 'e', dueDate: '2026-10-28' }), today), true);
    assert.equal(statMatches('overdue', cardTask({ id: 'f', dueDate: '2026-10-29' }), today), false);
    // Submitted and verified work never lands on due/overdue cards.
    const submittedSoon = cardTask({ id: 'g', status: 'submitted', dueDate: '2026-10-30' });
    const submittedPast = cardTask({ id: 'h', status: 'submitted', dueDate: '2026-10-01' });
    const verifiedPast = cardTask({ id: 'i', status: 'verified', dueDate: '2026-10-01' });
    for (const t of [submittedSoon, submittedPast, verifiedPast]) {
      assert.equal(statMatches('dueSoon', t, today), false);
      assert.equal(statMatches('overdue', t, today), false);
    }
    assert.equal(statMatches('verified', verifiedPast, today), true);
    // Submitted has no card but the dropdown-only value still matches exactly.
    assert.equal(statusFilterMatches('submitted', submittedSoon, today), true);
    assert.equal(statusFilterMatches('submitted', cardTask({ id: 'j' }), today), false);
  });

  it('orders previews by due date, title, then stable id', () => {
    const rows: CardTask[] = [
      cardTask({ id: 't3', title: 'Beta', dueDate: '2026-10-30' }),
      cardTask({ id: 't1', title: 'Alpha', dueDate: '2026-10-30' }),
      cardTask({ id: 't2', title: 'Alpha', dueDate: '2026-10-30' }),
      cardTask({ id: 't0', title: 'Zed', dueDate: '2026-10-29' })
    ];
    assert.deepEqual(
      statPreviewTasks('open', rows, today).map((t) => t.id),
      ['t0', 't1', 't2']
    );
  });

  it('caps previews at three with a countable remainder', () => {
    assert.equal(STAT_PREVIEW_SIZE, 3);
    const rows: CardTask[] = [1, 2, 3, 4, 5].map((n) =>
      cardTask({ id: `o${n}`, title: `Task ${n}`, dueDate: '2026-10-01' })
    );
    const total = statTasks('overdue', rows, today).length;
    const shown = statPreviewTasks('overdue', rows, today);
    assert.equal(total, 5);
    assert.equal(shown.length, 3);
    assert.equal(total - shown.length, 2);
  });

  it('yields honest empty pools for zero counts', () => {
    for (const stat of STAT_KEYS) {
      assert.deepEqual(statTasks(stat, [], today), []);
      assert.deepEqual(statPreviewTasks(stat, [], today), []);
    }
    // Upcoming-only work lands on no due/overdue card.
    const upcoming = [cardTask({ id: 'u', dueDate: '2027-01-01' })];
    assert.deepEqual(statTasks('dueSoon', upcoming, today), []);
    assert.deepEqual(statTasks('overdue', upcoming, today), []);
  });

  it('keeps dropdown and card filters equivalent', () => {
    assert.deepEqual(
      fixture.filter((t) => statusFilterMatches('all', t, today)),
      fixture
    );
    for (const stat of STAT_KEYS) {
      assert.deepEqual(
        fixture.filter((t) => statusFilterMatches(stat, t, today)),
        fixture.filter((t) => statMatches(stat, t, today))
      );
    }
  });

  it('labels every filter value for display', () => {
    assert.deepEqual(FILTER_LABELS, {
      all: 'All',
      submitted: 'Submitted',
      open: 'Open',
      in_progress: 'In progress',
      dueSoon: 'Due within 7 days',
      overdue: 'Overdue',
      verified: 'Verified'
    });
  });

  it('derives unique preview ids and Escape restore targets', () => {
    const regions = STAT_KEYS.map(statPreviewRegionId);
    const toggles = STAT_KEYS.map(statPreviewToggleId);
    assert.equal(new Set([...regions, ...toggles]).size, regions.length + toggles.length);
    for (const stat of STAT_KEYS) {
      assert.equal(
        previewToggleIdForRegion(statPreviewRegionId(stat)),
        statPreviewToggleId(stat)
      );
    }
    assert.equal(previewToggleIdForRegion('stat-preview-submitted'), null);
    assert.equal(previewToggleIdForRegion('tasks-heading'), null);
    assert.equal(previewToggleIdForRegion(''), null);
  });

  it('shows the filter bar on current or stale retained rows only', () => {
    assert.deepEqual(filterBarState('all', true, true), { visible: false, stale: false });
    assert.deepEqual(filterBarState('overdue', true, true), { visible: true, stale: false });
    assert.deepEqual(filterBarState('overdue', false, true), { visible: true, stale: true });
    assert.deepEqual(filterBarState('overdue', false, false), { visible: false, stale: false });
    assert.deepEqual(filterBarState('submitted', false, true), { visible: true, stale: true });
  });

  it('orders titles under the explicit en collation', () => {
    const lower = cardTask({ id: 'lower', title: 'alpha', dueDate: '2026-10-30' });
    const upper = cardTask({ id: 'upper', title: 'Alpha', dueDate: '2026-10-30' });
    assert.ok(compareTasksForPreview(lower, upper) < 0);
    assert.ok(compareTasksForPreview(upper, lower) > 0);
    assert.deepEqual(
      statPreviewTasks('open', [upper, lower], today).map((t) => t.id),
      ['lower', 'upper']
    );
  });

  it('reconciles filtered-list selections but keeps navigated ones', () => {
    // F-5(a)/(b): selected from the Open list, then an action or refresh
    // moves it outside that filter — the detail must clear.
    const open = [cardTask({ id: 't', status: 'open', dueDate: '2026-10-29' })];
    assert.equal(selectionSurvivesReconcile('t', open, 'open', today, true), true);
    const moved = [cardTask({ id: 't', status: 'in_progress', dueDate: '2026-10-29' })];
    assert.equal(selectionSurvivesReconcile('t', moved, 'open', today, true), false);
    // N-1/N-2: calendar/feed navigation pairs the selection with All, so
    // the new selection always survives reconciliation.
    assert.equal(selectionSurvivesReconcile('t', moved, 'all', today, true), true);
    assert.equal(selectionSurvivesReconcile('missing', moved, 'all', today, true), false);
    // F-5(c): loading/failure is not a successful dataset — valid detail stays.
    assert.equal(selectionSurvivesReconcile('t', [], 'open', today, false), true);
    assert.equal(selectionSurvivesReconcile('t', moved, 'open', today, false), true);
    // Context switches null the selection; nothing left to reconcile.
    assert.equal(selectionSurvivesReconcile(null, moved, 'open', today, true), true);
  });

  it('resolves pending creation only against loads started after it', () => {
    const key = 'u-staff|org-cah';
    // Request 7 was latest when the creation response arrived; the
    // follow-up refresh is request 8.
    const pending = { key, id: 'new-task', afterSeq: 7 };
    // The pre-creation snapshot (request 7's data, still current) waits —
    // ready and absent must never declare the task unavailable.
    assert.equal(resolvePendingCreation(pending, key, true, 7, false), 'wait');
    assert.equal(resolvePendingCreation(pending, key, true, 7, true), 'wait');
    // An older in-flight response landing late is dropped by the settle
    // guard and never recorded; even if consulted, it waits.
    assert.equal(resolvePendingCreation(pending, key, true, 5, false), 'wait');
    // No successful load yet at all: wait.
    assert.equal(resolvePendingCreation(pending, key, false, null, false), 'wait');
    // Failed follow-up load: wait with honest failure reporting, then the
    // successful retry resolves.
    assert.equal(resolvePendingCreation(pending, key, false, 7, false), 'wait');
    assert.equal(resolvePendingCreation(pending, key, true, 8, true), 'select');
    // A qualifying load genuinely lacking the task reports unavailable once.
    assert.equal(resolvePendingCreation(pending, key, true, 9, false), 'unavailable');
    // Superseding navigation clears the pending value itself.
    assert.equal(resolvePendingCreation(null, key, true, 8, true), 'none');
    // A user/org switch cancels; delayed completion selects nothing elsewhere.
    assert.equal(resolvePendingCreation(pending, 'u-other|org-cah', true, 8, true), 'cancelled');
  });

  it('supersedes creation responses after newer navigation', () => {
    // The live counter behind this protocol is bumped by every selection,
    // calendar/feed navigation, filter action, creation click, and switch.
    let seq = 0;
    const firstClick = ++seq;
    assert.equal(creationResponseSuperseded(firstClick, seq), false);
    ++seq; // Overdue card applied while the creation request is in flight.
    assert.equal(creationResponseSuperseded(firstClick, seq), true);
    const secondClick = ++seq; // A newer creation supersedes the older one.
    assert.equal(creationResponseSuperseded(firstClick, seq), true);
    assert.equal(creationResponseSuperseded(secondClick, seq), false);
    ++seq; // A context switch invalidates the surviving intent as well.
    assert.equal(creationResponseSuperseded(secondClick, seq), true);
  });

  it('never invalidates a new-context load from a stale completion', () => {
    // P-2 ordering, driven through the real settle guard: old creation
    // pending → context switch → new-context load pending → old creation
    // completes → new load succeeds. Local counters mirror App's refs.
    let requestSeq = 10;
    let contextGen = 1;
    const keyB = 'u-officer|org-cah';
    const emptyOk = <T,>(): PromiseSettledResult<T[]> => ({ status: 'fulfilled', value: [] });

    const opGen = contextGen; // Generate clicked in context A.
    contextGen += 1; // Switch to B...
    const newLoadSeq = ++requestSeq; // ...whose first load (11) starts.
    assert.equal(newLoadSeq, 11);

    // Old creation completes: obsolete, so App refreshes nothing and the
    // shared counter stays at 11.
    assert.equal(contextOpObsolete(opGen, contextGen), true);

    // The new load succeeds and applies — nothing bumped past it.
    const applied = applySettled(
      initialPanels(),
      keyB,
      newLoadSeq,
      keyB,
      requestSeq,
      emptyOk(),
      emptyOk(),
      emptyOk(),
      emptyOk(),
      emptyOk(),
      emptyOk()
    );
    assert.equal(applied.tasks.status, 'loaded');
    assert.equal(applied.tasks.key, keyB);

    // Contrast pinned as the defect avoided: had the stale completion
    // refreshed (counter 12), load 11 would be dropped and B stuck loading.
    const poisoned = applySettled(
      initialPanels(),
      keyB,
      newLoadSeq,
      keyB,
      newLoadSeq + 1,
      emptyOk(),
      emptyOk(),
      emptyOk(),
      emptyOk(),
      emptyOk(),
      emptyOk()
    );
    assert.deepEqual(poisoned.tasks, initialPanels().tasks);
  });

  it('binds completions to context generation across away-and-back', () => {
    let gen = 1;
    let nav = 0;
    const opGen = gen;
    const clickSeq = ++nav; // Creation clicked in A.
    gen += 1;
    nav += 1; // Switch to B.
    gen += 1;
    nav += 1; // Switch back to A: the key matches again...
    assert.equal(contextOpObsolete(opGen, gen), true); // ...but no revival.
    assert.equal(creationResponseSuperseded(clickSeq, nav), true);
    // A failed old operation post-switch reports nothing in the new context.
    assert.equal(contextOpObsolete(opGen, gen), true);
    // Same context, undisturbed: the operation proceeds fully.
    const gen2 = gen;
    const click2 = ++nav;
    assert.equal(contextOpObsolete(gen2, gen), false);
    assert.equal(creationResponseSuperseded(click2, nav), false);
    // Same-context superseded (filter applied mid-request): navigation is
    // skipped while the data refresh still proceeds.
    nav += 1;
    assert.equal(creationResponseSuperseded(click2, nav), true);
    assert.equal(contextOpObsolete(gen2, gen), false);
  });

  it('renders the template form only with current-context data', () => {
    const key = 'u-staff|org-cah';
    const templates = [{ id: 'tpl-1' }, { id: 'tpl-2' }];
    assert.deepEqual(
      resolveInstantiateTemplate({ key, templateId: 'tpl-1' }, key, templates),
      { id: 'tpl-1' }
    );
    // Unset target, another context's target, or an unloaded template:
    // render nothing instead of crashing on undefined.
    assert.equal(resolveInstantiateTemplate(null, key, templates), null);
    assert.equal(
      resolveInstantiateTemplate({ key, templateId: 'tpl-1' }, 'u-other|org-cah', templates),
      null
    );
    assert.equal(resolveInstantiateTemplate({ key, templateId: 'tpl-9' }, key, templates), null);
    assert.equal(resolveInstantiateTemplate({ key, templateId: 'tpl-1' }, key, []), null);
  });

  it('closes a form only on its own successful completion', () => {
    // Normal same-context success closes its own instance.
    assert.equal(shouldCloseFormOnCompletion('completed', 3, 3), true);
    // Failures keep the form/draft with their error; obsolete
    // completions never close; swallowed errors are never success.
    assert.equal(shouldCloseFormOnCompletion('failed', 3, 3), false);
    assert.equal(shouldCloseFormOnCompletion('obsolete', 3, 3), false);
    // A newer form instance opened before the old completion keeps its draft.
    assert.equal(shouldCloseFormOnCompletion('completed', 3, 4), false);
  });

  it('keeps newer form instances across interleaved completions', () => {
    // Per-form instance counters, mirroring App's refs: instance 1
    // submits slowly, instance 2 opens with a draft, then 1 completes.
    let formSeq = 0;
    const firstSubmit = ++formSeq;
    formSeq += 1; // Officer opens their own form and types a draft.
    assert.equal(shouldCloseFormOnCompletion('completed', firstSubmit, formSeq), false);
    // The second instance's own success still closes it.
    const secondSubmit = formSeq;
    assert.equal(shouldCloseFormOnCompletion('completed', secondSubmit, formSeq), true);
    // And a failure there keeps it open with the error shown.
    assert.equal(shouldCloseFormOnCompletion('failed', secondSubmit, formSeq), false);
  });

  it('retains valid selections across list refreshes', () => {
    const users = [{ id: 'u-tnguyen' }, { id: 'u-arahman' }];
    // Same members, new array identity (inline filter per render): kept.
    assert.equal(retainSelection('u-tnguyen', [...users]), 'u-tnguyen');
    assert.equal(retainSelection('u-arahman', users.slice().reverse()), 'u-arahman');
    // Chosen id left the list: cleared, never substituted with another person.
    assert.equal(retainSelection('u-gone', users), '');
    assert.equal(retainSelection('u-tnguyen', []), '');
    assert.equal(retainSelection('', users), '');
  });

  it('never revives concern receipts across away-and-back switches', () => {
    // The filing closure guards receipt/selection on the originating
    // generation: away-and-back changes it twice, so the late success
    // sets nothing even though the user/org key matches again.
    let contextGen = 1;
    const submitGen = contextGen;
    contextGen += 1; // Switch away.
    contextGen += 1; // Switch back: key matches, generation does not.
    assert.equal(contextOpObsolete(submitGen, contextGen), true);
    // Normal same-context filing proceeds to receipt and refresh.
    assert.equal(contextOpObsolete(contextGen, contextGen), false);
  });
});

describe('submit guard (D-1)', () => {
  it('blocks a second submit while one is in flight', () => {
    const guard = { inFlightFor: null };
    assert.equal(tryBeginSubmit(guard, 1), true);
    // Rapid clicks/Enter before any rerender: same instance still guarded.
    assert.equal(tryBeginSubmit(guard, 1), false);
    assert.equal(guard.inFlightFor, 1);
  });

  it('restores availability after the submit settles', () => {
    const guard = { inFlightFor: null };
    assert.equal(tryBeginSubmit(guard, 1), true);
    endSubmit(guard, 1);
    assert.equal(guard.inFlightFor, null);
    // Retry after failure starts cleanly.
    assert.equal(tryBeginSubmit(guard, 1), true);
  });

  it('lets a newer instance submit while an old one is in flight', () => {
    const guard = { inFlightFor: null };
    assert.equal(tryBeginSubmit(guard, 1), true);
    assert.equal(tryBeginSubmit(guard, 2), true);
    assert.equal(guard.inFlightFor, 2);
  });

  it('never lets an old completion unlock a newer instance', () => {
    const guard = { inFlightFor: null };
    assert.equal(tryBeginSubmit(guard, 1), true);
    assert.equal(tryBeginSubmit(guard, 2), true);
    endSubmit(guard, 1); // Late completion for the superseded instance.
    assert.equal(guard.inFlightFor, 2);
    assert.equal(tryBeginSubmit(guard, 2), false);
    endSubmit(guard, 2);
    assert.equal(tryBeginSubmit(guard, 2), true);
  });

  it('ignores releases with no matching in-flight submit', () => {
    const guard = { inFlightFor: null };
    endSubmit(guard, 9);
    assert.equal(guard.inFlightFor, null);
    assert.equal(tryBeginSubmit(guard, 9), true);
  });
});
