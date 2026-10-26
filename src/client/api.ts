import type { AuditEvent, CapaRecord, ComplianceTask, DemoUser, Organization, RecurringObligation, RegulatoryDomain, TaskTemplate } from '../shared/types.js';

function currentUserId(): string {
  return localStorage.getItem('sentinel-user') ?? '';
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
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
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
    req<{ task: ComplianceTask; obligation: RecurringObligation }>(`/api/obligations/${id}/generate`, { method: 'POST' })
};
