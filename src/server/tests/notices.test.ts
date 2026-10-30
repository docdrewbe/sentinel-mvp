// HTTP-level safety-notice slice tests: manual intake, one final human
// applicability decision, and idempotent follow-up task creation. Uses an
// isolated temp database and ephemeral ports; never touches
// data/sentinel.json or QA evidence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'sentinel-api-'));
process.env.SENTINEL_DATA_FILE = join(workdir, 'sentinel.json');
const dataFile = process.env.SENTINEL_DATA_FILE;

const { createApp } = await import('../app.js');
const { seedDatabase } = await import('../seed.js');
const store = await import('../store.js');
const notices = await import('../notices.js');

type Db = ReturnType<typeof seedDatabase>;

interface TestServer {
  db: Db;
  base: string;
  close: () => Promise<void>;
}

async function startServer(mutate?: (db: Db) => void): Promise<TestServer> {
  const db = seedDatabase();
  if (mutate) mutate(db);
  store.saveDb(db);
  const app = createApp(db);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    db,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

async function call(
  base: string,
  method: string,
  path: string,
  userId: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-demo-user-id': userId },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

interface Snapshot {
  notices: number;
  tasks: number;
  keys: unknown;
  audit: number;
  disk: string;
  mtimeMs: number;
}

function snapshot(db: Db): Snapshot {
  return {
    notices: db.notices.length,
    tasks: db.tasks.length,
    keys: JSON.parse(JSON.stringify(db.noticeFollowupKeys ?? null)) as unknown,
    audit: db.audit.length,
    disk: readFileSync(dataFile, 'utf8'),
    mtimeMs: statSync(dataFile).mtimeMs
  };
}

function assertUnchanged(db: Db, before: Snapshot): void {
  assert.equal(db.notices.length, before.notices);
  assert.equal(db.tasks.length, before.tasks);
  assert.deepEqual(db.noticeFollowupKeys ?? null, before.keys);
  assert.equal(db.audit.length, before.audit);
  assert.equal(readFileSync(dataFile, 'utf8'), before.disk);
  assert.equal(statSync(dataFile).mtimeMs, before.mtimeMs);
}

const NOTICE = {
  orgId: 'org-cah',
  source: 'SYNTH-REF-2026-114 (synthetic test notice)',
  title: 'Synthetic infusion-pump battery advisory',
  noticeDate: '2026-10-15',
  text: 'Synthetic test notice text. No real device, no real advisory.'
};

async function intakeNotice(
  base: string,
  userId = 'u-nurse-mgr',
  body: Record<string, unknown> = { ...NOTICE }
): Promise<{ status: number; json: Record<string, unknown> }> {
  return call(base, 'POST', '/api/notices', userId, body);
}

describe('notice intake', () => {
  it('records a needs_review notice with an audit event', async () => {
    const { db, base, close } = await startServer();
    try {
      const before = db.audit.length;
      const res = await intakeNotice(base);
      assert.equal(res.status, 201);
      assert.equal(res.json.orgId, 'org-cah');
      assert.equal(res.json.source, NOTICE.source);
      assert.equal(res.json.title, NOTICE.title);
      assert.equal(res.json.noticeDate, '2026-10-15');
      assert.equal(res.json.text, NOTICE.text);
      assert.equal(res.json.status, 'needs_review');
      assert.equal(res.json.createdBy, 'u-nurse-mgr');
      assert.equal(res.json.rationale, undefined);
      assert.equal(res.json.reviewedBy, undefined);
      assert.equal(typeof res.json.id, 'string');
      assert.equal(db.audit.length, before + 1);
      const event = db.audit[db.audit.length - 1] as { action: string; orgId: string; detail: string };
      assert.equal(event.action, 'notice.created');
      assert.equal(event.orgId, 'org-cah');
      assert.equal(event.detail, NOTICE.title);
      assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
    } finally {
      await close();
    }
  });

  it('rejects invalid intake with nothing changed', async () => {
    const { db, base, close } = await startServer();
    try {
      const bad: Array<[string, Record<string, unknown>]> = [
        ['missing source', { ...NOTICE, source: '' }],
        ['missing title', { ...NOTICE, title: '  ' }],
        ['bad date', { ...NOTICE, noticeDate: '2027-02-30' }],
        ['garbage date', { ...NOTICE, noticeDate: 'next Friday' }],
        ['missing text', { ...NOTICE, text: '' }],
        ['oversize text', { ...NOTICE, text: 'x'.repeat(4001) }],
        ['oversize source', { ...NOTICE, source: 'x'.repeat(121) }]
      ];
      for (const [label, body] of bad) {
        const before = snapshot(db);
        const res = await intakeNotice(base, 'u-nurse-mgr', body);
        assert.equal(res.status, 400, label);
        assertUnchanged(db, before);
      }
      const before = snapshot(db);
      const res = await intakeNotice(base, 'u-nurse-mgr', { ...NOTICE, title: 42 } as unknown as Record<string, unknown>);
      assert.equal(res.status, 400);
      assertUnchanged(db, before);
      // Scope-first ordering (same as task/concern creation): a manager
      // posting outside their org gets 403; an officer naming an unknown
      // org reaches the 400 existence check.
      const scoped = await intakeNotice(base, 'u-nurse-mgr', { ...NOTICE, orgId: 'org-nope' });
      assert.equal(scoped.status, 403);
      const unknown = await intakeNotice(base, 'u-officer', { ...NOTICE, orgId: 'org-nope' });
      assert.equal(unknown.status, 400);
      assertUnchanged(db, before);
    } finally {
      await close();
    }
  });

  it('enforces intake permissions server-side', async () => {
    const { db, base, close } = await startServer();
    try {
      const before = snapshot(db);
      assert.equal((await intakeNotice(base, 'u-staff')).status, 403);
      assert.equal((await intakeNotice(base, 'u-clinic-mgr')).status, 403);
      assertUnchanged(db, before);
      assert.equal((await intakeNotice(base, 'u-officer')).status, 201);
      assert.equal((await intakeNotice(base, 'u-admin')).status, 201);
      assertUnchanged(db, snapshot(db));
      assert.equal(db.notices.length, 2);
    } finally {
      await close();
    }
  });

  it('scopes notice reads by organization', async () => {
    const { base, close } = await startServer();
    try {
      await intakeNotice(base, 'u-nurse-mgr');
      await intakeNotice(base, 'u-clinic-mgr', { ...NOTICE, orgId: 'org-clinic' });
      const staff = await call(base, 'GET', '/api/notices?orgId=org-cah', 'u-staff');
      assert.equal(staff.status, 200);
      assert.equal((staff.json as unknown as unknown[]).length, 1);
      const cross = await call(base, 'GET', '/api/notices?orgId=org-clinic', 'u-staff');
      assert.equal(cross.status, 403);
      const officer = await call(base, 'GET', '/api/notices', 'u-officer');
      assert.equal(officer.status, 200);
      assert.equal((officer.json as unknown as unknown[]).length, 2);
    } finally {
      await close();
    }
  });
});

describe('notice applicability review', () => {
  it('records applicable with rationale, reviewer, and time', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await intakeNotice(base);
      const id = created.json.id as string;
      const res = await call(base, 'PATCH', `/api/notices/${id}`, 'u-nurse-mgr', {
        status: 'applicable',
        rationale: 'Synthetic test rationale: ward uses this pump model.'
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'applicable');
      assert.equal(res.json.rationale, 'Synthetic test rationale: ward uses this pump model.');
      assert.equal(res.json.reviewedBy, 'u-nurse-mgr');
      assert.equal(typeof res.json.reviewedAt, 'string');
      const event = db.audit[db.audit.length - 1] as { action: string; orgId: string; detail: string };
      assert.equal(event.action, 'notice.reviewed');
      assert.equal(event.orgId, 'org-cah');
      assert.equal(event.detail, 'needs_review -> applicable');
      assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
    } finally {
      await close();
    }
  });

  it('records not_applicable as a distinct final state', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await intakeNotice(base);
      const id = created.json.id as string;
      const res = await call(base, 'PATCH', `/api/notices/${id}`, 'u-officer', {
        status: 'not_applicable',
        rationale: 'Synthetic test rationale: no such device on site.'
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'not_applicable');
      assert.ok((res.json.rationale as string).includes('no such device'));
      assert.equal(res.json.reviewedBy, 'u-officer');
      const again = await call(base, 'PATCH', `/api/notices/${id}`, 'u-officer', {
        status: 'applicable',
        rationale: 'Second thoughts (synthetic).'
      });
      assert.equal(again.status, 400);
      assert.equal((db.notices.find((n) => n.id === id) as { status: string }).status, 'not_applicable');
    } finally {
      await close();
    }
  });

  it('rejects bad reviews with nothing changed', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await intakeNotice(base);
      const id = created.json.id as string;
      const bad: Array<[string, Record<string, unknown>]> = [
        ['missing rationale (applicable)', { status: 'applicable' }],
        ['blank rationale (not_applicable)', { status: 'not_applicable', rationale: '  ' }],
        ['unknown status', { status: 'maybe', rationale: 'Synthetic rationale.' }],
        ['missing status', { rationale: 'Synthetic rationale.' }],
        ['edited source', { status: 'applicable', rationale: 'Synthetic rationale.', source: 'other' }],
        ['edited title', { status: 'applicable', rationale: 'Synthetic rationale.', title: 'other' }],
        ['edited date', { status: 'applicable', rationale: 'Synthetic rationale.', noticeDate: '2026-01-01' }],
        ['edited text', { status: 'applicable', rationale: 'Synthetic rationale.', text: 'other' }]
      ];
      for (const [label, body] of bad) {
        const before = snapshot(db);
        const res = await call(base, 'PATCH', `/api/notices/${id}`, 'u-nurse-mgr', body);
        assert.equal(res.status, 400, label);
        assertUnchanged(db, before);
      }
      const missing = await call(base, 'PATCH', '/api/notices/notice-nope', 'u-nurse-mgr', {
        status: 'applicable',
        rationale: 'Synthetic rationale.'
      });
      assert.equal(missing.status, 404);
    } finally {
      await close();
    }
  });

  it('enforces review permissions server-side', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await intakeNotice(base);
      const id = created.json.id as string;
      const body = { status: 'applicable', rationale: 'Synthetic rationale.' };
      const before = snapshot(db);
      assert.equal((await call(base, 'PATCH', `/api/notices/${id}`, 'u-staff', body)).status, 403);
      assert.equal((await call(base, 'PATCH', `/api/notices/${id}`, 'u-clinic-mgr', body)).status, 403);
      assertUnchanged(db, before);
      assert.equal((await call(base, 'PATCH', `/api/notices/${id}`, 'u-admin', body)).status, 200);
    } finally {
      await close();
    }
  });
});

describe('notice follow-up tasks', () => {
  async function applicableNotice(base: string): Promise<string> {
    const created = await intakeNotice(base);
    const id = created.json.id as string;
    const res = await call(base, 'PATCH', `/api/notices/${id}`, 'u-nurse-mgr', {
      status: 'applicable',
      rationale: 'Synthetic test rationale.'
    });
    assert.equal(res.status, 200);
    return id;
  }

  function followupBody(key = 'notice-test-key-1'): Record<string, unknown> {
    return {
      idempotencyKey: key,
      orgId: 'org-cah',
      domainId: 'dom-tjc',
      title: 'Synthetic notice follow-up',
      ownerId: 'u-staff',
      dueDate: '2027-05-05'
    };
  }

  it('creates a linked task with key record and audits', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      const before = db.audit.length;
      const res = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', followupBody());
      assert.equal(res.status, 201);
      assert.equal(res.json.duplicate, false);
      const task = res.json.task as Record<string, unknown>;
      assert.equal(task.noticeId, id);
      assert.equal(task.status, 'open');
      assert.equal(db.audit.length, before + 2);
      const actions = db.audit.slice(-2).map((e) => (e as { action: string }).action);
      assert.deepEqual(actions, ['task.created', 'notice.followup.created']);
      const followupEvent = db.audit[db.audit.length - 1] as { orgId: string; recordType: string; recordId: string };
      assert.equal(followupEvent.orgId, 'org-cah');
      assert.equal(followupEvent.recordType, 'notice');
      assert.equal(followupEvent.recordId, id);
      assert.equal((db.noticeFollowupKeys as unknown[]).length, 1);
      assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
    } finally {
      await close();
    }
  });

  it('only applicable notices may create tasks', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await intakeNotice(base);
      const pending = created.json.id as string;
      const before = snapshot(db);
      assert.equal(
        (await call(base, 'POST', `/api/notices/${pending}/followups`, 'u-nurse-mgr', followupBody())).status,
        400
      );
      await call(base, 'PATCH', `/api/notices/${pending}`, 'u-nurse-mgr', {
        status: 'not_applicable',
        rationale: 'Synthetic test rationale.'
      });
      assert.equal(
        (await call(base, 'POST', `/api/notices/${pending}/followups`, 'u-nurse-mgr', followupBody('k2'))).status,
        400
      );
      assert.equal(
        (await call(base, 'POST', '/api/notices/notice-nope/followups', 'u-nurse-mgr', followupBody('k3'))).status,
        404
      );
      assert.equal(db.tasks.length, before.tasks);
      assert.equal((db.noticeFollowupKeys as unknown[]).length, 0);
    } finally {
      await close();
    }
  });

  it('validates task fields and org match with nothing changed', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      const bad: Array<[string, Record<string, unknown>]> = [
        ['missing key', { ...followupBody(), idempotencyKey: '' }],
        ['org mismatch', { ...followupBody('k-org'), orgId: 'org-clinic' }],
        ['unknown domain', { ...followupBody('k-dom'), domainId: 'dom-nope' }],
        ['cross-org domain', { ...followupBody('k-dom2'), domainId: 'dom-hipaa-c' }],
        ['blank title', { ...followupBody('k-title'), title: '  ' }],
        ['cross-org owner', { ...followupBody('k-owner'), ownerId: 'u-clinic-staff' }],
        ['bad due date', { ...followupBody('k-due'), dueDate: '2027-02-30' }]
      ];
      for (const [label, body] of bad) {
        const before = snapshot(db);
        const res = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', body);
        assert.equal(res.status, 400, label);
        assertUnchanged(db, before);
      }
    } finally {
      await close();
    }
  });

  it('enforces follow-up permissions server-side', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      const before = snapshot(db);
      assert.equal(
        (await call(base, 'POST', `/api/notices/${id}/followups`, 'u-staff', followupBody())).status,
        403
      );
      assert.equal(
        (await call(base, 'POST', `/api/notices/${id}/followups`, 'u-clinic-mgr', followupBody())).status,
        403
      );
      assertUnchanged(db, before);
    } finally {
      await close();
    }
  });

  it('replays identical retries without another write and rejects conflicts', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      const first = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', followupBody());
      assert.equal(first.status, 201);
      const firstTask = first.json.task as { id: string };
      const before = snapshot(db);
      const retry = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', followupBody());
      assert.equal(retry.status, 200);
      assert.equal(retry.json.duplicate, true);
      assert.equal((retry.json.task as { id: string }).id, firstTask.id);
      assertUnchanged(db, before);
      const conflict = await call(
        base,
        'POST',
        `/api/notices/${id}/followups`,
        'u-nurse-mgr',
        { ...followupBody(), title: 'Different synthetic title' }
      );
      assert.equal(conflict.status, 409);
      assertUnchanged(db, before);
      // A different actor's same key is a separate scope: own task.
      const other = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-officer', followupBody());
      assert.equal(other.status, 201);
      assert.notEqual((other.json.task as { id: string }).id, firstTask.id);
    } finally {
      await close();
    }
  });

  it('fails closed on corrupt key storage with nothing changed', async () => {
    const { base, close } = await startServer((db) => {
      (db as { noticeFollowupKeys: unknown }).noticeFollowupKeys = [{ key: 'broken' }];
    });
    try {
      const created = await intakeNotice(base);
      const id = created.json.id as string;
      await call(base, 'PATCH', `/api/notices/${id}`, 'u-nurse-mgr', {
        status: 'applicable',
        rationale: 'Synthetic test rationale.'
      });
      const res = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', followupBody());
      assert.equal(res.status, 503);
      assert.equal(res.json.code, 'notice.keys.unavailable');
    } finally {
      await close();
    }
  });

  it('returns the fixed 503 when a retained key references a missing task', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      const body = followupBody('orphan-key-1');
      (db.noticeFollowupKeys as Array<Record<string, unknown>>).push({
        key: 'orphan-key-1',
        actorId: 'u-nurse-mgr',
        orgId: 'org-cah',
        taskId: 'task-nope',
        contentHash: notices.noticeFollowupContentHash({
          orgId: 'org-cah',
          domainId: 'dom-tjc',
          title: 'Synthetic notice follow-up',
          ownerId: 'u-staff',
          dueDate: '2027-05-05',
          noticeId: id
        }),
        createdAt: new Date().toISOString()
      });
      const before = snapshot(db);
      const res = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', body);
      assert.equal(res.status, 503);
      assert.equal(res.json.error, 'Notice follow-ups are unavailable.');
      assert.equal(res.json.code, 'notice.keys.unavailable');
      assertUnchanged(db, before);
    } finally {
      await close();
    }
  });

  it('rolls back task, key, link, and audits on failed save', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      const before = snapshot(db);
      store.__setRenameImpl(() => {
        throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      });
      try {
        const res = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', followupBody());
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      assertUnchanged(db, before);
      assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
    } finally {
      await close();
    }
  });

  it('keeps the notice link authoritative and unforgeable', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      // Ordinary task creation drops a forged link field.
      const forged = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-tjc',
        title: 'Synthetic ordinary task',
        ownerId: 'u-staff',
        dueDate: '2027-05-05',
        noticeId: id
      });
      assert.equal(forged.status, 201);
      assert.equal((forged.json as Record<string, unknown>).noticeId, undefined);
      // Task PATCH has no link path either.
      const taskId = (forged.json as { id: string }).id;
      await call(base, 'PATCH', `/api/tasks/${taskId}`, 'u-nurse-mgr', { noticeId: id });
      assert.equal((db.tasks.find((t) => t.id === taskId) as { noticeId?: string }).noticeId, undefined);
    } finally {
      await close();
    }
  });

  it('runs follow-up tasks under unchanged verification rules', async () => {
    const { base, close } = await startServer();
    try {
      const id = await applicableNotice(base);
      const created = await call(base, 'POST', `/api/notices/${id}/followups`, 'u-nurse-mgr', followupBody());
      const taskId = (created.json.task as { id: string }).id;
      // D4: evidence gates submission on ordinary rules.
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${taskId}`, 'u-staff', { status: 'submitted' })).status,
        400
      );
      assert.equal(
        (
          await call(base, 'POST', `/api/tasks/${taskId}/evidence`, 'u-staff', {
            label: 'Synthetic quarantine log',
            holder: 'T. Nguyen'
          })
        ).status,
        201
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${taskId}`, 'u-staff', { status: 'submitted' })).status,
        200
      );
      // D5: the submitter cannot verify; an independent officer can.
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${taskId}`, 'u-staff', { status: 'verified' })).status,
        403
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${taskId}`, 'u-officer2', { status: 'verified' })).status,
        200
      );
    } finally {
      await close();
    }
  });

  it('loads legacy databases with an empty notices collection', async () => {
    const legacyFile = join(workdir, 'legacy-notices.json');
    const raw = JSON.parse(JSON.stringify(seedDatabase())) as Record<string, unknown>;
    delete raw.notices;
    delete raw.noticeFollowupKeys;
    writeFileSync(legacyFile, JSON.stringify(raw));
    const saved = process.env.SENTINEL_DATA_FILE;
    process.env.SENTINEL_DATA_FILE = legacyFile;
    try {
      const db = store.loadDb();
      assert.deepEqual(db.notices, []);
      assert.deepEqual(db.noticeFollowupKeys, []);
      // Absent keys WITH notice-linked tasks fail closed (undefined).
      const linked = JSON.parse(JSON.stringify(seedDatabase())) as {
        tasks: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
      delete linked.notices;
      delete linked.noticeFollowupKeys;
      linked.tasks[0].noticeId = 'notice-legacy';
      writeFileSync(legacyFile, JSON.stringify(linked));
      const db2 = store.loadDb();
      assert.deepEqual(db2.notices, []);
      assert.equal(db2.noticeFollowupKeys, undefined);
    } finally {
      process.env.SENTINEL_DATA_FILE = saved;
    }
  });
});
