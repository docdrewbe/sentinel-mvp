// Role-based access rules shared by the API (enforced) and the UI (hints).
// SIMULATED authorization for demo purposes only — not production-ready.
import type { DemoUser } from './types.js';

/** Minimal owned-record shape so task and CAPA checks share one matrix. */
export interface OwnedRecord {
  orgId: string;
  ownerId: string;
}

export type Action =
  | 'task.create'
  | 'task.update'
  | 'task.submit'
  | 'task.verify'
  | 'evidence.add'
  | 'custody.transfer'
  | 'template.manage'
  | 'capa.create'
  | 'capa.update'
  | 'capa.close'
  | 'capa.evidence.add'
  | 'capa.review.request'
  | 'obligation.manage'
  | 'docaudit.run';

/**
 * DEMO PRIVILEGE (explicit): administrators and compliance officers have
 * cross-organization access in this MVP so one demo login can oversee every
 * tenant. Department managers and staff are strictly limited to their own
 * organization. Revisit before any production use.
 */
export function visibleOrgIds(user: DemoUser, allOrgIds: string[]): string[] {
  if (user.role === 'administrator' || user.role === 'compliance_officer') return [...allOrgIds];
  return [user.orgId];
}

export function can(user: DemoUser, action: Action, record?: OwnedRecord): boolean {
  if (user.role === 'administrator') return true;
  // Compliance officers hold cross-organization verification authority in this demo.
  if (user.role === 'compliance_officer') return true;
  // Managers and staff are scoped to their own organization.
  if (record && record.orgId !== user.orgId) return false;
  if (user.role === 'department_manager') {
    // Managers can do everything except final verification/closure and template design.
    // Obligation schedules (obligation.manage) stay with managers and above: staff
    // never postpone, deactivate, or reassign schedules, even their own.
    return action !== 'task.verify' && action !== 'template.manage' && action !== 'capa.close';
  }
  if (user.role === 'staff') {
    // Staff may only work on records they own, and may never verify or
    // close. Advancing into effectiveness review needs capa.review.request,
    // which staff never hold, so owner-staff stop at Action In Progress.
    if (
      action === 'task.update' ||
      action === 'task.submit' ||
      action === 'evidence.add' ||
      action === 'capa.update' ||
      action === 'capa.evidence.add'
    ) {
      return record ? record.ownerId === user.id : false;
    }
    return false;
  }
  return false;
}
