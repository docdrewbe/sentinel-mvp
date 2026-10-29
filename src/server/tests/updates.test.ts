// HTTP-level "my recent updates" tests: the read-only personal feed applies
// organization scope, record access, personal relevance, and an explicit
// event allowlist BEFORE selecting the newest five. Uses an isolated temp
// database and ephemeral ports; never touches live data or QA evidence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'sentinel-updates-'));
process.env.SENTINEL_DATA_FILE = join(workdir, 'sentinel.json');
const dataFile = process.env.SENTINEL_DATA_FILE;

const { createApp } = await import('../app.js');
const { seedDatabase } = await import('../seed.js');
const store = await import('../store.js');

type Db = ReturnType<typeof seedDatabase>;
type Entry = Record<string, unknown>;

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

async function feed(base: string, userId: string, orgId = 'org-cah'): Promise<Entry[]> {
  const res = await call(base, 'GET', `/api/my-updates?orgId=${orgId}`, userId);
  assert.equal(res.status, 200);
  return res.json as unknown as Entry[];
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
  description: 'The stairwell light flickers intermittently during night shifts.'
};

/** Only these keys may ever appear on a feed entry (plus optional updateSeq/statusIndex). */
function assertEntryShape(entry: Entry): void {
  const keys = Object.keys(entry).filter((k) => k !== 'updateSeq' && k !== 'statusIndex').sort();
  assert.deepEqual(keys, [
    'description',
    'recordId',
    'recordKind',
    'recordStatus',
    'recordTitle',
    'seq',
    'timestamp'
  ]);
  assert.ok(!('detail' in entry));
  assert.ok(!('internalNotes' in entry));
}

describe('My-updates endpoint access', () => {
  it('requires authentication and organization scope, writing nothing', async () => {
    const { db, base, close } = await startServer();
    try {
      const bytes = diskBytes();
      const mtime = diskMtime();
      const auditLen = db.audit.length;
      assert.equal((await call(base, 'GET', '/api/my-updates?orgId=org-cah', '')).status, 401);
      assert.equal((await call(base, 'GET', '/api/my-updates?orgId=org-cah', 'u-ghost')).status, 401);
      assert.equal((await call(base, 'GET', '/api/my-updates?orgId=org-clinic', 'u-staff')).status, 403);
      assert.equal(db.audit.length, auditLen);
      assert.deepEqual(diskBytes(), bytes);
      assert.equal(diskMtime(), mtime);
    } finally {
      await close();
    }
  });

  it('is empty on a fresh seed and preserves the database on read', async () => {
    const { db, base, close } = await startServer();
    try {
      const before = JSON.parse(JSON.stringify(db)) as unknown;
      const bytes = diskBytes();
      const mtime = diskMtime();
      assert.deepEqual(await feed(base, 'u-staff'), []);
      assert.deepEqual(await feed(base, 'u-nurse-mgr'), []);
      assert.deepEqual(db, before);
      assert.deepEqual(diskBytes(), bytes);
      assert.equal(diskMtime(), mtime);
      assert.deepEqual(store.verifyAuditChain(db.audit), { ok: true });
    } finally {
      await close();
    }
  });

  it('is personal-only for officers despite broader visibility', async () => {
    const { base, close } = await startServer();
    try {
      // Organization activity by others: filings, triage, submissions.
      await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      await call(base, 'PATCH', '/api/tasks/task-hipaa-training', 'u-staff', { status: 'submitted' });
      // The officer owns task-access-review but has no eligible events yet.
      assert.deepEqual(await feed(base, 'u-officer'), []);
      // Filing their own report makes exactly one entry appear.
      await call(base, 'POST', '/api/concerns', 'u-officer', {
        ...CONCERN,
        title: 'Officer observation'
      });
      const entries = await feed(base, 'u-officer');
      assert.equal(entries.length, 1);
      assert.equal(entries[0].recordKind, 'concern');
      assert.equal(entries[0].description, 'J. Ortiz filed the report');
    } finally {
      await close();
    }
  });
});

describe('My-updates concern entries', () => {
  it('follows a report lifecycle newest-first with exact descriptions', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      assert.equal(filed.status, 201);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', {
        message: 'Facilities notified.'
      });
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'in_review' });
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        status: 'closed',
        closingMessage: 'Resolved.'
      });
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 5);
      for (const entry of entries) assertEntryShape(entry);
      assert.deepEqual(
        entries.map((e) => e.description),
        [
          'M. Lee closed the report',
          'M. Lee moved the report to In Review',
          'M. Lee posted a follow-up update',
          'M. Lee acknowledged the report',
          'T. Nguyen filed the report'
        ]
      );
      assert.ok(entries.every((e) => e.recordId === id && e.recordKind === 'concern'));
      // Newest first by stored timestamp, then sequence.
      for (let i = 1; i < entries.length; i++) {
        const prev = entries[i - 1];
        const cur = entries[i];
        assert.ok(
          (prev.timestamp as string) > (cur.timestamp as string) ||
            ((prev.timestamp as string) === (cur.timestamp as string) &&
              (prev.seq as number) > (cur.seq as number))
        );
      }
      // Timestamps and sequences equal the stored events (never invented).
      for (const entry of entries) {
        const stored = db.audit.find((e) => e.seq === entry.seq);
        assert.ok(stored);
        assert.equal(entry.timestamp, stored.timestamp);
      }
      // The follow-up entry carries its validated update sequence.
      const followUp = entries.find((e) => e.description === 'M. Lee posted a follow-up update');
      assert.ok(followUp);
      assert.equal(followUp.updateSeq, 1);
      assert.ok(entries.filter((e) => e !== followUp).every((e) => !('updateSeq' in e)));
    } finally {
      await close();
    }
  });

  it('caps at five newest across records', async () => {
    const { base, close } = await startServer();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await call(base, 'POST', '/api/concerns', 'u-staff', {
          ...CONCERN,
          title: `Report ${i}`
        });
        ids.push(res.json.id as string);
      }
      for (const id of ids) {
        await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
        await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: `Note for ${id.slice(0, 4)}` });
      }
      // 9 eligible events; only the newest 5 are returned.
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 5);
      const seqs = entries.map((e) => e.seq as number);
      assert.deepEqual([...seqs].sort((a, b) => b - a), seqs);
    } finally {
      await close();
    }
  });

  it('describes handler and link changes without naming historical assignees', async () => {
    const { base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { assigneeId: 'u-officer' });
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { capaId: 'capa-temp-log' });
      const entries = await feed(base, 'u-staff');
      assert.deepEqual(
        entries.map((e) => e.description),
        ['M. Lee updated the CAPA link', 'M. Lee updated the handler', 'T. Nguyen filed the report']
      );
      // The stored event names no assignee, so neither does the description.
      assert.ok(!JSON.stringify(entries).includes('J. Ortiz'));
      assert.ok(entries.every((e) => !('updateSeq' in e)));
      // Combined handler change plus unlink in one request.
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        assigneeId: 'u-officer2',
        capaId: null
      });
      const combined = await feed(base, 'u-staff');
      assert.equal(combined[0].description, 'M. Lee updated the handler and the CAPA link');
    } finally {
      await close();
    }
  });

  it('breaks timestamp ties by sequence', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      // Two stored events with an identical timestamp, distinct sequences.
      const stamp = '2026-10-29T12:00:00.000Z';
      store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.acknowledged',
        recordType: 'concern',
        recordId: id,
        orgId: 'org-cah',
        detail: `Concern ${id} [submitted -> acknowledged]`
      });
      store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.in_review',
        recordType: 'concern',
        recordId: id,
        orgId: 'org-cah',
        detail: `Concern ${id} [acknowledged -> in_review]`
      });
      db.audit[db.audit.length - 2].timestamp = stamp;
      db.audit[db.audit.length - 1].timestamp = stamp;
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      const tied = entries.filter((e) => e.timestamp === stamp);
      assert.equal(tied.length, 2);
      assert.ok((tied[0].seq as number) > (tied[1].seq as number));
    } finally {
      await close();
    }
  });
});

describe('My-updates task entries', () => {
  it('covers submission, verification, and send-back without conflation', async () => {
    const { base, close } = await startServer();
    try {
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-hipaa-training', 'u-staff', { status: 'submitted' }))
          .status,
        200
      );
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-hipaa-training', 'u-officer', { status: 'verified' }))
          .status,
        200
      );
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 2);
      for (const entry of entries) assertEntryShape(entry);
      assert.deepEqual(
        entries.map((e) => e.description),
        ['J. Ortiz verified the task', 'T. Nguyen submitted the task']
      );
      assert.ok(entries.every((e) => e.recordKind === 'task' && e.recordId === 'task-hipaa-training'));
      assert.equal(entries[0].recordStatus, 'verified');
      // A send-back on another owned task uses transition language.
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-patient-rights', 'u-officer', { status: 'open' }))
          .status,
        200
      );
      const latest = (await feed(base, 'u-staff'))[0];
      assert.equal(latest.description, 'J. Ortiz moved the task to Open');
    } finally {
      await close();
    }
  });

  it('describes assignment from historical owners, never the current handler', async () => {
    const { base, close } = await startServer();
    try {
      // task-emergency-drill is owned by M. Lee; reassign it to T. Nguyen.
      assert.equal(
        (
          await call(base, 'PATCH', '/api/tasks/task-emergency-drill', 'u-nurse-mgr', {
            ownerId: 'u-staff'
          })
        ).status,
        200
      );
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 1);
      assert.equal(
        entries[0].description,
        'M. Lee reassigned the task from M. Lee to T. Nguyen'
      );
      // Reassign it onward to the officer: the historical hop stays truthful.
      assert.equal(
        (
          await call(base, 'PATCH', '/api/tasks/task-emergency-drill', 'u-nurse-mgr', {
            ownerId: 'u-officer'
          })
        ).status,
        200
      );
      const officer = await feed(base, 'u-officer');
      const hop = officer.find(
        (e) => e.recordId === 'task-emergency-drill' && typeof e.description === 'string' && e.description.includes('reassigned')
      );
      assert.ok(hop);
      assert.equal(hop.description, 'M. Lee reassigned the task from T. Nguyen to J. Ortiz');
    } finally {
      await close();
    }
  });

  it('drops entries when a task is reassigned away', async () => {
    const { base, close } = await startServer();
    try {
      assert.equal(
        (await call(base, 'PATCH', '/api/tasks/task-hipaa-training', 'u-staff', { status: 'submitted' }))
          .status,
        200
      );
      assert.equal((await feed(base, 'u-staff')).length, 1);
      assert.equal(
        (
          await call(base, 'PATCH', '/api/tasks/task-hipaa-training', 'u-nurse-mgr', {
            ownerId: 'u-nurse-mgr'
          })
        ).status,
        200
      );
      assert.deepEqual(await feed(base, 'u-staff'), []);
    } finally {
      await close();
    }
  });

  it('omits creation, evidence, custody, and unrelated edits', async () => {
    const { base, close } = await startServer();
    try {
      // Fresh seed: only task.created events exist for owned tasks.
      assert.deepEqual(await feed(base, 'u-staff'), []);
      // Evidence, custody, and title edits on an owned task add no entries.
      await call(base, 'POST', '/api/tasks/task-hipaa-training/evidence', 'u-staff', {
        label: 'Extra roster (simulated)',
        holder: 'T. Nguyen'
      });
      await call(base, 'POST', '/api/tasks/task-hipaa-training/transfer', 'u-staff', {
        evidenceId: 'task-hipaa-training-ev1',
        toHolder: 'M. Lee'
      });
      await call(base, 'PATCH', '/api/tasks/task-hipaa-training', 'u-staff', {
        title: 'HIPAA annual workforce training review (retitled)'
      });
      assert.deepEqual(await feed(base, 'u-staff'), []);
    } finally {
      await close();
    }
  });
});

describe('My-updates exclusions and robustness', () => {
  it('excludes internal-note events in both current and older formats', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'POST', `/api/concerns/${id}/notes`, 'u-nurse-mgr', { text: 'Private triage note.' });
      // Older-format note event, as written before the note_added action.
      store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.updated',
        recordType: 'concern',
        recordId: id,
        orgId: 'org-cah',
        detail: `Concern ${id} internal note #9 added`
      });
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 1);
      assert.equal(entries[0].description, 'T. Nguyen filed the report');
      assert.ok(!JSON.stringify(entries).includes('internal note'));
      assert.ok(!JSON.stringify(entries).includes('Private triage note'));
    } finally {
      await close();
    }
  });

  it('skips events whose records are missing', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      assert.equal((await feed(base, 'u-staff')).length, 1);
      db.concerns.splice(
        db.concerns.findIndex((c) => c.id === id),
        1
      );
      store.saveDb(db);
      assert.deepEqual(await feed(base, 'u-staff'), []);
    } finally {
      await close();
    }
  });

  it('is not displaced by more than 500 unrelated events', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      // 600 unrelated events: other records, other orgs, other actions.
      for (let i = 0; i < 600; i++) {
        store.appendAudit(db, {
          actorId: 'u-officer',
          action: 'task.updated',
          recordType: 'task',
          recordId: 'task-access-review',
          orgId: 'org-cah',
          detail: `Noise event ${i}`
        });
      }
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 2);
      assert.deepEqual(
        entries.map((e) => e.description),
        ['M. Lee acknowledged the report', 'T. Nguyen filed the report']
      );
    } finally {
      await close();
    }
  });

  it('uses generic wording for ambiguous field lists, never invented meaning', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      // An unfamiliar fields shape: still a real stored change, described generically.
      store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.updated',
        recordType: 'concern',
        recordId: id,
        orgId: 'org-cah',
        detail: `Concern ${id} updated (fields: something_new)`
      });
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      assert.equal(entries[0].description, 'M. Lee updated the report');
      assert.ok(!('updateSeq' in entries[0]));
    } finally {
      await close();
    }
  });

  it('omits the update sequence when the referenced update is absent', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      // Well-formed update marker pointing at a nonexistent update.
      store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.updated',
        recordType: 'concern',
        recordId: id,
        orgId: 'org-cah',
        detail: `Concern ${id} reporter update #99 added`
      });
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      assert.equal(entries[0].description, 'M. Lee updated the report');
      assert.ok(!('updateSeq' in entries[0]));
    } finally {
      await close();
    }
  });
});

describe('F-1 status-history navigation targets', () => {
  it('transition entries carry validated status-history indices', async () => {
    const { base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: 'Note.' });
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'in_review' });
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', {
        status: 'closed',
        closingMessage: 'Done.'
      });
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 5);
      for (const entry of entries) assertEntryShape(entry);
      const byDescription = new Map(entries.map((e) => [e.description, e]));
      assert.equal(byDescription.get('M. Lee acknowledged the report')?.statusIndex, 1);
      assert.equal(byDescription.get('M. Lee moved the report to In Review')?.statusIndex, 2);
      assert.equal(byDescription.get('M. Lee closed the report')?.statusIndex, 3);
      assert.equal(byDescription.get('T. Nguyen filed the report')?.statusIndex, 0);
      assert.ok(!('statusIndex' in (byDescription.get('M. Lee posted a follow-up update') as Entry)));
    } finally {
      await close();
    }
  });

  it('repeated status values yield no index', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      // Unfamiliar data: the same status twice. The label alone cannot
      // identify the transition, so no index is offered.
      db.concerns[0].statusHistory.push({
        status: 'acknowledged',
        at: new Date().toISOString(),
        byUserId: 'u-nurse-mgr'
      });
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      const ack = entries.find((e) => e.description === 'M. Lee acknowledged the report');
      assert.ok(ack);
      assert.ok(!('statusIndex' in ack));
    } finally {
      await close();
    }
  });
});

describe('R-1/R-2/R-5 trustworthy navigation targets', () => {
  it('requires a matching actor for the history index', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      // The history row names a different actor than the event: same label,
      // untrustworthy identity — no index, entry kept.
      db.concerns[0].statusHistory[1].byUserId = 'u-officer';
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      const ack = entries.find((e) => e.description === 'M. Lee acknowledged the report');
      assert.ok(ack);
      assert.ok(!('statusIndex' in ack));
      const submitted = entries.find((e) => e.description === 'T. Nguyen filed the report');
      assert.ok(submitted);
      assert.equal(submitted.statusIndex, 0);
    } finally {
      await close();
    }
  });

  it('requires a valid timestamp relationship for the history index', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      // Same status and actor, but stamped long before the event — outside
      // anything the same-block write path can produce.
      db.concerns[0].statusHistory[1].at = '2025-01-01T00:00:00.000Z';
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      const ack = entries.find((e) => e.description === 'M. Lee acknowledged the report');
      assert.ok(ack);
      assert.ok(!('statusIndex' in ack));
      const submitted = entries.find((e) => e.description === 'T. Nguyen filed the report');
      assert.ok(submitted);
      assert.equal(submitted.statusIndex, 0);
    } finally {
      await close();
    }
  });

  it('strips the shared history claim from duplicate events', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      // A second stored event for the same transition, same actor. The
      // history stamp is aligned to the later event so both events pass
      // the identity checks — then neither may keep the shared claim.
      const dup = store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.acknowledged',
        recordType: 'concern',
        recordId: id,
        orgId: 'org-cah',
        detail: `Concern ${id} [submitted -> acknowledged]`
      });
      db.concerns[0].statusHistory[1].at = dup.timestamp;
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      const acks = entries.filter((e) => e.description === 'M. Lee acknowledged the report');
      assert.equal(acks.length, 2);
      assert.ok(acks.every((e) => !('statusIndex' in e)));
    } finally {
      await close();
    }
  });

  it('strips the shared update claim from duplicate update markers', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: 'Note.' });
      const real = db.audit.find(
        (e) => e.action === 'concern.updated' && e.detail.includes('reporter update #1 added')
      );
      assert.ok(real);
      store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.updated',
        recordType: 'concern',
        recordId: id,
        orgId: 'org-cah',
        detail: real.detail
      });
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      const followUps = entries.filter((e) => e.description === 'M. Lee posted a follow-up update');
      assert.equal(followUps.length, 2);
      assert.ok(followUps.every((e) => !('updateSeq' in e)));
    } finally {
      await close();
    }
  });

  it('filed entries omit the Submitted target when identity checks fail', async () => {
    const { db, base, close } = await startServer();
    try {
      await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      db.concerns[0].statusHistory[0].byUserId = 'u-officer';
      store.saveDb(db);
      let entries = await feed(base, 'u-staff');
      let filed = entries.find((e) => e.description === 'T. Nguyen filed the report');
      assert.ok(filed);
      assert.ok(!('statusIndex' in filed));
      db.concerns[0].statusHistory[0].byUserId = 'u-staff';
      db.concerns[0].statusHistory[0].at = '2025-01-01T00:00:00.000Z';
      store.saveDb(db);
      entries = await feed(base, 'u-staff');
      filed = entries.find((e) => e.description === 'T. Nguyen filed the report');
      assert.ok(filed);
      assert.ok(!('statusIndex' in filed));
    } finally {
      await close();
    }
  });

  it('malformed history never breaks the feed or repairs stored data', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: 'Note.' });
      const history = db.concerns[0].statusHistory as unknown as unknown[];
      history.unshift(null);
      history.push(null);
      history.push({ status: 'in_review' });
      history.push({ status: 'closed', at: 'not-a-date', byUserId: 'u-nurse-mgr' });
      (db.concerns[0] as unknown as Record<string, unknown>).updates = { not: 'an-array' };
      (db.concerns as unknown as unknown[]).push(null);
      (db.audit as unknown as unknown[]).push(null);
      store.saveDb(db);
      const before = JSON.stringify(db);
      const entries = await feed(base, 'u-staff');
      // Genuine entries survive with render-faithful indices (the unshifted
      // null shifts genuine rows to 1 and 2); the update degrades to the
      // generic wording without a target.
      const submitted = entries.find((e) => e.description === 'T. Nguyen filed the report');
      assert.ok(submitted);
      assert.equal(submitted.statusIndex, 1);
      const ack = entries.find((e) => e.description === 'M. Lee acknowledged the report');
      assert.ok(ack);
      assert.equal(ack.statusIndex, 2);
      const updated = entries.find((e) => e.description === 'M. Lee updated the report');
      assert.ok(updated);
      assert.ok(!('updateSeq' in updated));
      assert.equal(JSON.stringify(db), before);
    } finally {
      await close();
    }
  });

  it('missing history degrades every entry to the safe fallback', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      delete (db.concerns[0] as unknown as Record<string, unknown>).statusHistory;
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.length, 2);
      assert.ok(entries.every((e) => !('statusIndex' in e)));
    } finally {
      await close();
    }
  });
});

describe('§5ar bounded navigation matching', () => {
  it('bounds status matching symmetrically at ±1000ms', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      const event = db.audit.find((e) => e.recordId === id && e.action === 'concern.acknowledged');
      assert.ok(event);
      const eventMs = Date.parse(event.timestamp);
      const indexed = async (historyOffsetMs: number): Promise<boolean> => {
        db.concerns[0].statusHistory[1].at = new Date(eventMs + historyOffsetMs).toISOString();
        store.saveDb(db);
        const entries = await feed(base, 'u-staff');
        const ack = entries.find((e) => e.description === 'M. Lee acknowledged the report');
        assert.ok(ack);
        return 'statusIndex' in ack;
      };
      // audit − history = −offset: both boundaries match, just outside omits.
      assert.equal(await indexed(1000), true);
      assert.equal(await indexed(-1000), true);
      assert.equal(await indexed(1001), false);
      assert.equal(await indexed(-1001), false);
    } finally {
      await close();
    }
  });

  it('refuses history dated far after its event', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      const event = db.audit.find((e) => e.recordId === id && e.action === 'concern.acknowledged');
      assert.ok(event);
      const eventMs = Date.parse(event.timestamp);
      for (const at of [
        new Date(eventMs + 365 * 24 * 3600 * 1000).toISOString(),
        '9999-12-31T23:59:59.000Z'
      ]) {
        db.concerns[0].statusHistory[1].at = at;
        store.saveDb(db);
        const entries = await feed(base, 'u-staff');
        const ack = entries.find((e) => e.description === 'M. Lee acknowledged the report');
        assert.ok(ack);
        assert.ok(!('statusIndex' in ack));
      }
    } finally {
      await close();
    }
  });

  it('omits metadata under excessive monotonic skew', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${id}`, 'u-nurse-mgr', { status: 'acknowledged' });
      const event = db.audit.find((e) => e.recordId === id && e.action === 'concern.acknowledged');
      assert.ok(event);
      // A +1981ms lead, mirroring the measured artificial 2000-stamp burst:
      // beyond the ceiling, so the entry falls back safely instead of
      // claiming an exact target.
      db.concerns[0].statusHistory[1].at = new Date(Date.parse(event.timestamp) + 1981).toISOString();
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      const ack = entries.find((e) => e.description === 'M. Lee acknowledged the report');
      assert.ok(ack);
      assert.ok(!('statusIndex' in ack));
    } finally {
      await close();
    }
  });

  it('omits the update target on actor mismatch', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: 'Note.' });
      db.concerns[0].updates[0].byUserId = 'u-officer';
      store.saveDb(db);
      const entries = await feed(base, 'u-staff');
      assert.equal(entries.find((e) => e.description === 'M. Lee posted a follow-up update'), undefined);
      const updated = entries.find((e) => e.description === 'M. Lee updated the report');
      assert.ok(updated);
      assert.ok(!('updateSeq' in updated));
    } finally {
      await close();
    }
  });

  it('bounds update matching by timestamp like history matching', async () => {
    const { db, base, close } = await startServer();
    try {
      const filed = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const id = filed.json.id as string;
      await call(base, 'POST', `/api/concerns/${id}/updates`, 'u-nurse-mgr', { message: 'Note.' });
      const event = db.audit.find(
        (e) => e.recordId === id && e.action === 'concern.updated' && e.detail.includes('reporter update')
      );
      assert.ok(event);
      const eventMs = Date.parse(event.timestamp);
      // A year apart: the specific wording and target are both withheld.
      db.concerns[0].updates[0].at = new Date(eventMs - 365 * 24 * 3600 * 1000).toISOString();
      store.saveDb(db);
      let entries = await feed(base, 'u-staff');
      assert.equal(entries.find((e) => e.description === 'M. Lee posted a follow-up update'), undefined);
      // Exactly at the ceiling: still a validated match.
      db.concerns[0].updates[0].at = new Date(eventMs + 1000).toISOString();
      store.saveDb(db);
      entries = await feed(base, 'u-staff');
      const followUp = entries.find((e) => e.description === 'M. Lee posted a follow-up update');
      assert.ok(followUp);
      assert.equal(followUp.updateSeq, 1);
    } finally {
      await close();
    }
  });

  it('excludes invalid-timestamp events before limiting', async () => {
    const { db, base, close } = await startServer();
    try {
      const filedA = await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      const idA = filedA.json.id as string;
      await call(base, 'PATCH', `/api/concerns/${idA}`, 'u-nurse-mgr', { status: 'acknowledged' });
      await call(base, 'POST', `/api/concerns/${idA}/updates`, 'u-nurse-mgr', { message: 'Note.' });
      await call(base, 'PATCH', `/api/concerns/${idA}`, 'u-nurse-mgr', { status: 'in_review' });
      await call(base, 'PATCH', `/api/concerns/${idA}`, 'u-nurse-mgr', {
        status: 'closed',
        closingMessage: 'Done.'
      });
      await call(base, 'POST', '/api/concerns', 'u-staff', CONCERN);
      // Three otherwise-eligible events with unusable timestamps: garbage,
      // missing, and wrong-typed. None may appear or displace valid entries.
      const bad1 = store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.acknowledged',
        recordType: 'concern',
        recordId: idA,
        orgId: 'org-cah',
        detail: `Concern ${idA} [submitted -> acknowledged]`
      });
      bad1.timestamp = 'not-a-date';
      const bad2 = store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.acknowledged',
        recordType: 'concern',
        recordId: idA,
        orgId: 'org-cah',
        detail: `Concern ${idA} [submitted -> acknowledged]`
      });
      delete (bad2 as unknown as Record<string, unknown>).timestamp;
      const bad3 = store.appendAudit(db, {
        actorId: 'u-nurse-mgr',
        action: 'concern.updated',
        recordType: 'concern',
        recordId: idA,
        orgId: 'org-cah',
        detail: `Concern ${idA} updated (fields: assigneeId)`
      });
      (bad3 as unknown as Record<string, unknown>).timestamp = 12345;
      store.saveDb(db);
      const bytes = diskBytes();
      const entries = await feed(base, 'u-staff');
      // Six valid entries capped to the five newest; every emitted entry
      // carries a real stored timestamp; the read repaired nothing.
      assert.equal(entries.length, 5);
      for (const entry of entries) {
        assertEntryShape(entry);
        assert.ok(!Number.isNaN(Date.parse(entry.timestamp as string)));
      }
      assert.deepEqual(
        entries.map((e) => e.description),
        [
          'T. Nguyen filed the report',
          'M. Lee closed the report',
          'M. Lee moved the report to In Review',
          'M. Lee posted a follow-up update',
          'M. Lee acknowledged the report'
        ]
      );
      assert.deepEqual(diskBytes(), bytes);
    } finally {
      await close();
    }
  });
});
