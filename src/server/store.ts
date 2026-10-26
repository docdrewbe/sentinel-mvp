// Local JSON document store with an append-only, hash-chained audit log.
//
// SIMULATED tamper-evidence for demo purposes only: the SHA-256 chain makes
// casual edits detectable, but file-level protection is NOT production-ready.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AuditEvent,
  ComplianceTask,
  DemoUser,
  EvidenceRef,
  Organization,
  RegulatoryDomain,
  TaskStatus
} from '../shared/types.js';

export interface DbShape {
  version: 1;
  orgs: Organization[];
  domains: RegulatoryDomain[];
  users: DemoUser[];
  tasks: ComplianceTask[];
  audit: AuditEvent[];
}

export class ValidationError extends Error {}

export function dataFilePath(): string {
  return process.env.SENTINEL_DATA_FILE ?? join(process.cwd(), 'data', 'sentinel.json');
}

export function emptyDb(): DbShape {
  return { version: 1, orgs: [], domains: [], users: [], tasks: [], audit: [] };
}

export function loadDb(): DbShape {
  const file = dataFilePath();
  if (!existsSync(file)) return emptyDb();
  return JSON.parse(readFileSync(file, 'utf8')) as DbShape;
}

export function saveDb(db: DbShape): void {
  const file = dataFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  renameSync(tmp, file); // atomic replace so a crash never leaves a half-written DB
}

type HashableEvent = Omit<AuditEvent, 'hash'>;

function eventHash(e: HashableEvent): string {
  const parts = [
    e.seq,
    e.id,
    e.actorId,
    e.action,
    e.recordType,
    e.recordId,
    e.timestamp,
    e.detail,
    e.prevHash
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Build the next chained event for an existing audit trail (pure; no I/O). */
export function buildAuditEvent(
  audit: AuditEvent[],
  input: { actorId: string; action: string; recordType: string; recordId: string; detail: string }
): AuditEvent {
  const prevHash = audit.length > 0 ? audit[audit.length - 1].hash : 'GENESIS';
  const base: HashableEvent = {
    seq: audit.length + 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    prevHash,
    ...input
  };
  return { ...base, hash: eventHash(base) };
}

/** Verify the full hash chain. Returns the first bad sequence number, if any. */
export function verifyAuditChain(audit: AuditEvent[]): { ok: boolean; badSeq?: number } {
  let prev = 'GENESIS';
  for (const e of audit) {
    if (e.prevHash !== prev) return { ok: false, badSeq: e.seq };
    const { hash, ...rest } = e;
    if (eventHash(rest) !== hash) return { ok: false, badSeq: e.seq };
    prev = hash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Audit writer. APPEND-ONLY by design: this module intentionally exposes NO
// update or delete function for audit events, and the API exposes no
// POST/PUT/PATCH/DELETE route for them either.
// ---------------------------------------------------------------------------
export function appendAudit(
  db: DbShape,
  input: { actorId: string; action: string; recordType: string; recordId: string; detail: string }
): AuditEvent {
  const event = buildAuditEvent(db.audit, input);
  db.audit.push(event);
  saveDb(db);
  return event;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskInput {
  orgId: string;
  domainId: string;
  title: string;
  ownerId: string;
  dueDate: string;
}

const STATUSES: TaskStatus[] = ['open', 'in_progress', 'submitted', 'verified'];

/** Legal status transitions. Verification requires a submitted task. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'submitted'],
  in_progress: ['open', 'submitted'],
  submitted: ['open', 'in_progress', 'verified'],
  verified: []
};

function assertDueDate(dueDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate))) {
    throw new ValidationError('dueDate must be a valid ISO calendar date (YYYY-MM-DD).');
  }
}

export function createTask(db: DbShape, input: TaskInput): ComplianceTask {
  const org = db.orgs.find((o) => o.id === input.orgId);
  if (!org) throw new ValidationError('Unknown organization.');
  const domain = db.domains.find((d) => d.id === input.domainId && d.orgId === input.orgId);
  if (!domain) throw new ValidationError('Unknown regulatory domain for this organization.');
  if (!domain.active) throw new ValidationError('Regulatory domain is inactive.');
  const owner = db.users.find((u) => u.id === input.ownerId && u.orgId === input.orgId);
  if (!owner) throw new ValidationError('Owner must be a user of the same organization.');
  if (!input.title || !input.title.trim()) throw new ValidationError('Title is required.');
  assertDueDate(input.dueDate);
  const now = new Date().toISOString();
  const task: ComplianceTask = {
    id: randomUUID(),
    orgId: input.orgId,
    domainId: input.domainId,
    title: input.title.trim(),
    ownerId: input.ownerId,
    dueDate: input.dueDate,
    status: 'open',
    evidence: [],
    createdAt: now,
    updatedAt: now
  };
  db.tasks.push(task);
  saveDb(db);
  return task;
}

export function updateTask(
  db: DbShape,
  id: string,
  patch: Partial<Pick<ComplianceTask, 'title' | 'ownerId' | 'dueDate' | 'status' | 'domainId'>>
): ComplianceTask {
  const task = db.tasks.find((t) => t.id === id);
  if (!task) throw new ValidationError('Task not found.');
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new ValidationError('Title must not be empty.');
    task.title = patch.title.trim();
  }
  if (patch.dueDate !== undefined) {
    assertDueDate(patch.dueDate);
    task.dueDate = patch.dueDate;
  }
  if (patch.ownerId !== undefined) {
    const owner = db.users.find((u) => u.id === patch.ownerId && u.orgId === task.orgId);
    if (!owner) throw new ValidationError('Owner must be a user of the same organization.');
    task.ownerId = patch.ownerId;
  }
  if (patch.domainId !== undefined) {
    const domain = db.domains.find((d) => d.id === patch.domainId && d.orgId === task.orgId);
    if (!domain) throw new ValidationError('Unknown regulatory domain for this organization.');
    task.domainId = patch.domainId;
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new ValidationError('Unknown status.');
    if (patch.status !== task.status && !TRANSITIONS[task.status].includes(patch.status)) {
      throw new ValidationError(
        `Illegal status transition from '${task.status}' to '${patch.status}'.`
      );
    }
    task.status = patch.status;
  }
  task.updatedAt = new Date().toISOString();
  saveDb(db);
  return task;
}

// ---------------------------------------------------------------------------
// Evidence + chain of custody. Every add/handoff is recorded by the caller in
// the audit log; custody state itself lives on the task.
// ---------------------------------------------------------------------------

export function addEvidence(
  db: DbShape,
  taskId: string,
  input: { label: string; holder: string }
): EvidenceRef {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) throw new ValidationError('Task not found.');
  if (!input.label.trim()) throw new ValidationError('Evidence label is required.');
  if (!input.holder.trim()) throw new ValidationError('Evidence holder is required.');
  const ref: EvidenceRef = {
    id: randomUUID(),
    label: input.label.trim(),
    holder: input.holder.trim(),
    updatedAt: new Date().toISOString()
  };
  task.evidence.push(ref);
  task.updatedAt = ref.updatedAt;
  saveDb(db);
  return ref;
}

export function transferCustody(
  db: DbShape,
  taskId: string,
  input: { evidenceId: string; toHolder: string }
): EvidenceRef {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) throw new ValidationError('Task not found.');
  const ref = task.evidence.find((e) => e.id === input.evidenceId);
  if (!ref) throw new ValidationError('Evidence item not found on this task.');
  if (!input.toHolder.trim()) throw new ValidationError('New holder is required.');
  if (ref.holder === input.toHolder.trim()) {
    throw new ValidationError('New holder must differ from the current holder.');
  }
  ref.holder = input.toHolder.trim();
  ref.updatedAt = new Date().toISOString();
  task.updatedAt = ref.updatedAt;
  saveDb(db);
  return ref;
}
