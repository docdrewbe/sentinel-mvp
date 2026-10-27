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
  CapaRecord,
  CapaSeverity,
  CapaStatus,
  ComplianceTask,
  ControlType,
  DemoUser,
  EscalationRule,
  EvidenceRef,
  EvidenceRequirement,
  Organization,
  RecurrenceFrequency,
  RecurringObligation,
  RegulatoryDomain,
  RegulatorySourceRef,
  Role,
  TaskStatus,
  TaskTemplate
} from '../shared/types.js';
import { CAPA_CRITERIA_LOCKED_MESSAGE, SYSTEM_AUDIT_ORG, UNKNOWN_AUDIT_ORG } from '../shared/types.js';
import { requiredEvidenceCount } from '../shared/evidence.js';
import { CAPA_GATE_FIELD_LABELS, capaCriteriaLocked, capaGateMissing, capaRequiredFields } from '../shared/capa.js';
import { missingSubmissionHistory } from '../shared/verification.js';
import { addDaysISO, isValidIsoDate, isValidTimeZone, nextDueDate, nextOccurrence, orgToday, periodKeyFor } from '../shared/scheduling.js';

export interface DbShape {
  version: 1;
  orgs: Organization[];
  domains: RegulatoryDomain[];
  users: DemoUser[];
  tasks: ComplianceTask[];
  templates: TaskTemplate[];
  capas: CapaRecord[];
  obligations: RecurringObligation[];
  audit: AuditEvent[];
}

export class ValidationError extends Error {}

export function dataFilePath(): string {
  return process.env.SENTINEL_DATA_FILE ?? join(process.cwd(), 'data', 'sentinel.json');
}

export function emptyDb(): DbShape {
  return { version: 1, orgs: [], domains: [], users: [], tasks: [], templates: [], capas: [], obligations: [], audit: [] };
}

let lastStamp = '';

/**
 * Process-wide strictly increasing ISO timestamp for order-sensitive CAPA
 * records (review-cycle scoping compares evidence genesis against review
 * entry times, and fast consecutive requests can share a millisecond).
 */
export function monotonicNow(): string {
  const now = new Date().toISOString();
  if (now > lastStamp) {
    lastStamp = now;
    return now;
  }
  const bumped = new Date(Date.parse(lastStamp) + 1).toISOString();
  lastStamp = bumped;
  return bumped;
}

export function loadDb(): DbShape {
  const file = dataFilePath();
  if (!existsSync(file)) return emptyDb();
  // Tolerant read: databases written before templates existed gain defaults.
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DbShape>;
  const db: DbShape = { ...emptyDb(), ...raw };
  backfillAuditOrgIds(db);
  // CAL3: organizations stored before time zones keep the pre-CAL3
  // behavior by defaulting to UTC.
  for (const org of db.orgs) {
    if (!isValidTimeZone(org.timeZone)) org.timeZone = 'UTC';
  }
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

/** D5c: ids of submitted tasks with no trustworthy submission history. Read-only triage. */
export function findTasksMissingSubmissionHistory(db: DbShape): string[] {
  return db.tasks.filter(missingSubmissionHistory).map((t) => t.id);
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
  let seenV2 = false;
  for (const e of audit) {
    // Allow-list: absent (legacy v1) or exactly 2. Anything else fails here,
    // even if its hash was recomputed — the format itself is unauthorized.
    if ('hashVersion' in e && e.hashVersion !== 2) return { ok: false, badSeq: e.seq };
    // Monotonic: once v2 appears, every later event must be v2.
    if (seenV2 && e.hashVersion !== 2) return { ok: false, badSeq: e.seq };
    if (e.hashVersion === 2) seenV2 = true;
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

/**
 * Classify legacy audit events by re-deriving the org from the referenced
 * record — the stored v1 orgId is unhashed, so it is never trusted, whether
 * missing, wrong-but-valid, or forged. v2 orgIds are hash-protected and are
 * never rewritten here; mis-tagged v2 events are contained by the read-time
 * filter instead. Fail-closed: unresolvable records become 'unknown'.
 */
export function backfillAuditOrgIds(db: DbShape): void {
  for (const e of db.audit) {
    if (e.hashVersion === 2) continue;
    if (e.recordType === 'task') {
      e.orgId = db.tasks.find((t) => t.id === e.recordId)?.orgId ?? UNKNOWN_AUDIT_ORG;
    } else if (e.recordType === 'template') {
      e.orgId = db.templates.find((t) => t.id === e.recordId)?.orgId ?? UNKNOWN_AUDIT_ORG;
    } else if (e.recordType === 'capa') {
      e.orgId = db.capas.find((c) => c.id === e.recordId)?.orgId ?? UNKNOWN_AUDIT_ORG;
    } else if (e.recordType === 'database') {
      e.orgId = SYSTEM_AUDIT_ORG;
    } else {
      e.orgId = UNKNOWN_AUDIT_ORG;
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
  if (!isValidIsoDate(dueDate)) {
    throw new ValidationError('dueDate must be a real calendar date (YYYY-MM-DD).');
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

/** D4/D4b: explain what evidence a blocked submission or verification lacks. */
function evidenceBlockMessage(
  db: DbShape,
  task: ComplianceTask,
  required: number,
  action: 'Submission' | 'Verification'
): string {
  const template = task.templateId ? db.templates.find((t) => t.id === task.templateId) : undefined;
  const items = required === 1 ? '1 evidence item' : `${required} evidence items`;
  // Name the template only when its own list drives the count; the D4a floor
  // of 1 for empty templates is an MVP rule, not a template requirement.
  const source =
    template && template.evidenceRequired.length > 0
      ? ` (template '${template.title}' requires ${required})`
      : '';
  const have = action === 'Verification' ? ` (has ${task.evidence.length})` : '';
  return `${action} requires at least ${items}${have}${source}.`;
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
    if (
      (patch.status === 'submitted' && task.status !== 'submitted') ||
      (patch.status === 'verified' && task.status !== 'verified')
    ) {
      const required = requiredEvidenceCount(task, db.templates);
      if (task.evidence.length < required) {
        const action = patch.status === 'verified' ? 'Verification' : 'Submission';
        throw new ValidationError(evidenceBlockMessage(db, task, required, action));
      }
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
  input: { label: string; holder: string },
  byUserId: string
): EvidenceRef {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) throw new ValidationError('Task not found.');
  assertNotLocked(task);
  if (!input.label.trim()) throw new ValidationError('Evidence label is required.');
  if (!input.holder.trim()) throw new ValidationError('Evidence holder is required.');
  const now = new Date().toISOString();
  const ref: EvidenceRef = {
    id: randomUUID(),
    label: input.label.trim(),
    holder: input.holder.trim(),
    custody: [
      { seq: 1, fromHolder: null, toHolder: input.holder.trim(), byUserId, at: now }
    ],
    updatedAt: now
  };
  task.evidence.push(ref);
  task.updatedAt = ref.updatedAt;
  return ref;
}

export function transferCustody(
  db: DbShape,
  taskId: string,
  input: { evidenceId: string; toHolder: string; reason?: string },
  byUserId: string
): { ref: EvidenceRef; fromHolder: string } {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) throw new ValidationError('Task not found.');
  assertNotLocked(task);
  const ref = task.evidence.find((e) => e.id === input.evidenceId);
  if (!ref) throw new ValidationError('Evidence item not found on this task.');
  if (!input.toHolder.trim()) throw new ValidationError('New holder is required.');
  if (!ref.custody) ref.custody = [];
  // Capture the previous holder BEFORE mutating: the audit detail and the new
  // custody entry must record where the item came from, not where it went.
  const fromHolder = ref.holder;
  if (fromHolder === input.toHolder.trim()) {
    throw new ValidationError('New holder must differ from the current holder.');
  }
  const reason = input.reason?.trim() ? input.reason.trim() : undefined;
  ref.custody.push({
    seq: ref.custody.length + 1,
    fromHolder,
    toHolder: input.toHolder.trim(),
    byUserId,
    at: new Date().toISOString(),
    ...(reason ? { reason } : {})
  });
  ref.holder = input.toHolder.trim();
  ref.updatedAt = new Date().toISOString();
  task.updatedAt = ref.updatedAt;
  return { ref, fromHolder };
}

// ---------------------------------------------------------------------------
// CAPA records (first slice). Same safeguards as tasks: tenant checks at the
// API layer, strict status transitions, evidence with custody genesis, and
// locked records once closed. Closure independence is enforced in the PATCH
// route, which knows the acting user.
// ---------------------------------------------------------------------------

export interface CapaInput {
  orgId: string;
  domainId: string;
  taskId?: string;
  finding: string;
  severity: CapaSeverity;
  ownerId: string;
  dueDate: string;
  containment?: string;
  rootCause?: string;
  correctivePlan?: string;
  preventivePlan?: string;
  effectivenessCriteria?: string;
}

const CAPA_STATUSES: CapaStatus[] = [
  'open',
  'investigation',
  'action_in_progress',
  'effectiveness_review',
  'closed'
];

/** First-slice workflow: strict forward progression only. */
const CAPA_TRANSITIONS: Record<CapaStatus, CapaStatus[]> = {
  open: ['investigation'],
  investigation: ['action_in_progress'],
  action_in_progress: ['effectiveness_review'],
  effectiveness_review: ['closed'],
  closed: []
};

const CAPA_SEVERITIES: CapaSeverity[] = ['low', 'medium', 'high', 'critical'];

/**
 * C5: one source for transition legality. The PATCH route calls this before
 * the closure checks so an illegal jump reports the transition — never a
 * gate or independence error. Unknown statuses are left for updateCapa,
 * which still reports 'Unknown CAPA status.'
 */
export function assertLegalCapaTransition(from: CapaStatus, to: string): void {
  if (!CAPA_STATUSES.includes(to as CapaStatus)) return;
  if (!CAPA_TRANSITIONS[from].includes(to as CapaStatus)) {
    throw new ValidationError(`Illegal CAPA transition from '${from}' to '${to}'.`);
  }
}

function assertCapaNotLocked(capa: CapaRecord): void {
  if (capa.status === 'closed') {
    throw new ValidationError('Closed CAPA records are locked.');
  }
}

export function createCapa(db: DbShape, input: CapaInput): CapaRecord {
  const org = db.orgs.find((o) => o.id === input.orgId);
  if (!org) throw new ValidationError('Unknown organization.');
  const domain = db.domains.find((d) => d.id === input.domainId && d.orgId === input.orgId);
  if (!domain) throw new ValidationError('Unknown regulatory domain for this organization.');
  if (!domain.active) throw new ValidationError('Regulatory domain is inactive.');
  const owner = db.users.find((u) => u.id === input.ownerId && u.orgId === input.orgId);
  if (!owner) throw new ValidationError('Owner must be a user of the same organization.');
  if (!input.finding || !input.finding.trim()) throw new ValidationError('Finding description is required.');
  if (!CAPA_SEVERITIES.includes(input.severity)) throw new ValidationError('Unknown CAPA severity.');
  assertDueDate(input.dueDate);
  if (input.taskId !== undefined) {
    const task = db.tasks.find((t) => t.id === input.taskId && t.orgId === input.orgId);
    if (!task) throw new ValidationError('Linked task must exist in the same organization.');
  }
  const now = new Date().toISOString();
  const trim = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t ? t : undefined;
  };
  const capa: CapaRecord = {
    id: randomUUID(),
    orgId: input.orgId,
    domainId: input.domainId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    finding: input.finding.trim(),
    severity: input.severity,
    ...(trim(input.containment) ? { containment: trim(input.containment) as string } : {}),
    ...(trim(input.rootCause) ? { rootCause: trim(input.rootCause) as string } : {}),
    ownerId: input.ownerId,
    dueDate: input.dueDate,
    ...(trim(input.correctivePlan) ? { correctivePlan: trim(input.correctivePlan) as string } : {}),
    ...(trim(input.preventivePlan) ? { preventivePlan: trim(input.preventivePlan) as string } : {}),
    ...(trim(input.effectivenessCriteria)
      ? { effectivenessCriteria: trim(input.effectivenessCriteria) as string }
      : {}),
    status: 'open',
    evidence: [],
    createdAt: now,
    updatedAt: now
  };
  db.capas.push(capa);
  return capa;
}

export function updateCapa(
  db: DbShape,
  id: string,
  patch: Partial<
    Pick<
      CapaRecord,
      | 'finding'
      | 'severity'
      | 'containment'
      | 'rootCause'
      | 'ownerId'
      | 'dueDate'
      | 'domainId'
      | 'correctivePlan'
      | 'preventivePlan'
      | 'effectivenessCriteria'
      | 'status'
    >
  >
): CapaRecord {
  const capa = db.capas.find((c) => c.id === id);
  if (!capa) throw new ValidationError('CAPA not found.');
  assertCapaNotLocked(capa);
  // P1: a criteria change during review is rejected before any other field
  // in the same request is applied, so combined requests change nothing.
  // (Non-string input falls through to the field handlers below, which P2
  // turns into field-specific 400s.)
  if (
    typeof patch.effectivenessCriteria === 'string' &&
    capaCriteriaLocked(capa.status) &&
    patch.effectivenessCriteria.trim() !== (capa.effectivenessCriteria ?? '')
  ) {
    throw new ValidationError(CAPA_CRITERIA_LOCKED_MESSAGE);
  }
  if (patch.finding !== undefined) {
    if (!patch.finding.trim()) throw new ValidationError('Finding description is required.');
    capa.finding = patch.finding.trim();
  }
  if (patch.severity !== undefined) {
    if (!CAPA_SEVERITIES.includes(patch.severity)) throw new ValidationError('Unknown CAPA severity.');
    capa.severity = patch.severity;
  }
  // C2: effectivenessDecision is set only by the review endpoint; PATCH
  // input carrying it is ignored (it is not in the patch type at all).
  for (const field of ['containment', 'rootCause', 'correctivePlan', 'preventivePlan', 'effectivenessCriteria'] as const) {
    if (patch[field] !== undefined) {
      const text = patch[field]?.trim() ?? '';
      if (!text && (capaRequiredFields(capa.status) as string[]).includes(field)) {
        throw new ValidationError(
          `${CAPA_GATE_FIELD_LABELS[field as keyof typeof CAPA_GATE_FIELD_LABELS]} is required at this stage and cannot be removed.`
        );
      }
      if (text) capa[field] = text;
      else delete capa[field];
    }
  }
  if (patch.ownerId !== undefined) {
    const owner = db.users.find((u) => u.id === patch.ownerId && u.orgId === capa.orgId);
    if (!owner) throw new ValidationError('Owner must be a user of the same organization.');
    capa.ownerId = patch.ownerId;
  }
  if (patch.dueDate !== undefined) {
    assertDueDate(patch.dueDate);
    capa.dueDate = patch.dueDate;
  }
  if (patch.domainId !== undefined) {
    const domain = db.domains.find((d) => d.id === patch.domainId && d.orgId === capa.orgId);
    if (!domain) throw new ValidationError('Unknown regulatory domain for this organization.');
    capa.domainId = patch.domainId;
  }
  if (patch.status !== undefined) {
    if (!CAPA_STATUSES.includes(patch.status)) throw new ValidationError('Unknown CAPA status.');
    if (patch.status !== capa.status) {
      assertLegalCapaTransition(capa.status, patch.status);
      // C1: phase gates run against the record as patched (fields apply
      // first), so one request can document a field and advance on it.
      const missing = capaGateMissing(capa, patch.status);
      if (missing.length > 0) throw new ValidationError(missing.join(' '));
    }
    capa.status = patch.status;
  }
  capa.updatedAt = new Date().toISOString();
  return capa;
}

export function capaAddEvidence(
  db: DbShape,
  capaId: string,
  input: { label: string; holder: string; kind?: 'implementation' | 'effectiveness' },
  byUserId: string
): EvidenceRef {
  const capa = db.capas.find((c) => c.id === capaId);
  if (!capa) throw new ValidationError('CAPA not found.');
  assertCapaNotLocked(capa);
  if (!input.label.trim()) throw new ValidationError('Evidence label is required.');
  if (!input.holder.trim()) throw new ValidationError('Evidence holder is required.');
  if (input.kind !== undefined && input.kind !== 'implementation' && input.kind !== 'effectiveness') {
    throw new ValidationError('Unknown evidence kind.');
  }
  const now = monotonicNow();
  const ref: EvidenceRef = {
    id: randomUUID(),
    label: input.label.trim(),
    holder: input.holder.trim(),
    custody: [
      { seq: 1, fromHolder: null, toHolder: input.holder.trim(), byUserId, at: now }
    ],
    updatedAt: now,
    kind: input.kind ?? 'implementation'
  };
  capa.evidence.push(ref);
  capa.updatedAt = ref.updatedAt;
  return ref;
}

export function capaTransferCustody(
  db: DbShape,
  capaId: string,
  input: { evidenceId: string; toHolder: string; reason?: string },
  byUserId: string
): { ref: EvidenceRef; fromHolder: string } {
  const capa = db.capas.find((c) => c.id === capaId);
  if (!capa) throw new ValidationError('CAPA not found.');
  assertCapaNotLocked(capa);
  const ref = capa.evidence.find((e) => e.id === input.evidenceId);
  if (!ref) throw new ValidationError('Evidence not found.');
  const toHolder = input.toHolder.trim();
  if (!toHolder) throw new ValidationError('New holder is required.');
  if (toHolder === ref.holder) {
    throw new ValidationError('Evidence is already held by this holder.');
  }
  const fromHolder = ref.holder;
  ref.custody.push({
    seq: ref.custody.length + 1,
    fromHolder,
    toHolder,
    byUserId,
    at: monotonicNow(),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {})
  });
  ref.holder = toHolder;
  ref.updatedAt = new Date().toISOString();
  capa.updatedAt = ref.updatedAt;
  return { ref, fromHolder };
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
  // CAL3: default dues are org-local civil dates, never UTC slices.
  const zone = db.orgs.find((o) => o.id === template.orgId)?.timeZone ?? 'UTC';
  const today = orgToday(zone);
  const plus30 = addDaysISO(today, 30) ?? today;
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

// ---------------------------------------------------------------------------
// Recurring obligations. A template's cadence bound to an
// organization-selected target date. Frequency, regulatory source, and
// control classification resolve from the linked template; the obligation
// owns only the schedule state.
// ---------------------------------------------------------------------------

export interface ObligationInput {
  orgId: string;
  templateId: string;
  nextDueDate: string;
  assigneeId?: string;
}

export function createObligation(db: DbShape, input: ObligationInput): RecurringObligation {
  const org = db.orgs.find((o) => o.id === input.orgId);
  if (!org) throw new ValidationError('Unknown organization.');
  const template = db.templates.find((t) => t.id === input.templateId);
  if (!template) throw new ValidationError('Template not found.');
  if (template.orgId !== input.orgId) {
    throw new ValidationError('Template must belong to the obligation organization.');
  }
  if (!template.active) throw new ValidationError('Template is inactive.');
  assertDueDate(input.nextDueDate);
  if (input.assigneeId !== undefined && input.assigneeId !== '') {
    const assignee = db.users.find((u) => u.id === input.assigneeId && u.orgId === input.orgId);
    if (!assignee) throw new ValidationError('Assignee must be a user of the same organization.');
  }
  const now = new Date().toISOString();
  const obligation: RecurringObligation = {
    id: randomUUID(),
    orgId: input.orgId,
    templateId: template.id,
    nextDueDate: input.nextDueDate,
    anchorDay: Number(input.nextDueDate.slice(8, 10)),
    ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
    active: true,
    generatedPeriods: [],
    createdAt: now,
    updatedAt: now
  };
  db.obligations.push(obligation);
  return obligation;
}

/**
 * CAL2: true when `period` already has an instance for this obligation,
 * checking both the obligation's own history and task records. Pre-CAL2
 * exact-date entries normalize through the template's current frequency,
 * so legacy periods stay taken.
 */
function periodTaken(
  db: DbShape,
  obligation: RecurringObligation,
  frequency: RecurrenceFrequency,
  period: string
): boolean {
  if (obligation.generatedPeriods.includes(period)) return true;
  for (const entry of obligation.generatedPeriods) {
    if (periodKeyFor(entry, frequency) === period) return true;
  }
  return db.tasks.some((t) => {
    if (t.obligationId !== obligation.id || t.periodKey === undefined) return false;
    return t.periodKey === period || periodKeyFor(t.periodKey, frequency) === period;
  });
}

export function updateObligation(
  db: DbShape,
  id: string,
  patch: Partial<Pick<RecurringObligation, 'nextDueDate' | 'assigneeId' | 'active'>>
): RecurringObligation {
  const obligation = db.obligations.find((o) => o.id === id);
  if (!obligation) throw new ValidationError('Obligation not found.');
  if (patch.nextDueDate !== undefined) {
    assertDueDate(patch.nextDueDate);
    // CAL2: a target may move within an ungenerated period or forward, but
    // never into a period that already has an instance.
    const template = db.templates.find((t) => t.id === obligation.templateId);
    const period = template ? periodKeyFor(patch.nextDueDate, template.recurrence.frequency) : null;
    if (template && period && periodTaken(db, obligation, template.recurrence.frequency, period)) {
      throw new ValidationError(`An instance for ${period} already exists.`);
    }
    obligation.nextDueDate = patch.nextDueDate;
    // A manually reset target re-anchors the schedule to its day-of-month.
    obligation.anchorDay = Number(patch.nextDueDate.slice(8, 10));
  }
  if (patch.assigneeId !== undefined) {
    if (patch.assigneeId === '') {
      delete obligation.assigneeId;
    } else {
      const assignee = db.users.find((u) => u.id === patch.assigneeId && u.orgId === obligation.orgId);
      if (!assignee) throw new ValidationError('Assignee must be a user of the same organization.');
      obligation.assigneeId = patch.assigneeId;
    }
  }
  if (patch.active !== undefined) {
    obligation.active = patch.active;
  }
  obligation.updatedAt = new Date().toISOString();
  return obligation;
}

/**
 * Generate the next task instance for an obligation: one task due on the
 * current target date, then advance the target deterministically. Refuses
 * duplicates for an already-generated recurrence period (CAL2), inactive
 * obligations, and generation without a responsible owner. Instances are
 * ordinary tasks, so evidence, verification, and separation-of-duties
 * gates apply.
 *
 * Frequency changes: the period definition follows the template at
 * generation time, while each stored periodKey keeps the form computed
 * under its own frequency — so a mid-stream frequency change can neither
 * false-positive on old keys nor silently merge distinct periods.
 */
export function generateObligationInstance(
  db: DbShape,
  obligationId: string,
  byUserId: string
): { task: ComplianceTask; obligation: RecurringObligation } {
  const obligation = db.obligations.find((o) => o.id === obligationId);
  if (!obligation) throw new ValidationError('Obligation not found.');
  if (!obligation.active) throw new ValidationError('Obligation is inactive.');
  const template = db.templates.find((t) => t.id === obligation.templateId);
  if (!template) throw new ValidationError('Template not found.');
  if (!template.active) throw new ValidationError('Template is inactive.');
  const dueDate = obligation.nextDueDate;
  // CAL1: a legacy unparsable target fails loudly — never a bad-dated task,
  // and never a silent deactivation.
  const periodKey = periodKeyFor(dueDate, template.recurrence.frequency);
  if (!isValidIsoDate(dueDate) || !periodKey) {
    throw new ValidationError('Obligation target date is not a real calendar date.');
  }
  if (periodTaken(db, obligation, template.recurrence.frequency, periodKey)) {
    throw new ValidationError('An instance for this obligation and due period already exists.');
  }
  const caller = db.users.find((u) => u.id === byUserId);
  const ownerId =
    obligation.assigneeId ?? (caller && caller.orgId === obligation.orgId ? caller.id : undefined);
  if (!ownerId) throw new ValidationError('Assign a responsible person before generating.');
  const task = createTask(db, {
    orgId: obligation.orgId,
    domainId: template.domainId,
    title: template.title,
    ownerId,
    dueDate
  });
  task.templateId = template.id;
  task.obligationId = obligation.id;
  task.periodKey = periodKey;
  const next = nextOccurrence(dueDate, template.recurrence.frequency, obligation.anchorDay);
  if (next === null) {
    obligation.active = false;
  } else {
    obligation.nextDueDate = next;
  }
  obligation.generatedPeriods = [...obligation.generatedPeriods, periodKey];
  obligation.updatedAt = new Date().toISOString();
  return { task, obligation };
}
