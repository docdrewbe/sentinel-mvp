// Pure dashboard helpers: org visibility/switching and resilient panel loads.
// Kept free of React so the rules are unit-testable without a DOM.
import { can, visibleOrgIds, type Action } from '../shared/rbac.js';
import { addDaysISO, isValidIsoDate } from '../shared/scheduling.js';
import type { DocAuditFinding, DocAuditFollowupPayload, DocAuditPassage } from './api.js';
import { CAPA_CLOSE_SOD_MESSAGE, CAPA_NO_ELIGIBLE_REVIEWER_MESSAGE, CAPA_STATUS_LABELS, NO_ELIGIBLE_VERIFIER_MESSAGE, SEPARATION_OF_DUTIES_MESSAGE, SUBMITTER_UNKNOWN_MESSAGE } from '../shared/types.js';
import { capaGateMissing, capaNoEligibleReviewer, capaReviewIneligible, qualifyingEffectivenessEvidence } from '../shared/capa.js';
import { ineligibleVerifiers, missingSubmissionHistory, noEligibleVerifier } from '../shared/verification.js';
import type {
  AuditEvent,
  CapaRecord,
  CapaStatus,
  ComplianceTask,
  DemoUser,
  EvidenceRef,
  MyUpdateEntry,
  Organization,
  RecurringObligation,
  RegulatoryDomain,
  TaskTemplate
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// F3a: context-keyed panel state. Every response is tied to the user+org that
// requested it (and to a request sequence), so delayed or out-of-order
// responses can never paint another context's data.
// ---------------------------------------------------------------------------

export type PanelStatus = 'loading' | 'loaded' | 'error';

export interface PanelState<T> {
  key: string;
  status: PanelStatus;
  data: T[];
  error?: string;
}

export interface Panels {
  tasks: PanelState<ComplianceTask>;
  domains: PanelState<RegulatoryDomain>;
  audit: PanelState<AuditEvent>;
  templates: PanelState<TaskTemplate>;
  capas: PanelState<CapaRecord>;
  obligations: PanelState<RecurringObligation>;
}

export type PanelName = keyof Panels;

export function initialPanels(): Panels {
  const fresh = <T,>(): PanelState<T> => ({ key: '', status: 'loading', data: [] });
  return { tasks: fresh(), domains: fresh(), audit: fresh(), templates: fresh(), capas: fresh(), obligations: fresh() };
}

/** On a context change, synchronously clear every panel; same key → unchanged. */
export function beginContext(prevKey: string, nextKey: string, panels: Panels): Panels {
  if (prevKey === nextKey) return panels;
  const fresh = <T,>(): PanelState<T> => ({ key: nextKey, status: 'loading', data: [] });
  return { tasks: fresh(), domains: fresh(), audit: fresh(), templates: fresh(), capas: fresh(), obligations: fresh() };
}

function nextPanel<T>(
  prior: PanelState<T>,
  key: string,
  value: T[] | undefined,
  error: string | undefined
): PanelState<T> {
  if (value !== undefined) return { key, status: 'loaded', data: value };
  // Rejected: keep prior rows only when they belong to this same context and
  // were successfully loaded (same-context refresh/retry). After a context
  // change the panel is loading/empty, so failures stay empty — never stale.
  if (prior.key === key && prior.status === 'loaded') {
    return { key, status: 'loaded', data: prior.data, error };
  }
  return { key, status: 'error', data: [], error };
}

/**
 * Apply settled results only when they belong to the current context AND the
 * latest request. Stale contexts and out-of-order responses are discarded.
 */
export function applySettled(
  panels: Panels,
  key: string,
  seq: number,
  currentKey: string,
  currentSeq: number,
  tasks: PromiseSettledResult<ComplianceTask[]>,
  domains: PromiseSettledResult<RegulatoryDomain[]>,
  audit: PromiseSettledResult<AuditEvent[]>,
  templates: PromiseSettledResult<TaskTemplate[]>,
  capas: PromiseSettledResult<CapaRecord[]>,
  obligations: PromiseSettledResult<RecurringObligation[]>
): Panels {
  if (key !== currentKey || seq !== currentSeq) return panels;
  const { values, errors } = settlePanels(tasks, domains, audit, templates, capas, obligations);
  return {
    tasks: nextPanel(panels.tasks, key, values.tasks, errors.tasks),
    domains: nextPanel(panels.domains, key, values.domains, errors.domains),
    audit: nextPanel(panels.audit, key, values.audit, errors.audit),
    templates: nextPanel(panels.templates, key, values.templates, errors.templates),
    capas: nextPanel(panels.capas, key, values.capas, errors.capas),
    obligations: nextPanel(panels.obligations, key, values.obligations, errors.obligations)
  };
}

/** Rows render only for loaded panels of the current context. */
export function panelData<T>(panel: PanelState<T>, currentKey: string): T[] {
  return panel.key === currentKey && panel.status === 'loaded' ? panel.data : [];
}

/** Actions are allowed only on freshly loaded data for the current context. */
export function canAct<T>(panel: PanelState<T>, currentKey: string): boolean {
  return panel.key === currentKey && panel.status === 'loaded' && !panel.error;
}

/**
 * Slice-1 concerns ride outside the fixed Panels shape (whose arity existing
 * tests pin): settle one context-keyed panel with the same staleness rules
 * as applySettled — a wrong context or superseded request leaves the
 * previous state untouched.
 */
export function applyOneSettled<T>(
  prev: PanelState<T>,
  key: string,
  seq: number,
  currentKey: string,
  currentSeq: number,
  settled: PromiseSettledResult<T[]>
): PanelState<T> {
  if (key !== currentKey || seq !== currentSeq) return prev;
  if (settled.status === 'fulfilled') return { key, status: 'loaded', data: settled.value };
  return nextPanel(prev, key, undefined, reasonMessage(settled.reason));
}

/** Users eligible for concern assignment in an org (the server re-checks). */
export function triageUsersFor(users: DemoUser[], orgId: string): DemoUser[] {
  return users.filter(
    (u) =>
      u.role === 'administrator' ||
      u.role === 'compliance_officer' ||
      (u.role === 'department_manager' && u.orgId === orgId)
  );
}

/** Which concern detail rendering owns a focus target. */
export type ConcernDetailView = 'mine' | 'queue';

/**
 * Focus-target id for one public update item, scoped to its view so the
 * same concern rendered in both reporter and triage detail never shares
 * an id. One detail renders per view at a time, so the update sequence
 * alone is unique within a scope.
 */
export function concernUpdateDomId(view: ConcernDetailView, seq: number): string {
  return `concern-update-${view}-${seq}`;
}

/**
 * Focus-target id for one record-history row, scoped to its detail panel.
 * Audit sequences are globally unique, but the same event can render in
 * two concern views at once, so the scope keeps every id unique.
 */
export function auditEventDomId(view: ConcernDetailView | 'task', seq: number): string {
  return `audit-event-${view}-${seq}`;
}

/**
 * Focus-target id for one concern Status history entry, scoped to its
 * view. Used when the matching audit event is outside the loaded audit
 * window: status history is a complete record field, not a window.
 */
export function concernStatusDomId(view: ConcernDetailView, index: number): string {
  return `concern-status-${view}-${index}`;
}

/** Shown when navigation lands on a heading because the exact target is unavailable. */
export const UPDATE_OUTSIDE_HISTORY_NOTICE =
  'This update is outside the currently loaded record history.';

/**
 * Whether a navigation landing deserves the outside-history notice: only
 * when an exact candidate existed but the heading was the best available
 * target. Exact landings and total misses stay silent.
 */
export function navFallbackNotice(matchedId: string | null, focusIds: string[]): string | null {
  if (matchedId === null) return null;
  if (focusIds.length > 1 && matchedId === focusIds[focusIds.length - 1]) {
    return UPDATE_OUTSIDE_HISTORY_NOTICE;
  }
  return null;
}

/** Ordered focus candidates for a feed entry (exact target first). */
export interface UpdateNavTarget {
  recordKind: 'task' | 'concern';
  recordId: string;
  focusIds: string[];
}

/**
 * Navigation target for a feed entry: the record to select plus ordered
 * focus candidates — the exact update item when validated, then the
 * visible record-history event, then the matching Status history entry
 * for concern transitions (complete record data, usable past the audit
 * window), then the detail heading. A user's own concern always resolves
 * to reporter-facing targets in My reports, never depending on which
 * duplicate appears first. Callers try each in turn and open nothing
 * else when all are missing.
 */
export function updateNavTarget(entry: {
  recordKind: 'task' | 'concern';
  recordId: string;
  seq: number;
  updateSeq?: number;
  statusIndex?: number;
}): UpdateNavTarget {
  const focusIds: string[] = [];
  if (entry.recordKind === 'concern') {
    if (entry.updateSeq !== undefined) focusIds.push(concernUpdateDomId('mine', entry.updateSeq));
    focusIds.push(auditEventDomId('mine', entry.seq));
    if (entry.statusIndex !== undefined) focusIds.push(concernStatusDomId('mine', entry.statusIndex));
    focusIds.push('my-concern-detail-heading');
  } else {
    focusIds.push(auditEventDomId('task', entry.seq));
    focusIds.push('task-detail-heading');
  }
  return { recordKind: entry.recordKind, recordId: entry.recordId, focusIds };
}

/** Rendered state of the updates panel for one context key. */
export type UpdatesViewState = 'loading' | 'error' | 'stale' | 'empty' | 'empty-stale' | 'list';

/**
 * Which updates-panel body to render. Only a failed status (an initial
 * failure with no successful result) renders the error state; a loaded
 * panel with a refresh error keeps showing its retained entries while
 * PanelNotice carries the stale warning. O-1: a retained EMPTY result
 * under a failed refresh renders 'empty-stale' with qualified wording —
 * 'empty' ("No updates yet.") is reserved for a current successful empty
 * response. 'empty' still requires the current context.
 */
export function updatesViewState(
  panel: PanelState<MyUpdateEntry>,
  currentKey: string
): UpdatesViewState {
  if (panel.key !== currentKey) return 'stale';
  if (panel.status === 'loading') return 'loading';
  if (panel.status === 'error') return 'error';
  if (panel.data.length > 0) return 'list';
  return panel.error ? 'empty-stale' : 'empty';
}

/**
 * F-2: feed-only settle. A failed refresh after a successful load in the
 * SAME context keeps the last entries (or the last empty result) with a
 * stale marker, so the panel shows them under an explicit warning with
 * Retry. An initial failure carries no entries and renders the error
 * state. Context changes and late responses behave exactly like
 * applyOneSettled: the previous state is left untouched, so another
 * context's entries are never retained. A success replaces everything
 * and clears the marker.
 */
export function applyFeedSettled<T>(
  prev: PanelState<T>,
  key: string,
  seq: number,
  currentKey: string,
  currentSeq: number,
  settled: PromiseSettledResult<T[]>
): PanelState<T> {
  if (key !== currentKey || seq !== currentSeq) return prev;
  if (settled.status === 'fulfilled') return { key, status: 'loaded', data: settled.value };
  if (prev.key === key && prev.status === 'loaded') {
    return { key, status: 'loaded', data: prev.data, error: reasonMessage(settled.reason) };
  }
  return { key, status: 'error', data: [], error: reasonMessage(settled.reason) };
}

/**
 * Short display form for record ids: readable seed ids stay whole, long
 * generated ids truncate. Single rule for every concern-view id rendering.
 */
export function shortDisplayId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…` : id;
}

/**
 * F-1: concern linked-CAPA display line from the server summary only — the
 * concern view never searches full CAPA records for status. An unresolvable
 * link reports honestly instead of inventing a status.
 */
export function linkedCapaLine(concern: {
  capaId?: string;
  linkedCapa?: { id: string; status: CapaStatus };
}): string {
  if (!concern.capaId) return 'None';
  const short = shortDisplayId(concern.capaId);
  if (!concern.linkedCapa || concern.linkedCapa.id !== concern.capaId) {
    return `${short} (status unavailable)`;
  }
  return `${short} (${CAPA_STATUS_LABELS[concern.linkedCapa.status]})`;
}

/**
 * D4c: authoritative evidence requirement for a task. Uses only the
 * server-computed `task.requiredEvidence`; returns null when absent (older
 * server) so the UI reports "unavailable" instead of guessing from a
 * possibly unloaded templates panel.
 */
export function requiredEvidenceFor(task: Pick<ComplianceTask, 'requiredEvidence'>): number | null {
  return typeof task.requiredEvidence === 'number' ? task.requiredEvidence : null;
}

/**
 * D4d: Submit block reason with correct singular/plural, e.g.
 * "Add 1 more evidence item (1 required, 0 attached)". Null when the
 * requirement is met or unknown (server decides); never carries a
 * "Requires: " prefix — callers must not add one.
 */
/**
 * Action-button state reasons. Each returns null when the task status allows
 * the action; role, evidence and separation-of-duties checks layer on top.
 * The server remains authoritative — these only keep the dashboard honest.
 */

/** Start moves a task to in_progress: legal from open, or as a send-back from submitted. */
export function startBlockReason(task: Pick<ComplianceTask, 'status'>): string | null {
  switch (task.status) {
    case 'open':
    case 'submitted':
      return null;
    case 'in_progress':
      return 'Already in progress.';
    case 'verified':
      return 'Verified records are locked.';
  }
}

/** Status half of the Submit gate; the evidence half stays in submitBlockReason. */
export function submitStatusReason(task: Pick<ComplianceTask, 'status'>): string | null {
  switch (task.status) {
    case 'open':
    case 'in_progress':
      return null;
    case 'submitted':
      return 'Already submitted.';
    case 'verified':
      return 'Verified records are locked.';
  }
}

/** Status half of the Verify gate; SoD and evidence reasons layer on top. */
export function verifyStatusReason(task: Pick<ComplianceTask, 'status'>): string | null {
  switch (task.status) {
    case 'submitted':
      return null;
    case 'verified':
      return 'Already verified.';
    case 'open':
    case 'in_progress':
      return 'Only submitted tasks can be verified.';
  }
}

/** Reopen moves a task to open: legal from in_progress and submitted. */
export function reopenBlockReason(task: Pick<ComplianceTask, 'status'>): string | null {
  switch (task.status) {
    case 'in_progress':
    case 'submitted':
      return null;
    case 'open':
      return 'Already open.';
    case 'verified':
      return 'Verified records are locked.';
  }
}

/**
 * M-UI1: evidence-action lock reason for the task detail panel. Verified
 * records accept no new evidence or custody transfers (the server refuses
 * both); the dashboard disables those forms with this exact message.
 * Mirrors the other status-gate reasons; the server still decides.
 */
export function evidenceLockedReason(task: Pick<ComplianceTask, 'status'>): string | null {
  return task.status === 'verified' ? 'Verified records are locked.' : null;
}

/**
 * M-UI1 accessibility: id of the visible verified-lock explanation in the
 * task detail panel. Locked evidence, custody, and workflow controls point
 * at it with `aria-describedby`; null for every other status so no dangling
 * reference is ever rendered. Disabled controls stay outside the Tab order.
 * M-A11Y1 (keyboard opening of task/CAPA rows) is tracked separately.
 */
export function verifiedLockNoteId(task: Pick<ComplianceTask, 'id' | 'status'>): string | null {
  return task.status === 'verified' ? `verified-lock-${task.id}` : null;
}

/** Evidence shortfall for verification, mirroring the D4b server gate. Only submitted tasks are verifiable; unknown requirements defer to the server. */
export function verifyEvidenceReason(
  task: Pick<ComplianceTask, 'requiredEvidence' | 'status'> & { evidence: readonly unknown[] }
): string | null {
  if (task.status !== 'submitted') return null;
  const required = requiredEvidenceFor(task);
  if (required === null) return null;
  const short = required - task.evidence.length;
  if (short <= 0) return null;
  const item = short === 1 ? 'item' : 'items';
  return `Needs ${short} more evidence ${item} before verification (${required} required, ${task.evidence.length} attached)`;
}

export function submitBlockReason(
  task: Pick<ComplianceTask, 'requiredEvidence'> & { evidence: readonly unknown[] }
): string | null {
  const required = requiredEvidenceFor(task);
  if (required === null) return null;
  const short = required - task.evidence.length;
  if (short <= 0) return null;
  const item = short === 1 ? 'item' : 'items';
  return `Add ${short} more evidence ${item} (${required} required, ${task.evidence.length} attached)`;
}

/**
 * D5/D5a/D5b: separation-of-duties reason when `me` must not verify `task`.
 * Eligibility comes from the full submission/ownership history. Only
 * submitted tasks are verifiable, so anything else returns null. When the
 * privileged roster is supplied and nobody on it is eligible, reports the
 * deadlock instead. Submitted tasks with no recorded submission fail
 * closed. Mirrors the server message; the server still decides.
 */
export function verifyBlockReason(
  me: Pick<DemoUser, 'id'>,
  task: Pick<ComplianceTask, 'ownerId' | 'submittedBy' | 'submissions' | 'ownersWhileSubmitted' | 'status'>,
  privilegedUserIds: string[] = []
): string | null {
  if (task.status !== 'submitted') return null;
  if (missingSubmissionHistory(task)) return SUBMITTER_UNKNOWN_MESSAGE;
  if (ineligibleVerifiers(task).includes(me.id)) {
    return noEligibleVerifier(task, privilegedUserIds)
      ? NO_ELIGIBLE_VERIFIER_MESSAGE
      : SEPARATION_OF_DUTIES_MESSAGE;
  }
  return null;
}

/** C5: the one legal forward step from each non-terminal CAPA status. */
export const CAPA_NEXT: Record<Exclude<CapaStatus, 'closed'>, CapaStatus> = {
  open: 'investigation',
  investigation: 'action_in_progress',
  action_in_progress: 'effectiveness_review',
  effectiveness_review: 'closed'
};

/**
 * C5: CAPA advance gate for the dashboard. Mirrors the PATCH route order:
 * role authority first (requesting effectiveness review needs
 * capa.review.request, which owner-staff never hold), then the shared C1/C2
 * gate list verbatim. Closed CAPAs are locked; effectiveness review has its
 * own review form. Mirrors the server; the server still decides.
 */
export function capaAdvanceBlockReason(
  me: DemoUser,
  capa: CapaRecord
): string | null {
  if (capa.status === 'closed') return 'Closed CAPA records are locked.';
  if (capa.status === 'effectiveness_review') return 'Close via an effectiveness review.';
  const next = CAPA_NEXT[capa.status];
  const action: Action = next === 'effectiveness_review' ? 'capa.review.request' : 'capa.update';
  if (!can(me, action, capa)) {
    return next === 'effectiveness_review'
      ? 'Requires: manager / compliance officer / admin'
      : 'Requires: owner / manager / officer / admin';
  }
  const missing = capaGateMissing(capa, next);
  if (missing.length > 0) return missing.join(' ');
  return null;
}

/**
 * C2/C3: CAPA review gate for the dashboard. Effectiveness review only, a
 * reviewer outside the involvement record, and at least one current-cycle
 * effectiveness evidence item. When the privileged roster is supplied and
 * nobody on it is eligible, reports the deadlock instead. Outcome,
 * rationale, and the evidence selection are form state, checked by the
 * component. Mirrors the server; the server still decides.
 */
export function capaReviewBlockReason(
  me: Pick<DemoUser, 'id'>,
  capa: Pick<
    CapaRecord,
    'ownerId' | 'createdBy' | 'ownerHistory' | 'actionsBy' | 'status' | 'evidence' | 'statusHistory'
  >,
  privilegedUserIds: string[] = []
): string | null {
  if (capa.status !== 'effectiveness_review') {
    return 'Only CAPAs in effectiveness review can be reviewed.';
  }
  if (capaReviewIneligible(capa).includes(me.id)) {
    return capaNoEligibleReviewer(capa, privilegedUserIds)
      ? CAPA_NO_ELIGIBLE_REVIEWER_MESSAGE
      : CAPA_CLOSE_SOD_MESSAGE;
  }
  if (qualifyingEffectivenessEvidence(capa).length < 1) {
    return 'At least 1 current-cycle effectiveness evidence item is required to review.';
  }
  return null;
}

/**
 * Polish: review history names each supporting evidence item (falling back
 * to the id when the item is gone) instead of showing only a count. Labels
 * come from the already tenant-scoped record, so no new data is exposed.
 */
export function reviewEvidenceLabels(
  evidence: Pick<EvidenceRef, 'id' | 'label'>[],
  evidenceIds: string[]
): string[] {
  const label = new Map(evidence.map((e) => [e.id, e.label]));
  return evidenceIds.map((id) => label.get(id) ?? id);
}

/** Calendar timeline buckets (slice 1 list view). */
export type CalendarBucket = 'overdue' | 'dueSoon' | 'upcoming' | 'submitted' | 'verified';

/**
 * Bucket a task for the compliance calendar as of an org-local `today`
 * (YYYY-MM-DD): verified and submitted (completed, awaiting verification)
 * first, then overdue, due-within-7-days, and future upcoming work.
 */
export function calendarBucket(
  task: Pick<ComplianceTask, 'dueDate' | 'status'>,
  todayISODate: string
): CalendarBucket {
  if (task.status === 'verified') return 'verified';
  if (task.status === 'submitted') return 'submitted';
  if (task.dueDate < todayISODate) return 'overdue';
  const edge = addDaysISO(todayISODate, 7);
  if (edge !== null && task.dueDate <= edge) return 'dueSoon';
  return 'upcoming';
}

/**
 * M-CAL12: actionable overdue work as of an org-local `today` (YYYY-MM-DD).
 * Single source for the Overdue KPI card and every Overdue filter, so the
 * count always matches the listed rows. Submitted work awaiting verification
 * and verified work are excluded — only open and in-progress tasks past
 * their due date count. Due-date red styling and `overdueBadgeLabel` still
 * flag submitted past-due items distinctly, so nothing looks silently on time.
 */
export function isOverdueWork(
  task: Pick<ComplianceTask, 'dueDate' | 'status'>,
  todayISODate: string
): boolean {
  return calendarBucket(task, todayISODate) === 'overdue';
}

/**
 * M-CAL15: actionable due-soon work as of an org-local `today` (YYYY-MM-DD).
 * Single source for the "Due within 7 days" KPI card and every due-soon
 * filter, so the count always matches the listed rows. Only open and
 * in-progress tasks due within the existing civil window (today through
 * today+7, inclusive) count; submitted, verified, past-due, and later work
 * are excluded. The calendar inline "Due soon" badge still uses the local
 * App.tsx helper so submitted work due soon keeps its badge.
 */
export function isDueSoonWork(
  task: Pick<ComplianceTask, 'dueDate' | 'status'>,
  todayISODate: string
): boolean {
  return calendarBucket(task, todayISODate) === 'dueSoon';
}

/** Task action label: returning a submitted task to in-progress reads as a send-back. */
export function startButtonLabel(task: Pick<ComplianceTask, 'status'>): string {
  return task.status === 'submitted' ? 'Send back' : 'Start';
}

/**
 * M-CAL4: overdue badge text as of an org-local `today` (YYYY-MM-DD).
 * Submitted work past its target reads as awaiting verification — not
 * "Overdue" — so the calendar never shows the confusing Submitted + Overdue
 * pair. Returns null when not past due or verified. The Overdue KPI and
 * filters exclude submitted work (see `isOverdueWork`); this badge still
 * flags submitted past-due items so they never look silently on time.
 */
export function overdueBadgeLabel(
  task: Pick<ComplianceTask, 'dueDate' | 'status'>,
  todayISODate: string
): string | null {
  if (task.status === 'verified') return null;
  if (task.dueDate >= todayISODate) return null;
  return task.status === 'submitted' ? 'Awaiting verification — past target' : 'Overdue';
}

/**
 * M-CAL3: New-obligation gate — disabled when the org has no active templates
 * to build from. Returns the disabled reason, or null when creation is
 * allowed. Callers check panel readiness separately.
 */
export function newObligationBlockReason(templates: Pick<TaskTemplate, 'active'>[]): string | null {
  return templates.some((t) => t.active) ? null : 'No templates available for this organization.';
}

/** Org ids the picker may offer for this user (all of them while loading). */
export function pickerOrgIds(orgs: Organization[], me: DemoUser | null): string[] {
  const ids = orgs.map((o) => o.id);
  if (!me) return ids;
  return visibleOrgIds(me, ids).filter((id) => ids.includes(id));
}

/** Keep the current org when the user may see it, else fall back to their own. */
export function resolveOrgId(
  orgs: Organization[],
  me: DemoUser | null,
  currentOrgId: string
): string {
  if (!me || orgs.length === 0 || !currentOrgId) return currentOrgId;
  if (pickerOrgIds(orgs, me).includes(currentOrgId)) return currentOrgId;
  return me.orgId;
}

export interface PanelResults {
  tasks: ComplianceTask[];
  domains: RegulatoryDomain[];
  audit: AuditEvent[];
  templates: TaskTemplate[];
  capas: CapaRecord[];
  obligations: RecurringObligation[];
}

export interface SettledPanels {
  values: Partial<PanelResults>;
  errors: Partial<Record<keyof PanelResults, string>>;
}

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Load failed.';
}

/**
 * Merge Promise.allSettled outcomes: fulfilled panels carry values, rejected
 * ones carry short errors. Callers update only fulfilled panels, so a single
 * failure never erases previously loaded data.
 */
export function settlePanels(
  tasks: PromiseSettledResult<ComplianceTask[]>,
  domains: PromiseSettledResult<RegulatoryDomain[]>,
  audit: PromiseSettledResult<AuditEvent[]>,
  templates: PromiseSettledResult<TaskTemplate[]>,
  capas: PromiseSettledResult<CapaRecord[]>,
  obligations: PromiseSettledResult<RecurringObligation[]>
): SettledPanels {
  const values: Partial<PanelResults> = {};
  const errors: Partial<Record<keyof PanelResults, string>> = {};
  if (tasks.status === 'fulfilled') values.tasks = tasks.value;
  else errors.tasks = reasonMessage(tasks.reason);
  if (domains.status === 'fulfilled') values.domains = domains.value;
  else errors.domains = reasonMessage(domains.reason);
  if (audit.status === 'fulfilled') values.audit = audit.value;
  else errors.audit = reasonMessage(audit.reason);
  if (templates.status === 'fulfilled') values.templates = templates.value;
  else errors.templates = reasonMessage(templates.reason);
  if (capas.status === 'fulfilled') values.capas = capas.value;
  else errors.capas = reasonMessage(capas.reason);
  if (obligations.status === 'fulfilled') values.obligations = obligations.value;
  else errors.obligations = reasonMessage(obligations.reason);
  return { values, errors };
}

// ---------------------------------------------------------------------------
// WM2 client: document-audit review helpers. Pure; unit-tested without a DOM.
// ---------------------------------------------------------------------------

/**
 * Client mirrors of src/server/docaudit.ts caps. Equality with the server
 * constants is pinned by dashboard.test.ts; the server re-validates, so
 * these only drive counters, maxlengths, and client-side messages.
 */
export const DOCAUDIT_TEXT_MAX = 4000;
export const DOCAUDIT_SUMMARY_MAX = 200;
export const DOCAUDIT_TASK_TITLE_MAX = 200;
/** Mirrors FOLLOWUPS_UNAVAILABLE_CODE; pinned equal by unit test. */
export const DOCAUDIT_KEYS_UNAVAILABLE_CODE = 'docaudit.keys.unavailable';

/** Fixed synthetic demo texts for the clearly labeled sample buttons. */
export const DOCAUDIT_SAMPLE_A =
  'North Pine site stores fuel in locked cabinets. Nightly counts are logged by hand. ' +
  'The closing checklist is filed at the nurse station.';
export const DOCAUDIT_SAMPLE_B =
  'North Pine site stores fuel in locked cabinets. Nightly counts are logged by scanner. ' +
  'The opening checklist is filed at the nurse station.';

/** Preview disclosure, pinned verbatim by unit test. */
export const FOLLOWUP_EVIDENCE_NOTE =
  'Saved passages are review source material. They do not count as completion evidence.';

export function findingKindLabel(kind: string): string {
  if (kind === 'difference') return 'Difference';
  if (kind === 'missing_in_a') return 'Only in second text';
  if (kind === 'missing_in_b') return 'Only in first text';
  return kind;
}

export function occurrenceLabel(index: number, total: number, start: number, end: number): string {
  return `Location ${index + 1} of ${total} — characters ${start}–${end}`;
}

export function occurrencesTruncated(passage: Pick<DocAuditPassage, 'occurrences' | 'totalOccurrences'>): boolean {
  return passage.totalOccurrences > passage.occurrences.length;
}

/** Same rule as applySettled's guard, for single-shot docaudit responses. */
export function shouldApplyDocAuditResponse(
  sentKey: string,
  sentSeq: number,
  currentKey: string,
  currentSeq: number
): boolean {
  return sentKey === currentKey && sentSeq === currentSeq;
}

export type FollowupSettleAction = 'apply' | 'refresh' | 'ignore';

/**
 * WM2C-1: classifies a settled follow-up response. 'apply' only when the
 * context and request sequence are both current. 'refresh' when the request
 * was superseded but the context is unchanged: the caller may reload the
 * CURRENT context's panels (same org) but must touch no review state and
 * raise no alerts. 'ignore' when the user or org changed: the caller must
 * do nothing at all — no refresh, no alerts, no state.
 */
export function followupSettleAction(
  sentKey: string,
  sentSeq: number,
  currentKey: string,
  currentSeq: number
): FollowupSettleAction {
  if (sentKey !== currentKey) return 'ignore';
  if (sentSeq !== currentSeq) return 'refresh';
  return 'apply';
}

export interface FollowupKeyBinding {
  contentJson: string;
  key: string;
}

/**
 * Idempotency-key binding: a byte-identical payload reuses the prior key;
 * anything else returns null so the caller mints a fresh key. Pure — the
 * caller owns randomness (crypto.randomUUID). contentJson must exclude the
 * key itself (see buildFollowupPreview).
 */
export function resolveFollowupKey(
  contentJson: string,
  prior: FollowupKeyBinding | null
): string | null {
  if (prior && prior.contentJson === contentJson) return prior.key;
  return null;
}

export type DocAuditVerdict = 'accepted' | 'dismissed';

/** Reasons creation is blocked; empty means the finding may proceed. */
export function findingBlockers(args: {
  verdict: DocAuditVerdict | undefined;
  finding: Pick<DocAuditFinding, 'passageA' | 'passageB'>;
  selectionA: number | undefined;
  selectionB: number | undefined;
  completed: boolean;
}): string[] {
  if (args.completed) return ['A follow-up task was already created for this finding.'];
  const blockers: string[] = [];
  if (args.verdict === undefined) blockers.push('Accept this finding to proceed.');
  else if (args.verdict === 'dismissed') blockers.push('This finding was dismissed.');
  if (args.finding.passageA && args.selectionA === undefined) {
    blockers.push('Choose a location for the source text A passage.');
  }
  if (args.finding.passageB && args.selectionB === undefined) {
    blockers.push('Choose a location for the source text B passage.');
  }
  return blockers;
}

export interface FollowupPreviewInput {
  orgId: string;
  orgName: string;
  domainId: string;
  domainName: string;
  title: string;
  ownerId: string;
  ownerName: string;
  dueDate: string;
  finding: DocAuditFinding;
  summary: string;
  selectionA: number | undefined;
  selectionB: number | undefined;
  textA: string;
  textB: string;
}

export interface FollowupPreviewRow {
  label: string;
  value: string;
}

export type FollowupPreview =
  | {
      ok: true;
      content: Omit<DocAuditFollowupPayload, 'idempotencyKey'>;
      /** Canonical JSON of the saved content, key excluded, for key binding. */
      contentJson: string;
      rows: FollowupPreviewRow[];
    }
  | { ok: false; errors: string[] };

/**
 * Builds the exact follow-up content plus one preview row per saved field.
 * Selections resolve against the occurrence lists the server returned; the
 * server re-verifies every offset. contentJson excludes the idempotency
 * key so byte-identical retries rebind to the same key.
 */
export function buildFollowupPreview(input: FollowupPreviewInput): FollowupPreview {
  const errors: string[] = [];
  if (!input.domainId) errors.push('Choose a regulatory domain.');
  if (!input.title.trim()) errors.push('Enter a task title.');
  else if (input.title.trim().length > DOCAUDIT_TASK_TITLE_MAX) errors.push('Title exceeds 200 characters.');
  if (!input.ownerId) errors.push('Choose a task owner.');
  if (!isValidIsoDate(input.dueDate)) errors.push('Enter a real due date (YYYY-MM-DD).');
  if (!input.summary.trim()) errors.push('Finding summary must not be empty.');
  else if (input.summary.trim().length > DOCAUDIT_SUMMARY_MAX) errors.push('Summary exceeds 200 characters.');
  const sides: Array<{ side: 'A' | 'B'; passage: DocAuditFinding['passageA']; selected: number | undefined }> = [
    { side: 'A', passage: input.finding.passageA, selected: input.selectionA },
    { side: 'B', passage: input.finding.passageB, selected: input.selectionB }
  ];
  const passages: DocAuditFollowupPayload['passages'] = [];
  for (const { side, passage, selected } of sides) {
    if (!passage) continue;
    if (selected === undefined) {
      errors.push(`Choose a location for the source text ${side} passage.`);
      continue;
    }
    const occurrence = passage.occurrences[selected];
    if (!occurrence) {
      errors.push(`Selected location for source text ${side} is not available.`);
      continue;
    }
    passages.push({
      side,
      text: passage.text,
      start: occurrence.start,
      end: occurrence.end,
      occurrenceIndex: selected
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  const content: Omit<DocAuditFollowupPayload, 'idempotencyKey'> = {
    orgId: input.orgId,
    domainId: input.domainId,
    title: input.title.trim(),
    ownerId: input.ownerId,
    dueDate: input.dueDate,
    findingId: input.finding.id,
    kind: input.finding.kind,
    summary: input.summary.trim(),
    textA: input.textA,
    textB: input.textB,
    passages
  };
  return {
    ok: true,
    content,
    contentJson: JSON.stringify(content),
    rows: [
      { label: 'Organization', value: input.orgName },
      { label: 'Regulatory domain', value: input.domainName },
      { label: 'Title', value: content.title },
      { label: 'Owner', value: input.ownerName },
      { label: 'Due date', value: content.dueDate },
      { label: 'Finding', value: `${content.findingId} — ${findingKindLabel(content.kind)}` },
      { label: 'Summary', value: content.summary },
      ...passages.map((p, i) => ({
        label: `Passage ${i + 1} (source text ${p.side})`,
        value: `“${p.text}” at characters ${p.start}–${p.end} (location ${p.occurrenceIndex + 1})`
      }))
    ]
  };
}
