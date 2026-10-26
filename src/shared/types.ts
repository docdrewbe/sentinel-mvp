// Shared domain model for the Sentinel compliance MVP.
//
// NOTE: All security and compliance capabilities in this MVP are SIMULATED
// for demonstration purposes. This code is NOT production-ready and must not
// be used with real patient data.

export type Role =
  | 'administrator'
  | 'compliance_officer'
  | 'department_manager'
  | 'staff';

export type OrgKind = 'hospital' | 'clinic' | 'cannabis_microbusiness';

export interface Organization {
  id: string;
  name: string;
  kind: OrgKind;
  /** Bed count, used by the critical access hospital demo. */
  beds?: number;
  location: string;
  createdAt: string;
}

export interface RegulatoryDomain {
  id: string;
  orgId: string;
  code: string;
  name: string;
  description: string;
  active: boolean;
}

export interface DemoUser {
  id: string;
  orgId: string;
  name: string;
  role: Role;
  department: string;
}

export type TaskStatus = 'open' | 'in_progress' | 'submitted' | 'verified';

export interface EvidenceRef {
  id: string;
  label: string;
  /** Person currently holding / responsible for this evidence item. */
  holder: string;
  updatedAt: string;
}

export interface ComplianceTask {
  id: string;
  orgId: string;
  domainId: string;
  title: string;
  ownerId: string;
  /** ISO calendar date (YYYY-MM-DD). */
  dueDate: string;
  status: TaskStatus;
  evidence: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  seq: number;
  id: string;
  actorId: string;
  action: string;
  recordType: string;
  recordId: string;
  timestamp: string;
  detail: string;
  prevHash: string;
  hash: string;
}

export const ROLE_LABELS: Record<Role, string> = {
  administrator: 'Administrator',
  compliance_officer: 'Compliance Officer',
  department_manager: 'Department Manager',
  staff: 'Staff'
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  submitted: 'Submitted',
  verified: 'Verified'
};

export const KIND_LABELS: Record<OrgKind, string> = {
  hospital: 'Hospital',
  clinic: 'Clinic',
  cannabis_microbusiness: 'Cannabis Microbusiness'
};
