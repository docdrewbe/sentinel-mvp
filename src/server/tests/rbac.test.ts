import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { can, visibleOrgIds } from '../../shared/rbac.js';
import type { ComplianceTask, DemoUser } from '../../shared/types.js';

const task = (over: Partial<ComplianceTask> = {}): ComplianceTask => ({
  id: 'task-1',
  orgId: 'org-cah',
  domainId: 'dom-hipaa-h',
  title: 't',
  ownerId: 'u-staff',
  dueDate: '2026-06-01',
  status: 'open',
  evidence: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over
});

const user = (over: Partial<DemoUser> = {}): DemoUser => ({
  id: 'u-staff',
  orgId: 'org-cah',
  name: 'T',
  role: 'staff',
  department: 'Nursing',
  ...over
});

describe('role-based workflows (simulated)', () => {
  it('administrator can do everything', () => {
    const admin = user({ id: 'u-admin', role: 'administrator' });
    for (const a of ['task.create', 'task.update', 'task.submit', 'task.verify', 'evidence.add', 'custody.transfer'] as const) {
      assert.equal(can(admin, a, task()), true);
    }
  });

  it('compliance officer can verify; managers and staff cannot', () => {
    const t = task({ status: 'submitted' });
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'task.verify', t), true);
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'task.verify', t), false);
    assert.equal(can(user({ role: 'staff' }), 'task.verify', t), false);
  });

  it('staff can submit only their own tasks', () => {
    const mine = task({ ownerId: 'u-staff' });
    const theirs = task({ ownerId: 'u-other' });
    assert.equal(can(user({ role: 'staff' }), 'task.submit', mine), true);
    assert.equal(can(user({ role: 'staff' }), 'task.submit', theirs), false);
    assert.equal(can(user({ role: 'staff' }), 'task.create'), false);
  });

  it('managers and staff are scoped to their own organization', () => {
    const other = task({ orgId: 'org-clinic', ownerId: 'u-clinic-staff' });
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'task.update', other), false);
    assert.equal(can(user({ role: 'staff' }), 'evidence.add', other), false);
  });
});

describe('CAPA permissions (simulated)', () => {
  const capa = (over: { orgId?: string; ownerId?: string } = {}) => ({
    orgId: 'org-cah',
    ownerId: 'u-staff',
    ...over
  });

  it('only officers and admins may close', () => {
    const c = capa();
    assert.equal(can(user({ role: 'administrator', id: 'u-admin' }), 'capa.close', c), true);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'capa.close', c), true);
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'capa.close', c), false);
    assert.equal(can(user({ role: 'staff' }), 'capa.close', c), false);
  });

  it('managers update and create; staff create nothing and update only their own', () => {
    const mgr = user({ role: 'department_manager', id: 'u-mgr' });
    assert.equal(can(mgr, 'capa.create'), true);
    assert.equal(can(mgr, 'capa.update', capa({ ownerId: 'u-staff' })), true);
    assert.equal(can(user({ role: 'staff' }), 'capa.create'), false);
    assert.equal(can(user({ role: 'staff' }), 'capa.update', capa({ ownerId: 'u-staff' })), true);
    assert.equal(can(user({ role: 'staff' }), 'capa.update', capa({ ownerId: 'u-other' })), false);
    assert.equal(can(user({ role: 'staff' }), 'capa.evidence.add', capa({ ownerId: 'u-staff' })), true);
    assert.equal(can(user({ role: 'staff' }), 'capa.evidence.add', capa({ ownerId: 'u-other' })), false);
  });

  it('scoped roles cannot touch other organizations CAPAs', () => {
    const foreign = capa({ orgId: 'org-clinic', ownerId: 'u-clinic-staff' });
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'capa.update', foreign), false);
    assert.equal(can(user({ role: 'staff' }), 'capa.evidence.add', foreign), false);
  });
});

describe('organization visibility (F3)', () => {
  const all = ['org-cah', 'org-clinic', 'org-canna'];

  it('scopes managers and staff to their own org', () => {
    assert.deepEqual(
      visibleOrgIds(user({ role: 'department_manager', orgId: 'org-cah' }), all),
      ['org-cah']
    );
    assert.deepEqual(visibleOrgIds(user({ role: 'staff', orgId: 'org-clinic' }), all), ['org-clinic']);
  });

  it('grants admin and officer the documented cross-org demo privilege', () => {
    assert.deepEqual(visibleOrgIds(user({ role: 'administrator' }), all), all);
    assert.deepEqual(visibleOrgIds(user({ role: 'compliance_officer' }), all), all);
  });
});
