// Pure dashboard helpers: org visibility/switching and resilient panel loads.
// Kept free of React so the rules are unit-testable without a DOM.
import { can, visibleOrgIds, type Action } from '../shared/rbac.js';
import { addDaysISO } from '../shared/scheduling.js';
import { CAPA_CLOSE_SOD_MESSAGE, CAPA_NO_ELIGIBLE_REVIEWER_MESSAGE, NO_ELIGIBLE_VERIFIER_MESSAGE, SEPARATION_OF_DUTIES_MESSAGE, SUBMITTER_UNKNOWN_MESSAGE } from '../shared/types.js';
import { capaGateMissing, capaNoEligibleReviewer, capaReviewIneligible, qualifyingEffectivenessEvidence } from '../shared/capa.js';
import { ineligibleVerifiers, missingSubmissionHistory, noEligibleVerifier } from '../shared/verification.js';
import type {
  AuditEvent,
  CapaRecord,
  CapaStatus,
  ComplianceTask,
  DemoUser,
  EvidenceRef,
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
