// Local JSON document store with an append-only, hash-chained audit log.
//
// SIMULATED tamper-evidence for demo purposes only: the SHA-256 chain makes
// casual edits detectable, but file-level protection is NOT production-ready.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync as fsRenameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AuditEvent,
  ComplianceTask,
  ControlType,
  DemoUser,
  EscalationRule,
  EvidenceRef,
  EvidenceRequirement,
  Organization,
  RecurrenceFrequency,
  RegulatoryDomain,
  RegulatorySourceRef,
  Role,
  TaskStatus,
  TaskTemplate
} from '../shared/types.js';
import { SYSTEM_AUDIT_ORG } from '../shared/types.js';
import { nextDueDate } from '../shared/scheduling.js';

export interface DbShape {
  version: 1;
  orgs: Organization[];
  domains: RegulatoryDomain[];
  users: DemoUser[];
  tasks: ComplianceTask[];
  templates: TaskTemplate[];
  audit: AuditEvent[];
}

export class ValidationError extends Error {}

export function dataFilePath(): string {
  return process.env.SENTINEL_DATA_FILE ?? join(process.cwd(), 'data', 'sentinel.json');
}

export function emptyDb(): DbShape {
  return { version: 1, orgs: [], domains: [], users: [], tasks: [], templates: [], audit: [] };
}

export function loadDb(): DbShape {
  const file = dataFilePath();
  if (!existsSync(file)) return emptyDb();
  // Tolerant read: databases written before templates existed gain defaults.
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DbShape>;
  const db: DbShape = { ...emptyDb(), ...raw };
  backfillAuditOrgIds(db);
  return db;
}

// Rename step behind a seam so tests can deterministically simulate the
// intermittent Windows rename failures (EPERM/EBUSY from antivirus/indexers).
let renameImpl: (tmp: string, file: string) => void = (tmp, file) => fsRenameSync(tmp, file);

/** Test-only seam: replace the atomic rename step, or pass null to restore it. */
export function __setRenameImpl(impl: ((tmp: string, file: string) => void) | null): void {
  renameImpl = impl ?? ((tmp, file) => fsRenameSync(tmp, file));
}

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function isRetryable(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Persist the whole database with one atomic file replace. On Windows the
 * rename intermittently fails while the target is briefly locked, so retry a
 * few times with backoff; on final failure remove the temp file and throw.
 */
export function saveDb(db: DbShape): void {
  const file = dataFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      renameImpl(tmp, file); // atomic replace so a crash never leaves a half-written DB
      return;
    } catch (e) {
      lastError = e;
      if (!isRetryable(e) || attempt === 6) break;
      sleepMs(50 * attempt);
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* best effort */
  }
  throw lastError;
}

/** Temp files left by an interrupted save. Callers must warn, never auto-apply. */
export function findOrphanedTempFiles(): string[] {
  const file = dataFilePath();
  const dir = dirname(file);
  const base = file.split(/[\\/]/).pop() ?? '';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.`) && name.endsWith('.tmp'))
    .map((name) => join(dir, name));
}

/**
 * Run in-memory mutations and persist them with a single write. If anything
 * fails (including the write itself), in-memory state is rolled back to the
 * snapshot taken beforehand, so callers never observe a partial change.
 */
export function mutateDb<T>(db: DbShape, fn: () => T): T {
  const snapshot = structuredClone(db);
  try {
    const result = fn();
    saveDb(db);
    return result;
  } catch (e) {
    for (const key of Object.keys(db)) delete (db as unknown as Record<string, unknown>)[key];
    Object.assign(db, snapshot);
    throw e;
  }
}

type HashableEvent = Omit<AuditEvent, 'hash'>;

function eventHash(e: HashableEvent): string {
  // v2: canonical JSON array — quoting/escaping makes the encoding unambiguous,
  // so no two different field sets share a hash input. Field order is frozen.
  if (e.hashVersion === 2) {
    return createHash('sha256')
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
  }
  // v1: frozen pipe-joined list so pre-F1 chains keep verifying. It keeps a
  // field-boundary ambiguity (a '|' inside a field), which disappears with the
  // planned demo-data reset that makes every event v2.
  const parts: Array<string | number> = [
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

export interface AuditInput {
  actorId: string;
  action: string;
  recordType: string;
  recordId: string;
  orgId: string;
  detail: string;
}

/** Build the next chained event for an existing audit trail (pure; no I/O). */
export function buildAuditEvent(audit: AuditEvent[], input: AuditInput): AuditEvent {
  const prevHash = audit.length > 0 ? audit[audit.length - 1].hash : 'GENESIS';
  const base: HashableEvent = {
    seq: audit.length + 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    prevHash,
    ...input,
    hashVersion: 2
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
//
// Appends in memory only; the caller must persist via mutateDb/saveDb so each
// state change and its audit event are written together, atomically.
// ---------------------------------------------------------------------------
export function appendAudit(db: DbShape, input: AuditInput): AuditEvent {
  const event = buildAuditEvent(db.audit, input);
  db.audit.push(event);
  return event;
}

/** Associate legacy audit events (saved before org tracking) with their org. */
export function backfillAuditOrgIds(db: DbShape): void {
  for (const e of db.audit) {
    if (e.orgId) continue;
    if (e.recordType === 'task') {
      e.orgId = db.tasks.find((t) => t.id === e.recordId)?.orgId ?? SYSTEM_AUDIT_ORG;
    } else if (e.recordType === 'template') {
      e.orgId = db.templates.find((t) => t.id === e.recordId)?.orgId ?? SYSTEM_AUDIT_ORG;
    } else {
      e.orgId = SYSTEM_AUDIT_ORG;
    }
  }
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
  return task;
}

/** D2: verified records are immutable. No reopen/amendment workflow exists yet. */
function assertNotLocked(task: ComplianceTask): void {
  if (task.status === 'verified') {
    throw new ValidationError('Verified records are locked.');
  }
}

export function updateTask(
  db: DbShape,
  id: string,
  patch: Partial<Pick<ComplianceTask, 'title' | 'ownerId' | 'dueDate' | 'status' | 'domainId'>>
): ComplianceTask {
  const task = db.tasks.find((t) => t.id === id);
  if (!task) throw new ValidationError('Task not found.');
  assertNotLocked(task);
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
  assertNotLocked(task);
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
  return ref;
}

export function transferCustody(
  db: DbShape,
  taskId: string,
  input: { evidenceId: string; toHolder: string }
): EvidenceRef {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) throw new ValidationError('Task not found.');
  assertNotLocked(task);
  const ref = task.evidence.find((e) => e.id === input.evidenceId);
  if (!ref) throw new ValidationError('Evidence item not found on this task.');
  if (!input.toHolder.trim()) throw new ValidationError('New holder is required.');
  if (ref.holder === input.toHolder.trim()) {
    throw new ValidationError('New holder must differ from the current holder.');
  }
  ref.holder = input.toHolder.trim();
  ref.updatedAt = new Date().toISOString();
  task.updatedAt = ref.updatedAt;
  return ref;
}

// ---------------------------------------------------------------------------
// Task templates
// ---------------------------------------------------------------------------

export interface TemplateInput {
  orgId: string;
  domainId: string;
  title: string;
  description: string;
  controlType: ControlType;
  regulatoryRefs: RegulatorySourceRef[];
  responsibleRoles: Role[];
  recurrence: { frequency: RecurrenceFrequency };
  evidenceRequired: EvidenceRequirement[];
  escalation: EscalationRule[];
}

const ROLES: Role[] = ['administrator', 'compliance_officer', 'department_manager', 'staff'];
const CONTROL_TYPES: ControlType[] = ['legally_required', 'best_practice'];
const FREQUENCIES: RecurrenceFrequency[] = ['once', 'weekly', 'monthly', 'quarterly', 'annually'];

function assertTemplateShape(input: TemplateInput): void {
  if (!input.title || !input.title.trim()) throw new ValidationError('Template title is required.');
  if (!CONTROL_TYPES.includes(input.controlType)) throw new ValidationError('Unknown control type.');
  if (!input.responsibleRoles || input.responsibleRoles.length === 0) {
    throw new ValidationError('At least one responsible role is required.');
  }
  for (const role of input.responsibleRoles) {
    if (!ROLES.includes(role)) throw new ValidationError(`Unknown role '${role}'.`);
  }
  if (!input.recurrence || !FREQUENCIES.includes(input.recurrence.frequency)) {
    throw new ValidationError('Unknown recurrence frequency.');
  }
  for (const ref of input.regulatoryRefs ?? []) {
    if (!ref.source?.trim() || !ref.citation?.trim()) {
      throw new ValidationError('Regulatory references need a source and a citation.');
    }
  }
  for (const req of input.evidenceRequired ?? []) {
    if (!req.label?.trim()) throw new ValidationError('Evidence requirements need a label.');
  }
  for (const rule of input.escalation ?? []) {
    if (!Number.isInteger(rule.afterDaysOverdue) || rule.afterDaysOverdue < 0) {
      throw new ValidationError('Escalation thresholds must be whole days >= 0.');
    }
    if (!ROLES.includes(rule.escalateTo)) {
      throw new ValidationError(`Unknown escalation role '${rule.escalateTo}'.`);
    }
  }
}

export function createTemplate(db: DbShape, input: TemplateInput): TaskTemplate {
  const org = db.orgs.find((o) => o.id === input.orgId);
  if (!org) throw new ValidationError('Unknown organization.');
  const domain = db.domains.find((d) => d.id === input.domainId && d.orgId === input.orgId);
  if (!domain) throw new ValidationError('Unknown regulatory domain for this organization.');
  if (!domain.active) throw new ValidationError('Regulatory domain is inactive.');
  assertTemplateShape(input);
  const now = new Date().toISOString();
  const template: TaskTemplate = {
    id: randomUUID(),
    orgId: input.orgId,
    domainId: input.domainId,
    title: input.title.trim(),
    description: (input.description ?? '').trim(),
    controlType: input.controlType,
    regulatoryRefs: input.regulatoryRefs ?? [],
    responsibleRoles: [...input.responsibleRoles],
    recurrence: { frequency: input.recurrence.frequency },
    evidenceRequired: input.evidenceRequired ?? [],
    escalation: input.escalation ?? [],
    active: true,
    createdAt: now,
    updatedAt: now
  };
  db.templates.push(template);
  return template;
}

export function updateTemplate(
  db: DbShape,
  id: string,
  patch: Partial<
    Pick<
      TaskTemplate,
      | 'title'
      | 'description'
      | 'controlType'
      | 'regulatoryRefs'
      | 'responsibleRoles'
      | 'recurrence'
      | 'evidenceRequired'
      | 'escalation'
      | 'active'
    >
  >
): TaskTemplate {
  const template = db.templates.find((t) => t.id === id);
  if (!template) throw new ValidationError('Template not found.');
  const merged: TemplateInput = {
    orgId: template.orgId,
    domainId: template.domainId,
    title: patch.title ?? template.title,
    description: patch.description ?? template.description,
    controlType: patch.controlType ?? template.controlType,
    regulatoryRefs: patch.regulatoryRefs ?? template.regulatoryRefs,
    responsibleRoles: patch.responsibleRoles ?? template.responsibleRoles,
    recurrence: patch.recurrence ?? template.recurrence,
    evidenceRequired: patch.evidenceRequired ?? template.evidenceRequired,
    escalation: patch.escalation ?? template.escalation
  };
  assertTemplateShape(merged);
  Object.assign(template, {
    title: merged.title.trim(),
    description: merged.description.trim(),
    controlType: merged.controlType,
    regulatoryRefs: merged.regulatoryRefs,
    responsibleRoles: merged.responsibleRoles,
    recurrence: merged.recurrence,
    evidenceRequired: merged.evidenceRequired,
    escalation: merged.escalation,
    active: patch.active ?? template.active,
    updatedAt: new Date().toISOString()
  });
  return template;
}

/** Instantiate a task from an active template. Default due date honors recurrence. */
export function instantiateTemplate(
  db: DbShape,
  templateId: string,
  input: { ownerId: string; dueDate?: string }
): ComplianceTask {
  const template = db.templates.find((t) => t.id === templateId);
  if (!template) throw new ValidationError('Template not found.');
  if (!template.active) throw new ValidationError('Template is inactive.');
  const today = new Date().toISOString().slice(0, 10);
  const plus30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const dueDate = input.dueDate ?? nextDueDate(today, template.recurrence.frequency) ?? plus30;
  const task = createTask(db, {
    orgId: template.orgId,
    domainId: template.domainId,
    title: template.title,
    ownerId: input.ownerId,
    dueDate
  });
  task.templateId = template.id;
  return task;
}
