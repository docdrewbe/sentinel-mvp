// Pure dashboard helpers: org visibility/switching and resilient panel loads.
// Kept free of React so the rules are unit-testable without a DOM.
import { visibleOrgIds } from '../shared/rbac.js';
import type {
  AuditEvent,
  ComplianceTask,
  DemoUser,
  Organization,
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
}

export type PanelName = keyof Panels;

export function initialPanels(): Panels {
  const fresh = <T,>(): PanelState<T> => ({ key: '', status: 'loading', data: [] });
  return { tasks: fresh(), domains: fresh(), audit: fresh(), templates: fresh() };
}

/** On a context change, synchronously clear every panel; same key → unchanged. */
export function beginContext(prevKey: string, nextKey: string, panels: Panels): Panels {
  if (prevKey === nextKey) return panels;
  const fresh = <T,>(): PanelState<T> => ({ key: nextKey, status: 'loading', data: [] });
  return { tasks: fresh(), domains: fresh(), audit: fresh(), templates: fresh() };
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
  templates: PromiseSettledResult<TaskTemplate[]>
): Panels {
  if (key !== currentKey || seq !== currentSeq) return panels;
  const { values, errors } = settlePanels(tasks, domains, audit, templates);
  return {
    tasks: nextPanel(panels.tasks, key, values.tasks, errors.tasks),
    domains: nextPanel(panels.domains, key, values.domains, errors.domains),
    audit: nextPanel(panels.audit, key, values.audit, errors.audit),
    templates: nextPanel(panels.templates, key, values.templates, errors.templates)
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
  templates: PromiseSettledResult<TaskTemplate[]>
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
  return { values, errors };
}
