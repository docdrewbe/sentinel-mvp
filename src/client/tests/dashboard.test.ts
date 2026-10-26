import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettled,
  beginContext,
  canAct,
  initialPanels,
  panelData,
  pickerOrgIds,
  requiredEvidenceFor,
  resolveOrgId,
  settlePanels
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
