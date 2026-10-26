import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '../../shared/types.js';
import { UNKNOWN_AUDIT_ORG } from '../../shared/types.js';

process.env.SENTINEL_DATA_FILE = join(mkdtempSync(join(tmpdir(), 'sentinel-test-')), 'db.json');

const {
  addEvidence,
  appendAudit,
  backfillAuditOrgIds,
  buildAuditEvent,
  emptyDb,
  findOrphanedTempFiles,
  findTasksMissingSubmissionHistory,
  verifyAuditChain,
  createTask,
  updateTask,
  ValidationError
} = await import('../store.js');
const { seedDatabase } = await import('../seed.js');
const { requiredEvidenceCount } = await import('../../shared/evidence.js');

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
    addEvidence(db, task.id, { label: 'attachment (simulated)', holder: 'T. Nguyen' }, 'u-staff');
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

// Pinned copy of the v2 hash computation (canonical JSON array, frozen order).
const v2hash = (e: {
  seq: number;
  id: string;
  actorId: string;
  action: string;
  recordType: string;
  recordId: string;
  timestamp: string;
  detail: string;
  prevHash: string;
  hashVersion: number;
  orgId: string;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        e.seq,
        e.id,
        e.actorId,
        e.action,
        e.recordType,
        e.recordId,
        e.timestamp,
        e.detail,
        e.prevHash,
        e.hashVersion,
        e.orgId
      ])
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

// Attacker simulation: re-link and re-hash from index onward, using the form
// production applies to each event's own version.
function rehashFrom(chain: AuditEvent[], from: number): void {
  for (let i = from; i < chain.length; i++) {
    const e = chain[i];
    e.prevHash = i === 0 ? 'GENESIS' : chain[i - 1].hash;
    const base = {
      seq: e.seq,
      id: e.id,
      actorId: e.actorId,
      action: e.action,
      recordType: e.recordType,
      recordId: e.recordId,
      timestamp: e.timestamp,
      detail: e.detail,
      prevHash: e.prevHash
    };
    e.hash = e.hashVersion === 2 ? v2hash({ ...base, hashVersion: 2, orgId: e.orgId }) : v1hash(base);
  }
}

describe('hash versions (F1)', () => {
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

describe('F1a canonical v2 encoding', () => {
  const piped = () => {
    const db = emptyDb();
    appendAudit(db, {
      actorId: 'u1|X',
      action: 'a|b',
      recordType: 't|y',
      recordId: 'r1|z',
      orgId: 'org-cah|evil',
      detail: 'A | B'
    });
    return db;
  };

  it('detects the demonstrated timestamp|detail boundary shift', () => {
    const db = piped();
    const e = db.audit[0];
    e.timestamp = `${e.timestamp}|A `;
    e.detail = ' B';
    assert.deepEqual(verifyAuditChain(db.audit), { ok: false, badSeq: 1 });
  });

  it('detects boundary shifts across every adjacent string-field pair', () => {
    const pairs: Array<[string, string]> = [
      ['actorId', 'action'],
      ['action', 'recordType'],
      ['recordType', 'recordId'],
      ['recordId', 'timestamp'],
      ['timestamp', 'detail'],
      ['detail', 'prevHash']
    ];
    for (const [f1, f2] of pairs) {
      const db = piped();
      const e = db.audit[0] as unknown as Record<string, string>;
      const full = e[f2];
      const at = full.indexOf('|');
      if (at === -1) {
        e[f1] = `${e[f1]}|${full.slice(0, 2)}`;
        e[f2] = full.slice(2);
      } else {
        e[f1] = `${e[f1]}|${full.slice(0, at)}`;
        e[f2] = full.slice(at + 1);
      }
      assert.deepEqual(verifyAuditChain(db.audit), { ok: false, badSeq: 1 }, `${f1}|${f2}`);
    }
    const db = piped();
    db.audit[0].orgId = 'org-cah|evil|injected';
    assert.deepEqual(verifyAuditChain(db.audit), { ok: false, badSeq: 1 }, 'orgId');
  });

  it('verifies hostile characters untampered; one-char edits detected', () => {
    const db = emptyDb();
    appendAudit(db, {
      actorId: 'u"1',
      action: 'a\\b',
      recordType: 't\nt',
      recordId: 'r|1',
      orgId: 'org-cah',
      detail: 'mix "q" \\ back | pipe\nnewline ünïcode ✓'
    });
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
    db.audit[0].detail = 'mix "q" \\ back | pipe\nnewline ünïcode ✗';
    assert.deepEqual(verifyAuditChain(db.audit), { ok: false, badSeq: 1 });
  });
});

describe('F1b version allow-list', () => {
  const freshV2x3 = () => {
    const db = emptyDb();
    const rows = [
      ['u1', 'r1', 'first'],
      ['u2', 'r2', 'second'],
      ['u3', 'r3', 'third']
    ] as const;
    for (const [actorId, recordId, detail] of rows) {
      appendAudit(db, { actorId, action: 'a', recordType: 't', recordId, orgId: 'org-cah', detail });
    }
    return db;
  };

  it('rejects unsupported versions even when the chain is re-hashed', () => {
    const bad: unknown[] = [1, 0, 3, 99, '2', null, 2.5];
    for (const version of bad) {
      const db = freshV2x3();
      (db.audit[1] as unknown as Record<string, unknown>).hashVersion = version;
      db.audit[1].orgId = 'org-clinic';
      rehashFrom(db.audit, 1);
      assert.deepEqual(
        verifyAuditChain(db.audit),
        { ok: false, badSeq: 2 },
        `hashVersion=${String(version)}`
      );
    }
  });

  it('rejects downgrades to v1 after v2 events', () => {
    const db = freshV2x3();
    delete (db.audit[1] as unknown as Record<string, unknown>).hashVersion;
    db.audit[1].orgId = 'org-clinic';
    rehashFrom(db.audit, 1);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: false, badSeq: 2 });
  });

  it('accepts v1-then-v2 but rejects v2-then-v1', () => {
    const mixed = v1chain();
    mixed.push(
      buildAuditEvent(mixed, {
        actorId: 'u1',
        action: 'c',
        recordType: 't',
        recordId: 'r3',
        orgId: 'org-cah',
        detail: 'third'
      })
    );
    assert.deepEqual(verifyAuditChain(mixed), { ok: true });
    const db = emptyDb();
    appendAudit(db, { actorId: 'u1', action: 'a', recordType: 't', recordId: 'r1', orgId: 'org-cah', detail: 'first' });
    const tail = {
      seq: 2,
      id: 'v1-tail',
      actorId: 'u2',
      action: 'b',
      recordType: 't',
      recordId: 'r2',
      orgId: 'org-cah',
      timestamp: new Date().toISOString(),
      detail: 'second',
      prevHash: db.audit[0].hash,
      hash: ''
    };
    tail.hash = v1hash(tail);
    db.audit.push(tail as AuditEvent);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: false, badSeq: 2 });
  });
});

describe('audit org backfill', () => {
  it('associates legacy events with their record org, system events with system', () => {
    const db = seedDatabase();
    for (const e of db.audit) {
      const rec = e as unknown as Record<string, unknown>;
      delete rec.hashVersion;
      delete rec.orgId;
    }
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
    rehashFrom(db.audit, 0);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });

  it('fails closed to unknown for orphaned records', () => {
    const db = seedDatabase();
    db.tasks = db.tasks.filter((t) => t.id !== 'task-sharps-log');
    db.templates = db.templates.filter((t) => t.id !== 'tpl-signage');
    for (const e of db.audit) {
      const rec = e as unknown as Record<string, unknown>;
      delete rec.hashVersion;
      delete rec.orgId;
    }
    backfillAuditOrgIds(db);
    const orphans = db.audit.filter(
      (e) => e.recordId === 'task-sharps-log' || e.recordId === 'tpl-signage'
    );
    assert.equal(orphans.length, 2);
    assert.ok(orphans.every((e) => e.orgId === UNKNOWN_AUDIT_ORG));
    assert.ok(
      db.audit
        .filter((e) => e.recordType === 'task' || e.recordType === 'template')
        .filter((e) => e.recordId !== 'task-sharps-log' && e.recordId !== 'tpl-signage')
        .every((e) => e.orgId !== UNKNOWN_AUDIT_ORG)
    );
    assert.equal(db.audit.find((e) => e.action === 'db.seeded')?.orgId, 'system');
  });

  it('repairs legacy system-tagged non-database events from their records', () => {
    const db = seedDatabase();
    for (const e of db.audit) {
      const rec = e as unknown as Record<string, unknown>;
      delete rec.hashVersion;
      if (e.recordType !== 'database') rec.orgId = 'system';
    }
    db.tasks = db.tasks.filter((t) => t.id !== 'task-sharps-log');
    backfillAuditOrgIds(db);
    for (const e of db.audit) {
      if (e.recordType === 'database') {
        assert.equal(e.orgId, 'system');
      } else if (e.recordId === 'task-sharps-log') {
        assert.equal(e.orgId, UNKNOWN_AUDIT_ORG);
      } else if (e.recordType === 'task') {
        assert.equal(e.orgId, db.tasks.find((t) => t.id === e.recordId)?.orgId);
      } else if (e.recordType === 'template') {
        assert.equal(e.orgId, db.templates.find((t) => t.id === e.recordId)?.orgId);
      }
    }
    assert.ok(db.audit.some((e) => e.orgId === UNKNOWN_AUDIT_ORG));
  });

  it('derives v1 orgIds from records regardless of stored value', () => {
    const db = seedDatabase();
    for (const e of db.audit) {
      delete (e as unknown as Record<string, unknown>).hashVersion;
      if (e.recordType === 'task') e.orgId = 'org-clinic';
      else if (e.recordType === 'template') e.orgId = 'org-canna';
      else e.orgId = 'org-cah';
    }
    const nope = db.audit.find((e) => e.recordId === 'task-eyewash') as AuditEvent;
    nope.orgId = 'org-nope';
    db.tasks = db.tasks.filter((t) => t.id !== 'task-sharps-log');
    backfillAuditOrgIds(db);
    for (const e of db.audit) {
      if (e.recordType === 'database') {
        assert.equal(e.orgId, 'system');
      } else if (e.recordId === 'task-sharps-log') {
        assert.equal(e.orgId, UNKNOWN_AUDIT_ORG);
      } else if (e.recordType === 'task') {
        assert.equal(e.orgId, db.tasks.find((t) => t.id === e.recordId)?.orgId);
      } else if (e.recordType === 'template') {
        assert.equal(e.orgId, db.templates.find((t) => t.id === e.recordId)?.orgId);
      }
    }
    rehashFrom(db.audit, 0);
    assert.deepEqual(verifyAuditChain(db.audit), { ok: true });
  });

  it('never rewrites hash-protected v2 fields', () => {
    const pristine = seedDatabase();
    const before = JSON.stringify(pristine.audit);
    backfillAuditOrgIds(pristine);
    assert.equal(JSON.stringify(pristine.audit), before);
    const forged = seedDatabase();
    const target = forged.audit.find((e) => e.recordType === 'task') as AuditEvent;
    target.orgId = 'system';
    backfillAuditOrgIds(forged);
    assert.equal(target.orgId, 'system');
  });
});

describe('D4a required-evidence floor (unit)', () => {
  const req = (label: string) => ({ label, required: true });

  it('returns 1 for empty requirements, missing and dangling templates', () => {
    const templates = [{ id: 'tpl-empty', evidenceRequired: [] as Array<{ label: string; required: boolean }> }];
    assert.equal(requiredEvidenceCount({ templateId: 'tpl-empty' }, templates), 1);
    assert.equal(requiredEvidenceCount({}, templates), 1);
    assert.equal(requiredEvidenceCount({ templateId: 'tpl-gone' }, templates), 1);
  });

  it('returns N for templates with N >= 1 requirements', () => {
    const templates = [
      { id: 'tpl-one', evidenceRequired: [req('a')] },
      { id: 'tpl-three', evidenceRequired: [req('a'), req('b'), req('c')] }
    ];
    assert.equal(requiredEvidenceCount({ templateId: 'tpl-one' }, templates), 1);
    assert.equal(requiredEvidenceCount({ templateId: 'tpl-three' }, templates), 3);
  });
});

describe('D5c submission-history triage (unit)', () => {
  it('lists submitted tasks without recorded submissions', () => {
    const db = seedDatabase();
    assert.deepEqual(
      findTasksMissingSubmissionHistory(db).sort(),
      ['task-med-storage', 'task-patient-rights']
    );
    const task = db.tasks.find((t) => t.id === 'task-med-storage');
    assert.ok(task);
    task.submissions = [
      {
        seq: 1,
        submittedBy: 'u-nurse-mgr',
        ownerAtSubmission: 'u-nurse-mgr',
        at: new Date().toISOString()
      }
    ];
    assert.deepEqual(findTasksMissingSubmissionHistory(db), ['task-patient-rights']);
  });
});
