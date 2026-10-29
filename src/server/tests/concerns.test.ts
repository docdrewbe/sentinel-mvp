// HTTP-level concern-reporting slice 1 tests: filing, reporter/triage
// visibility, triage workflow, CAPA linking, audit filtering, and atomicity.
// Uses an isolated temp database and ephemeral ports; never touches
// data/sentinel.json or QA evidence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'sentinel-concerns-'));
process.env.SENTINEL_DATA_FILE = join(workdir, 'sentinel.json');
const dataFile = process.env.SENTINEL_DATA_FILE;

const { createApp } = await import('../app.js');
const { seedDatabase } = await import('../seed.js');
const store = await import('../store.js');

type Db = ReturnType<typeof seedDatabase>;

interface TestServer {
  db: Db;
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
): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-demo-user-id': userId },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

/** Disk state must always equal memory state, with a valid audit chain. */
function assertDiskMatchesMemory(db: Db): void {
  const disk = JSON.parse(readFileSync(dataFile, 'utf8')) as Db;
  assert.deepEqual(disk, db);
  assert.deepEqual(store.verifyAuditChain(disk.audit), { ok: true });
}

function diskBytes(): Buffer {
  return readFileSync(dataFile);
}

function diskMtime(): number {
  return statSync(dataFile).mtimeMs;
}

const CONCERN = {
  orgId: 'org-cah',
  title: 'Flickering light in stairwell B',
  category: 'equipment_facilities',
  description: 'The stairwell light flickers intermittently during night shifts.',
  location: 'Stairwell B, level 2'
};

async function fileConcern(
  base: string,
  userId: string,
  overrides: Record<string, unknown> = {}
): Promise<{ status: number; json: Record<string, any> }> {
  return call(base, 'POST', '/api/concerns', userId, { ...CONCERN, ...overrides });
}

describe('Concern filing', () => {
  it('staff files in their own org; server sets the reporter identity', async () => {
    const { db, base, close } = await startServer();
    try {
      const before = db.audit.length;
      const res = await fileConcern(base, 'u-staff', { reporterId: 'u-admin', status: 'closed' });
      assert.equal(res.status, 201);
      assert.equal(res.json.reporterId, 'u-staff');
      assert.equal(res.json.status, 'submitted');
      assert.equal(res.json.title, CONCERN.title);
      assert.equal(res.json.orgId, 'org-cah');
      assert.deepEqual(res.json.statusHistory, [
        { status: 'submitted', at: res.json.createdAt, byUserId: 'u-staff' }
      ]);
      assert.equal(db.audit.length, before + 1);
      const event = db.audit[db.audit.length - 1];
      assert.equal(event.action, 'concern.submitted');
      assert.equal(event.recordType, 'concern');
      assert.equal(event.recordId, res.json.id);
      assert.equal(event.orgId, 'org-cah');
      assert.equal(event.detail, `Concern ${res.json.id} submitted`);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('manager, officer (cross-org), and admin may all file', async () => {
    const { db, base, close } = await startServer();
    try {
      assert.equal((await fileConcern(base, 'u-nurse-mgr')).status, 201);
      assert.equal((await fileConcern(base, 'u-officer', { orgId: 'org-clinic' })).status, 201);
      assert.equal((await fileConcern(base, 'u-admin', { orgId: 'org-canna' })).status, 201);
      assert.equal(db.concerns.length, 3);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('staff filing cross-org is refused with nothing changed', async () => {
    const { db, base, close } = await startServer();
    try {
      const bytes = diskBytes();
      const mtime = diskMtime();
      const auditLen = db.audit.length;
      const res = await fileConcern(base, 'u-staff', { orgId: 'org-clinic' });
      assert.equal(res.status, 403);
      assert.equal(db.concerns.length, 0);
      assert.equal(db.audit.length, auditLen);
      assert.deepEqual(diskBytes(), bytes);
      assert.equal(diskMtime(), mtime);
    } finally {
      await close();
    }
  });

  it('unknown org and missing auth are refused', async () => {
    const { base, close } = await startServer();
    try {
      assert.equal((await fileConcern(base, 'u-officer', { orgId: 'org-nope' })).status, 400);
      assert.equal((await fileConcern(base, '')).status, 401);
      assert.equal((await fileConcern(base, 'u-ghost')).status, 401);
    } finally {
      await close();
    }
  });

  it('validation failures change nothing on disk, memory, or audit', async () => {
    const { db, base, close } = await startServer();
    try {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['blank title', { title: '   ' }],
        ['missing title', { title: undefined }],
        ['missing category', { category: undefined }],
        ['unknown category', { category: 'aliens' }],
        ['blank description', { description: '' }],
        ['non-string title', { title: 42 }],
        ['non-string description', { description: { nested: true } }],
        ['non-string location', { location: 7 }],
        ['title too long', { title: 'x'.repeat(121) }],
        ['description too long', { description: 'x'.repeat(2001) }],
        ['location too long', { location: 'x'.repeat(201) }]
      ];
      for (const [name, overrides] of cases) {
        const bytes = diskBytes();
        const mtime = diskMtime();
        const auditLen = db.audit.length;
        const body: Record<string, unknown> = { ...CONCERN, ...overrides };
        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }
        const res = await call(base, 'POST', '/api/concerns', 'u-staff', body);
        assert.equal(res.status, 400, name);
        assert.equal(db.concerns.length, 0, name);
        assert.equal(db.audit.length, auditLen, name);
        assert.deepEqual(diskBytes(), bytes, name);
        assert.equal(diskMtime(), mtime, name);
      }
    } finally {
      await close();
    }
  });

  it('audit details never carry user-supplied concern content', async () => {
    const { db, base, close } = await startServer();
    try {
      const title = 'Zebra-striped valve cover loose';
      const description = 'Quixotic rattling near the intake manifold housing unit';
      const location = 'Sub-basement alcove nine';
      const res = await fileConcern(base, 'u-staff', { title, description, location });
      assert.equal(res.status, 201);
      const details = db.audit.map((e) => e.detail).join('\n');
      assert.ok(!details.includes(title));
      assert.ok(!details.includes(description));
      assert.ok(!details.includes(location));
      assert.ok(!details.includes('Zebra'));
      assert.ok(!details.includes('Quixotic'));
      assert.ok(!details.includes('alcove'));
    } finally {
      await close();
    }
  });
});

describe('Concern visibility', () => {
  async function seedThree(base: string): Promise<{ hospital: string; clinic: string; officer: string }> {
    const hospital = (await fileConcern(base, 'u-staff')).json.id as string;
    const clinic = (await fileConcern(base, 'u-clinic-staff', { orgId: 'org-clinic' })).json.id as string;
    const officer = (await fileConcern(base, 'u-officer')).json.id as string;
    return { hospital, clinic, officer };
  }

  it('staff list only their own concerns', async () => {
    const { base, close } = await startServer();
    try {
      const ids = await seedThree(base);
      const mine = await call(base, 'GET', '/api/concerns?orgId=org-cah', 'u-staff');
      assert.equal(mine.status, 200);
      assert.deepEqual(
        (mine.json as Array<Record<string, unknown>>).map((c) => c.id),
        [ids.hospital]
      );
      const clinic = await call(base, 'GET', '/api/concerns?orgId=org-clinic', 'u-clinic-staff');
      assert.equal(clinic.status, 200);
      assert.deepEqual((clinic.json as Array<Record<string, unknown>>).map((c) => c.id), [ids.clinic]);
      const cross = await call(base, 'GET', '/api/concerns?orgId=org-clinic', 'u-staff');
      assert.equal(cross.status, 403);
    } finally {
      await close();
    }
  });

  it("staff read their own detail but get 404 for others' and guessed ids", async () => {
    const { base, close } = await startServer();
    try {
      const ids = await seedThree(base);
      const own = await call(base, 'GET', `/api/concerns/${ids.hospital}`, 'u-staff');
      assert.equal(own.status, 200);
      assert.equal(own.json.title, CONCERN.title);
      assert.ok(!('internalNotes' in own.json));
      assert.equal((await call(base, 'GET', `/api/concerns/${ids.officer}`, 'u-staff')).status, 404);
      assert.equal(
        (await call(base, 'GET', '/api/concerns/00000000-0000-0000-0000-000000000000', 'u-staff'))
          .status,
        404
      );
    } finally {
      await close();
    }
  });

  it('managers triage their own org only; officers see across orgs', async () => {
    const { base, close } = await startServer();
    try {
      const ids = await seedThree(base);
      const queue = await call(base, 'GET', '/api/concerns?orgId=org-cah', 'u-nurse-mgr');
      assert.equal(queue.status, 200);
      assert.deepEqual(
        new Set((queue.json as Array<Record<string, unknown>>).map((c) => c.id)),
        new Set([ids.hospital, ids.officer])
      );
      assert.ok('internalNotes' in (queue.json as Array<Record<string, unknown>>)[0]);
      assert.equal(
        (await call(base, 'GET', `/api/concerns/${ids.clinic}`, 'u-nurse-mgr')).status,
        404
      );
      assert.equal(
        (await call(base, 'GET', '/api/concerns?orgId=org-cah', 'u-clinic-mgr')).status,
        403
      );
      const officer = await call(base, 'GET', '/api/concerns?orgId=org-clinic', 'u-officer');
      assert.equal(officer.status, 200);
      assert.equal((officer.json as Array<unknown>).length, 1);
      assert.equal((await call(base, 'GET', `/api/concerns/${ids.clinic}`, 'u-officer')).status, 200);
    } finally {
      await close();
    }
  });

  it('mine=1 shows the reporter view even for triage roles', async () => {
    const { base, close } = await startServer();
    try {
      await fileConcern(base, 'u-nurse-mgr');
      await fileConcern(base, 'u-staff');
      const mine = await call(base, 'GET', '/api/concerns?orgId=org-cah&mine=1', 'u-nurse-mgr');
      assert.equal(mine.status, 200);
      const rows = mine.json as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reporterId, 'u-nurse-mgr');
      assert.ok(!('internalNotes' in rows[0]));
    } finally {
      await close();
    }
  });
});

describe('Concern triage workflow', () => {
  it('staff cannot triage, even their own report', async () => {
    const { base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-staff', { status: 'acknowledged' }))
          .status,
        404
      );
      assert.equal(
        (await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-staff', { message: 'hi' })).status,
        404
      );
      assert.equal(
        (await call(base, 'POST', `/api/concerns/${id}/notes`, 'u-staff', { text: 'hi' })).status,
        404
      );
    } finally {
      await close();
    }
  });

  it('manager acknowledges with recorded actor and time; officer advances cross-org', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-clinic-staff', { orgId: 'org-clinic' })).json.id as string;
      const ack = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-clinic-mgr', {
        status: 'acknowledged'
      });
      assert.equal(ack.status, 200);
      assert.equal(ack.json.status, 'acknowledged');
      assert.deepEqual(ack.json.statusHistory, [
        { status: 'submitted', at: ack.json.createdAt, byUserId: 'u-clinic-staff' },
        { status: 'acknowledged', at: ack.json.updatedAt, byUserId: 'u-clinic-mgr' }
      ]);
      assert.equal(db.audit[db.audit.length - 1].action, 'concern.acknowledged');
      const review = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-officer', {
        status: 'in_review'
      });
      assert.equal(review.status, 200);
      assert.equal(review.json.status, 'in_review');
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('illegal, backward, and unknown transitions change nothing', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['skip to in_review', { status: 'in_review' }],
        ['skip to closed', { status: 'closed', closingMessage: 'done' }],
        ['unknown status', { status: 'resolved' }]
      ];
      for (const [name, patch] of attempts) {
        const bytes = diskBytes();
        const auditLen = db.audit.length;
        const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', patch);
        assert.equal(res.status, 400, name);
        assert.equal(db.concerns[0].status, 'submitted', name);
        assert.equal(db.audit.length, auditLen, name);
        assert.deepEqual(diskBytes(), bytes, name);
      }
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' }))
          .status,
        200
      );
      const back = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        status: 'submitted'
      });
      assert.equal(back.status, 400);
    } finally {
      await close();
    }
  });

  it('unauthorized managers get 404 without an existence oracle', async () => {
    const { base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      const cross = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-clinic-mgr', {
        status: 'acknowledged'
      });
      assert.equal(cross.status, 404);
      const missing = await call(base, 'PATCH', '/api/concerns/does-not-exist', 'u-nurse-mgr', {
        status: 'acknowledged'
      });
      assert.equal(missing.status, 404);
      assert.deepEqual(Object.keys(cross.json).sort(), Object.keys(missing.json).sort());
    } finally {
      await close();
    }
  });

  it('true no-op triage writes nothing but still requires authorization', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-staff', {})).status,
        404
      );
      const before = db.concerns[0];
      const auditLen = db.audit.length;
      const bytes = diskBytes();
      const mtime = diskMtime();
      const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        status: 'submitted'
      });
      assert.equal(res.status, 200);
      assert.equal(db.audit.length, auditLen);
      assert.equal(db.concerns[0].updatedAt, before.updatedAt);
      assert.deepEqual(diskBytes(), bytes);
      assert.equal(diskMtime(), mtime);
    } finally {
      await close();
    }
  });

  it('assignment is limited to triage-authorized users and grants no access', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      const bad = ['u-staff', 'u-clinic-mgr', 'u-ghost'];
      for (const assignee of bad) {
        const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
          assigneeId: assignee
        });
        assert.equal(res.status, 400, assignee);
      }
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { assigneeId: 'u-officer' }))
          .status,
        200
      );
      assert.equal(db.concerns[0].assigneeId, 'u-officer');
      // Assignment widens nobody's access: unrelated staff still see nothing.
      const other = await call(base, 'GET', `/api/concerns/${id}`, 'u-clinic-staff');
      assert.equal(other.status, 404);
      const queue = await call(base, 'GET', '/api/concerns?orgId=org-cah', 'u-staff');
      assert.equal((queue.json as Array<unknown>).length, 1);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('Concern updates and internal notes', () => {
  it('reporter sees progress updates but never internal notes', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      const update = 'Facilities work order WO-4242 opened for the stairwell light.';
      const note = 'Custodian mentioned the same flicker last month; verify coverage gap.';
      assert.equal(
        (await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: update }))
          .status,
        200
      );
      assert.equal(
        (await call(base, 'POST', `/api/concerns/${id}/notes`, 'u-nurse-mgr', { text: note })).status,
        200
      );
      const reporter = await call(base, 'GET', `/api/concerns/${id}`, 'u-staff');
      assert.equal(reporter.status, 200);
      assert.deepEqual(
        (reporter.json.updates as Array<Record<string, unknown>>).map((u) => u.message),
        [update]
      );
      assert.ok(!('internalNotes' in reporter.json));
      const triage = await call(base, 'GET', `/api/concerns/${id}`, 'u-nurse-mgr');
      assert.deepEqual(
        (triage.json.internalNotes as Array<Record<string, unknown>>).map((n) => n.text),
        [note]
      );
      const details = db.audit.map((e) => e.detail).join('\n');
      assert.ok(!details.includes('WO-4242'));
      assert.ok(!details.includes('Custodian'));
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('blank, non-string, and overlong updates or notes change nothing', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      const attempts: Array<[string, string, Record<string, unknown>]> = [
        ['blank message', 'updates', { message: '  ' }],
        ['non-string message', 'updates', { message: 5 }],
        ['long message', 'updates', { message: 'x'.repeat(1001) }],
        ['blank note', 'notes', { text: '' }],
        ['non-string note', 'notes', { text: ['x'] }],
        ['long note', 'notes', { text: 'x'.repeat(1001) }]
      ];
      for (const [name, route, body] of attempts) {
        const bytes = diskBytes();
        const auditLen = db.audit.length;
        const res = await call(base, 'POST', `/api/concerns/${id}/${route}`, 'u-nurse-mgr', body);
        assert.equal(res.status, 400, name);
        assert.equal(db.concerns[0].updates.length, 0, name);
        assert.equal((db.concerns[0].internalNotes ?? []).length, 0, name);
        assert.equal(db.audit.length, auditLen, name);
        assert.deepEqual(diskBytes(), bytes, name);
      }
    } finally {
      await close();
    }
  });
});

describe('Concern closure', () => {
  async function toReview(base: string, id: string): Promise<void> {
    assert.equal(
      (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' }))
        .status,
      200
    );
    assert.equal(
      (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'in_review' })).status,
      200
    );
  }

  it('closing requires a reporter-visible explanation saved atomically', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      await toReview(base, id);
      const bytes = diskBytes();
      const auditLen = db.audit.length;
      const missing = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        status: 'closed'
      });
      assert.equal(missing.status, 400);
      assert.equal(db.concerns[0].status, 'in_review');
      assert.equal(db.concerns[0].updates.length, 0);
      assert.equal(db.audit.length, auditLen);
      assert.deepEqual(diskBytes(), bytes);
      const explanation = 'Electrician relamped the stairwell; nightly checks added for a week.';
      const closed = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        status: 'closed',
        closingMessage: explanation
      });
      assert.equal(closed.status, 200);
      assert.equal(closed.json.status, 'closed');
      assert.equal(db.audit.length, auditLen + 1);
      assert.equal(db.audit[db.audit.length - 1].action, 'concern.closed');
      const stored = db.concerns[0];
      assert.equal(stored.updates.length, 1);
      assert.equal(stored.updates[0].kind, 'closing');
      assert.equal(stored.updates[0].message, explanation);
      assert.equal(stored.statusHistory[stored.statusHistory.length - 1].status, 'closed');
      assert.ok(!db.audit[db.audit.length - 1].detail.includes('relamped'));
      const reporter = await call(base, 'GET', `/api/concerns/${id}`, 'u-staff');
      assert.equal(reporter.json.status, 'closed');
      assert.equal((reporter.json.updates as Array<Record<string, unknown>>).length, 1);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('closed concerns reject every further mutation', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      await toReview(base, id);
      assert.equal(
        (
          await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
            status: 'closed',
            closingMessage: 'Done.'
          })
        ).status,
        200
      );
      const snapshot = JSON.parse(JSON.stringify(db.concerns[0])) as unknown;
      const auditLen = db.audit.length;
      const bytes = diskBytes();
      const attempts: Array<[string, string, string, Record<string, unknown>]> = [
        ['status', 'PATCH', `/api/concerns/${id}`, { status: 'in_review' }],
        ['assign', 'PATCH', `/api/concerns/${id}`, { assigneeId: 'u-officer' }],
        ['link', 'PATCH', `/api/concerns/${id}`, { capaId: 'capa-temp-log' }],
        ['update', 'POST', `/api/concerns/${id}/updates`, { message: 'late' }],
        ['note', 'POST', `/api/concerns/${id}/notes`, { text: 'late' }]
      ];
      for (const [name, method, path, body] of attempts) {
        const res = await call(base, method, path, 'u-nurse-mgr', body);
        assert.equal(res.status, 400, name);
      }
      assert.deepEqual(db.concerns[0], snapshot);
      assert.equal(db.audit.length, auditLen);
      assert.deepEqual(diskBytes(), bytes);
    } finally {
      await close();
    }
  });
});

describe('Concern CAPA linking', () => {
  it('links an existing same-org CAPA and records history without touching the CAPA', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      const capaBefore = JSON.parse(
        JSON.stringify(db.capas.find((c) => c.id === 'capa-temp-log'))
      ) as unknown;
      const linked = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        capaId: 'capa-temp-log'
      });
      assert.equal(linked.status, 200);
      assert.equal(linked.json.capaId, 'capa-temp-log');
      assert.equal(linked.json.linkHistory.length, 1);
      assert.equal(linked.json.linkHistory[0].capaId, 'capa-temp-log');
      assert.equal(linked.json.linkHistory[0].byUserId, 'u-nurse-mgr');
      assert.deepEqual(db.capas.find((c) => c.id === 'capa-temp-log'), capaBefore);
      const reporter = await call(base, 'GET', `/api/concerns/${id}`, 'u-staff');
      assert.equal(reporter.json.capaId, 'capa-temp-log');
      assert.ok(!('finding' in reporter.json));
      assert.ok(!('rootCause' in reporter.json));
      const unlinked = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        capaId: null
      });
      assert.equal(unlinked.status, 200);
      assert.ok(!('capaId' in unlinked.json) || unlinked.json.capaId === undefined);
      assert.equal(unlinked.json.linkHistory.length, 2);
      assert.equal(unlinked.json.linkHistory[1].capaId, null);
      assert.deepEqual(db.capas.find((c) => c.id === 'capa-temp-log'), capaBefore);
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('rejects cross-org and missing CAPA links with nothing changed', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/capas', 'u-officer', {
        orgId: 'org-clinic',
        domainId: 'dom-osha-c',
        finding: 'Clinic eyewash flow below target (simulated).',
        severity: 'low',
        ownerId: 'u-clinic-mgr',
        dueDate: '2027-06-15'
      });
      assert.equal(created.status, 201);
      const clinicCapaId = created.json.id as string;
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      for (const capaId of [clinicCapaId, 'capa-missing']) {
        const bytes = diskBytes();
        const auditLen = db.audit.length;
        const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { capaId });
        assert.equal(res.status, 400, String(capaId));
        assert.equal(db.concerns[0].capaId, undefined, String(capaId));
        assert.equal(db.concerns[0].linkHistory.length, 0, String(capaId));
        assert.equal(db.audit.length, auditLen, String(capaId));
        assert.deepEqual(diskBytes(), bytes, String(capaId));
      }
    } finally {
      await close();
    }
  });
});

describe('Concern audit filtering', () => {
  it('staff see only their own concern events; managers stay org-scoped', async () => {
    const { base, close } = await startServer();
    try {
      const own = (await fileConcern(base, 'u-staff')).json.id as string;
      await fileConcern(base, 'u-officer', { title: 'Officer report on lighting' });
      await fileConcern(base, 'u-clinic-staff', { orgId: 'org-clinic' });
      const staffAudit = await call(base, 'GET', '/api/audit?limit=500', 'u-staff');
      assert.equal(staffAudit.status, 200);
      const staffConcerns = (staffAudit.json as Array<Record<string, unknown>>).filter(
        (e) => e.recordType === 'concern'
      );
      assert.ok(staffConcerns.length > 0);
      assert.ok(staffConcerns.every((e) => e.recordId === own));
      const mgrAudit = await call(base, 'GET', '/api/audit?limit=500', 'u-nurse-mgr');
      const mgrConcerns = (mgrAudit.json as Array<Record<string, unknown>>).filter(
        (e) => e.recordType === 'concern'
      );
      assert.equal(mgrConcerns.length, 2);
      assert.ok(mgrConcerns.every((e) => e.orgId === 'org-cah'));
      const officerAudit = await call(base, 'GET', '/api/audit?limit=500', 'u-officer');
      const officerConcerns = (officerAudit.json as Array<Record<string, unknown>>).filter(
        (e) => e.recordType === 'concern'
      );
      assert.equal(officerConcerns.length, 3);
      // Other record types keep their existing visibility.
      const staffTasks = (staffAudit.json as Array<Record<string, unknown>>).filter(
        (e) => e.recordType === 'task'
      );
      assert.ok(staffTasks.length > 0);
      assert.ok(staffTasks.every((e) => e.orgId === 'org-cah'));
    } finally {
      await close();
    }
  });
});

describe('Concern storage safety', () => {
  it('databases that predate concerns load with an empty collection', async () => {
    const legacy = seedDatabase() as unknown as Record<string, unknown>;
    delete legacy.concerns;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dataFile, JSON.stringify(legacy));
    const db = store.loadDb();
    assert.deepEqual(db.concerns, []);
    assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
  });

  it('failed concern writes roll back memory and disk and log only the route', async () => {
    const { db, base, close } = await startServer();
    try {
      const logged: unknown[][] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      try {
        store.__setRenameImpl(() => {
          const e = new Error('simulated EIO') as NodeJS.ErrnoException;
          e.code = 'EIO';
          throw e;
        });
        const res = await fileConcern(base, 'u-staff');
        assert.equal(res.status, 500);
        assert.equal(db.concerns.length, 0);
        assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
        assertDiskMatchesMemory(db);
        assert.equal(logged.length, 1);
        assert.equal(logged[0][0], '[sentinel] error.route.unexpected route=/api/concerns');
      } finally {
        console.error = origError;
        store.__setRenameImpl(null);
      }
      assert.equal((await fileConcern(base, 'u-staff')).status, 201);
    } finally {
      await close();
    }
  });
});

describe('F-1 linked-CAPA summary', () => {
  it('reporter and triage responses carry id/status only, never stored', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { capaId: 'capa-temp-log' }))
          .status,
        200
      );
      for (const [who, path] of [
        ['u-staff', `/api/concerns/${id}`],
        ['u-nurse-mgr', `/api/concerns/${id}`]
      ] as const) {
        const res = await call(base, 'GET', path, who);
        assert.equal(res.status, 200, who);
        assert.deepEqual(res.json.linkedCapa, { id: 'capa-temp-log', status: 'investigation' }, who);
        assert.deepEqual(Object.keys(res.json.linkedCapa).sort(), ['id', 'status'], who);
      }
      const mine = await call(base, 'GET', '/api/concerns?orgId=org-cah&mine=1', 'u-staff');
      assert.deepEqual((mine.json as Array<Record<string, unknown>>)[0].linkedCapa, {
        id: 'capa-temp-log',
        status: 'investigation'
      });
      // The summary is computed per response, never persisted.
      assert.ok(!('linkedCapa' in db.concerns[0]));
      const disk = JSON.parse(readFileSync(dataFile, 'utf8')) as Db;
      assert.ok(!('linkedCapa' in disk.concerns[0]));
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });

  it('summary tracks the live CAPA status', async () => {
    const { base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { capaId: 'capa-temp-log' }))
          .status,
        200
      );
      assert.equal(
        (
          await call(base, 'PATCH', '/api/capas/capa-temp-log', 'u-nurse-mgr', {
            status: 'action_in_progress'
          })
        ).status,
        200
      );
      const res = await call(base, 'GET', `/api/concerns/${id}`, 'u-staff');
      assert.deepEqual(res.json.linkedCapa, { id: 'capa-temp-log', status: 'action_in_progress' });
    } finally {
      await close();
    }
  });

  it('stale links carry no invented status', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { capaId: 'capa-temp-log' }))
          .status,
        200
      );
      // Cross-org drift: the summary requires a same-org CAPA.
      db.capas.find((c) => c.id === 'capa-temp-log')!.orgId = 'org-clinic';
      store.saveDb(db);
      const drifted = await call(base, 'GET', `/api/concerns/${id}`, 'u-staff');
      assert.equal(drifted.status, 200);
      assert.equal(drifted.json.capaId, 'capa-temp-log');
      assert.ok(!('linkedCapa' in drifted.json));
      // Removed CAPA row: link id stays visible, summary stays absent.
      db.capas.splice(
        db.capas.findIndex((c) => c.id === 'capa-temp-log'),
        1
      );
      store.saveDb(db);
      for (const who of ['u-staff', 'u-nurse-mgr']) {
        const res = await call(base, 'GET', `/api/concerns/${id}`, who);
        assert.equal(res.status, 200, who);
        assert.equal(res.json.capaId, 'capa-temp-log', who);
        assert.ok(!('linkedCapa' in res.json), who);
      }
      assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
    } finally {
      await close();
    }
  });

  it('existing CAPA read permissions are unchanged for staff', async () => {
    const { base, close } = await startServer();
    try {
      // Deliberately preserved: demo staff can still read organization CAPA
      // investigation details through the existing CAPA feature. The concern
      // summary only fixes the concern workflow's own data dependency.
      const res = await call(base, 'GET', '/api/capas?orgId=org-cah', 'u-staff');
      assert.equal(res.status, 200);
      const capa = (res.json as Array<Record<string, unknown>>).find((c) => c.id === 'capa-temp-log');
      assert.ok(capa);
      assert.ok('finding' in capa);
      assert.ok('rootCause' in capa);
      assert.ok('evidence' in capa);
    } finally {
      await close();
    }
  });
});

describe('F-2 internal-note audit filtering', () => {
  it('reporters cannot see note events; triage can; history is preserved', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: 'Public.' }))
          .status,
        200
      );
      assert.equal(
        (await call(base, 'POST', `/api/concerns/${id}/notes`, 'u-nurse-mgr', { text: 'Private.' }))
          .status,
        200
      );
      const reporter = await call(base, 'GET', `/api/audit?recordId=${id}`, 'u-staff');
      assert.equal(reporter.status, 200);
      const reporterActions = (reporter.json as Array<Record<string, unknown>>).map((e) => e.action);
      assert.ok(reporterActions.includes('concern.submitted'));
      assert.ok(reporterActions.includes('concern.updated'));
      assert.ok(!reporterActions.includes('concern.note_added'));
      const unfiltered = await call(base, 'GET', '/api/audit?limit=500', 'u-staff');
      assert.ok(
        (unfiltered.json as Array<Record<string, unknown>>).every((e) => e.action !== 'concern.note_added')
      );
      const triage = await call(base, 'GET', `/api/audit?recordId=${id}`, 'u-nurse-mgr');
      const triageActions = (triage.json as Array<Record<string, unknown>>).map((e) => e.action);
      assert.ok(triageActions.includes('concern.note_added'));
      // Stored history keeps the event; nothing rewritten or renumbered.
      const stored = db.audit.find((e) => e.action === 'concern.note_added' && e.recordId === id);
      assert.ok(stored);
      assert.ok(stored.detail.includes('internal note #1 added'));
      assert.ok(!stored.detail.includes('Private.'));
      assert.deepEqual(
        db.audit.map((e) => e.seq),
        db.audit.map((_, i) => i + 1)
      );
      assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('F-3 actual-change audit field lists', () => {
  it('same-value assignee/link/status PATCHes write nothing', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { assigneeId: 'u-officer' }))
          .status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { capaId: 'capa-temp-log' }))
          .status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' }))
          .status,
        200
      );
      const patches: Array<[string, Record<string, unknown>]> = [
        ['same assignee', { assigneeId: 'u-officer' }],
        ['same link', { capaId: 'capa-temp-log' }],
        ['same status', { status: 'acknowledged' }],
        ['all unchanged', { status: 'acknowledged', assigneeId: 'u-officer', capaId: 'capa-temp-log' }]
      ];
      for (const [name, patch] of patches) {
        const updatedAt = db.concerns[0].updatedAt;
        const auditLen = db.audit.length;
        const bytes = diskBytes();
        const mtime = diskMtime();
        const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', patch);
        assert.equal(res.status, 200, name);
        assert.equal(db.audit.length, auditLen, name);
        assert.equal(db.concerns[0].updatedAt, updatedAt, name);
        assert.deepEqual(diskBytes(), bytes, name);
        assert.equal(diskMtime(), mtime, name);
      }
    } finally {
      await close();
    }
  });

  it('mixed requests list only the changed field', async () => {
    const { db, base, close } = await startServer();
    try {
      const created = await call(base, 'POST', '/api/capas', 'u-officer', {
        orgId: 'org-cah',
        domainId: 'dom-hipaa-h',
        finding: 'Second simulated finding for field-list checks.',
        severity: 'low',
        ownerId: 'u-nurse-mgr',
        dueDate: '2027-06-15'
      });
      assert.equal(created.status, 201);
      const second = created.json.id as string;
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      assert.equal(
        (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { assigneeId: 'u-officer' }))
          .status,
        200
      );
      assert.equal(db.audit[db.audit.length - 1].detail, `Concern ${id} updated (fields: assigneeId)`);
      // Same assignee + new link: only the link is listed.
      assert.equal(
        (
          await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
            assigneeId: 'u-officer',
            capaId: second
          })
        ).status,
        200
      );
      assert.equal(db.audit[db.audit.length - 1].detail, `Concern ${id} updated (fields: capaId)`);
      // Status change + unchanged link: no fields suffix at all.
      assert.equal(
        (
          await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
            status: 'acknowledged',
            capaId: second
          })
        ).status,
        200
      );
      assert.equal(db.audit[db.audit.length - 1].detail, `Concern ${id} [submitted -> acknowledged]`);
      // Status change + changed assignee: only the assignee is listed.
      assert.equal(
        (
          await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
            status: 'in_review',
            assigneeId: 'u-officer2'
          })
        ).status,
        200
      );
      assert.equal(
        db.audit[db.audit.length - 1].detail,
        `Concern ${id} [acknowledged -> in_review] (fields: assigneeId)`
      );
      assertDiskMatchesMemory(db);
    } finally {
      await close();
    }
  });
});

describe('R-2 closed-concern PATCH lock', () => {
  async function closedFixture(base: string): Promise<string> {
    const id = (await fileConcern(base, 'u-staff')).json.id as string;
    assert.equal(
      (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { assigneeId: 'u-officer' }))
        .status,
      200
    );
    assert.equal(
      (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { capaId: 'capa-temp-log' }))
        .status,
      200
    );
    assert.equal(
      (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' }))
        .status,
      200
    );
    assert.equal(
      (await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'in_review' })).status,
      200
    );
    assert.equal(
      (
        await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
          status: 'closed',
          closingMessage: 'Original closing explanation.'
        })
      ).status,
      200
    );
    return id;
  }

  it('authorized same-value PATCH on a closed concern is rejected with nothing changed', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await closedFixture(base);
      const snapshot = JSON.parse(JSON.stringify(db.concerns[0])) as unknown;
      const patches: Array<[string, Record<string, unknown>]> = [
        ['same status', { status: 'closed' }],
        ['same assignee', { assigneeId: 'u-officer' }],
        ['same link', { capaId: 'capa-temp-log' }],
        ['all unchanged', { status: 'closed', assigneeId: 'u-officer', capaId: 'capa-temp-log' }],
        ['ignored fields only', { title: 'New title', description: 'New description' }],
        ['empty body', {}]
      ];
      for (const [name, patch] of patches) {
        const bytes = diskBytes();
        const mtime = diskMtime();
        const auditLen = db.audit.length;
        const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', patch);
        assert.equal(res.status, 400, name);
        assert.equal(res.json.error, 'Closed concerns are locked.', name);
        assert.deepEqual(db.concerns[0], snapshot, name);
        assert.equal(db.audit.length, auditLen, name);
        assert.deepEqual(diskBytes(), bytes, name);
        assert.equal(diskMtime(), mtime, name);
      }
      // Unlink-when-unlinked on a closed concern that never had a link.
      const bare = (await fileConcern(base, 'u-staff')).json.id as string;
      for (const status of ['acknowledged', 'in_review']) {
        assert.equal(
          (await call(base, 'PATCH', `/api/concerns/${bare}`, 'u-nurse-mgr', { status })).status,
          200
        );
      }
      assert.equal(
        (
          await call(base, 'PATCH', `/api/concerns/${bare}`, 'u-nurse-mgr', {
            status: 'closed',
            closingMessage: 'Done.'
          })
        ).status,
        200
      );
      const auditLen = db.audit.length;
      const bytes = diskBytes();
      const unlink = await call(base, 'PATCH', `/api/concerns/${bare}`, 'u-nurse-mgr', {
        capaId: null
      });
      assert.equal(unlink.status, 400);
      assert.equal(unlink.json.error, 'Closed concerns are locked.');
      assert.equal(db.audit.length, auditLen);
      assert.deepEqual(diskBytes(), bytes);
    } finally {
      await close();
    }
  });

  it('re-closing with a new explanation is rejected and stores nothing', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await closedFixture(base);
      assert.equal(db.concerns[0].updates.length, 1);
      const bytes = diskBytes();
      const mtime = diskMtime();
      const auditLen = db.audit.length;
      const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        status: 'closed',
        closingMessage: 'A second explanation that must never land.'
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'Closed concerns are locked.');
      assert.equal(db.concerns[0].updates.length, 1);
      assert.equal(db.concerns[0].updates[0].message, 'Original closing explanation.');
      assert.equal(db.audit.length, auditLen);
      assert.deepEqual(diskBytes(), bytes);
      assert.equal(diskMtime(), mtime);
      assert.ok(!JSON.stringify(db.concerns[0]).includes('must never land'));
    } finally {
      await close();
    }
  });

  it('unauthorized PATCH on a closed concern keeps the 404 access response', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = await closedFixture(base);
      const bytes = diskBytes();
      const mtime = diskMtime();
      const auditLen = db.audit.length;
      for (const who of ['u-staff', 'u-clinic-staff', 'u-clinic-mgr']) {
        const res = await call(base, 'PATCH', `/api/concerns/${id}`, who, { status: 'acknowledged' });
        assert.equal(res.status, 404, who);
        assert.equal(res.json.error, 'Concern not found.', who);
      }
      assert.equal(db.audit.length, auditLen);
      assert.deepEqual(diskBytes(), bytes);
      assert.equal(diskMtime(), mtime);
    } finally {
      await close();
    }
  });

  it('non-closed no-ops still succeed without writing', async () => {
    const { db, base, close } = await startServer();
    try {
      const id = (await fileConcern(base, 'u-staff')).json.id as string;
      const patches: Array<[string, Record<string, unknown>]> = [
        ['empty body', {}],
        ['same status', { status: 'submitted' }],
        ['ignored fields only', { title: 'x', description: 'y', reporterId: 'u-admin' }]
      ];
      for (const [name, patch] of patches) {
        const updatedAt = db.concerns[0].updatedAt;
        const auditLen = db.audit.length;
        const bytes = diskBytes();
        const mtime = diskMtime();
        const res = await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', patch);
        assert.equal(res.status, 200, name);
        assert.equal(db.audit.length, auditLen, name);
        assert.equal(db.concerns[0].updatedAt, updatedAt, name);
        assert.deepEqual(diskBytes(), bytes, name);
        assert.equal(diskMtime(), mtime, name);
      }
    } finally {
      await close();
    }
  });
});
