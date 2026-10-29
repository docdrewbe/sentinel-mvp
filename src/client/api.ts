import type { AuditEvent, CapaRecord, ComplianceTask, ConcernRecord, DemoUser, Organization, RecurringObligation, RegulatoryDomain, TaskTemplate } from '../shared/types.js';

function currentUserId(): string {
  return localStorage.getItem('sentinel-user') ?? '';
}

/**
 * Typed API failure. Message is preserved so existing callers keep working;
 * status and the server diagnostic code let new callers branch (for example
 * the follow-up 503 carries code 'docaudit.keys.unavailable').
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-demo-user-id': currentUserId(),
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  }
  return (await res.json()) as T;
}

export interface NewTask {
  orgId: string;
  domainId: string;
  title: string;
  ownerId: string;
  dueDate: string;
}

// Document-audit wire shapes (mirror the Phase 2 server contract; the
// server re-validates everything, so these are display/submit conveniences).

export interface DocAuditOccurrence {
  start: number;
  end: number;
  contextBefore: string;
  contextAfter: string;
}

export interface DocAuditPassage {
  text: string;
  occurrences: DocAuditOccurrence[];
  totalOccurrences: number;
}

export type DocAuditFindingKind = 'difference' | 'missing_in_a' | 'missing_in_b';

export interface DocAuditFinding {
  id: string;
  kind: DocAuditFindingKind;
  summary: string;
  passageA: DocAuditPassage | null;
  passageB: DocAuditPassage | null;
}

export interface DocAuditCompareResult {
  provider: string;
  notice?: string;
  runId: string;
  missingLabel: string;
  findings: DocAuditFinding[];
}

export interface DocAuditPassageSelection {
  side: 'A' | 'B';
  text: string;
  start: number;
  end: number;
  occurrenceIndex: number;
}

export interface DocAuditFollowupPayload {
  idempotencyKey: string;
  orgId: string;
  domainId: string;
  title: string;
  ownerId: string;
  dueDate: string;
  findingId: string;
  kind: string;
  summary: string;
  textA: string;
  textB: string;
  passages: DocAuditPassageSelection[];
}

export interface DocAuditFollowupResult {
  task: ComplianceTask;
  duplicate: boolean;
}

export const api = {
  orgs: () => req<Organization[]>('/api/orgs'),
  users: () => req<DemoUser[]>('/api/users'),
  domains: (orgId: string) => req<RegulatoryDomain[]>(`/api/domains?orgId=${orgId}`),
  tasks: (orgId: string) => req<ComplianceTask[]>(`/api/tasks?orgId=${orgId}`),
  createTask: (t: NewTask) => req<ComplianceTask>('/api/tasks', { method: 'POST', body: JSON.stringify(t) }),
  patchTask: (id: string, patch: object) =>
    req<ComplianceTask>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addEvidence: (id: string, e: { label: string; holder: string }) =>
    req(`/api/tasks/${id}/evidence`, { method: 'POST', body: JSON.stringify(e) }),
  transfer: (id: string, t: { evidenceId: string; toHolder: string; reason?: string }) =>
    req(`/api/tasks/${id}/transfer`, { method: 'POST', body: JSON.stringify(t) }),
  audit: (limit = 100) => req<AuditEvent[]>(`/api/audit?limit=${limit}`),
  templates: (orgId: string) => req<TaskTemplate[]>(`/api/templates?orgId=${orgId}`),
  instantiate: (id: string, body: { ownerId: string; dueDate?: string }) =>
    req<ComplianceTask>(`/api/templates/${id}/instantiate`, { method: 'POST', body: JSON.stringify(body) }),
  capas: (orgId: string) => req<CapaRecord[]>(`/api/capas?orgId=${orgId}`),
  patchCapa: (id: string, patch: object) =>
    req<CapaRecord>(`/api/capas/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addCapaEvidence: (id: string, e: { label: string; holder: string; kind?: string }) =>
    req(`/api/capas/${id}/evidence`, { method: 'POST', body: JSON.stringify(e) }),
  reviewCapa: (id: string, review: { outcome: string; rationale: string; evidenceIds: string[] }) =>
    req<CapaRecord>(`/api/capas/${id}/effectiveness-review`, { method: 'POST', body: JSON.stringify(review) }),
  transferCapaEvidence: (id: string, t: { evidenceId: string; toHolder: string; reason?: string }) =>
    req(`/api/capas/${id}/transfer`, { method: 'POST', body: JSON.stringify(t) }),
  obligations: (orgId: string) => req<RecurringObligation[]>(`/api/obligations?orgId=${orgId}`),
  createObligation: (o: { orgId: string; templateId: string; nextDueDate: string; assigneeId?: string }) =>
    req<RecurringObligation>('/api/obligations', { method: 'POST', body: JSON.stringify(o) }),
  patchObligation: (id: string, patch: object) =>
    req<RecurringObligation>(`/api/obligations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  generateObligation: (id: string) =>
    req<{ task: ComplianceTask; obligation: RecurringObligation }>(`/api/obligations/${id}/generate`, { method: 'POST' }),
  docauditCompare: (body: { orgId: string; textA: string; textB: string }) =>
    req<DocAuditCompareResult>('/api/docaudit/compare', { method: 'POST', body: JSON.stringify(body) }),
  docauditFollowup: (body: DocAuditFollowupPayload) =>
    req<DocAuditFollowupResult>('/api/docaudit/followups', { method: 'POST', body: JSON.stringify(body) }),
  concerns: (orgId: string) => req<ConcernRecord[]>(`/api/concerns?orgId=${orgId}`),
  myConcerns: (orgId: string) => req<ConcernRecord[]>(`/api/concerns?orgId=${orgId}&mine=1`),
  createConcern: (c: { orgId: string; title: string; category: string; description: string; location?: string }) =>
    req<ConcernRecord>('/api/concerns', { method: 'POST', body: JSON.stringify(c) }),
  patchConcern: (id: string, patch: object) =>
    req<ConcernRecord>(`/api/concerns/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addConcernUpdate: (id: string, u: { message: string }) =>
    req<ConcernRecord>(`/api/concerns/${id}/updates`, { method: 'POST', body: JSON.stringify(u) }),
  addConcernNote: (id: string, n: { text: string }) =>
    req<ConcernRecord>(`/api/concerns/${id}/notes`, { method: 'POST', body: JSON.stringify(n) })
};
