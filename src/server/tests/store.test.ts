import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SENTINEL_DATA_FILE = join(mkdtempSync(join(tmpdir(), 'sentinel-test-')), 'db.json');

const { appendAudit, emptyDb, verifyAuditChain, createTask, updateTask, ValidationError } =
  await import('../store.js');
const { seedDatabase } = await import('../seed.js');

describe('append-only audit log', () => {
  it('chains events with increasing sequence numbers and a verifiable hash', () => {
    const db = emptyDb();
    appendAudit(db, { actorId: 'u1', action: 'a', recordType: 't', recordId: 'r1', detail: 'first' });
    appendAudit(db, { actorId: 'u2', action: 'b', recordType: 't', recordId: 'r2', detail: 'second' });
    assert.equal(db.audit[0].seq, 1);
    assert.equal(db.audit[1].seq, 2);
    assert.equal(db.audit[1].prevHash, db.audit[0].hash);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });

  it('detects tampering with any recorded event', () => {
    const db = emptyDb();
    appendAudit(db, { actorId: 'u1', action: 'a', recordType: 't', recordId: 'r1', detail: 'first' });
    appendAudit(db, { actorId: 'u2', action: 'b', recordType: 't', recordId: 'r2', detail: 'second' });
    db.audit[0].detail = 'forged';
    assert.equal(verifyAuditChain(db.audit).ok, false);
  });

  it('exposes no update or delete API for audit events', async () => {
    const store = await import('../store.js');
    assert.equal(typeof (store as Record<string, unknown>).updateAudit, 'undefined');
    assert.equal(typeof (store as Record<string, unknown>).deleteAudit, 'undefined');
    assert.equal(typeof (store as Record<string, unknown>).removeAudit, 'undefined');
  });
});

describe('task integrity', () => {
  it('rejects tasks with unknown owner, domain, or bad due date', () => {
    const db = seedDatabase();
    assert.throws(
      () =>
        createTask(db, { orgId: 'org-cah', domainId: 'dom-hipaa-h', title: 'x', ownerId: 'nope', dueDate: '2026-01-01' }),
      ValidationError
    );
    assert.throws(
      () =>
        createTask(db, { orgId: 'org-cah', domainId: 'nope', title: 'x', ownerId: 'u-staff', dueDate: '2026-01-01' }),
      ValidationError
    );
    assert.throws(
      () =>
        createTask(db, { orgId: 'org-cah', domainId: 'dom-hipaa-h', title: 'x', ownerId: 'u-staff', dueDate: 'not-a-date' }),
      ValidationError
    );
  });

  it('rejects illegal status transitions (e.g. open -> verified)', () => {
    const db = seedDatabase();
    const task = createTask(db, {
      orgId: 'org-cah',
      domainId: 'dom-hipaa-h',
      title: 'transition test',
      ownerId: 'u-staff',
      dueDate: '2026-06-01'
    });
    assert.throws(() => updateTask(db, task.id, { status: 'verified' }), ValidationError);
    updateTask(db, task.id, { status: 'submitted' });
    updateTask(db, task.id, { status: 'verified' });
    assert.equal(db.tasks.find((t) => t.id === task.id)?.status, 'verified');
  });
});
