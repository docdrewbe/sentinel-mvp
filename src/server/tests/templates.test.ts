import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DemoUser } from '../../shared/types.js';

process.env.SENTINEL_DATA_FILE = join(mkdtempSync(join(tmpdir(), 'sentinel-test-')), 'db.json');

const {
  ValidationError,
  createTemplate,
  emptyDb,
  instantiateTemplate,
  loadDb,
  updateTemplate,
  verifyAuditChain
} = await import('../store.js');
const { seedDatabase } = await import('../seed.js');
const { can } = await import('../../shared/rbac.js');
const { daysOverdue, evaluateEscalation, nextDueDate } = await import('../../shared/scheduling.js');

const validInput = () => ({
  orgId: 'org-cah',
  domainId: 'dom-hipaa-h',
  title: 'Test template',
  description: 'synthetic',
  controlType: 'legally_required' as const,
  regulatoryRefs: [{ source: '45 CFR Part 164', citation: 'illustrative' }],
  responsibleRoles: ['compliance_officer' as const],
  recurrence: { frequency: 'monthly' as const },
  evidenceRequired: [{ label: 'checklist (simulated)', required: true }],
  escalation: [{ afterDaysOverdue: 7, escalateTo: 'administrator' as const }]
});

describe('task templates', () => {
  it('creates valid templates and rejects bad shape', () => {
    const db = seedDatabase();
    const t = createTemplate(db, validInput());
    assert.equal(t.active, true);
    assert.equal(t.controlType, 'legally_required');
    assert.throws(() => createTemplate(db, { ...validInput(), domainId: 'nope' }), ValidationError);
    assert.throws(() => createTemplate(db, { ...validInput(), responsibleRoles: [] }), ValidationError);
    assert.throws(
      () => createTemplate(db, { ...validInput(), controlType: 'bogus' as never }),
      ValidationError
    );
    assert.throws(
      () =>
        createTemplate(db, {
          ...validInput(),
          escalation: [{ afterDaysOverdue: -1, escalateTo: 'administrator' }]
        }),
      ValidationError
    );
  });

  it('updates templates and deactivates them', () => {
    const db = seedDatabase();
    const t = createTemplate(db, validInput());
    updateTemplate(db, t.id, { active: false, title: 'Renamed' });
    const after = db.templates.find((x) => x.id === t.id);
    assert.equal(after?.active, false);
    assert.equal(after?.title, 'Renamed');
    assert.throws(() => updateTemplate(db, t.id, { title: '  ' }), ValidationError);
  });

  it('instantiates tasks linked to the template with recurrence-aware dues', () => {
    const db = seedDatabase();
    const t = createTemplate(db, validInput());
    const task = instantiateTemplate(db, t.id, { ownerId: 'u-staff' });
    assert.equal(task.templateId, t.id);
    assert.equal(task.title, t.title);
    assert.match(task.dueDate, /^\d{4}-\d{2}-\d{2}$/);
    const explicit = instantiateTemplate(db, t.id, { ownerId: 'u-staff', dueDate: '2026-08-01' });
    assert.equal(explicit.dueDate, '2026-08-01');
    updateTemplate(db, t.id, { active: false });
    assert.throws(() => instantiateTemplate(db, t.id, { ownerId: 'u-staff' }), ValidationError);
  });

  it('seeds CAH templates covering both control types with valid references', () => {
    const db = seedDatabase();
    const cah = db.templates.filter((x) => x.orgId === 'org-cah');
    assert.ok(cah.length >= 5);
    assert.ok(cah.some((x) => x.controlType === 'legally_required'));
    assert.ok(cah.some((x) => x.controlType === 'best_practice'));
    for (const x of cah) {
      assert.ok(x.regulatoryRefs.length > 0);
      assert.ok(x.responsibleRoles.length > 0);
      assert.ok(x.evidenceRequired.length > 0);
      assert.ok(x.escalation.length > 0);
      assert.ok(db.domains.some((d) => d.id === x.domainId && d.orgId === x.orgId));
    }
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });

  it('reads databases written before templates existed', () => {
    const legacy = { ...emptyDb() } as Record<string, unknown>;
    delete legacy.templates;
    writeFileSync(process.env.SENTINEL_DATA_FILE as string, JSON.stringify(legacy));
    const db = loadDb();
    assert.deepEqual(db.templates, []);
    assert.ok(db.orgs.length >= 0);
  });
});

describe('recurrence and escalation', () => {
  it('computes next due dates per frequency', () => {
    assert.equal(nextDueDate('2026-01-15', 'weekly'), '2026-01-22');
    assert.equal(nextDueDate('2026-01-15', 'monthly'), '2026-02-15');
    assert.equal(nextDueDate('2026-01-15', 'quarterly'), '2026-04-15');
    assert.equal(nextDueDate('2026-01-15', 'annually'), '2027-01-15');
    assert.equal(nextDueDate('2026-01-15', 'once'), null);
    assert.equal(nextDueDate('bogus', 'monthly'), null);
  });

  it('fires the highest reached escalation tier only when overdue', () => {
    const db = seedDatabase();
    const t = createTemplate(
      db,
      validInput()
    );
    updateTemplate(db, t.id, {
      escalation: [
        { afterDaysOverdue: 14, escalateTo: 'administrator' },
        { afterDaysOverdue: 7, escalateTo: 'compliance_officer' }
      ]
    });
    const tpl = db.templates.find((x) => x.id === t.id) as typeof t;
    assert.equal(evaluateEscalation(tpl, { dueDate: '2026-06-10', status: 'open' }, '2026-06-01'), null);
    assert.equal(
      evaluateEscalation(tpl, { dueDate: '2026-06-01', status: 'open' }, '2026-06-08')?.escalateTo,
      'compliance_officer'
    );
    assert.equal(
      evaluateEscalation(tpl, { dueDate: '2026-06-01', status: 'open' }, '2026-06-20')?.escalateTo,
      'administrator'
    );
    assert.equal(
      evaluateEscalation(tpl, { dueDate: '2026-06-01', status: 'verified' }, '2026-06-20'),
      null
    );
    assert.equal(daysOverdue('2026-06-01', 'open', '2026-06-05'), 4);
  });
});

describe('template authorization (simulated)', () => {
  it('restricts template.manage to officers and admins', () => {
    const db = seedDatabase();
    const byRole = (role: DemoUser['role']): DemoUser =>
      db.users.find((u) => u.role === role) as DemoUser;
    assert.equal(can(byRole('administrator'), 'template.manage'), true);
    assert.equal(can(byRole('compliance_officer'), 'template.manage'), true);
    assert.equal(can(byRole('department_manager'), 'template.manage'), false);
    assert.equal(can(byRole('staff'), 'template.manage'), false);
  });
});
