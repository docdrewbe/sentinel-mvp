// HTTP-level D1 regression tests: state changes and their audit events must
// persist together or not at all. Uses an isolated temp database and
// ephemeral ports; never touches data/sentinel.json or QA evidence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

async function startServer(): Promise<TestServer> {
  const db = seedDatabase();
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
});
