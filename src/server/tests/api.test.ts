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
