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

export interface CustodyEntry {
  seq: number;
  /** Previous holder; null for the initial custody entry. */
  fromHolder: string | null;
  toHolder: string;
  byUserId: string;
  at: string;
  reason?: string;
}

export interface EvidenceRef {
  id: string;
  label: string;
  /** Person currently holding / responsible for this evidence item. */
  holder: string;
  /** Append-only custody history; entries are never edited or removed. */
  custody: CustodyEntry[];
  updatedAt: string;
}

export interface ComplianceTask {
  id: string;
  orgId: string;
  domainId: string;
  /** Source template, when this task was instantiated from one. */
  templateId?: string;
  title: string;
  ownerId: string;
  /** ISO calendar date (YYYY-MM-DD). */
  dueDate: string;
  status: TaskStatus;
  evidence: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  /**
   * D4c: authoritative evidence count required before submission, computed
   * server-side per response. Never persisted; absent from stored records and
   * from older servers.
   */
  requiredEvidence?: number;
  /**
   * D5: user who last submitted the task (set on each transition into
   * `submitted`). Absent on tasks that predate the rule or were never
   * submitted.
   */
  submittedBy?: string;
  /**
   * D5a: append-only, server-maintained submission history. One entry per
   * transition into `submitted`; never accepted from clients.
   */
  submissions?: SubmissionRecord[];
  /**
   * D5a: every user who owned the task while it was `submitted`
   * (reassignments of submitted tasks add both sides). Server-maintained.
   */
  ownersWhileSubmitted?: string[];
  /**
   * D5d: who verified the task and when, recorded atomically with the
   * transition into `verified`. Server-maintained; never from clients.
   */
  verifiedBy?: string;
  verifiedAt?: string;
}

/** D5a: one recorded submission: who submitted whose work, and when. */
export interface SubmissionRecord {
  seq: number;
  submittedBy: string;
  ownerAtSubmission: string;
  at: string;
}

/** D5: shared server/dashboard separation-of-duties rejection message. */
export const SEPARATION_OF_DUTIES_MESSAGE =
  'Separation of duties: verifier must differ from owner/submitter.';

/**
 * D5b: returned when every privileged user is in the task's ineligible set,
 * so no independent verifier remains. There is deliberately no override.
 */
export const NO_ELIGIBLE_VERIFIER_MESSAGE =
  'No eligible independent verifier: all privileged users submitted or owned this task.';

/**
 * D5c: verification refused for a submitted task with no trustworthy
 * submission history. Send-back + resubmit establishes a record.
 */
export const SUBMITTER_UNKNOWN_MESSAGE =
  'Submitter unknown for this task — send it back and resubmit to establish a verifiable submission.';

export interface AuditEvent {
  seq: number;
  id: string;
  actorId: string;
  action: string;
  recordType: string;
  recordId: string;
  /** Owning organization; 'system' for non-tenant operational events. */
  orgId: string;
  /**
   * Hash format version. Absent on pre-F1 (v1) events, whose orgId is
   * backfilled and NOT hash-covered. v2 events bind orgId into the hash.
   */
  hashVersion?: number;
  timestamp: string;
  detail: string;
  prevHash: string;
  hash: string;
}

/** orgId marker for audit events that belong to no tenant (e.g. db.seeded). */
export const SYSTEM_AUDIT_ORG = 'system';

/**
 * orgId marker for legacy events whose record no longer exists, so ownership
 * cannot be determined. Fail-closed: visible to privileged roles only.
 */
export const UNKNOWN_AUDIT_ORG = 'unknown';

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

/** CAPA workflow states (first slice: strict forward progression). */
export type CapaStatus =
  | 'open'
  | 'investigation'
  | 'action_in_progress'
  | 'effectiveness_review'
  | 'closed';

/** CAPA finding severity (synthetic demo scale). */
export type CapaSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CapaRecord {
  id: string;
  orgId: string;
  domainId: string;
  /** Linked compliance task, when this CAPA arose from one. */
  taskId?: string;
  /** Finding description (synthetic; never real PHI). */
  finding: string;
  severity: CapaSeverity;
  /** Immediate containment / correction. */
  containment?: string;
  /** Root-cause analysis. */
  rootCause?: string;
  ownerId: string;
  /** ISO calendar date (YYYY-MM-DD). */
  dueDate: string;
  correctivePlan?: string;
  preventivePlan?: string;
  status: CapaStatus;
  /** Supporting evidence (same custody-tracked shape as tasks). */
  evidence: EvidenceRef[];
  /** Effectiveness decision, documented at closure. */
  effectivenessDecision?: string;
  closedBy?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const CAPA_STATUS_LABELS: Record<CapaStatus, string> = {
  open: 'Open',
  investigation: 'Investigation',
  action_in_progress: 'Action In Progress',
  effectiveness_review: 'Effectiveness Review',
  closed: 'Closed'
};

export const CAPA_SEVERITY_LABELS: Record<CapaSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical'
};

/** CAPA closure independence rule (server-enforced; the dashboard mirrors it). */
export const CAPA_CLOSE_SOD_MESSAGE =
  'Separation of duties: the reviewer closing a CAPA must differ from its owner.';

export const KIND_LABELS: Record<OrgKind, string> = {
  hospital: 'Hospital',
  clinic: 'Clinic',
  cannabis_microbusiness: 'Cannabis Microbusiness'
};

/** Legally required controls vs voluntary organizational best practices. */
export type ControlType = 'legally_required' | 'best_practice';

export interface RegulatorySourceRef {
  /** Regulatory source, e.g. '45 CFR Part 164'. */
  source: string;
  /** Citation or description (illustrative references in this demo). */
  citation: string;
  url?: string;
}

export type RecurrenceFrequency = 'once' | 'weekly' | 'monthly' | 'quarterly' | 'annually';

export interface Recurrence {
  frequency: RecurrenceFrequency;
}

export interface EvidenceRequirement {
  label: string;
  required: boolean;
}

export interface EscalationRule {
  /** Days past the due date before this rule fires. */
  afterDaysOverdue: number;
  escalateTo: Role;
  note?: string;
}

export interface TaskTemplate {
  id: string;
  orgId: string;
  domainId: string;
  title: string;
  description: string;
  controlType: ControlType;
  regulatoryRefs: RegulatorySourceRef[];
  responsibleRoles: Role[];
  recurrence: Recurrence;
  evidenceRequired: EvidenceRequirement[];
  escalation: EscalationRule[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export const CONTROL_LABELS: Record<ControlType, string> = {
  legally_required: 'Legally required',
  best_practice: 'Best practice (voluntary)'
};

export const RECURRENCE_LABELS: Record<RecurrenceFrequency, string> = {
  once: 'Once',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually'
};
