import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickerOrgIds, resolveOrgId, settlePanels } from '../dashboard.js';
import type { DemoUser, Organization } from '../../shared/types.js';

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
