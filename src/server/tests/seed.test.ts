import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seedDatabase } from '../seed.js';
import { verifyAuditChain } from '../store.js';
import { requiredEvidenceCount } from '../../shared/evidence.js';

describe('synthetic demo data', () => {
  it('seeds a 25-bed critical access hospital plus clinic and cannabis orgs', () => {
    const db = seedDatabase();
    const hospital = db.orgs.find((o) => o.kind === 'hospital');
    assert.ok(hospital);
    assert.equal(hospital.beds, 25);
    assert.ok(db.orgs.some((o) => o.kind === 'clinic'));
    assert.ok(db.orgs.some((o) => o.kind === 'cannabis_microbusiness'));
  });

  it('covers all four demo roles with per-org regulatory domains', () => {
    const db = seedDatabase();
    const roles = new Set(db.users.map((u) => u.role));
    for (const r of ['administrator', 'compliance_officer', 'department_manager', 'staff'] as const) {
      assert.ok(roles.has(r), `missing role ${r}`);
    }
    for (const org of db.orgs) {
      assert.ok(db.domains.some((d) => d.orgId === org.id), `org ${org.id} has no domains`);
    }
  });

  it('gives every task an owner, due date, status, and valid references', () => {
    const db = seedDatabase();
    assert.ok(db.tasks.length > 0);
    for (const t of db.tasks) {
      assert.ok(t.ownerId && db.users.some((u) => u.id === t.ownerId && u.orgId === t.orgId));
      assert.match(t.dueDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(['open', 'in_progress', 'submitted', 'verified'].includes(t.status));
      assert.ok(db.domains.some((d) => d.id === t.domainId && d.orgId === t.orgId));
    }
  });

  it('starts with a verifiable audit chain', () => {
    const db = seedDatabase();
    assert.ok(db.audit.length > 0);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });

  it('gives every evidence item a genesis custody entry', () => {
    const db = seedDatabase();
    let count = 0;
    for (const t of db.tasks) {
      for (const e of t.evidence) {
        count++;
        assert.equal(e.custody.length, 1);
        assert.deepEqual(e.custody[0], {
          seq: 1,
          fromHolder: null,
          toHolder: e.holder,
          byUserId: 'system',
          at: e.custody[0].at
        });
      }
    }
    assert.ok(count > 0);
  });

  it('D4b: every submitted/verified seed task meets its evidence requirement', () => {
    const db = seedDatabase();
    let count = 0;
    for (const t of db.tasks) {
      if (t.status !== 'submitted' && t.status !== 'verified') continue;
      count++;
      const required = requiredEvidenceCount(t, db.templates);
      assert.ok(
        t.evidence.length >= required,
        `${t.id}: has ${t.evidence.length}, requires ${required}`
      );
      for (const e of t.evidence) {
        assert.ok(e.custody.length > 0, `${t.id}/${e.id}: missing custody`);
        assert.equal(e.custody[0].seq, 1);
        assert.equal(e.custody[0].fromHolder, null);
      }
    }
    assert.ok(count > 0, 'expected seeded submitted/verified tasks');
  });
});
