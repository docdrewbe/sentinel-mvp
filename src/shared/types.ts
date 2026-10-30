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
  /** IANA time zone for org-local dates (e.g. America/Chicago). */
  timeZone: string;
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
  /**
   * CAPA evidence only: implementation work proof vs effectiveness-check
   * proof. Absent (all task evidence, legacy CAPA evidence) counts as
   * implementation evidence.
   */
  kind?: 'implementation' | 'effectiveness';
}

export interface ComplianceTask {
  id: string;
  orgId: string;
  domainId: string;
  /** Source template, when this task was instantiated from one. */
  templateId?: string;
  /** Source obligation, when generated from a recurring obligation. */
  obligationId?: string;
  /** Recurrence period covered (week/month/quarter/year key, or 'once'). */
  periodKey?: string;
  /**
   * Source safety notice, when created as a notice follow-up. Set only by
   * the dedicated follow-up endpoint; immutable after creation. The notice
   * derives its task list from this link (no duplicate arrays).
   */
  noticeId?: string;
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
  /**
   * Phase 2: reviewer-confirmed document-audit source material attached by
   * the dedicated follow-up endpoint. Review context only — it is NOT proof
   * that corrective work was completed and NEVER counts toward the evidence
   * required for submission or verification (those count `evidence` only).
   * Immutable after creation: no update path accepts it.
   */
  docauditSource?: DocAuditSource;
}

/** One reviewer-selected passage with its verified source location. */
export interface DocAuditSavedPassage {
  /** Which compared text the passage was quoted from. */
  side: 'A' | 'B';
  /** Exact verified quotation (UTF-16 offsets, native String semantics). */
  text: string;
  start: number;
  end: number;
  /** Reviewer-chosen occurrence among all matches in the source. */
  occurrenceIndex: number;
  /** Total matches in the source at save time. */
  totalOccurrences: number;
}

/**
 * Exactly what a document-audit follow-up persists beyond ordinary task
 * fields: the reviewer-confirmed finding summary plus the selected passages
 * with source locations. The later client preview must disclose this whole
 * record — summary included — before the reviewer confirms creation.
 */
export interface DocAuditSource {
  /** Reviewer-supplied finding label (e.g. 'f1' from a compare response). */
  findingId: string;
  kind: 'difference' | 'missing_in_a' | 'missing_in_b';
  /** Reviewer-confirmed summary. Persisted; shown in the creation preview. */
  summary: string;
  passages: DocAuditSavedPassage[];
  createdBy: string;
  createdAt: string;
}

/**
 * Idempotency record for document-audit follow-ups. Scoped to the actor
 * and organization that created it: the same key string from a different
 * actor or org is an independent record. Survives server restarts.
 */
export interface DocAuditIdempotencyRecord {
  key: string;
  actorId: string;
  orgId: string;
  taskId: string;
  /** SHA-256 over the canonical persisted payload (excludes the key). */
  contentHash: string;
  createdAt: string;
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
  /**
   * Effectiveness decision: display alias of the latest effective review's
   * rationale, set only by the review endpoint. Never accepted from clients.
   */
  effectivenessDecision?: string;
  /** What effectiveness will be judged against; required before review. */
  effectivenessCriteria?: string;
  /** Append-only criteria history (server-maintained; one entry per change). */
  criteriaHistory?: CriteriaHistoryEntry[];
  /** Append-only effectiveness review history (server-maintained). */
  effectivenessReviews?: EffectivenessReview[];
  /** Append-only status-entry history (server-maintained). */
  statusHistory?: StatusHistoryEntry[];
  /** Who created the record (server-set; counts toward reviewer eligibility). */
  createdBy?: string;
  /** Append-only ownership history (server-maintained). */
  ownerHistory?: OwnerHistoryEntry[];
  /** Users who advanced phases, edited work content, or added work evidence. */
  actionsBy?: string[];
  closedBy?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** One recorded effectiveness review: outcome, rationale, reviewer, time, evidence, criteria. */
export interface EffectivenessReview {
  seq: number;
  outcome: 'effective' | 'ineffective';
  rationale: string;
  reviewerId: string;
  at: string;
  evidenceIds: string[];
  /** Server-copied criteria text the review was judged against. */
  criteriaSnapshot: string;
}

/**
 * One recorded effectiveness-criteria value. Cycle N covers the period
 * after N-1 reviews: cycle 1 is everything before the first review.
 */
export interface CriteriaHistoryEntry {
  seq: number;
  text: string;
  byUserId: string;
  at: string;
  cycle: number;
}

/** One recorded entry into a CAPA status (server-maintained). */
export interface StatusHistoryEntry {
  status: CapaStatus;
  at: string;
  byUserId: string;
}

/** One recorded CAPA owner: the initial owner plus every reassignment. */
export interface OwnerHistoryEntry {
  ownerId: string;
  from: 'initial' | 'reassignment';
  byUserId: string;
  at: string;
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
  'Separation of duties: the reviewer closing a CAPA must not have owned it or contributed to its work.';

/**
 * C3: every privileged user contributed to or owned the CAPA, so no
 * independent reviewer remains. There is deliberately no override.
 */
export const CAPA_NO_ELIGIBLE_REVIEWER_MESSAGE =
  'No eligible independent reviewer: all privileged users contributed to or owned this CAPA.';

/** P1: criteria may not change while a review could judge against them. */
export const CAPA_CRITERIA_LOCKED_MESSAGE =
  'Effectiveness criteria are locked during effectiveness review.';

/** Staff concern-reporting workflow states (slice 1: strict forward progression). */
export type ConcernStatus = 'submitted' | 'acknowledged' | 'in_review' | 'closed';

/** Fixed concern categories for the slice-1 short form. */
export type ConcernCategory =
  | 'safety'
  | 'infection_prevention'
  | 'equipment_facilities'
  | 'policy_process'
  | 'other';

/** One reporter-visible progress or closing update (append-only, server-maintained). */
export interface ConcernUpdate {
  seq: number;
  kind: 'progress' | 'closing';
  message: string;
  byUserId: string;
  at: string;
}

/** One internal triage note (append-only; never shown to unauthorized reporters). */
export interface ConcernNote {
  seq: number;
  text: string;
  byUserId: string;
  at: string;
}

/** One recorded entry into a concern status (server-maintained actor/time). */
export interface ConcernStatusEntry {
  status: ConcernStatus;
  at: string;
  byUserId: string;
}

/** One recorded CAPA-link change: the linked id, or null when unlinked. */
export interface ConcernLinkEntry {
  seq: number;
  capaId: string | null;
  byUserId: string;
  at: string;
}

/**
 * Server-resolved linked-CAPA summary: id and status only. Computed at
 * response time from an existing same-organization CAPA; never stored and
 * never carrying investigation fields. Absent when unlinked or unresolvable.
 */
export interface ConcernCapaSummary {
  id: string;
  status: CapaStatus;
}

/**
 * One "my recent updates" feed entry. Server-composed from a single stored
 * audit event: plain-language description plus the minimal navigation
 * fields. Never carries raw audit detail, update text, or internal notes.
 */
export interface MyUpdateEntry {
  recordKind: 'task' | 'concern';
  recordId: string;
  recordTitle: string;
  /** Live record status (for the client's status chip), not historical. */
  recordStatus: string;
  /** Plain-language description, including the actor's name. */
  description: string;
  /** Stored event timestamp (ISO), verbatim. */
  timestamp: string;
  /** Stored event sequence (ordering + navigation), verbatim. */
  seq: number;
  /** Reporter-update sequence within the concern; present only when validated. */
  updateSeq?: number;
  /**
   * Index into the concern's status history for status-transition events;
   * present only when exactly one history entry matches the transition.
   */
  statusIndex?: number;
}

export interface ConcernRecord {
  id: string;
  orgId: string;
  /** Filing user; server-set from simulated auth, never from clients. */
  reporterId: string;
  title: string;
  category: ConcernCategory;
  description: string;
  location?: string;
  status: ConcernStatus;
  /** Assigned triage handler; assignment grants no additional access. */
  assigneeId?: string;
  /** Explicit link to an existing same-org CAPA; concern actions never modify it. */
  capaId?: string;
  /**
   * Response-time summary of the linked CAPA (id + status). The server
   * recomputes it on every response; it is never persisted on the record.
   */
  linkedCapa?: ConcernCapaSummary;
  /** Reporter-visible follow-up timeline (append-only). */
  updates: ConcernUpdate[];
  /**
   * Internal investigation notes (append-only). Stored on every record; the
   * API omits this field for readers without triage authority.
   */
  internalNotes?: ConcernNote[];
  statusHistory: ConcernStatusEntry[];
  linkHistory: ConcernLinkEntry[];
  createdAt: string;
  updatedAt: string;
}

export const CONCERN_STATUS_LABELS: Record<ConcernStatus, string> = {
  submitted: 'Submitted',
  acknowledged: 'Acknowledged',
  in_review: 'In Review',
  closed: 'Closed'
};

export const CONCERN_CATEGORY_LABELS: Record<ConcernCategory, string> = {
  safety: 'Safety',
  infection_prevention: 'Infection prevention',
  equipment_facilities: 'Equipment/facilities',
  policy_process: 'Policy/process',
  other: 'Other'
};

/** Slice-1 input length limits (server-enforced; the form mirrors them). */
export const CONCERN_TITLE_MAX = 120;
export const CONCERN_DESCRIPTION_MAX = 2000;
export const CONCERN_LOCATION_MAX = 200;
export const CONCERN_MESSAGE_MAX = 1000;

/** Slice-1 reporter notices (exact approved wording). */
export const CONCERN_IDENTIFIED_NOTICE =
  'Demo only—use synthetic information. Sign-in is simulated. Reports are identified, not anonymous. Authorized reviewers can see your report.';
export const CONCERN_REVIEWER_ACCESS_NOTICE =
  'Reviewers are department managers in your organization, plus compliance officers and administrators, who have cross-organization demo access.';
export const CONCERN_EMERGENCY_NOTICE =
  'If there is immediate danger, follow your organization’s emergency procedures. This demo is not monitored for emergencies.';
export const CONCERN_NO_SENSITIVE_DETAILS_HINT =
  'Describe the situation only — do not include patient names or other sensitive personal details.';
export const CONCERN_CLOSED_MEANING_NOTICE =
  'Closing a concern means the reporting workflow ended. It does not establish that a hazard was fixed, that a CAPA is closed, or that effectiveness was verified.';

/** Safety-notice applicability states (slice 1: one decision, final). */
export type NoticeStatus = 'needs_review' | 'applicable' | 'not_applicable';

/**
 * One manually pasted synthetic safety notice. Source material (source,
 * title, noticeDate, text) is immutable once saved in this slice; the
 * reviewer records exactly one applicability decision with rationale.
 * No automated discovery, fetching, or verdicts: every field is human
 * supplied and human reviewed.
 */
export interface NoticeRecord {
  id: string;
  orgId: string;
  /** Intake user; server-set from simulated auth, never from clients. */
  createdBy: string;
  /** Human-supplied source label/reference (free text, never fetched). */
  source: string;
  title: string;
  /** Notice date as stated on the source (ISO calendar date). */
  noticeDate: string;
  /** Pasted synthetic notice text, verbatim. Rendered as plain text. */
  text: string;
  status: NoticeStatus;
  /** Required reviewer rationale for BOTH decisions. */
  rationale?: string;
  /** Reviewer and decision time; set exactly once with the decision. */
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const NOTICE_STATUS_LABELS: Record<NoticeStatus, string> = {
  needs_review: 'Needs review',
  applicable: 'Applicable',
  not_applicable: 'Not applicable'
};

/** Slice-1 input length limits (server-enforced; the form mirrors them). */
export const NOTICE_SOURCE_MAX = 120;
export const NOTICE_TITLE_MAX = 200;
export const NOTICE_TEXT_MAX = 4000;
export const NOTICE_RATIONALE_MAX = 1000;

/** Slice-1 reviewer notices (exact approved wording). */
export const NOTICE_FINALITY_NOTICE =
  'Applicability decisions are final in this slice: they cannot be changed, reopened, or deleted after confirmation.';
export const NOTICE_APPLICABLE_MEANING_NOTICE =
  'Applicable means a human reviewer judged this notice relevant. Linked task states are shown for tracking only; they do not prove every instruction in the notice was addressed.';
export const NOTICE_SYNTHETIC_NOTICE =
  'Paste synthetic text only. No web addresses are fetched; record the source as a written label.';

/** One persisted idempotency record for notice follow-up creation. */
export interface NoticeFollowupKeyRecord {
  key: string;
  actorId: string;
  orgId: string;
  taskId: string;
  contentHash: string;
  createdAt: string;
}

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

/**
 * A recurring compliance obligation: a template's cadence bound to an
 * organization-selected scheduling target. Frequency, regulatory source,
 * and control classification always resolve from the linked template
 * (single source of truth); the obligation owns only the operational
 * schedule: the next target date, the responsible person, and which due
 * periods already have instances. Target dates are illustrative
 * organization-selected targets — never legal mandates.
 */
export interface RecurringObligation {
  id: string;
  orgId: string;
  templateId: string;
  /** Next organization-selected target date (YYYY-MM-DD, org-local). */
  nextDueDate: string;
  /** Day-of-month anchor (1-31) keeping monthly+ steps off month-end drift. */
  anchorDay: number;
  /** Responsible person; generated instances are owned by them. */
  assigneeId?: string;
  active: boolean;
  /** Recurrence periods already generated (period keys), append-only. */
  generatedPeriods: string[];
  /** Append-only schedule-change history (server-maintained). */
  scheduleHistory?: ScheduleHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/** One recorded schedule change: what moved, old → new, who, when, why. */
export interface ScheduleHistoryEntry {
  seq: number;
  change: 'target' | 'assignee' | 'active';
  oldValue: string;
  newValue: string;
  byUserId: string;
  at: string;
  reason: string;
}
