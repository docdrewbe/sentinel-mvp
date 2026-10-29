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

describe('obligation schedule permissions (CAL4)', () => {
  const sched = (over: { orgId?: string; ownerId?: string } = {}) => ({
    orgId: 'org-cah',
    ownerId: '',
    ...over
  });

  it('managers, officers, and admins manage schedules; staff never', () => {
    const s = sched();
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'obligation.manage', s), true);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'obligation.manage', s), true);
    assert.equal(can(user({ role: 'administrator', id: 'u-admin' }), 'obligation.manage', s), true);
    assert.equal(can(user({ role: 'staff' }), 'obligation.manage', s), false);
  });

  it('managers cannot manage other organizations schedules', () => {
    const foreign = sched({ orgId: 'org-clinic' });
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'obligation.manage', foreign), false);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'obligation.manage', foreign), true);
  });
});

describe('document audit permissions (Phase 1)', () => {
  const scope = (over: { orgId?: string; ownerId?: string } = {}) => ({
    orgId: 'org-cah',
    ownerId: '',
    ...over
  });

  it('managers, officers, and admins run comparisons; staff never', () => {
    const s = scope();
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'docaudit.run', s), true);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'docaudit.run', s), true);
    assert.equal(can(user({ role: 'administrator', id: 'u-admin' }), 'docaudit.run', s), true);
    assert.equal(can(user({ role: 'staff' }), 'docaudit.run', s), false);
  });

  it('managers cannot compare for other organizations', () => {
    const foreign = scope({ orgId: 'org-clinic' });
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'docaudit.run', foreign), false);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'docaudit.run', foreign), true);
  });

  it('follow-ups match the compare matrix: managers and above, staff never (Phase 2)', () => {
    const s = scope();
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'docaudit.followup', s), true);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'docaudit.followup', s), true);
    assert.equal(can(user({ role: 'administrator', id: 'u-admin' }), 'docaudit.followup', s), true);
    assert.equal(can(user({ role: 'staff' }), 'docaudit.followup', s), false);
  });

  it('managers cannot create follow-ups for other organizations (Phase 2)', () => {
    const foreign = scope({ orgId: 'org-clinic' });
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'docaudit.followup', foreign), false);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'docaudit.followup', foreign), true);
  });
});

describe('concern permissions (slice 1)', () => {
  const scope = (over: { orgId?: string; ownerId?: string } = {}) => ({
    orgId: 'org-cah',
    ownerId: '',
    ...over
  });

  it('any signed-in role may file; only managers and above triage', () => {
    for (const role of ['staff', 'department_manager', 'compliance_officer', 'administrator'] as const) {
      assert.equal(can(user({ role }), 'concern.create'), true);
    }
    const s = scope();
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'concern.triage', s), true);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'concern.triage', s), true);
    assert.equal(can(user({ role: 'administrator', id: 'u-admin' }), 'concern.triage', s), true);
    assert.equal(can(user({ role: 'staff' }), 'concern.triage', s), false);
  });

  it('managers triage their own org only', () => {
    const foreign = scope({ orgId: 'org-clinic' });
    assert.equal(can(user({ role: 'department_manager', id: 'u-mgr' }), 'concern.triage', foreign), false);
    assert.equal(can(user({ role: 'compliance_officer', id: 'u-officer' }), 'concern.triage', foreign), true);
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
