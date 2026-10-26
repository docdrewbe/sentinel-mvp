import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '../../shared/types.js';

process.env.SENTINEL_DATA_FILE = join(mkdtempSync(join(tmpdir(), 'sentinel-test-')), 'db.json');

const {
  appendAudit,
  backfillAuditOrgIds,
  buildAuditEvent,
  emptyDb,
  findOrphanedTempFiles,
  verifyAuditChain,
  createTask,
  updateTask,
  ValidationError
} = await import('../store.js');
const { seedDatabase } = await import('../seed.js');

describe('append-only audit log', () => {
  it('chains events with increasing sequence numbers and a verifiable hash', () => {
    const db = emptyDb();
    appendAudit(db, { actorId: 'u1', action: 'a', recordType: 't', recordId: 'r1', orgId: 'org-cah', detail: 'first' });
    appendAudit(db, { actorId: 'u2', action: 'b', recordType: 't', recordId: 'r2', orgId: 'org-cah', detail: 'second' });
    assert.equal(db.audit[0].seq, 1);
    assert.equal(db.audit[1].seq, 2);
    assert.equal(db.audit[1].prevHash, db.audit[0].hash);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });

  it('detects tampering with any recorded event', () => {
    const db = emptyDb();
    appendAudit(db, { actorId: 'u1', action: 'a', recordType: 't', recordId: 'r1', orgId: 'org-cah', detail: 'first' });
    appendAudit(db, { actorId: 'u2', action: 'b', recordType: 't', recordId: 'r2', orgId: 'org-cah', detail: 'second' });
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

describe('interrupted-save detection', () => {
  it('finds orphaned temp files without touching them', () => {
    assert.deepEqual(findOrphanedTempFiles(), []);
    const orphan = `${process.env.SENTINEL_DATA_FILE as string}.99999.tmp`;
    writeFileSync(orphan, '{}');
    try {
      assert.deepEqual(findOrphanedTempFiles(), [orphan]);
    } finally {
      unlinkSync(orphan);
    }
  });
});

describe('hash versions (F1)', () => {
  // Pinned copy of the pre-F1 (v1) hash computation. The v1 field list is
  // frozen; this independent copy fails loudly if it ever drifts.
  const v1hash = (e: {
    seq: number;
    id: string;
    actorId: string;
    action: string;
    recordType: string;
    recordId: string;
    timestamp: string;
    detail: string;
    prevHash: string;
  }): string =>
    createHash('sha256')
      .update(
        [
          e.seq,
          e.id,
          e.actorId,
          e.action,
          e.recordType,
          e.recordId,
          e.timestamp,
          e.detail,
          e.prevHash
        ].join('|')
      )
      .digest('hex');

  // A genuine v1-shaped chain: backfilled orgId present, no hashVersion.
  function v1chain(): AuditEvent[] {
    const t = '2026-10-26T00:00:00.000Z';
    const e1 = {
      seq: 1,
      id: 'v1-a',
      actorId: 'u-admin',
      action: 'task.created',
      recordType: 'task',
      recordId: 't1',
      orgId: 'org-cah',
      timestamp: t,
      detail: 'first',
      prevHash: 'GENESIS'
    };
    const h1 = { ...e1, hash: v1hash(e1) };
    const e2 = { ...e1, seq: 2, id: 'v1-b', recordId: 't2', detail: 'second', prevHash: h1.hash };
    return [h1, { ...e2, hash: v1hash(e2) }] as AuditEvent[];
  }

  const freshV2 = () => {
    const db = emptyDb();
    appendAudit(db, { actorId: 'u1', action: 'a', recordType: 't', recordId: 'r1', orgId: 'org-cah', detail: 'first' });
    appendAudit(db, { actorId: 'u2', action: 'b', recordType: 't', recordId: 'r2', orgId: 'org-cah', detail: 'second' });
    return db;
  };

  it('writes hashVersion 2 on new events', () => {
    const db = freshV2();
    assert.equal(db.audit[0].hashVersion, 2);
    assert.equal(db.audit[1].hashVersion, 2);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });

  it('detects tampering with a v2 event orgId', () => {
    const db = freshV2();
    db.audit[1].orgId = 'org-clinic';
    assert.deepEqual(verifyAuditChain(db.audit), { ok: false, badSeq: 2 });
  });

  it('detects tampering with hashVersion itself', () => {
    const downgraded = freshV2();
    downgraded.audit[1].hashVersion = 1;
    assert.deepEqual(verifyAuditChain(downgraded.audit), { ok: false, badSeq: 2 });
    const stripped = freshV2();
    delete (stripped.audit[0] as unknown as Record<string, unknown>).hashVersion;
    assert.deepEqual(verifyAuditChain(stripped.audit), { ok: false, badSeq: 1 });
  });

  it('still verifies legacy v1 chains', () => {
    assert.deepEqual(verifyAuditChain(v1chain()), { ok: true });
    const tampered = v1chain();
    tampered[0].detail = 'forged';
    assert.deepEqual(verifyAuditChain(tampered), { ok: false, badSeq: 1 });
  });

  it('verifies mixed v1/v2 histories and protects the v2 suffix', () => {
    const chain = v1chain();
    chain.push(
      buildAuditEvent(chain, {
        actorId: 'u1',
        action: 'c',
        recordType: 't',
        recordId: 'r3',
        orgId: 'org-cah',
        detail: 'third'
      })
    );
    assert.deepEqual(verifyAuditChain(chain), { ok: true });
    chain[2].orgId = 'system';
    assert.deepEqual(verifyAuditChain(chain), { ok: false, badSeq: 3 });
  });
});

describe('audit org backfill', () => {
  it('associates legacy events with their record org, system events with system', () => {
    const db = seedDatabase();
    for (const e of db.audit) delete (e as unknown as Record<string, unknown>).orgId;
    backfillAuditOrgIds(db);
    for (const e of db.audit) {
      if (e.recordType === 'task') {
        assert.equal(e.orgId, db.tasks.find((t) => t.id === e.recordId)?.orgId);
      } else if (e.recordType === 'template') {
        assert.equal(e.orgId, db.templates.find((t) => t.id === e.recordId)?.orgId);
      } else {
        assert.equal(e.orgId, 'system');
      }
    }
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });
});
