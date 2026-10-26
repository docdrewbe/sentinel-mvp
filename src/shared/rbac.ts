// Role-based access rules shared by the API (enforced) and the UI (hints).
// SIMULATED authorization for demo purposes only — not production-ready.
import type { ComplianceTask, DemoUser } from './types.js';

export type Action =
  | 'task.create'
  | 'task.update'
  | 'task.submit'
  | 'task.verify'
  | 'evidence.add'
  | 'custody.transfer'
  | 'template.manage';

export function can(user: DemoUser, action: Action, task?: ComplianceTask): boolean {
  if (user.role === 'administrator') return true;
  // Compliance officers hold cross-organization verification authority in this demo.
  if (user.role === 'compliance_officer') return true;
  // Managers and staff are scoped to their own organization.
  if (task && task.orgId !== user.orgId) return false;
  if (user.role === 'department_manager') {
    // Managers can do everything except final verification and template design.
    return action !== 'task.verify' && action !== 'template.manage';
  }
  if (user.role === 'staff') {
    // Staff may only work on tasks they own, and may never verify.
    if (action === 'task.update' || action === 'task.submit' || action === 'evidence.add') {
      return task ? task.ownerId === user.id : false;
    }
    return false;
  }
  return false;
}
