// Survey/OCM inspection packet slice: explicit-linkage projection, audit
// containment, tamper surfacing, and read-only HTTP behavior. Uses an
// isolated temp database and ephemeral ports; never touches
// data/sentinel.json or QA evidence.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'sentinel-survey-'));
process.env.SENTINEL_DATA_FILE = join(workdir, 'sentinel.json');
const dataFile = process.env.SENTINEL_DATA_FILE as string;

const { createApp } = await import('../app.js');
const store = await import('../store.js');
const { seedDatabase } = await import('../seed.js');
const { buildSurveyPacket } = await import('../survey.js');
const sharedSurvey = await import('../../shared/survey.js');

type Db = ReturnType<typeof seedDatabase>;

// Seed a hospital template link: instantiateTemplate is the only legitimate
// way a task gains a templateId, so the packet must honor exactly this.
function dbWithLink(): { db: Db; linkedId: string } {
  const db = seedDatabase();
  const linked = store.instantiateTemplate(db, 'tpl-access-review', {
    ownerId: 'u-officer',
    dueDate: '2026-11-15'
  });
  return { db, linkedId: linked.id };
}

describe('survey packet projection (unit)', () => {
  it('template scope includes only explicitly linked tasks', () => {
    const { db, linkedId } = dbWithLink();
    const packet = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-access-review');
    assert.ok(packet);
    assert.equal(packet.scope.kind, 'template');
    assert.deepEqual(
      packet.tasks.map((t) => t.id),
      [linkedId]
    );
    // task-access-review resembles the template by title but carries no
    // templateId: title similarity must never imply a link.
    assert.ok(!packet.tasks.some((t) => t.id === 'task-access-review'));
    assert.equal(packet.simulated, true);
    assert.ok(packet.generatedAt);
  });

  it('unlinked template returns zero tasks with a coverage-gap scope note', () => {
    const db = seedDatabase();
    const packet = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-med-storage');
    assert.ok(packet);
    assert.deepEqual(packet.tasks, []);
    assert.match(packet.scope.note, /Unlinked/);
    assert.match(packet.scope.note, /illustrative/);
  });

  it('pins the exact empty-template wording', () => {
    assert.equal(
      sharedSurvey.SURVEY_EMPTY_TEMPLATE,
      'No tasks explicitly linked to this standard/control template. Review the domain packet for unlinked tasks. This packet does not establish completeness or compliance.'
    );
  });

  it('domain scope includes unlinked tasks', () => {
    const db = seedDatabase();
    const packet = buildSurveyPacket(db, 'org-cah', 'domain', 'dom-hipaa-h');
    assert.ok(packet);
    assert.equal(packet.scope.kind, 'domain');
    const ids = packet.tasks.map((t) => t.id).sort();
    assert.deepEqual(ids, ['task-access-review', 'task-baa', 'task-hipaa-training']);
  });

  it('single-task scope returns exactly that task', () => {
    const db = seedDatabase();
    const packet = buildSurveyPacket(db, 'org-cah', 'task', 'task-med-storage');
    assert.ok(packet);
    assert.equal(packet.scope.kind, 'task');
    assert.deepEqual(
      packet.tasks.map((t) => t.id),
      ['task-med-storage']
    );
    assert.match(packet.scope.note, /No relationship.*inferred/);
  });

  it('cannabis domain and task work with zero templates', () => {
    const db = seedDatabase();
    assert.equal(
      db.templates.filter((t) => t.orgId === 'org-canna').length,
      0
    );
    const domain = buildSurveyPacket(db, 'org-canna', 'domain', 'dom-ocm');
    assert.ok(domain);
    assert.deepEqual(
      domain.tasks.map((t) => t.id),
      ['task-inventory-sop']
    );
    assert.deepEqual(domain.regulatoryRefs, []);
    const single = buildSurveyPacket(db, 'org-canna', 'task', 'task-inventory-sop');
    assert.ok(single);
    assert.equal(single.tasks.length, 1);
    assert.equal(single.organization.kind, 'cannabis_microbusiness');
  });

  it('unknown or foreign scope returns null', () => {
    const db = seedDatabase();
    assert.equal(buildSurveyPacket(db, 'org-cah', 'template', 'nope'), null);
    assert.equal(buildSurveyPacket(db, 'org-cah', 'domain', 'nope'), null);
    assert.equal(buildSurveyPacket(db, 'org-cah', 'task', 'nope'), null);
    assert.equal(buildSurveyPacket(db, 'nope', 'domain', 'dom-hipaa-h'), null);
    // A clinic task id requested under the hospital org must not resolve.
    assert.equal(buildSurveyPacket(db, 'org-cah', 'task', 'task-privacy-screen'), null);
    // No template of another org exists in seed, but the org constraint is
    // structural: a hospital template under the clinic org must not resolve.
    assert.equal(buildSurveyPacket(db, 'org-clinic', 'template', 'tpl-access-review'), null);
  });

  it('audit contains only related task/template events in this org', () => {
    const { db } = dbWithLink();
    const packet = buildSurveyPacket(db, 'org-cah', 'domain', 'dom-hipaa-h');
    assert.ok(packet);
    assert.ok(packet.audit.length > 0);
    const taskIds = new Set(packet.tasks.map((t) => t.id));
    const templateIds = new Set(
      db.templates.filter((t) => t.orgId === 'org-cah' && t.domainId === 'dom-hipaa-h').map((t) => t.id)
    );
    for (const e of packet.audit) {
      assert.equal(e.orgId, 'org-cah');
      if (e.recordType === 'task') assert.ok(taskIds.has(e.recordId));
      else if (e.recordType === 'template') assert.ok(templateIds.has(e.recordId));
      else assert.fail(`unexpected record type in packet: ${e.recordType}`);
    }
    // Clinic tasks have seeded task.created events; none may leak in.
    assert.ok(!packet.audit.some((e) => e.recordId === 'task-privacy-screen'));
  });

  it('excludes non-task record types even on id collision', () => {
    const { db, linkedId } = dbWithLink();
    store.appendAudit(db, {
      actorId: 'u-officer',
      action: 'concern.created',
      recordType: 'concern',
      recordId: linkedId,
      orgId: 'org-cah',
      detail: 'collision probe: must never enter a packet'
    });
    const packet = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-access-review');
    assert.ok(packet);
    assert.ok(!packet.audit.some((e) => e.action === 'concern.created'));
  });

  it('excludes unknown-org events fail-closed without failing the chain', () => {
    const { db, linkedId } = dbWithLink();
    // Valid v2 hash over a fail-closed org tag: the chain verifies, but the
    // packet containment rule (event org must equal the packet org) drops it.
    store.appendAudit(db, {
      actorId: 'u-admin',
      action: 'task.updated',
      recordType: 'task',
      recordId: linkedId,
      orgId: 'unknown',
      detail: 'unknown-org probe: contained, not leaked'
    });
    const packet = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-access-review');
    assert.ok(packet);
    assert.equal(packet.integrity.ok, true);
    assert.ok(!packet.audit.some((e) => e.orgId === 'unknown'));
  });

  it('tampered chain surfaces ok:false with related counts intact', () => {
    const { db } = dbWithLink();
    db.audit[3].detail += ' (tampered)';
    const packet = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-access-review');
    assert.ok(packet);
    assert.equal(packet.integrity.ok, false);
    assert.equal(packet.integrity.relatedEvents, packet.audit.length);
    assert.ok(packet.integrity.checkedEvents >= packet.audit.length);
  });

  it('counts legacy related events lacking the v2 org binding', () => {
    const { db, linkedId } = dbWithLink();
    const before = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-access-review');
    assert.ok(before);
    assert.equal(before.integrity.legacyEvents, 0);
    const legacy = store.buildAuditEvent(db.audit, {
      actorId: 'u-admin',
      action: 'task.updated',
      recordType: 'task',
      recordId: linkedId,
      orgId: 'org-cah',
      detail: 'legacy-shaped probe'
    });
    delete (legacy as { hashVersion?: number }).hashVersion;
    db.audit.push(legacy);
    const packet = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-access-review');
    assert.ok(packet);
    assert.equal(packet.integrity.legacyEvents, 1);
  });

  it('resolves actor names from demo users only', () => {
    const { db } = dbWithLink();
    const packet = buildSurveyPacket(db, 'org-cah', 'domain', 'dom-hipaa-h');
    assert.ok(packet);
    assert.equal(packet.actors['u-officer'], 'J. Ortiz');
    for (const t of packet.tasks) {
      const owner = db.users.find((u) => u.id === t.ownerId);
      assert.ok(owner);
      assert.equal(packet.actors[t.ownerId], owner.name);
    }
    // 'system' authors seed custody/audit entries but is not a demo user:
    // absent here, so the client falls back to the raw id.
    assert.ok(!('system' in packet.actors));
    for (const [id, name] of Object.entries(packet.actors)) {
      assert.equal(
        db.users.find((u) => u.id === id)?.name,
        name
      );
    }
  });

  it('projection clones records instead of sharing live references', () => {
    const { db } = dbWithLink();
    const packet = buildSurveyPacket(db, 'org-cah', 'template', 'tpl-access-review');
    assert.ok(packet);
    assert.ok(packet.tasks.length > 0 && packet.audit.length > 0);
    packet.tasks[0].title = 'MUTATED';
    packet.audit[0].detail = 'MUTATED';
    assert.ok(!db.tasks.some((t) => t.title === 'MUTATED'));
    assert.ok(!db.audit.some((e) => e.detail === 'MUTATED'));
  });
});

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
  path: string,
  userId: string
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
  const res = await fetch(base + path, { headers: { 'x-demo-user-id': userId } });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, json };
}

describe('survey packet endpoint (HTTP)', () => {
  it('serves a packet snapshot with no-store', async () => {
    const { base, close } = await startServer();
    try {
      const res = await call(
        base,
        '/api/survey-packet?orgId=org-cah&kind=domain&id=dom-hipaa-h',
        'u-officer'
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.json.simulated, true);
      assert.ok(typeof res.json.generatedAt === 'string');
      const scope = res.json.scope as { kind: string; id: string };
      assert.equal(scope.kind, 'domain');
      assert.equal((res.json.integrity as { ok: boolean }).ok, true);
    } finally {
      await close();
    }
  });

  it('rejects bad params, hidden scopes, and foreign orgs', async () => {
    const { base, close } = await startServer();
    try {
      assert.equal(
        (await call(base, '/api/survey-packet?orgId=org-cah&kind=domain', 'u-officer')).status,
        400
      );
      assert.equal(
        (await call(base, '/api/survey-packet?orgId=org-cah&kind=capa&id=x', 'u-officer')).status,
        400
      );
      assert.equal(
        (await call(base, '/api/survey-packet?orgId=org-cah&kind=task&id=nope', 'u-officer'))
          .status,
        404
      );
      // Clinic task requested under the hospital org: not found, not leaked.
      assert.equal(
        (
          await call(
            base,
            '/api/survey-packet?orgId=org-cah&kind=task&id=task-privacy-screen',
            'u-officer'
          )
        ).status,
        404
      );
      // Department manager asking outside their own org: forbidden, no records.
      assert.equal(
        (
          await call(
            base,
            '/api/survey-packet?orgId=org-clinic&kind=domain&id=dom-hipaa-c',
            'u-nurse-mgr'
          )
        ).status,
        403
      );
      // Same-organization staff may read their own org packet.
      assert.equal(
        (
          await call(
            base,
            '/api/survey-packet?orgId=org-cah&kind=task&id=task-hipaa-training',
            'u-staff'
          )
        ).status,
        200
      );
    } finally {
      await close();
    }
  });

  it('reads write nothing: bytes identical, no audit growth', async () => {
    const { db, base, close } = await startServer();
    try {
      const beforeBytes = readFileSync(dataFile, 'utf8');
      const beforeAudit = db.audit.length;
      const beforeJson = JSON.stringify(db);
      await call(base, '/api/survey-packet?orgId=org-cah&kind=domain&id=dom-hipaa-h', 'u-officer');
      await call(base, '/api/survey-packet?orgId=org-cah&kind=task&id=nope', 'u-officer');
      await call(base, '/api/survey-packet?orgId=org-clinic&kind=domain&id=dom-hipaa-c', 'u-nurse-mgr');
      await call(base, '/api/survey-packet?orgId=org-canna&kind=domain&id=dom-ocm', 'u-officer');
      assert.equal(readFileSync(dataFile, 'utf8'), beforeBytes);
      assert.equal(db.audit.length, beforeAudit);
      assert.equal(JSON.stringify(db), beforeJson);
    } finally {
      await close();
    }
  });
});
