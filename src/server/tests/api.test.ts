// HTTP-level D1 regression tests: state changes and their audit events must
// persist together or not at all. Uses an isolated temp database and
// ephemeral ports; never touches data/sentinel.json or QA evidence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync as realRenameSync } from 'node:fs';
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

interface TestServer {
  db: ReturnType<typeof seedDatabase>;
  base: string;
  close: () => Promise<void>;
}

async function startServer(mutate?: (db: ReturnType<typeof seedDatabase>) => void): Promise<TestServer> {
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

/** Disk state must always equal memory state, with a valid audit chain. */
function assertDiskMatchesMemory(db: ReturnType<typeof seedDatabase>): void {
  const disk = JSON.parse(readFileSync(dataFile, 'utf8')) as ReturnType<typeof seedDatabase>;
  assert.deepEqual(disk, db);
  assert.deepEqual(store.verifyAuditChain(disk.audit), { ok: true });
}

function tempFiles(): string[] {
  return readdirSync(workdir).filter((name) => name.endsWith('.tmp'));
}

function eperm(): Error {
  const e = new Error('simulated EPERM') as NodeJS.ErrnoException;
  e.code = 'EPERM';
  return e;
}

describe('D1 atomic persistence (HTTP)', () => {
  it('persists a status change and its audit event together', async () => {
    const { db, base, close } = await startServer();
    try {
      // D5c: seeded legacy tasks need a recorded submission first.
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-officer', { status: 'in_progress' }))
          .status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-nurse-mgr', { status: 'submitted' }))
          .status,
        200
      );
      const before = db.audit.length;
      const res = await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-officer', {
        status: 'verified'
      });
      assert.equal(res.status, 200);
      assert.equal(db.tasks.find((t) => t.id === 'task-med-storage')?.status, 'verified');
      assert.equal(db.audit.length, before + 1);
      assert.equal(db.audit[db.audit.length - 1].action, 'task.verified');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back memory and disk when persistence fails, and logs the error', async () => {
    const { db, base, close } = await startServer();
    // D5c: seeded legacy tasks need a recorded submission first.
    assert.equal(
      (await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-officer', { status: 'in_progress' }))
        .status,
      200
    );
    assert.equal(
      (await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-nurse-mgr', { status: 'submitted' }))
        .status,
      200
    );
    const logged: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    store.__setRenameImpl(() => {
      throw eperm();
    });
    try {
      const diskBefore = readFileSync(dataFile, 'utf8');
      const statusBefore = db.tasks.find((t) => t.id === 'task-med-storage')?.status;
      const auditBefore = db.audit.length;
      const res = await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-officer', {
        status: 'verified'
      });
      assert.equal(res.status, 500);
      assert.deepEqual(res.json, { error: 'Internal error.' });
      // Memory rolled back.
      assert.equal(db.tasks.find((t) => t.id === 'task-med-storage')?.status, statusBefore);
      assert.equal(db.audit.length, auditBefore);
      // Disk untouched, no orphan temp file.
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      // Failure was logged with route context.
      assert.ok(
        logged.some((args) => String(args[0]).includes('PATCH /api/tasks/task-med-storage')),
        `expected route context in logs, got: ${JSON.stringify(logged)}`
      );
    } finally {
      console.error = origError;
      store.__setRenameImpl(null);
      await close();
    }
  });

  it('succeeds after a transient rename failure', async () => {
    const { db, base, close } = await startServer();
    // D5c: seeded legacy tasks need a recorded submission first.
    assert.equal(
      (await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-officer', { status: 'in_progress' }))
        .status,
      200
    );
    assert.equal(
      (await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-nurse-mgr', { status: 'submitted' }))
        .status,
      200
    );
    let calls = 0;
    store.__setRenameImpl((tmp, file) => {
      calls++;
      if (calls === 1) throw eperm();
      realRenameSync(tmp, file);
    });
    try {
      const res = await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-officer', {
        status: 'verified'
      });
      assert.equal(res.status, 200);
      assert.ok(calls >= 2, 'expected at least one retry');
      assertDiskMatchesMemory(db);
    } finally {
      store.__setRenameImpl(null);
      await close();
    }
  });

  it('persists created tasks and evidence together with their audit events', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D1 probe task',
        ownerId: 'u-staff',
        dueDate: '2026-12-01'
      });
      assert.equal(created.status, 201);
      assertDiskMatchesMemory(db);
      const taskId = String(created.json.id);
      const ev = await call(base, 'POST', `/api/tasks/${taskId}/evidence`, 'u-nurse-mgr', {
        label: 'probe photo (simulated)',
        holder: 'M. Lee'
      });
      assert.equal(ev.status, 201);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('persists template changes and instantiation together', async () => {
    const { db, base, close } = await startServer();
    try {
      const updated = await call(base, 'PATCH', '/api/templates/tpl-signage', 'u-officer', {
        active: false
      });
      assert.equal(updated.status, 200);
      assertDiskMatchesMemory(db);
      const inst = await call(base, 'POST', '/api/templates/tpl-access-review/instantiate', 'u-officer', {
        ownerId: 'u-officer',
        dueDate: '2026-11-01'
      });
      assert.equal(inst.status, 201);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D2 verified-record locking (HTTP)', () => {
  async function taskJson(
    base: string,
    userId: string,
    id: string
  ): Promise<Record<string, unknown>> {
    const res = await call(base, 'GET', '/api/tasks?orgId=org-cah', userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as Array<Record<string, unknown>>;
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible to ${userId}`);
    return found;
  }

  async function auditCount(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  it('rejects field edits on verified tasks for admin, officer, and manager', async () => {
    const { db, base, close } = await startServer();
    try {
      const patches: Array<Record<string, string>> = [
        { title: 'renamed after verification' },
        { ownerId: 'u-staff' },
        { dueDate: '2027-01-01' },
        { domainId: 'dom-osha-h' },
        {}
      ];
      for (const userId of ['u-admin', 'u-officer', 'u-nurse-mgr']) {
        for (const patch of patches) {
          const before = await taskJson(base, userId, 'task-baa');
          const audits = await auditCount(base, userId);
          const res = await call(base, 'PATCH', '/api/tasks/task-baa', userId, patch);
          assert.equal(res.status, 400, `${userId} ${JSON.stringify(patch)}`);
          assert.equal(res.json.error, 'Verified records are locked.');
          assert.deepEqual(await taskJson(base, userId, 'task-baa'), before);
          assert.equal(await auditCount(base, userId), audits);
        }
      }
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects staff-owner edits and evidence on their own verified task', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D2 staff probe task',
        ownerId: 'u-staff',
        dueDate: '2026-12-01'
      });
      assert.equal(created.status, 201);
      const id = String(created.json.id);
      assert.equal(
        (
          await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-staff', {
            label: 'attachment (simulated)',
            holder: 'T. Nguyen'
          })
        ).status,
        201
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-staff', { status: 'submitted' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'verified' })).status,
        200
      );
      const before = await taskJson(base, 'u-staff', id);
      const audits = await auditCount(base, 'u-staff');
      const renamed = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-staff', {
        title: 'staff rename after verification'
      });
      assert.equal(renamed.status, 400);
      assert.equal(renamed.json.error, 'Verified records are locked.');
      const ev = await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-staff', {
        label: 'late photo (simulated)',
        holder: 'T. Nguyen'
      });
      assert.equal(ev.status, 400);
      assert.equal(ev.json.error, 'Verified records are locked.');
      assert.deepEqual(await taskJson(base, 'u-staff', id), before);
      assert.equal(await auditCount(base, 'u-staff'), audits);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects evidence additions and custody transfers on verified tasks', async () => {
    const { db, base, close } = await startServer();
    try {
      for (const userId of ['u-admin', 'u-officer', 'u-nurse-mgr']) {
        const before = await taskJson(base, userId, 'task-baa');
        const audits = await auditCount(base, userId);
        const evidence = before.evidence as Array<Record<string, unknown>>;
        assert.ok(evidence.length > 0);
        const ev = await call(base, 'POST', '/api/tasks/task-baa/evidence', userId, {
          label: 'late addition (simulated)',
          holder: 'J. Ortiz'
        });
        assert.equal(ev.status, 400, userId);
        assert.equal(ev.json.error, 'Verified records are locked.');
        const tr = await call(base, 'POST', '/api/tasks/task-baa/transfer', userId, {
          evidenceId: String(evidence[0].id),
          toHolder: 'Archive'
        });
        assert.equal(tr.status, 400, userId);
        assert.equal(tr.json.error, 'Verified records are locked.');
        assert.deepEqual(await taskJson(base, userId, 'task-baa'), before);
        assert.equal(await auditCount(base, userId), audits);
      }
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('still denies staff custody transfer by role without touching data', async () => {
    const { db, base, close } = await startServer();
    try {
      const before = await taskJson(base, 'u-staff', 'task-baa');
      const audits = await auditCount(base, 'u-staff');
      const evidence = before.evidence as Array<Record<string, unknown>>;
      const tr = await call(base, 'POST', '/api/tasks/task-baa/transfer', 'u-staff', {
        evidenceId: String(evidence[0].id),
        toHolder: 'Archive'
      });
      assert.equal(tr.status, 403);
      assert.deepEqual(await taskJson(base, 'u-staff', 'task-baa'), before);
      assert.equal(await auditCount(base, 'u-staff'), audits);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects status changes out of verified but allows edits on unverified tasks', async () => {
    const { db, base, close } = await startServer();
    try {
      const reopen = await call(base, 'PATCH', '/api/tasks/task-baa', 'u-officer', {
        status: 'open'
      });
      assert.equal(reopen.status, 400);
      const ok = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-nurse-mgr', {
        title: 'OSHA sharps injury log — quarterly review (retitled)'
      });
      assert.equal(ok.status, 200);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D6 organization isolation (HTTP)', () => {
  function rows(json: Record<string, unknown>): Array<Record<string, unknown>> {
    return json as unknown as Array<Record<string, unknown>>;
  }

  function assertErrorOnly(json: Record<string, unknown>): void {
    assert.deepEqual(Object.keys(json), ['error']);
  }

  it('restricts scoped reads to their own org; foreign orgId → 403 without records', async () => {
    const { base, close } = await startServer();
    try {
      const scoped: Array<{ user: string; org: string; foreign: string }> = [
        { user: 'u-nurse-mgr', org: 'org-cah', foreign: 'org-clinic' },
        { user: 'u-clinic-staff', org: 'org-clinic', foreign: 'org-cah' },
        { user: 'u-canna-mgr', org: 'org-canna', foreign: 'org-cah' }
      ];
      for (const s of scoped) {
        for (const path of ['/api/tasks', '/api/domains', '/api/templates']) {
          const own = await call(base, 'GET', `${path}?orgId=${s.org}`, s.user);
          assert.equal(own.status, 200, `${s.user} ${path} own`);
          assert.ok(rows(own.json).every((r) => r.orgId === s.org));
          const missing = await call(base, 'GET', path, s.user);
          assert.equal(missing.status, 200, `${s.user} ${path} missing orgId`);
          assert.ok(rows(missing.json).every((r) => r.orgId === s.org));
          const denied = await call(base, 'GET', `${path}?orgId=${s.foreign}`, s.user);
          assert.equal(denied.status, 403, `${s.user} ${path} foreign`);
          assertErrorOnly(denied.json);
        }
      }
    } finally {
      await close();
    }
  });

  it('shows scoped users only own-org audit events', async () => {
    const { base, close } = await startServer();
    try {
      const mk = async (orgId: string, domainId: string, ownerId: string, title: string) =>
        call(base, 'POST', '/api/tasks', 'u-officer', {
          orgId,
          domainId,
          title,
          ownerId,
          dueDate: '2026-12-01'
        });
      assert.equal((await mk('org-cah', 'dom-osha-h', 'u-staff', 'D6 hospital probe')).status, 201);
      assert.equal(
        (await mk('org-clinic', 'dom-osha-c', 'u-clinic-staff', 'D6 clinic probe')).status,
        201
      );
      const staff = await call(base, 'GET', '/api/audit?limit=500', 'u-clinic-staff');
      assert.equal(staff.status, 200);
      const staffEvents = rows(staff.json);
      assert.ok(staffEvents.length > 0);
      assert.ok(staffEvents.every((e) => e.orgId === 'org-clinic' || e.orgId === 'system'));
      assert.ok(staffEvents.some((e) => e.orgId === 'org-clinic'));
      const mgr = await call(base, 'GET', '/api/audit?limit=500', 'u-nurse-mgr');
      assert.equal(mgr.status, 200);
      assert.ok(rows(mgr.json).every((e) => e.orgId === 'org-cah' || e.orgId === 'system'));
    } finally {
      await close();
    }
  });

  it('retains documented cross-org read access for admin and officer', async () => {
    const { base, close } = await startServer();
    try {
      for (const user of ['u-admin', 'u-officer']) {
        const all = await call(base, 'GET', '/api/tasks', user);
        assert.equal(all.status, 200, user);
        const orgs = new Set(rows(all.json).map((t) => t.orgId));
        assert.ok(orgs.has('org-cah') && orgs.has('org-clinic') && orgs.has('org-canna'), user);
        const one = await call(base, 'GET', '/api/tasks?orgId=org-clinic', user);
        assert.equal(one.status, 200, user);
        assert.ok(rows(one.json).every((t) => t.orgId === 'org-clinic'));
      }
      const audit = await call(base, 'GET', '/api/audit?limit=500', 'u-officer');
      const auditOrgs = new Set(rows(audit.json).map((e) => e.orgId));
      assert.ok(auditOrgs.has('org-cah') && auditOrgs.has('org-clinic'));
    } finally {
      await close();
    }
  });

  it('rejects cross-org writes without side effects or record leaks', async () => {
    const { db, base, close } = await startServer();
    try {
      const tasksBefore = db.tasks.length;
      const auditsBefore = db.audit.length;
      const attempts = [
        call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
          orgId: 'org-clinic',
          domainId: 'dom-osha-c',
          title: 'foreign create',
          ownerId: 'u-clinic-staff',
          dueDate: '2026-12-01'
        }),
        call(base, 'PATCH', '/api/tasks/task-privacy-screen', 'u-nurse-mgr', {
          title: 'foreign edit'
        }),
        call(base, 'PATCH', '/api/tasks/task-privacy-screen', 'u-nurse-mgr', {}),
        call(base, 'POST', '/api/tasks/task-privacy-screen/evidence', 'u-nurse-mgr', {
          label: 'x',
          holder: 'y'
        }),
        call(base, 'POST', '/api/tasks/task-eyewash/transfer', 'u-nurse-mgr', {
          evidenceId: 'task-eyewash-ev1',
          toHolder: 'Archive'
        }),
        call(base, 'POST', '/api/templates/tpl-access-review/instantiate', 'u-clinic-mgr', {
          ownerId: 'u-clinic-staff'
        }),
        call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-clinic-staff', { title: 'x' })
      ];
      for (const attempt of attempts) {
        const res = await attempt;
        assert.equal(res.status, 403);
        assertErrorOnly(res.json);
      }
      assert.equal(db.tasks.length, tasksBefore);
      assert.equal(db.audit.length, auditsBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('allows authorized writes with correct audit org attribution', async () => {
    const { db, base, close } = await startServer();
    try {
      const scoped = await call(base, 'POST', '/api/tasks', 'u-clinic-mgr', {
        orgId: 'org-clinic',
        domainId: 'dom-osha-c',
        title: 'D6 authorized clinic task',
        ownerId: 'u-clinic-staff',
        dueDate: '2026-12-01'
      });
      assert.equal(scoped.status, 201);
      const cross = await call(base, 'POST', '/api/tasks', 'u-officer', {
        orgId: 'org-clinic',
        domainId: 'dom-osha-c',
        title: 'D6 privileged cross-org task',
        ownerId: 'u-clinic-staff',
        dueDate: '2026-12-01'
      });
      assert.equal(cross.status, 201);
      const mine = await call(base, 'PATCH', '/api/tasks/task-eyewash', 'u-clinic-mgr', {
        title: 'Eyewash station weekly check log (retitled)'
      });
      assert.equal(mine.status, 200);
      for (const id of [String(scoped.json.id), String(cross.json.id)]) {
        const trail = await call(base, 'GET', `/api/audit?recordId=${id}`, 'u-officer');
        assert.equal(trail.status, 200);
        const events = rows(trail.json);
        assert.ok(events.length > 0);
        assert.ok(events.every((e) => e.orgId === 'org-clinic'));
      }
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('keeps the audit chain valid when titles contain pipes', async () => {
    const { base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'QA-F1 synthetic | pipe in title',
        ownerId: 'u-staff',
        dueDate: '2026-12-01'
      });
      assert.equal(created.status, 201);
      const id = String(created.json.id);
      const patched = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
        status: 'in_progress'
      });
      assert.equal(patched.status, 200);
      const health = await call(base, 'GET', '/api/health', 'u-admin');
      assert.equal(health.status, 200);
      assert.equal(health.json.auditChainOk, true);
    } finally {
      await close();
    }
  });

  it('seeds every audit event with an org id', async () => {
    const { base, close } = await startServer();
    try {
      const res = await call(base, 'GET', '/api/audit?limit=500', 'u-admin');
      assert.equal(res.status, 200);
      const events = rows(res.json);
      assert.ok(events.length > 0);
      const known = new Set(['org-cah', 'org-clinic', 'org-canna', 'system']);
      assert.ok(events.every((e) => typeof e.orgId === 'string' && known.has(e.orgId as string)));
      assert.ok(events.some((e) => e.action === 'db.seeded' && e.orgId === 'system'));
    } finally {
      await close();
    }
  });

  it('reports an unhealthy chain when a version is unsupported', async () => {
    const { db, base, close } = await startServer();
    try {
      (db.audit[0] as unknown as Record<string, unknown>).hashVersion = 99;
      const health = await call(base, 'GET', '/api/health', 'u-admin');
      assert.equal(health.status, 200);
      assert.equal(health.json.auditChainOk, false);
    } finally {
      await close();
    }
  });

  it('hides unknown-org events from scoped users; privileged roles see them', async () => {
    // Legacy-shaped fixture: genuine v1 chain (v1 hashes), one orphaned task
    // record backfilled to 'unknown', plus the seeded marker as 'system'.
    const { base, close } = await startServer((db) => {
      db.tasks = db.tasks.filter((t) => t.id !== 'task-sharps-log');
      for (const e of db.audit) {
        const rec = e as unknown as Record<string, unknown>;
        delete rec.hashVersion;
        delete rec.orgId;
      }
      store.backfillAuditOrgIds(db);
      let prev = 'GENESIS';
      for (const e of db.audit) {
        e.prevHash = prev;
        e.hash = createHash('sha256')
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
        prev = e.hash;
      }
    });
    try {
      const health = await call(base, 'GET', '/api/health', 'u-admin');
      assert.equal(health.json.auditChainOk, true);
      for (const user of ['u-nurse-mgr', 'u-staff', 'u-clinic-mgr', 'u-clinic-staff', 'u-canna-mgr']) {
        const res = await call(base, 'GET', '/api/audit?limit=500', user);
        assert.equal(res.status, 200, user);
        const events = rows(res.json);
        assert.ok(
          events.every((e) => e.orgId !== 'unknown'),
          user
        );
        assert.ok(
          events.some((e) => e.action === 'db.seeded' && e.orgId === 'system'),
          `${user} sees db.seeded`
        );
      }
      for (const user of ['u-admin', 'u-officer']) {
        const res = await call(base, 'GET', '/api/audit?limit=500', user);
        assert.equal(res.status, 200, user);
        assert.ok(
          rows(res.json).some((e) => e.orgId === 'unknown'),
          `${user} sees unknown events`
        );
      }
    } finally {
      await close();
    }
  });

  it('contains forged system tags on task events to privileged roles only', async () => {
    // Attacker re-tags a v2 task event as 'system' and re-hashes correctly,
    // so the chain itself stays valid and only the read-time rule protects it.
    const { base, close } = await startServer((db) => {
      const idx = db.audit.findIndex((e) => e.recordType === 'task');
      db.audit[idx].orgId = 'system';
      let prev = idx === 0 ? 'GENESIS' : db.audit[idx - 1].hash;
      for (let i = idx; i < db.audit.length; i++) {
        const e = db.audit[i];
        e.prevHash = prev;
        e.hash = createHash('sha256')
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
        prev = e.hash;
      }
    });
    try {
      const health = await call(base, 'GET', '/api/health', 'u-admin');
      assert.equal(health.json.auditChainOk, true);
      const forged = (e: Record<string, unknown>): boolean =>
        e.orgId === 'system' && e.recordType === 'task';
      for (const user of ['u-nurse-mgr', 'u-staff', 'u-clinic-mgr', 'u-clinic-staff', 'u-canna-mgr']) {
        const res = await call(base, 'GET', '/api/audit?limit=500', user);
        assert.equal(res.status, 200, user);
        assert.ok(!rows(res.json).some(forged), `${user} must not see forged event`);
        assert.ok(
          rows(res.json).some((e) => e.action === 'db.seeded' && e.orgId === 'system'),
          `${user} sees db.seeded`
        );
      }
      for (const user of ['u-admin', 'u-officer']) {
        const res = await call(base, 'GET', '/api/audit?limit=500', user);
        assert.equal(res.status, 200, user);
        assert.ok(rows(res.json).some(forged), `${user} sees forged event for forensics`);
      }
    } finally {
      await close();
    }
  });

  it('serves derived legacy orgIds correctly to every role', async () => {
    // Legacy v1 chain whose stored tags are all wrong; backfill re-derives.
    const { base, close } = await startServer((db) => {
      db.tasks = db.tasks.filter((t) => t.id !== 'task-sharps-log');
      for (const e of db.audit) {
        const rec = e as unknown as Record<string, unknown>;
        delete rec.hashVersion;
        rec.orgId = 'org-clinic';
      }
      store.backfillAuditOrgIds(db);
      let prev = 'GENESIS';
      for (const e of db.audit) {
        e.prevHash = prev;
        e.hash = createHash('sha256')
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
        prev = e.hash;
      }
    });
    try {
      const health = await call(base, 'GET', '/api/health', 'u-admin');
      assert.equal(health.json.auditChainOk, true);
      const scoped: Array<{ user: string; org: string }> = [
        { user: 'u-nurse-mgr', org: 'org-cah' },
        { user: 'u-staff', org: 'org-cah' },
        { user: 'u-clinic-mgr', org: 'org-clinic' },
        { user: 'u-clinic-staff', org: 'org-clinic' },
        { user: 'u-canna-mgr', org: 'org-canna' }
      ];
      for (const s of scoped) {
        const res = await call(base, 'GET', '/api/audit?limit=500', s.user);
        assert.equal(res.status, 200, s.user);
        const events = rows(res.json);
        assert.ok(
          events.every((e) => e.orgId === s.org || e.orgId === 'system'),
          `${s.user} sees only own org + system`
        );
        assert.ok(
          events.every((e) => e.orgId !== 'unknown'),
          `${s.user} sees no unknown`
        );
      }
      // A hospital event mis-tagged org-clinic is derived back: visible to
      // hospital staff, invisible to clinic staff.
      const mgr = rows((await call(base, 'GET', '/api/audit?limit=500', 'u-nurse-mgr')).json);
      const mine = mgr.find((e) => e.recordId === 'task-med-storage' && e.action === 'task.created');
      assert.ok(mine && mine.orgId === 'org-cah');
      const clinic = rows((await call(base, 'GET', '/api/audit?limit=500', 'u-clinic-staff')).json);
      assert.ok(!clinic.some((e) => e.recordId === 'task-med-storage'));
      for (const user of ['u-admin', 'u-officer']) {
        const res = await call(base, 'GET', '/api/audit?limit=500', user);
        assert.ok(rows(res.json).some((e) => e.orgId === 'unknown'), `${user} sees unknown`);
        assert.ok(rows(res.json).some((e) => e.recordId === 'task-med-storage'), user);
      }
    } finally {
      await close();
    }
  });
});

describe('D3 custody history (HTTP)', () => {
  interface CustodyJson {
    seq: number;
    fromHolder: string | null;
    toHolder: string;
    byUserId: string;
    at: string;
    reason?: string;
  }
  interface EvidenceJson {
    id: string;
    label: string;
    holder: string;
    custody: CustodyJson[];
  }
  interface TaskJson {
    id: string;
    evidence: EvidenceJson[];
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function trail(base: string, userId: string, id: string): Promise<Array<Record<string, unknown>>> {
    const res = await call(base, 'GET', `/api/audit?recordId=${id}&limit=50`, userId);
    assert.equal(res.status, 200);
    return res.json as unknown as Array<Record<string, unknown>>;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  const shape = (c: CustodyJson): object => ({
    seq: c.seq,
    fromHolder: c.fromHolder,
    toHolder: c.toHolder,
    byUserId: c.byUserId,
    reason: c.reason ?? null
  });

  it('records a correct append-only custody chain across transfers', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D3 custody probe',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01'
      });
      assert.equal(created.status, 201);
      const id = String(created.json.id);
      const ev = await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
        label: 'D3 probe item',
        holder: 'Alice'
      });
      assert.equal(ev.status, 201);
      const evId = String((ev.json as Record<string, unknown>).id);
      const genesis = ((ev.json as Record<string, unknown>).custody as CustodyJson[])[0];
      assert.deepEqual(shape(genesis), {
        seq: 1,
        fromHolder: null,
        toHolder: 'Alice',
        byUserId: 'u-nurse-mgr',
        reason: null
      });
      const t1 = await call(base, 'POST', `/api/tasks/${id}/transfer`, 'u-nurse-mgr', {
        evidenceId: evId,
        toHolder: 'Bob',
        reason: 'shift handoff'
      });
      assert.equal(t1.status, 200);
      const t2 = await call(base, 'POST', `/api/tasks/${id}/transfer`, 'u-officer', {
        evidenceId: evId,
        toHolder: 'Carol'
      });
      assert.equal(t2.status, 200);
      const task = await getTask(base, 'u-officer', 'org-cah', id);
      const item = task.evidence.find((e) => e.id === evId) as EvidenceJson;
      assert.equal(item.holder, 'Carol');
      assert.deepEqual(
        item.custody.map(shape),
        [
          { seq: 1, fromHolder: null, toHolder: 'Alice', byUserId: 'u-nurse-mgr', reason: null },
          { seq: 2, fromHolder: 'Alice', toHolder: 'Bob', byUserId: 'u-nurse-mgr', reason: 'shift handoff' },
          { seq: 3, fromHolder: 'Bob', toHolder: 'Carol', byUserId: 'u-officer', reason: null }
        ]
      );
      for (const c of item.custody) assert.ok(!Number.isNaN(Date.parse(c.at)), 'at is ISO time');
      assert.deepEqual(item.custody[0], genesis, 'genesis entry never edited');
      const events = await trail(base, 'u-officer', id);
      assert.deepEqual(
        events.filter((e) => e.action === 'custody.transferred').map((e) => e.detail),
        ['D3 probe item: Alice -> Bob — shift handoff', 'D3 probe item: Bob -> Carol']
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects transfer to the current holder without side effects', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D3 same-holder probe',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01'
      });
      const id = String(created.json.id);
      const ev = await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
        label: 'item',
        holder: 'Alice'
      });
      const evId = String((ev.json as Record<string, unknown>).id);
      const before = await getTask(base, 'u-nurse-mgr', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const res = await call(base, 'POST', `/api/tasks/${id}/transfer`, 'u-nurse-mgr', {
        evidenceId: evId,
        toHolder: 'Alice'
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'New holder must differ from the current holder.');
      assert.deepEqual(await getTask(base, 'u-nurse-mgr', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects unauthorized transfers without side effects', async () => {
    const { db, base, close } = await startServer();
    try {
      const audits = await auditTotal(base, 'u-officer');
      const foreign = await call(base, 'POST', '/api/tasks/task-eyewash/transfer', 'u-nurse-mgr', {
        evidenceId: 'task-eyewash-ev1',
        toHolder: 'Mallory'
      });
      assert.equal(foreign.status, 403);
      const staff = await call(base, 'POST', '/api/tasks/task-med-storage/transfer', 'u-staff', {
        evidenceId: 'task-med-storage-ev1',
        toHolder: 'Mallory'
      });
      assert.equal(staff.status, 403);
      const locked = await call(base, 'POST', '/api/tasks/task-baa/transfer', 'u-officer', {
        evidenceId: 'task-baa-ev1',
        toHolder: 'Mallory'
      });
      assert.equal(locked.status, 400);
      assert.equal(locked.json.error, 'Verified records are locked.');
      assert.equal((await getTask(base, 'u-officer', 'org-cah', 'task-med-storage')).evidence[0].holder, 'J. Ortiz');
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back custody changes when persistence fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D3 atomic probe',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01'
      });
      const id = String(created.json.id);
      const ev = await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
        label: 'item',
        holder: 'Alice'
      });
      const evId = String((ev.json as Record<string, unknown>).id);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'POST', `/api/tasks/${id}/transfer`, 'u-nurse-mgr', {
          evidenceId: evId,
          toHolder: 'Bob'
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      const task = await getTask(base, 'u-nurse-mgr', 'org-cah', id);
      assert.equal(task.evidence[0].holder, 'Alice');
      assert.equal(task.evidence[0].custody.length, 1);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D4 evidence-gated submission (HTTP)', () => {
  interface TaskJson {
    id: string;
    status: string;
    evidence: Array<Record<string, unknown>>;
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeTask(
    base: string,
    userId: string,
    ownerId: string
  ): Promise<string> {
    const created = await call(base, 'POST', '/api/tasks', userId, {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      title: 'D4 probe',
      ownerId,
      dueDate: '2026-12-01'
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  it('rejects submission with zero evidence, then allows it', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const before = await getTask(base, 'u-nurse-mgr', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
        status: 'submitted'
      });
      assert.equal(denied.status, 400);
      assert.equal(denied.json.error, 'Submission requires at least 1 evidence item.');
      assert.deepEqual(await getTask(base, 'u-nurse-mgr', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      const added = await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
        label: 'attachment (simulated)',
        holder: 'M. Lee'
      });
      assert.equal(added.status, 201);
      const ok = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
        status: 'submitted'
      });
      assert.equal(ok.status, 200);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('enforces template evidence counts', async () => {
    const { db, base, close } = await startServer();
    try {
      const inst = await call(base, 'POST', '/api/templates/tpl-emergency-drill/instantiate', 'u-officer', {
        ownerId: 'u-officer'
      });
      assert.equal(inst.status, 201);
      const id = String(inst.json.id);
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'submitted'
      });
      assert.equal(denied.status, 400);
      assert.equal(
        denied.json.error,
        "Submission requires at least 2 evidence items (template 'Emergency preparedness drill and review' requires 2)."
      );
      assert.equal((await getTask(base, 'u-officer', 'org-cah', id)).status, 'open');
      await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-officer', {
        label: 'drill log (simulated)',
        holder: 'J. Ortiz'
      });
      const still = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'submitted'
      });
      assert.equal(still.status, 400);
      await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-officer', {
        label: 'after-action note (simulated)',
        holder: 'J. Ortiz'
      });
      const ok = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'submitted'
      });
      assert.equal(ok.status, 200);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects unauthorized submissions without side effects', async () => {
    const { db, base, close } = await startServer();
    try {
      const audits = await auditTotal(base, 'u-officer');
      const other = await call(base, 'PATCH', '/api/tasks/task-emergency-drill', 'u-staff', {
        status: 'submitted'
      });
      assert.equal(other.status, 403);
      const foreign = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-clinic-mgr', {
        status: 'submitted'
      });
      assert.equal(foreign.status, 403);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back submission when persistence fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-nurse-mgr', 'u-nurse-mgr');
      await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
        label: 'attachment (simulated)',
        holder: 'M. Lee'
      });
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
          status: 'submitted'
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      assert.equal((await getTask(base, 'u-nurse-mgr', 'org-cah', id)).status, 'open');
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D4a zero-requirement templates (HTTP)', () => {
  interface TaskJson {
    id: string;
    status: string;
    evidence: Array<Record<string, unknown>>;
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  const ZERO_TEMPLATE = {
    orgId: 'org-cah',
    domainId: 'dom-osha-h',
    title: 'D4a zero-requirement probe (simulated)',
    description: 'Synthetic template with no evidence requirements.',
    controlType: 'best_practice',
    regulatoryRefs: [{ source: 'Internal QA probe', citation: 'not a legal mandate' }],
    responsibleRoles: ['department_manager'],
    recurrence: { frequency: 'once' },
    evidenceRequired: [],
    escalation: []
  };

  it('still requires 1 evidence item for zero-requirement templates', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/templates', 'u-officer', ZERO_TEMPLATE);
      assert.equal(created.status, 201);
      const templateId = String(created.json.id);
      const inst = await call(base, 'POST', `/api/templates/${templateId}/instantiate`, 'u-nurse-mgr', {
        ownerId: 'u-nurse-mgr'
      });
      assert.equal(inst.status, 201);
      const id = String(inst.json.id);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getTask(base, 'u-nurse-mgr', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
        status: 'submitted'
      });
      assert.equal(denied.status, 400);
      assert.equal(denied.json.error, 'Submission requires at least 1 evidence item.');
      assert.deepEqual(await getTask(base, 'u-nurse-mgr', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      const added = await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
        label: 'attachment (simulated)',
        holder: 'M. Lee'
      });
      assert.equal(added.status, 201);
      const ok = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
        status: 'submitted'
      });
      assert.equal(ok.status, 200);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('holds after PATCH clears a template to zero requirements', async () => {
    const { db, base, close } = await startServer();
    try {
      const patched = await call(base, 'PATCH', '/api/templates/tpl-sharps-review', 'u-officer', {
        evidenceRequired: []
      });
      assert.equal(patched.status, 200);
      const inst = await call(
        base,
        'POST',
        '/api/templates/tpl-sharps-review/instantiate',
        'u-nurse-mgr',
        { ownerId: 'u-nurse-mgr' }
      );
      assert.equal(inst.status, 201);
      const id = String(inst.json.id);
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
        status: 'submitted'
      });
      assert.equal(denied.status, 400);
      assert.equal(denied.json.error, 'Submission requires at least 1 evidence item.');
      assert.equal((await getTask(base, 'u-nurse-mgr', 'org-cah', id)).status, 'open');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D4b verification evidence gate (HTTP)', () => {
  interface TaskJson {
    id: string;
    status: string;
    evidence: Array<Record<string, unknown>>;
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  it('rejects verifying legacy submitted tasks with zero evidence', async () => {
    const { db, base, close } = await startServer((seeded) => {
      const legacy = seeded.tasks.find((t) => t.id === 'task-sharps-log');
      assert.ok(legacy);
      legacy.status = 'submitted';
      legacy.evidence = [];
      // D5c: history recorded so the test reaches the evidence gate.
      legacy.submissions = [
        {
          seq: 1,
          submittedBy: 'u-staff',
          ownerAtSubmission: 'u-staff',
          at: new Date().toISOString()
        }
      ];
    });
    try {
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getTask(base, 'u-officer', 'org-cah', 'task-sharps-log');
      const audits = await auditTotal(base, 'u-officer');
      for (const verifier of ['u-officer', 'u-admin']) {
        const denied = await call(base, 'PATCH', '/api/tasks/task-sharps-log', verifier, {
          status: 'verified'
        });
        assert.equal(denied.status, 400);
        assert.equal(
          denied.json.error,
          'Verification requires at least 1 evidence item (has 0).'
        );
      }
      assert.deepEqual(await getTask(base, 'u-officer', 'org-cah', 'task-sharps-log'), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('enforces template counts at verification too', async () => {
    const at = new Date().toISOString();
    const { db, base, close } = await startServer((seeded) => {
      const legacy = seeded.tasks.find((t) => t.id === 'task-sharps-log');
      assert.ok(legacy);
      legacy.status = 'submitted';
      legacy.templateId = 'tpl-emergency-drill';
      // D5c: history recorded so the test reaches the evidence gate.
      legacy.submissions = [
        { seq: 1, submittedBy: 'u-staff', ownerAtSubmission: 'u-staff', at }
      ];
      legacy.evidence = [
        {
          id: 'task-sharps-log-ev1',
          label: 'drill log (simulated)',
          holder: 'M. Lee',
          custody: [{ seq: 1, fromHolder: null, toHolder: 'M. Lee', byUserId: 'u-officer', at }],
          updatedAt: at
        }
      ];
    });
    try {
      const denied = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 400);
      assert.equal(
        denied.json.error,
        "Verification requires at least 2 evidence items (has 1) (template 'Emergency preparedness drill and review' requires 2)."
      );
      const added = await call(base, 'POST', '/api/tasks/task-sharps-log/evidence', 'u-officer', {
        label: 'after-action note (simulated)',
        holder: 'M. Lee'
      });
      assert.equal(added.status, 201);
      const ok = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-officer', {
        status: 'verified'
      });
      assert.equal(ok.status, 200);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('keeps the normal submit-then-verify path working and locked', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D4b probe',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01'
      });
      assert.equal(created.status, 201);
      const id = String(created.json.id);
      assert.equal(
        (
          await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
            label: 'attachment (simulated)',
            holder: 'M. Lee'
          })
        ).status,
        201
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', { status: 'submitted' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'verified' })).status,
        200
      );
      const locked = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        title: 'edited after lock'
      });
      assert.equal(locked.status, 400);
      assert.equal((await getTask(base, 'u-officer', 'org-cah', id)).status, 'verified');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('guard: the suite never touches the live database file', () => {
    assert.ok(dataFile.startsWith(workdir), `data file ${dataFile} is not the temp copy`);
    assert.notEqual(dataFile, join(process.cwd(), 'data', 'sentinel.json'));
  });
});

describe('D4c authoritative requiredEvidence (HTTP)', () => {
  interface TaskJson {
    id: string;
    requiredEvidence?: number;
  }

  async function requiredOf(base: string, userId: string, id: string): Promise<number | undefined> {
    const res = await call(base, 'GET', '/api/tasks?orgId=org-cah', userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    return tasks.find((t) => t.id === id)?.requiredEvidence;
  }

  it('serves 1 for ad-hoc, template count for template tasks, 1 for empty templates', async () => {
    const { db, base, close } = await startServer();
    try {
      assert.equal(await requiredOf(base, 'u-officer', 'task-sharps-log'), 1);
      const inst = await call(base, 'POST', '/api/templates/tpl-emergency-drill/instantiate', 'u-officer', {
        ownerId: 'u-officer'
      });
      assert.equal(inst.status, 201);
      assert.equal(inst.json.requiredEvidence, 2);
      assert.equal(await requiredOf(base, 'u-officer', String(inst.json.id)), 2);
      const zero = await call(base, 'POST', '/api/templates', 'u-officer', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D4c zero probe (simulated)',
        description: '',
        controlType: 'best_practice',
        regulatoryRefs: [],
        responsibleRoles: ['department_manager'],
        recurrence: { frequency: 'once' },
        evidenceRequired: [],
        escalation: []
      });
      assert.equal(zero.status, 201);
      const zeroInst = await call(
        base,
        'POST',
        `/api/templates/${String(zero.json.id)}/instantiate`,
        'u-nurse-mgr',
        { ownerId: 'u-nurse-mgr' }
      );
      assert.equal(zeroInst.status, 201);
      assert.equal(zeroInst.json.requiredEvidence, 1);
      assert.equal(await requiredOf(base, 'u-nurse-mgr', String(zeroInst.json.id)), 1);
      // Computed per response, never persisted.
      for (const t of db.tasks) {
        assert.equal('requiredEvidence' in t, false);
      }
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('includes the count in POST and PATCH task responses', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D4c probe',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01'
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.requiredEvidence, 1);
      const patched = await call(base, 'PATCH', `/api/tasks/${String(created.json.id)}`, 'u-nurse-mgr', {
        title: 'D4c probe (renamed)'
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.json.requiredEvidence, 1);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D5 separation of duties (HTTP)', () => {
  const SOD = 'Separation of duties: verifier must differ from owner/submitter.';

  interface TaskJson {
    id: string;
    status: string;
    evidence: Array<Record<string, unknown>>;
    submittedBy?: string;
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeSubmitted(
    base: string,
    actorId: string,
    ownerId: string,
    orgId = 'org-cah',
    domainId = 'dom-osha-h'
  ): Promise<string> {
    const created = await call(base, 'POST', '/api/tasks', actorId, {
      orgId,
      domainId,
      title: 'D5 probe',
      ownerId,
      dueDate: '2026-12-01'
    });
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    assert.equal(
      (
        await call(base, 'POST', `/api/tasks/${id}/evidence`, actorId, {
          label: 'attachment (simulated)',
          holder: 'Case File'
        })
      ).status,
      201
    );
    assert.equal(
      (await call(base, 'PATCH', `/api/tasks/${id}`, actorId, { status: 'submitted' })).status,
      200
    );
    return id;
  }

  it('rejects owner self-verification with no state change', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeSubmitted(base, 'u-officer', 'u-officer');
      assert.equal((await getTask(base, 'u-officer', 'org-cah', id)).submittedBy, 'u-officer');
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getTask(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assert.deepEqual(await getTask(base, 'u-officer', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects submitter self-verification but allows an independent verifier', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D5 probe',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01'
      });
      assert.equal(created.status, 201);
      const id = String(created.json.id);
      assert.equal(
        (
          await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
            label: 'attachment (simulated)',
            holder: 'Case File'
          })
        ).status,
        201
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'submitted' })).status,
        200
      );
      assert.equal((await getTask(base, 'u-officer', 'org-cah', id)).submittedBy, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      const ok = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-admin', {
        status: 'verified'
      });
      assert.equal(ok.status, 200);
      assert.equal((await getTask(base, 'u-admin', 'org-cah', id)).status, 'verified');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects admin self-verification of an owned task', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeSubmitted(base, 'u-admin', 'u-admin');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-admin', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      const ok = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(ok.status, 200);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('keeps cross-org rules: scoped users blocked, privileged independent verify allowed', async () => {
    const { db, base, close } = await startServer();
    try {
      const blocked = await call(base, 'PATCH', '/api/tasks/task-med-storage', 'u-clinic-mgr', {
        status: 'verified'
      });
      assert.equal(blocked.status, 403);
      const id = await makeSubmitted(base, 'u-officer', 'u-clinic-staff', 'org-clinic', 'dom-osha-c');
      assert.equal((await getTask(base, 'u-officer', 'org-clinic', id)).submittedBy, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      const ok = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-admin', {
        status: 'verified'
      });
      assert.equal(ok.status, 200);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('still enforces the evidence gate for independent verifiers', async () => {
    const { db, base, close } = await startServer((seeded) => {
      const legacy = seeded.tasks.find((t) => t.id === 'task-sharps-log');
      assert.ok(legacy);
      legacy.status = 'submitted';
      legacy.evidence = [];
      // D5c: history recorded so the test reaches the evidence gate.
      legacy.submissions = [
        {
          seq: 1,
          submittedBy: 'u-staff',
          ownerAtSubmission: 'u-staff',
          at: new Date().toISOString()
        }
      ];
    });
    try {
      const denied = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-admin', {
        status: 'verified'
      });
      assert.equal(denied.status, 400);
      assert.equal(
        denied.json.error,
        'Verification requires at least 1 evidence item (has 0).'
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('applies separation of duties before the evidence gate', async () => {
    const { db, base, close } = await startServer((seeded) => {
      const legacy = seeded.tasks.find((t) => t.id === 'task-sharps-log');
      assert.ok(legacy);
      legacy.status = 'submitted';
      legacy.evidence = [];
      legacy.ownerId = 'u-officer';
      // D5c: history recorded so the test reaches the membership check.
      legacy.submissions = [
        {
          seq: 1,
          submittedBy: 'u-staff',
          ownerAtSubmission: 'u-officer',
          at: new Date().toISOString()
        }
      ];
    });
    try {
      const denied = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back an independent verification when persistence fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeSubmitted(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
          status: 'verified'
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      const task = await getTask(base, 'u-officer', 'org-cah', id);
      assert.equal(task.status, 'submitted');
      assert.equal(task.submittedBy, 'u-nurse-mgr');
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D5a reassignment bypass (HTTP)', () => {
  const SOD = 'Separation of duties: verifier must differ from owner/submitter.';

  interface SubmissionJson {
    seq: number;
    submittedBy: string;
    ownerAtSubmission: string;
    at: string;
  }

  interface TaskJson {
    id: string;
    status: string;
    ownerId: string;
    evidence: Array<Record<string, unknown>>;
    submittedBy?: string;
    submissions?: SubmissionJson[];
    ownersWhileSubmitted?: string[];
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeTask(base: string, actorId: string, ownerId: string): Promise<string> {
    const created = await call(base, 'POST', '/api/tasks', actorId, {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      title: 'D5a probe',
      ownerId,
      dueDate: '2026-12-01'
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  async function addEvidence(base: string, actorId: string, id: string): Promise<void> {
    assert.equal(
      (
        await call(base, 'POST', `/api/tasks/${id}/evidence`, actorId, {
          label: 'attachment (simulated)',
          holder: 'Case File'
        })
      ).status,
      201
    );
  }

  it('blocks verifying after reassigning away a submitted task', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-officer', 'u-officer');
      await addEvidence(base, 'u-nurse-mgr', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', { status: 'submitted' })).status,
        200
      );
      const submitted = await getTask(base, 'u-officer', 'org-cah', id);
      assert.equal(submitted.submissions?.length, 1);
      assert.equal(submitted.submissions?.[0].submittedBy, 'u-nurse-mgr');
      assert.equal(submitted.submissions?.[0].ownerAtSubmission, 'u-officer');
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { ownerId: 'u-nurse-mgr' })).status,
        200
      );
      const moved = await getTask(base, 'u-officer', 'org-cah', id);
      assert.deepEqual([...(moved.ownersWhileSubmitted ?? [])].sort(), ['u-nurse-mgr', 'u-officer']);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assert.deepEqual(await getTask(base, 'u-officer', 'org-cah', id), moved);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('blocks the admin variant: own, reassign to staff, verify', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-admin', 'u-admin');
      await addEvidence(base, 'u-nurse-mgr', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', { status: 'submitted' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-admin', { ownerId: 'u-staff' })).status,
        200
      );
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-admin', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects combined owner+verify requests without applying the owner change', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-officer', 'u-officer');
      await addEvidence(base, 'u-officer', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'submitted' })).status,
        200
      );
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getTask(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        ownerId: 'u-nurse-mgr',
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      const after = await getTask(base, 'u-officer', 'org-cah', id);
      assert.deepEqual(after, before);
      assert.equal(after.ownerId, 'u-officer');
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('blocks multi-step reassignment chains', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-officer', 'u-officer');
      await addEvidence(base, 'u-officer', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'submitted' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { ownerId: 'u-staff' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { ownerId: 'u-nurse-mgr' })).status,
        200
      );
      const moved = await getTask(base, 'u-officer', 'org-cah', id);
      assert.deepEqual(
        [...(moved.ownersWhileSubmitted ?? [])].sort(),
        ['u-nurse-mgr', 'u-officer', 'u-staff']
      );
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('still allows a genuinely independent verifier', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-officer', 'u-officer');
      await addEvidence(base, 'u-nurse-mgr', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', { status: 'submitted' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-admin', { status: 'verified' })).status,
        200
      );
      assert.equal((await getTask(base, 'u-admin', 'org-cah', id)).status, 'verified');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('allows handover before submission: prior owner may verify', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-officer', 'u-officer');
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'in_progress' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { ownerId: 'u-staff' })).status,
        200
      );
      await addEvidence(base, 'u-staff', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-staff', { status: 'submitted' })).status,
        200
      );
      const submitted = await getTask(base, 'u-officer', 'org-cah', id);
      assert.equal(submitted.ownersWhileSubmitted, undefined);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'verified' })).status,
        200
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back a submitted-task reassignment when persistence fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeTask(base, 'u-officer', 'u-officer');
      await addEvidence(base, 'u-officer', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', { status: 'submitted' })).status,
        200
      );
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getTask(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
          ownerId: 'u-nurse-mgr'
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      assert.deepEqual(await getTask(base, 'u-officer', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D5b resubmission laundering (HTTP)', () => {
  const SOD = 'Separation of duties: verifier must differ from owner/submitter.';
  const DEADLOCK = 'No eligible independent verifier: all privileged users submitted or owned this task.';

  interface SubmissionJson {
    seq: number;
    submittedBy: string;
    ownerAtSubmission: string;
    at: string;
  }

  interface TaskJson {
    id: string;
    status: string;
    ownerId: string;
    evidence: Array<Record<string, unknown>>;
    submittedBy?: string;
    submissions?: SubmissionJson[];
    ownersWhileSubmitted?: string[];
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function status(base: string, actorId: string, id: string, next: string): Promise<number> {
    return (await call(base, 'PATCH', `/api/tasks/${id}`, actorId, { status: next })).status;
  }

  async function makeOwned(base: string, ownerId: string): Promise<string> {
    const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      title: 'D5b probe',
      ownerId,
      dueDate: '2026-12-01'
    });
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    assert.equal(
      (
        await call(base, 'POST', `/api/tasks/${id}/evidence`, ownerId, {
          label: 'attachment (simulated)',
          holder: 'Case File'
        })
      ).status,
      201
    );
    return id;
  }

  it('keeps an earlier submitter ineligible after send-back and resubmit', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOwned(base, 'u-staff');
      assert.equal(await status(base, 'u-officer', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-officer', id, 'in_progress'), 200);
      assert.equal(await status(base, 'u-staff', id, 'submitted'), 200);
      const resubmitted = await getTask(base, 'u-officer', 'org-cah', id);
      assert.equal(resubmitted.submittedBy, 'u-staff');
      assert.deepEqual(
        (resubmitted.submissions ?? []).map((s) => [s.seq, s.submittedBy]),
        [
          [1, 'u-officer'],
          [2, 'u-staff']
        ]
      );
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assert.deepEqual(await getTask(base, 'u-officer', 'org-cah', id), resubmitted);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('reports no eligible verifier once every privileged user submitted', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOwned(base, 'u-staff');
      assert.equal(await status(base, 'u-admin', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-admin', id, 'in_progress'), 200);
      assert.equal(await status(base, 'u-staff', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-officer', id, 'in_progress'), 200);
      assert.equal(await status(base, 'u-officer', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-officer', id, 'in_progress'), 200);
      assert.equal(await status(base, 'u-staff', id, 'submitted'), 200);
      // A second officer remains eligible, so this is an ordinary SoD block.
      const partial = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-admin', {
        status: 'verified'
      });
      assert.equal(partial.status, 403);
      assert.equal(partial.json.error, SOD);
      assert.equal(await status(base, 'u-officer2', id, 'in_progress'), 200);
      assert.equal(await status(base, 'u-officer2', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-officer2', id, 'in_progress'), 200);
      assert.equal(await status(base, 'u-staff', id, 'submitted'), 200);
      assert.equal((await getTask(base, 'u-admin', 'org-cah', id)).submissions?.length, 6);
      for (const verifier of ['u-admin', 'u-officer', 'u-officer2']) {
        const denied = await call(base, 'PATCH', `/api/tasks/${id}`, verifier, {
          status: 'verified'
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.json.error, DEADLOCK);
      }
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('allows send-back, fix, resubmit, then an uninvolved verify', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOwned(base, 'u-staff');
      assert.equal(await status(base, 'u-staff', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-officer', id, 'in_progress'), 200);
      assert.equal(await status(base, 'u-staff', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-officer', id, 'verified'), 200);
      assert.equal((await getTask(base, 'u-officer', 'org-cah', id)).status, 'verified');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('ignores client-supplied submission history', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOwned(base, 'u-staff');
      assert.equal(await status(base, 'u-officer', id, 'submitted'), 200);
      const before = await getTask(base, 'u-officer', 'org-cah', id);
      const forged = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        submissions: [],
        ownersWhileSubmitted: [],
        submittedBy: 'u-admin'
      });
      assert.equal(forged.status, 200);
      const after = await getTask(base, 'u-officer', 'org-cah', id);
      assert.deepEqual(after.submissions, before.submissions);
      assert.equal(after.submittedBy, 'u-officer');
      assert.equal(after.ownersWhileSubmitted, undefined);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back a resubmit without leaving a ghost history entry', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOwned(base, 'u-staff');
      assert.equal(await status(base, 'u-officer', id, 'submitted'), 200);
      assert.equal(await status(base, 'u-officer', id, 'in_progress'), 200);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        assert.equal(await status(base, 'u-staff', id, 'submitted'), 500);
      } finally {
        store.__setRenameImpl(null);
      }
      const rolled = await getTask(base, 'u-officer', 'org-cah', id);
      assert.equal(rolled.status, 'in_progress');
      assert.equal(rolled.submittedBy, 'u-officer');
      assert.deepEqual(
        (rolled.submissions ?? []).map((s) => s.seq),
        [1]
      );
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assert.equal(await status(base, 'u-staff', id, 'submitted'), 200);
      assert.deepEqual(
        ((await getTask(base, 'u-officer', 'org-cah', id)).submissions ?? []).map((s) => s.seq),
        [1, 2]
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('D5c legacy submission history (HTTP)', () => {
  const UNKNOWN =
    'Submitter unknown for this task — send it back and resubmit to establish a verifiable submission.';

  interface TaskJson {
    id: string;
    status: string;
    evidence: Array<Record<string, unknown>>;
    submittedBy?: string;
    submissions?: Array<Record<string, unknown>>;
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  function legacySubmitted(seeded: ReturnType<typeof seedDatabase>): void {
    const legacy = seeded.tasks.find((t) => t.id === 'task-sharps-log');
    assert.ok(legacy);
    legacy.status = 'submitted';
  }

  it('refuses verification when no submission is recorded', async () => {
    const { db, base, close } = await startServer(legacySubmitted);
    try {
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getTask(base, 'u-officer', 'org-cah', 'task-sharps-log');
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 409);
      assert.equal(denied.json.error, UNKNOWN);
      assert.deepEqual(await getTask(base, 'u-officer', 'org-cah', 'task-sharps-log'), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('recovers through send-back, resubmit, and independent verify', async () => {
    const { db, base, close } = await startServer(legacySubmitted);
    try {
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-officer', { status: 'in_progress' }))
          .status,
        200
      );
      assert.equal(
        (
          await call(base, 'POST', '/api/tasks/task-sharps-log/evidence', 'u-staff', {
            label: 'attachment (simulated)',
            holder: 'T. Nguyen'
          })
        ).status,
        201
      );
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-staff', { status: 'submitted' }))
          .status,
        200
      );
      const resubmitted = await getTask(base, 'u-staff', 'org-cah', 'task-sharps-log');
      assert.equal(resubmitted.submissions?.length, 1);
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-admin', { status: 'verified' }))
          .status,
        200
      );
      assert.equal((await getTask(base, 'u-admin', 'org-cah', 'task-sharps-log')).status, 'verified');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('still refuses when only an audit event records the submission', async () => {
    // Simplest safe rule (chosen): audit trails are not trusted as
    // submission history. Send-back + resubmit is required either way.
    const { db, base, close } = await startServer((seeded) => {
      legacySubmitted(seeded);
      store.appendAudit(seeded, {
        actorId: 'u-admin',
        action: 'task.submitted',
        recordType: 'task',
        recordId: 'task-sharps-log',
        orgId: 'org-cah',
        detail: 'D5c probe submission (simulated legacy audit trail)'
      });
    });
    try {
      const denied = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-admin', {
        status: 'verified'
      });
      assert.equal(denied.status, 409);
      assert.equal(denied.json.error, UNKNOWN);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('refuses verification when the audit chain is broken', async () => {
    const { db, base, close } = await startServer((seeded) => {
      legacySubmitted(seeded);
      seeded.audit[seeded.audit.length - 1].hash = 'broken-by-qa-fixture';
    });
    try {
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getTask(base, 'u-officer', 'org-cah', 'task-sharps-log');
      const denied = await call(base, 'PATCH', '/api/tasks/task-sharps-log', 'u-officer', {
        status: 'verified'
      });
      assert.equal(denied.status, 409);
      assert.equal(denied.json.error, UNKNOWN);
      assert.deepEqual(await getTask(base, 'u-officer', 'org-cah', 'task-sharps-log'), before);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(db.tasks, JSON.parse(diskBefore).tasks);
    } finally {
      await close();
    }
  });
});

describe('D5d verifier recording (HTTP)', () => {
  interface TaskJson {
    id: string;
    status: string;
    verifiedBy?: string;
    verifiedAt?: string;
  }

  async function getTask(base: string, userId: string, orgId: string, id: string): Promise<TaskJson> {
    const res = await call(base, 'GET', `/api/tasks?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const tasks = res.json as unknown as TaskJson[];
    const found = tasks.find((t) => t.id === id);
    assert.ok(found, `task ${id} visible`);
    return found;
  }

  async function makeSubmitted(base: string): Promise<string> {
    const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      title: 'D5d probe',
      ownerId: 'u-nurse-mgr',
      dueDate: '2026-12-01'
    });
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    assert.equal(
      (
        await call(base, 'POST', `/api/tasks/${id}/evidence`, 'u-nurse-mgr', {
          label: 'attachment (simulated)',
          holder: 'Case File'
        })
      ).status,
      201
    );
    assert.equal(
      (await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', { status: 'submitted' })).status,
      200
    );
    return id;
  }

  it('records the verifier atomically with verification', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeSubmitted(base);
      const ok = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
        status: 'verified'
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.verifiedBy, 'u-officer');
      assert.match(String(ok.json.verifiedAt), /^\d{4}-\d{2}-\d{2}T/);
      const fetched = await getTask(base, 'u-officer', 'org-cah', id);
      assert.equal(fetched.status, 'verified');
      assert.equal(fetched.verifiedBy, 'u-officer');
      assert.equal(fetched.verifiedAt, ok.json.verifiedAt);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('ignores client-supplied verifier fields on PATCH and POST', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/tasks', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        title: 'D5d probe',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01',
        verifiedBy: 'u-admin',
        verifiedAt: '2020-01-01T00:00:00.000Z',
        submissions: [{ seq: 1, submittedBy: 'u-admin', ownerAtSubmission: 'u-admin', at: '2020-01-01T00:00:00.000Z' }]
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.verifiedBy, undefined);
      assert.equal(created.json.submissions, undefined);
      const id = String(created.json.id);
      const touched = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-nurse-mgr', {
        title: 'D5d probe (renamed)',
        verifiedBy: 'u-admin',
        verifiedAt: '2020-01-01T00:00:00.000Z'
      });
      assert.equal(touched.status, 200);
      assert.equal(touched.json.verifiedBy, undefined);
      assert.equal((await getTask(base, 'u-nurse-mgr', 'org-cah', id)).verifiedBy, undefined);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('leaves the verifier unset when the verifying save fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeSubmitted(base);
      const diskBefore = readFileSync(dataFile, 'utf8');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'PATCH', `/api/tasks/${id}`, 'u-officer', {
          status: 'verified'
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      const task = await getTask(base, 'u-officer', 'org-cah', id);
      assert.equal(task.status, 'submitted');
      assert.equal(task.verifiedBy, undefined);
      assert.equal(task.verifiedAt, undefined);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('second compliance officer (HTTP)', () => {
  const SOD = 'Separation of duties: verifier must differ from owner/submitter.';

  async function makeSubmitted(base: string, submitterId: string, ownerId: string): Promise<string> {
    const created = await call(base, 'POST', '/api/tasks', submitterId, {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      title: 'Second-officer probe',
      ownerId,
      dueDate: '2026-12-01'
    });
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    assert.equal(
      (
        await call(base, 'POST', `/api/tasks/${id}/evidence`, submitterId, {
          label: 'attachment (simulated)',
          holder: 'Case File'
        })
      ).status,
      201
    );
    assert.equal(
      (await call(base, 'PATCH', `/api/tasks/${id}`, submitterId, { status: 'submitted' })).status,
      200
    );
    return id;
  }

  it('both officers verify independently but never their own work', async () => {
    const { db, base, close } = await startServer();
    try {
      const a = await makeSubmitted(base, 'u-officer', 'u-staff');
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${a}`, 'u-officer2', { status: 'verified' })).status,
        200
      );
      const b = await makeSubmitted(base, 'u-officer2', 'u-staff');
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${b}`, 'u-officer', { status: 'verified' })).status,
        200
      );
      const c = await makeSubmitted(base, 'u-officer2', 'u-officer2');
      const denied = await call(base, 'PATCH', `/api/tasks/${c}`, 'u-officer2', {
        status: 'verified'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assert.equal(
        (await call(base, 'PATCH', `/api/tasks/${c}`, 'u-officer', { status: 'verified' })).status,
        200
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('CAPA lifecycle (HTTP)', () => {
  const SOD = 'Separation of duties: the reviewer closing a CAPA must differ from its owner.';

  interface CapaJson {
    id: string;
    status: string;
    ownerId: string;
    evidence: Array<Record<string, unknown>>;
    closedBy?: string;
    closedAt?: string;
    effectivenessDecision?: string;
  }

  async function getCapa(base: string, userId: string, orgId: string, id: string): Promise<CapaJson> {
    const res = await call(base, 'GET', `/api/capas?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const capas = res.json as unknown as CapaJson[];
    const found = capas.find((c) => c.id === id);
    assert.ok(found, `capa ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeCapa(
    base: string,
    actorId: string,
    ownerId: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> {
    const created = await call(base, 'POST', '/api/capas', actorId, {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      finding: 'CAPA probe finding (simulated).',
      severity: 'medium',
      ownerId,
      dueDate: '2026-12-01',
      containment: 'Containment (simulated).',
      rootCause: 'Root cause (simulated).',
      correctivePlan: 'Corrective plan (simulated).',
      preventivePlan: 'Preventive plan (simulated).',
      effectivenessCriteria: 'No recurrence in 30 days (simulated).',
      ...extra
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  async function addCapaEvidence(
    base: string,
    actorId: string,
    id: string,
    kind?: string
  ): Promise<string> {
    const added = await call(base, 'POST', `/api/capas/${id}/evidence`, actorId, {
      label: 'attachment (simulated)',
      holder: 'Case File',
      ...(kind ? { kind } : {})
    });
    assert.equal(added.status, 201);
    return String(added.json.id);
  }

  async function advance(base: string, actorId: string, id: string, status: string): Promise<number> {
    return (await call(base, 'PATCH', `/api/capas/${id}`, actorId, { status })).status;
  }

  it('runs the full workflow to an independent closure, then locks', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/capas', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        taskId: 'task-med-storage',
        finding: 'CAPA probe finding (simulated).',
        severity: 'high',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01',
        containment: 'Immediate correction (simulated).'
      });
      assert.equal(created.status, 201);
      const id = String(created.json.id);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'investigation'), 200);
      assert.equal(
        (
          await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
            rootCause: 'Root cause (simulated).',
            correctivePlan: 'Corrective plan (simulated).',
            preventivePlan: 'Preventive plan (simulated).',
            effectivenessCriteria: 'No recurrence in 30 days (simulated).'
          })
        ).status,
        200
      );
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'action_in_progress'), 200);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
            label: 'implementation proof (simulated)',
            holder: 'M. Lee'
          })
        ).status,
        201
      );
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
      const check = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'effectiveness check (simulated)',
        holder: 'M. Lee',
        kind: 'effectiveness'
      });
      assert.equal(check.status, 201);
      const patchClose = await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer', {
        status: 'closed'
      });
      assert.equal(patchClose.status, 400);
      assert.equal(patchClose.json.error, 'Close via an effectiveness review.');
      const closed = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: 'Effective: no recurrence in 30 days (simulated).',
        evidenceIds: [String(check.json.id)]
      });
      assert.equal(closed.status, 201);
      assert.equal(closed.json.closedBy, 'u-officer');
      assert.match(String(closed.json.closedAt), /^\d{4}-\d{2}-\d{2}T/);
      const reviews = (closed.json as unknown as { effectivenessReviews: Array<{ outcome: string }> })
        .effectivenessReviews;
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].outcome, 'effective');
      const fetched = await getCapa(base, 'u-officer', 'org-cah', id);
      assert.equal(fetched.status, 'closed');
      assert.equal(fetched.effectivenessDecision, 'Effective: no recurrence in 30 days (simulated).');
      const locked = await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer', {
        finding: 'edited after close'
      });
      assert.equal(locked.status, 400);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-officer', {
            label: 'late (simulated)',
            holder: 'J. Ortiz'
          })
        ).status,
        400
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects illegal transitions and invalid input', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
            label: 'attachment (simulated)',
            holder: 'Case File'
          })
        ).status,
        201
      );
      const jump = await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer', {
        status: 'closed'
      });
      assert.equal(jump.status, 400);
      // C5: the illegal jump reports before the closure checks.
      assert.match(String(jump.json.error), /Illegal CAPA transition/);
      const skip = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
        status: 'action_in_progress'
      });
      assert.equal(skip.status, 400);
      assert.match(String(skip.json.error), /Illegal CAPA transition/);
      assert.equal(
        (await call(base, 'POST', '/api/capas', 'u-officer', {
          orgId: 'org-cah',
          domainId: 'dom-osha-h',
          finding: 'Bad severity (simulated).',
          severity: 'urgent',
          ownerId: 'u-officer',
          dueDate: '2026-12-01'
        })).status,
        400
      );
      assert.equal(
        (await call(base, 'POST', '/api/capas', 'u-officer', {
          orgId: 'org-cah',
          domainId: 'dom-osha-h',
          taskId: 'task-inventory-sop',
          finding: 'Cross-org link (simulated).',
          severity: 'low',
          ownerId: 'u-officer',
          dueDate: '2026-12-01'
        })).status,
        400
      );
      assert.equal(
        (await call(base, 'POST', '/api/capas', 'u-officer', {
          orgId: 'org-cah',
          domainId: 'dom-osha-h',
          finding: '   ',
          severity: 'low',
          ownerId: 'u-officer',
          dueDate: '2026-12-01'
        })).status,
        400
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('enforces roles and tenant isolation', async () => {
    const { db, base, close } = await startServer();
    try {
      assert.equal(
        (await call(base, 'POST', '/api/capas', 'u-staff', {
          orgId: 'org-cah',
          domainId: 'dom-osha-h',
          finding: 'Staff probe (simulated).',
          severity: 'low',
          ownerId: 'u-staff',
          dueDate: '2026-12-01'
        })).status,
        403
      );
      assert.equal((await call(base, 'GET', '/api/capas?orgId=org-cah', 'u-clinic-mgr')).status, 403);
      const own = await call(base, 'GET', '/api/capas', 'u-clinic-mgr');
      assert.equal(own.status, 200);
      assert.deepEqual(own.json, []);
      const id = await makeCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      assert.equal((await call(base, 'PATCH', `/api/capas/${id}`, 'u-clinic-staff', { finding: 'x' })).status, 403);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'action_in_progress'), 200);
      await addCapaEvidence(base, 'u-nurse-mgr', id);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
          status: 'closed',
          effectivenessDecision: 'Manager close (simulated).'
        })).status,
        403
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-staff', {
          status: 'closed',
          effectivenessDecision: 'Staff close (simulated).'
        })).status,
        403
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('requires an independent reviewer to close', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeCapa(base, 'u-officer', 'u-officer');
      assert.equal(await advance(base, 'u-officer', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-officer', id, 'action_in_progress'), 200);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-officer', {
            label: 'effectiveness check (simulated)',
            holder: 'J. Ortiz'
          })
        ).status,
        201
      );
      assert.equal(await advance(base, 'u-officer', id, 'effectiveness_review'), 200);
      const check = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-officer', {
        label: 'effectiveness check (simulated)',
        holder: 'J. Ortiz',
        kind: 'effectiveness'
      });
      assert.equal(check.status, 201);
      const reviewBody = {
        outcome: 'effective',
        rationale: 'Self-approved (simulated).',
        evidenceIds: [String(check.json.id)]
      };
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', reviewBody);
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      assert.deepEqual(await getCapa(base, 'u-officer', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer2', {
            outcome: 'effective',
            rationale: 'Effective (simulated).',
            evidenceIds: [String(check.json.id)]
          })
        ).status,
        201
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('requires review evidence references and a documented rationale', async () => {
    const { db, base, close } = await startServer((seeded) => {
      const legacy = seeded.capas.find((c) => c.id === 'capa-temp-log');
      assert.ok(legacy);
      legacy.status = 'effectiveness_review';
      legacy.statusHistory = [
        ...(legacy.statusHistory ?? []),
        { status: 'effectiveness_review', at: '2026-10-20T00:00:00.000Z', byUserId: 'u-nurse-mgr' }
      ];
    });
    try {
      const id = 'capa-temp-log';
      const noRefs = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-admin', {
        outcome: 'effective',
        rationale: 'Rationale without evidence (simulated).',
        evidenceIds: []
      });
      assert.equal(noRefs.status, 400);
      assert.equal(
        noRefs.json.error,
        'Each referenced evidence item must be current-cycle effectiveness evidence.'
      );
      const added = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'effectiveness check (simulated)',
        holder: 'M. Lee',
        kind: 'effectiveness'
      });
      assert.equal(added.status, 201);
      const noRationale = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-admin', {
        outcome: 'effective',
        rationale: '   ',
        evidenceIds: [String(added.json.id)]
      });
      assert.equal(noRationale.status, 400);
      assert.equal(noRationale.json.error, 'An effectiveness review requires a documented rationale.');
      assert.equal((await getCapa(base, 'u-officer', 'org-cah', id)).status, 'effectiveness_review');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back CAPA writes when persistence fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'action_in_progress'), 200);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
            label: 'effectiveness check (simulated)',
            holder: 'M. Lee'
          })
        ).status,
        201
      );
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
      const check = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'effectiveness check (simulated)',
        holder: 'M. Lee',
        kind: 'effectiveness'
      });
      assert.equal(check.status, 201);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const capasBefore = db.capas.length;
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
          outcome: 'effective',
          rationale: 'Effective (simulated).',
          evidenceIds: [String(check.json.id)]
        });
        assert.equal(res.status, 500);
        const created = await call(base, 'POST', '/api/capas', 'u-officer', {
          orgId: 'org-cah',
          domainId: 'dom-osha-h',
          finding: 'Rolled-back probe (simulated).',
          severity: 'low',
          ownerId: 'u-officer',
          dueDate: '2026-12-01'
        });
        assert.equal(created.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      assert.deepEqual(await getCapa(base, 'u-officer', 'org-cah', id), before);
      assert.equal(db.capas.length, capasBefore);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('C1 CAPA phase gates (HTTP)', () => {
  interface CapaJson {
    id: string;
    status: string;
    containment?: string;
    rootCause?: string;
    correctivePlan?: string;
    preventivePlan?: string;
    evidence: Array<Record<string, unknown>>;
  }

  interface AuditJson {
    action: string;
    recordId: string;
    detail: string;
  }

  async function getCapa(base: string, userId: string, orgId: string, id: string): Promise<CapaJson> {
    const res = await call(base, 'GET', `/api/capas?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const capas = res.json as unknown as CapaJson[];
    const found = capas.find((c) => c.id === id);
    assert.ok(found, `capa ${id} visible`);
    return found;
  }

  async function lastCapaAudit(base: string, id: string): Promise<AuditJson> {
    const res = await call(base, 'GET', '/api/audit?limit=500', 'u-officer');
    assert.equal(res.status, 200);
    const events = (res.json as unknown as AuditJson[]).filter((e) => e.recordId === id);
    return events[events.length - 1];
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeBareCapa(base: string): Promise<string> {
    const created = await call(base, 'POST', '/api/capas', 'u-nurse-mgr', {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      finding: 'C1 probe finding (simulated).',
      severity: 'medium',
      ownerId: 'u-nurse-mgr',
      dueDate: '2026-12-01'
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  async function addCapaEvidence(base: string, actorId: string, id: string): Promise<void> {
    assert.equal(
      (
        await call(base, 'POST', `/api/capas/${id}/evidence`, actorId, {
          label: 'attachment (simulated)',
          holder: 'Case File'
        })
      ).status,
      201
    );
  }

  it('rejects each transition until its gate fields are documented', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeBareCapa(base);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
        status: 'investigation'
      });
      assert.equal(denied.status, 400);
      assert.equal(denied.json.error, 'Containment is required to start the investigation.');
      assert.equal((await getCapa(base, 'u-nurse-mgr', 'org-cah', id)).status, 'open');
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { containment: 'Held (simulated).' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'investigation' })).status,
        200
      );
      const noCause = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
        status: 'action_in_progress'
      });
      assert.equal(noCause.status, 400);
      assert.match(String(noCause.json.error), /Root cause is required to begin action\./);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { rootCause: 'Found (simulated).' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'action_in_progress' })).status,
        200
      );
      const noPlans = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
        status: 'effectiveness_review'
      });
      assert.equal(noPlans.status, 400);
      assert.match(String(noPlans.json.error), /Corrective plan is required/);
      assert.match(String(noPlans.json.error), /Preventive plan is required/);
      assert.match(String(noPlans.json.error), /At least 1 implementation evidence item is required/);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('runs the full gated path with evidence at the review gate', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeBareCapa(base);
      assert.equal(
        (
          await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
            containment: 'Held (simulated).',
            rootCause: 'Found (simulated).',
            correctivePlan: 'Fix (simulated).',
            preventivePlan: 'Prevent (simulated).',
            effectivenessCriteria: 'No recurrence in 30 days (simulated).'
          })
        ).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'investigation' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'action_in_progress' })).status,
        200
      );
      const noEvidence = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
        status: 'effectiveness_review'
      });
      assert.equal(noEvidence.status, 400);
      assert.equal(
        noEvidence.json.error,
        'At least 1 implementation evidence item is required to request effectiveness review.'
      );
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
            label: 'implementation proof (simulated)',
            holder: 'M. Lee'
          })
        ).status,
        201
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'effectiveness_review' })).status,
        200
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('allows amending gate fields but never blanking them', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeBareCapa(base);
      assert.equal(
        (
          await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
            containment: 'Held (simulated).',
            rootCause: 'Found (simulated).'
          })
        ).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'investigation' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'action_in_progress' })).status,
        200
      );
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      const blanked = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { rootCause: '   ' });
      assert.equal(blanked.status, 400);
      assert.equal(blanked.json.error, 'Root cause is required at this stage and cannot be removed.');
      assert.equal((await getCapa(base, 'u-nurse-mgr', 'org-cah', id)).rootCause, 'Found (simulated).');
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { rootCause: 'Revised (simulated).' })).status,
        200
      );
      const event = await lastCapaAudit(base, id);
      assert.equal(event.action, 'capa.updated');
      assert.match(event.detail, /rootCause/);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('re-checks every gate at closure, including for legacy shapes', async () => {
    const { db, base, close } = await startServer((seeded) => {
      const legacy = seeded.capas.find((c) => c.id === 'capa-temp-log');
      assert.ok(legacy);
      legacy.status = 'effectiveness_review';
      delete legacy.rootCause;
      legacy.statusHistory = [
        ...(legacy.statusHistory ?? []),
        { status: 'effectiveness_review', at: '2026-10-20T00:00:00.000Z', byUserId: 'u-nurse-mgr' }
      ];
      const at = '2026-10-21T00:00:00.000Z';
      legacy.evidence = [
        {
          id: 'capa-temp-log-ev1',
          label: 'legacy proof (simulated)',
          holder: 'M. Lee',
          custody: [{ seq: 1, fromHolder: null, toHolder: 'M. Lee', byUserId: 'u-nurse-mgr', at }],
          updatedAt: at
        },
        {
          id: 'capa-temp-log-ev2',
          label: 'legacy check (simulated)',
          holder: 'M. Lee',
          kind: 'effectiveness',
          custody: [{ seq: 1, fromHolder: null, toHolder: 'M. Lee', byUserId: 'u-nurse-mgr', at }],
          updatedAt: at
        }
      ];
    });
    try {
      const denied = await call(base, 'POST', '/api/capas/capa-temp-log/effectiveness-review', 'u-admin', {
        outcome: 'effective',
        rationale: 'Effective (simulated).',
        evidenceIds: ['capa-temp-log-ev2']
      });
      assert.equal(denied.status, 400);
      assert.match(String(denied.json.error), /Root cause is still required to close\./);
      assert.equal((await getCapa(base, 'u-officer', 'org-cah', 'capa-temp-log')).status, 'effectiveness_review');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects combined blank-and-close requests with nothing applied', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeBareCapa(base);
      assert.equal(
        (
          await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
            containment: 'Held (simulated).',
            rootCause: 'Found (simulated).',
            correctivePlan: 'Fix (simulated).',
            preventivePlan: 'Prevent (simulated).',
            effectivenessCriteria: 'No recurrence in 30 days (simulated).'
          })
        ).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'investigation' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'action_in_progress' })).status,
        200
      );
      await addCapaEvidence(base, 'u-nurse-mgr', id);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'effectiveness_review' })).status,
        200
      );
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer', {
        rootCause: '',
        status: 'closed'
      });
      assert.equal(denied.status, 400);
      assert.equal(denied.json.error, 'Close via an effectiveness review.');
      assert.deepEqual(await getCapa(base, 'u-officer', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('C2 effectiveness reviews (HTTP)', () => {
  interface ReviewJson {
    seq: number;
    outcome: string;
    rationale: string;
    reviewerId: string;
    at: string;
    evidenceIds: string[];
  }

  interface CapaJson {
    id: string;
    status: string;
    evidence: Array<{ id: string; kind?: string }>;
    effectivenessReviews?: ReviewJson[];
    effectivenessDecision?: string;
    closedBy?: string;
    closedAt?: string;
  }

  interface AuditJson {
    action: string;
    recordId: string;
  }

  async function getCapa(base: string, userId: string, orgId: string, id: string): Promise<CapaJson> {
    const res = await call(base, 'GET', `/api/capas?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const capas = res.json as unknown as CapaJson[];
    const found = capas.find((c) => c.id === id);
    assert.ok(found, `capa ${id} visible`);
    return found;
  }

  async function capaAuditActions(base: string, id: string): Promise<string[]> {
    const res = await call(base, 'GET', '/api/audit?limit=500', 'u-officer');
    assert.equal(res.status, 200);
    return (res.json as unknown as AuditJson[])
      .filter((e) => e.recordId === id)
      .map((e) => e.action);
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeFullCapa(base: string): Promise<string> {
    const created = await call(base, 'POST', '/api/capas', 'u-nurse-mgr', {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      finding: 'C2 probe finding (simulated).',
      severity: 'medium',
      ownerId: 'u-nurse-mgr',
      dueDate: '2026-12-01',
      containment: 'Held (simulated).',
      rootCause: 'Found (simulated).',
      correctivePlan: 'Fix (simulated).',
      preventivePlan: 'Prevent (simulated).',
      effectivenessCriteria: 'No recurrence in 30 days (simulated).'
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  async function advance(base: string, actorId: string, id: string, status: string): Promise<number> {
    return (await call(base, 'PATCH', `/api/capas/${id}`, actorId, { status })).status;
  }

  async function addEvidence(
    base: string,
    actorId: string,
    id: string,
    kind: string
  ): Promise<string> {
    const added = await call(base, 'POST', `/api/capas/${id}/evidence`, actorId, {
      label: `${kind} proof (simulated)`,
      holder: 'Case File',
      kind
    });
    assert.equal(added.status, 201);
    assert.equal(added.json.kind, kind);
    return String(added.json.id);
  }

  async function toReview(base: string, id: string): Promise<void> {
    assert.equal(await advance(base, 'u-nurse-mgr', id, 'investigation'), 200);
    assert.equal(await advance(base, 'u-nurse-mgr', id, 'action_in_progress'), 200);
    await addEvidence(base, 'u-nurse-mgr', id, 'implementation');
    assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
  }

  it('closes through an effective review with history and audit', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base);
      await toReview(base, id);
      const check = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const done = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: 'Effective: no recurrence in 30 days (simulated).',
        evidenceIds: [check]
      });
      assert.equal(done.status, 201);
      assert.equal(done.json.status, 'closed');
      assert.equal(done.json.closedBy, 'u-officer');
      assert.match(String(done.json.closedAt), /^\d{4}-\d{2}-\d{2}T/);
      const reviews = (done.json as unknown as { effectivenessReviews: ReviewJson[] }).effectivenessReviews;
      assert.equal(reviews.length, 1);
      assert.deepEqual(reviews[0], {
        seq: 1,
        outcome: 'effective',
        rationale: 'Effective: no recurrence in 30 days (simulated).',
        reviewerId: 'u-officer',
        at: reviews[0].at,
        evidenceIds: [check]
      });
      assert.match(String(reviews[0].at), /^\d{4}-\d{2}-\d{2}T/);
      const fetched = await getCapa(base, 'u-officer', 'org-cah', id);
      assert.equal(fetched.effectivenessDecision, 'Effective: no recurrence in 30 days (simulated).');
      const actions = await capaAuditActions(base, id);
      assert.ok(actions.includes('capa.effectiveness_review.recorded'));
      assert.ok(actions.includes('capa.closed'));
      const again = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: 'Second (simulated).',
        evidenceIds: [check]
      });
      assert.equal(again.status, 400);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('returns to action on ineffective, then closes on a fresh cycle', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base);
      await toReview(base, id);
      const stale = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const first = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'ineffective',
        rationale: 'Recurrence observed (simulated).',
        evidenceIds: [stale]
      });
      assert.equal(first.status, 201);
      assert.equal(first.json.status, 'action_in_progress');
      assert.equal(first.json.closedBy, undefined);
      // Old implementation evidence still satisfies the work gate.
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
      const reused = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: 'Reusing prior cycle (simulated).',
        evidenceIds: [stale]
      });
      assert.equal(reused.status, 400);
      assert.equal(
        reused.json.error,
        'Each referenced evidence item must be current-cycle effectiveness evidence.'
      );
      const fresh = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const second = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: 'Effective on recheck (simulated).',
        evidenceIds: [fresh]
      });
      assert.equal(second.status, 201);
      assert.equal(second.json.status, 'closed');
      assert.deepEqual(
        (second.json.effectivenessReviews as ReviewJson[]).map((r) => [r.seq, r.outcome]),
        [
          [1, 'ineffective'],
          [2, 'effective']
        ]
      );
      const actions = await capaAuditActions(base, id);
      assert.ok(actions.includes('capa.returned_to_action'));
      assert.ok(actions.includes('capa.closed'));
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('validates outcome, rationale, and evidence references', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base);
      const early = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: 'Too early (simulated).',
        evidenceIds: ['nope']
      });
      assert.equal(early.status, 400);
      assert.equal(early.json.error, 'Only CAPAs in effectiveness review can be reviewed.');
      await toReview(base, id);
      const impl = await addEvidence(base, 'u-nurse-mgr', id, 'implementation');
      const check = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const badOutcome = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'maybe',
        rationale: 'Rationale (simulated).',
        evidenceIds: [check]
      });
      assert.equal(badOutcome.status, 400);
      assert.equal(badOutcome.json.error, 'Review outcome must be effective or ineffective.');
      const blank = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: '  ',
        evidenceIds: [check]
      });
      assert.equal(blank.status, 400);
      assert.equal(blank.json.error, 'An effectiveness review requires a documented rationale.');
      for (const evidenceIds of [[], ['missing-id'], [impl], 'not-an-array']) {
        const bad = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
          outcome: 'effective',
          rationale: 'Rationale (simulated).',
          evidenceIds
        });
        assert.equal(bad.status, 400);
        assert.equal(
          bad.json.error,
          'Each referenced evidence item must be current-cycle effectiveness evidence.'
        );
      }
      assert.equal((await getCapa(base, 'u-officer', 'org-cah', id)).status, 'effectiveness_review');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('restricts reviews to privileged same-organization reviewers', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base);
      await toReview(base, id);
      const check = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const body = {
        outcome: 'effective',
        rationale: 'Effective (simulated).',
        evidenceIds: [check]
      };
      assert.equal(
        (await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-clinic-mgr', body)).status,
        403
      );
      assert.equal(
        (await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-nurse-mgr', body)).status,
        403
      );
      assert.equal(
        (await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', body)).status,
        201
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back a review when persistence fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base);
      await toReview(base, id);
      const check = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
          outcome: 'effective',
          rationale: 'Effective (simulated).',
          evidenceIds: [check]
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      assert.deepEqual(await getCapa(base, 'u-officer', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects effectiveness evidence gathered before the review cycle', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'action_in_progress'), 200);
      const early = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      await addEvidence(base, 'u-nurse-mgr', id, 'implementation');
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
      const denied = await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
        outcome: 'effective',
        rationale: 'Early check (simulated).',
        evidenceIds: [early]
      });
      assert.equal(denied.status, 400);
      assert.equal(
        denied.json.error,
        'Each referenced evidence item must be current-cycle effectiveness evidence.'
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('C3 CAPA reviewer independence (HTTP)', () => {
  const SOD = 'Separation of duties: the reviewer closing a CAPA must differ from its owner.';
  const DEADLOCK =
    'No eligible independent reviewer: all privileged users contributed to or owned this CAPA.';

  interface CapaJson {
    id: string;
    status: string;
    ownerId: string;
    createdBy?: string;
    ownerHistory?: Array<{ ownerId: string; from: string; byUserId: string; at: string }>;
    actionsBy?: string[];
    effectivenessReviews?: Array<Record<string, unknown>>;
  }

  async function getCapa(base: string, userId: string, orgId: string, id: string): Promise<CapaJson> {
    const res = await call(base, 'GET', `/api/capas?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const capas = res.json as unknown as CapaJson[];
    const found = capas.find((c) => c.id === id);
    assert.ok(found, `capa ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeFullCapa(base: string, actorId: string, ownerId: string): Promise<string> {
    const created = await call(base, 'POST', '/api/capas', actorId, {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      finding: 'C3 probe finding (simulated).',
      severity: 'medium',
      ownerId,
      dueDate: '2026-12-01',
      containment: 'Held (simulated).',
      rootCause: 'Found (simulated).',
      correctivePlan: 'Fix (simulated).',
      preventivePlan: 'Prevent (simulated).',
      effectivenessCriteria: 'No recurrence in 30 days (simulated).'
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  async function advance(base: string, actorId: string, id: string, status: string): Promise<number> {
    return (await call(base, 'PATCH', `/api/capas/${id}`, actorId, { status })).status;
  }

  async function addEvidence(
    base: string,
    actorId: string,
    id: string,
    kind: string
  ): Promise<string> {
    const added = await call(base, 'POST', `/api/capas/${id}/evidence`, actorId, {
      label: `${kind} proof (simulated)`,
      holder: 'Case File',
      kind
    });
    assert.equal(added.status, 201);
    return String(added.json.id);
  }

  async function review(
    base: string,
    actorId: string,
    id: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    return call(base, 'POST', `/api/capas/${id}/effectiveness-review`, actorId, body);
  }

  it('keeps a prior owner ineligible after reassignment', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base, 'u-officer2', 'u-officer2');
      assert.equal(await advance(base, 'u-officer2', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-officer2', id, 'action_in_progress'), 200);
      await addEvidence(base, 'u-officer2', id, 'implementation');
      assert.equal(await advance(base, 'u-officer2', id, 'effectiveness_review'), 200);
      const check = await addEvidence(base, 'u-officer2', id, 'effectiveness');
      const body = { outcome: 'effective', rationale: 'Effective (simulated).', evidenceIds: [check] };
      const self = await review(base, 'u-officer2', id, body);
      assert.equal(self.status, 403);
      assert.equal(self.json.error, SOD);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer2', { ownerId: 'u-nurse-mgr' })).status,
        200
      );
      const moved = await getCapa(base, 'u-officer2', 'org-cah', id);
      assert.equal(moved.ownerId, 'u-nurse-mgr');
      assert.deepEqual(
        (moved.ownerHistory ?? []).map((e) => [e.ownerId, e.from]),
        [
          ['u-officer2', 'initial'],
          ['u-nurse-mgr', 'reassignment']
        ]
      );
      assert.ok((moved.actionsBy ?? []).includes('u-officer2'));
      const again = await review(base, 'u-officer2', id, body);
      assert.equal(again.status, 403);
      assert.equal(again.json.error, SOD);
      const owner = await review(base, 'u-nurse-mgr', id, body);
      assert.equal(owner.status, 403);
      const independent = await review(base, 'u-admin', id, body);
      assert.equal(independent.status, 201);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('reports no eligible reviewer once all privileged users contributed', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base, 'u-admin', 'u-nurse-mgr');
      assert.equal(await advance(base, 'u-officer', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-officer', id, 'action_in_progress'), 200);
      await addEvidence(base, 'u-officer2', id, 'implementation');
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
      const check = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const body = { outcome: 'effective', rationale: 'Effective (simulated).', evidenceIds: [check] };
      for (const reviewer of ['u-admin', 'u-officer', 'u-officer2']) {
        const denied = await review(base, reviewer, id, body);
        assert.equal(denied.status, 403);
        assert.equal(denied.json.error, DEADLOCK);
      }
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects combined reassign-and-close requests with nothing applied', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base, 'u-officer', 'u-officer');
      assert.equal(await advance(base, 'u-officer', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-officer', id, 'action_in_progress'), 200);
      await addEvidence(base, 'u-officer', id, 'implementation');
      assert.equal(await advance(base, 'u-officer', id, 'effectiveness_review'), 200);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer', {
        ownerId: 'u-nurse-mgr',
        status: 'closed'
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.json.error, SOD);
      const after = await getCapa(base, 'u-officer', 'org-cah', id);
      assert.deepEqual(after, before);
      assert.equal(after.ownerId, 'u-officer');
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('ignores client-supplied involvement history', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const before = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      const forged = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
        ownerHistory: [],
        actionsBy: [],
        createdBy: 'u-admin',
        statusHistory: [],
        effectivenessReviews: []
      });
      assert.equal(forged.status, 200);
      const after = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      assert.deepEqual(after.ownerHistory, before.ownerHistory);
      assert.equal(after.createdBy, 'u-nurse-mgr');
      assert.equal(after.actionsBy, undefined);
      assert.equal(after.effectivenessReviews, undefined);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back a reassignment without touching ownership history', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'investigation'), 200);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer', {
          ownerId: 'u-staff'
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      assert.deepEqual(await getCapa(base, 'u-nurse-mgr', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('lets an uninvolved officer review work another officer touched', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeFullCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      assert.equal(
        (
          await call(base, 'PATCH', `/api/capas/${id}`, 'u-officer', {
            rootCause: 'Improved by Ortiz (simulated).'
          })
        ).status,
        200
      );
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'investigation'), 200);
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'action_in_progress'), 200);
      await addEvidence(base, 'u-nurse-mgr', id, 'implementation');
      assert.equal(await advance(base, 'u-nurse-mgr', id, 'effectiveness_review'), 200);
      const check = await addEvidence(base, 'u-nurse-mgr', id, 'effectiveness');
      const body = { outcome: 'effective', rationale: 'Effective (simulated).', evidenceIds: [check] };
      const tainted = await review(base, 'u-officer', id, body);
      assert.equal(tainted.status, 403);
      assert.equal(tainted.json.error, SOD);
      assert.equal((await review(base, 'u-officer2', id, body)).status, 201);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('C4 CAPA custody transfers (HTTP)', () => {
  interface CustodyJson {
    seq: number;
    fromHolder: string | null;
    toHolder: string;
    byUserId: string;
    at: string;
    reason?: string;
  }

  interface EvidenceJson {
    id: string;
    holder: string;
    custody: CustodyJson[];
  }

  interface CapaJson {
    id: string;
    status: string;
    evidence: EvidenceJson[];
  }

  interface AuditJson {
    action: string;
    recordType: string;
    recordId: string;
    detail: string;
  }

  async function getCapa(base: string, userId: string, orgId: string, id: string): Promise<CapaJson> {
    const res = await call(base, 'GET', `/api/capas?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const capas = res.json as unknown as CapaJson[];
    const found = capas.find((c) => c.id === id);
    assert.ok(found, `capa ${id} visible`);
    return found;
  }

  async function capaAudits(base: string, id: string): Promise<AuditJson[]> {
    const res = await call(base, 'GET', '/api/audit?limit=500', 'u-officer');
    assert.equal(res.status, 200);
    return (res.json as unknown as AuditJson[]).filter((e) => e.recordId === id);
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeOpenCapa(base: string, actorId: string, ownerId: string): Promise<string> {
    const created = await call(base, 'POST', '/api/capas', actorId, {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      finding: 'C4 probe finding (simulated).',
      severity: 'medium',
      ownerId,
      dueDate: '2026-12-01',
      containment: 'Held (simulated).'
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  it('chains custody across transfers with matching audit events', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOpenCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const added = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'implementation proof (simulated)',
        holder: 'Alice'
      });
      assert.equal(added.status, 201);
      const evidenceId = String(added.json.id);
      const first = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-nurse-mgr', {
        evidenceId,
        toHolder: 'Bob',
        reason: 'Shift handover (simulated).'
      });
      assert.equal(first.status, 200);
      const second = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-officer', {
        evidenceId,
        toHolder: 'Carol'
      });
      assert.equal(second.status, 200);
      const capa = await getCapa(base, 'u-officer', 'org-cah', id);
      const item = capa.evidence.find((e) => e.id === evidenceId);
      assert.ok(item);
      assert.equal(item.holder, 'Carol');
      assert.deepEqual(
        item.custody.map((c) => [c.seq, c.fromHolder, c.toHolder, c.byUserId]),
        [
          [1, null, 'Alice', 'u-nurse-mgr'],
          [2, 'Alice', 'Bob', 'u-nurse-mgr'],
          [3, 'Bob', 'Carol', 'u-officer']
        ]
      );
      assert.equal(item.custody[1].reason, 'Shift handover (simulated).');
      const transfers = (await capaAudits(base, id)).filter((e) => e.action === 'custody.transferred');
      assert.equal(transfers.length, 2);
      assert.ok(transfers.every((e) => e.recordType === 'capa'));
      assert.match(transfers[0].detail, /Alice -> Bob/);
      assert.match(transfers[1].detail, /Bob -> Carol/);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects invalid, unauthorized, and cross-record transfers', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOpenCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const other = await makeOpenCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const added = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'implementation proof (simulated)',
        holder: 'Alice'
      });
      const evidenceId = String(added.json.id);
      const foreign = await call(base, 'POST', `/api/capas/${other}/evidence`, 'u-nurse-mgr', {
        label: 'other proof (simulated)',
        holder: 'Zed'
      });
      const foreignId = String(foreign.json.id);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const audits = await auditTotal(base, 'u-officer');
      const same = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-nurse-mgr', {
        evidenceId,
        toHolder: 'Alice'
      });
      assert.equal(same.status, 400);
      const outsider = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-clinic-staff', {
        evidenceId,
        toHolder: 'Bob'
      });
      assert.equal(outsider.status, 403);
      const nonOwner = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-staff', {
        evidenceId,
        toHolder: 'Bob'
      });
      assert.equal(nonOwner.status, 403);
      const crossRecord = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-nurse-mgr', {
        evidenceId: foreignId,
        toHolder: 'Bob'
      });
      assert.equal(crossRecord.status, 400);
      assert.equal(crossRecord.json.error, 'Evidence not found.');
      const item = (await getCapa(base, 'u-nurse-mgr', 'org-cah', id)).evidence.find(
        (e) => e.id === evidenceId
      );
      assert.ok(item);
      assert.equal(item.holder, 'Alice');
      assert.equal(item.custody.length, 1);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('locks transfers on closed CAPAs', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/capas', 'u-nurse-mgr', {
        orgId: 'org-cah',
        domainId: 'dom-osha-h',
        finding: 'C4 probe finding (simulated).',
        severity: 'medium',
        ownerId: 'u-nurse-mgr',
        dueDate: '2026-12-01',
        containment: 'Held (simulated).',
        rootCause: 'Found (simulated).',
        correctivePlan: 'Fix (simulated).',
        preventivePlan: 'Prevent (simulated).',
        effectivenessCriteria: 'No recurrence in 30 days (simulated).'
      });
      const id = String(created.json.id);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'investigation' })).status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'action_in_progress' })).status,
        200
      );
      const proof = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'implementation proof (simulated)',
        holder: 'Alice'
      });
      const evidenceId = String(proof.json.id);
      assert.equal(
        (await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', { status: 'effectiveness_review' })).status,
        200
      );
      const check = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'effectiveness check (simulated)',
        holder: 'Alice',
        kind: 'effectiveness'
      });
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/effectiveness-review`, 'u-officer', {
            outcome: 'effective',
            rationale: 'Effective (simulated).',
            evidenceIds: [String(check.json.id)]
          })
        ).status,
        201
      );
      const denied = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-officer', {
        evidenceId,
        toHolder: 'Bob'
      });
      assert.equal(denied.status, 400);
      assert.equal(denied.json.error, 'Closed CAPA records are locked.');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rolls back a transfer when persistence fails', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOpenCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const added = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'implementation proof (simulated)',
        holder: 'Alice'
      });
      const evidenceId = String(added.json.id);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      store.__setRenameImpl(() => {
        throw eperm();
      });
      try {
        const res = await call(base, 'POST', `/api/capas/${id}/transfer`, 'u-nurse-mgr', {
          evidenceId,
          toHolder: 'Bob'
        });
        assert.equal(res.status, 500);
      } finally {
        store.__setRenameImpl(null);
      }
      assert.deepEqual(await getCapa(base, 'u-nurse-mgr', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assert.deepEqual(tempFiles(), []);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('ignores client-supplied custody rewrites', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeOpenCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const added = await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
        label: 'implementation proof (simulated)',
        holder: 'Alice'
      });
      const evidenceId = String(added.json.id);
      const before = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      const forged = await call(base, 'PATCH', `/api/capas/${id}`, 'u-nurse-mgr', {
        evidence: [{ id: evidenceId, holder: 'Mallory', custody: [] }]
      });
      assert.equal(forged.status, 200);
      const after = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      assert.deepEqual(after.evidence, before.evidence);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('C5 CAPA workflow ordering and authority (HTTP)', () => {
  interface CapaJson {
    id: string;
    status: string;
    ownerId: string;
  }

  async function getCapa(base: string, userId: string, orgId: string, id: string): Promise<CapaJson> {
    const res = await call(base, 'GET', `/api/capas?orgId=${orgId}`, userId);
    assert.equal(res.status, 200);
    const capas = res.json as unknown as CapaJson[];
    const found = capas.find((c) => c.id === id);
    assert.ok(found, `capa ${id} visible`);
    return found;
  }

  async function auditTotal(base: string, userId: string): Promise<number> {
    const res = await call(base, 'GET', '/api/audit?limit=500', userId);
    assert.equal(res.status, 200);
    return (res.json as unknown as unknown[]).length;
  }

  async function makeGatedCapa(base: string, actorId: string, ownerId: string): Promise<string> {
    const created = await call(base, 'POST', '/api/capas', actorId, {
      orgId: 'org-cah',
      domainId: 'dom-osha-h',
      finding: 'C5 probe finding (simulated).',
      severity: 'medium',
      ownerId,
      dueDate: '2026-12-01',
      containment: 'Held (simulated).',
      rootCause: 'Found (simulated).',
      correctivePlan: 'Fix (simulated).',
      preventivePlan: 'Prevent (simulated).',
      effectivenessCriteria: 'No recurrence in 30 days (simulated).'
    });
    assert.equal(created.status, 201);
    return String(created.json.id);
  }

  async function advance(base: string, userId: string, id: string, status: string) {
    return call(base, 'PATCH', `/api/capas/${id}`, userId, { status });
  }

  it('reports illegal transitions before closure checks', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeGatedCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      // An involved officer (in actionsBy) still sees the transition error,
      // not an independence error, when jumping investigation -> closed.
      assert.equal((await advance(base, 'u-officer', id, 'investigation')).status, 200);
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-officer', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const jump = await advance(base, 'u-officer', id, 'closed');
      assert.equal(jump.status, 400);
      assert.match(String(jump.json.error), /Illegal CAPA transition/);
      const skip = await advance(base, 'u-officer', id, 'effectiveness_review');
      assert.equal(skip.status, 400);
      assert.match(String(skip.json.error), /Illegal CAPA transition/);
      assert.deepEqual(await getCapa(base, 'u-officer', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('lets owner-staff advance to Action In Progress but not into review', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeGatedCapa(base, 'u-nurse-mgr', 'u-staff');
      assert.equal((await advance(base, 'u-staff', id, 'investigation')).status, 200);
      assert.equal((await advance(base, 'u-staff', id, 'action_in_progress')).status, 200);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-staff', {
            label: 'implementation proof (simulated)',
            holder: 'T. Nguyen'
          })
        ).status,
        201
      );
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      const denied = await advance(base, 'u-staff', id, 'effectiveness_review');
      assert.equal(denied.status, 403);
      assert.match(String(denied.json.error), /capa\.review\.request/);
      assert.deepEqual(await getCapa(base, 'u-nurse-mgr', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      // A same-org manager completes the legitimate path.
      assert.equal((await advance(base, 'u-nurse-mgr', id, 'effectiveness_review')).status, 200);
      assert.equal((await getCapa(base, 'u-nurse-mgr', 'org-cah', id)).status, 'effectiveness_review');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects non-owner and cross-org review requests', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeGatedCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      assert.equal((await advance(base, 'u-nurse-mgr', id, 'investigation')).status, 200);
      assert.equal((await advance(base, 'u-nurse-mgr', id, 'action_in_progress')).status, 200);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
            label: 'implementation proof (simulated)',
            holder: 'M. Lee'
          })
        ).status,
        201
      );
      const diskBefore = readFileSync(dataFile, 'utf8');
      const before = await getCapa(base, 'u-nurse-mgr', 'org-cah', id);
      const audits = await auditTotal(base, 'u-officer');
      assert.equal((await advance(base, 'u-staff', id, 'effectiveness_review')).status, 403);
      assert.equal((await advance(base, 'u-clinic-mgr', id, 'effectiveness_review')).status, 403);
      assert.equal((await advance(base, 'u-clinic-staff', id, 'investigation')).status, 403);
      assert.deepEqual(await getCapa(base, 'u-nurse-mgr', 'org-cah', id), before);
      assert.equal(await auditTotal(base, 'u-officer'), audits);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('preserves unknown-status and close-via-review reporting', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await makeGatedCapa(base, 'u-nurse-mgr', 'u-nurse-mgr');
      const unknown = await advance(base, 'u-nurse-mgr', id, 'archived');
      assert.equal(unknown.status, 400);
      assert.equal(unknown.json.error, 'Unknown CAPA status.');
      assert.equal((await advance(base, 'u-nurse-mgr', id, 'investigation')).status, 200);
      assert.equal((await advance(base, 'u-nurse-mgr', id, 'action_in_progress')).status, 200);
      assert.equal(
        (
          await call(base, 'POST', `/api/capas/${id}/evidence`, 'u-nurse-mgr', {
            label: 'implementation proof (simulated)',
            holder: 'M. Lee'
          })
        ).status,
        201
      );
      assert.equal((await advance(base, 'u-nurse-mgr', id, 'effectiveness_review')).status, 200);
      // Legal transition, eligible reviewer: the review endpoint owns closure.
      const direct = await advance(base, 'u-officer', id, 'closed');
      assert.equal(direct.status, 400);
      assert.equal(direct.json.error, 'Close via an effectiveness review.');
      assert.equal((await getCapa(base, 'u-officer', 'org-cah', id)).status, 'effectiveness_review');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});
