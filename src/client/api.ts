import type { AuditEvent, ComplianceTask, DemoUser, Organization, RegulatoryDomain, TaskTemplate } from '../shared/types.js';

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
    req<ComplianceTask>(`/api/templates/${id}/instantiate`, { method: 'POST', body: JSON.stringify(body) })
};
