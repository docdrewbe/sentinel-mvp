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
