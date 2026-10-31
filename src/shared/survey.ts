// Shared survey/OCM inspection packet shapes and fixed wording. The packet
// is a read-only projection over existing records: tasks, templates, and
// their audit history. SIMULATED demo data only — never a compliance
// certification.
import type { AuditEvent, ComplianceTask, OrgKind, RegulatorySourceRef } from './types.js';

export type SurveyScopeKind = 'template' | 'domain' | 'task';

export interface SurveyPacketScope {
  kind: SurveyScopeKind;
  id: string;
  title: string;
  /** Coverage note distinguishing what this scope includes and excludes. */
  note: string;
}

export interface SurveyPacketIntegrity {
  /** Full stored chain verified at generation time. */
  ok: boolean;
  /** Full stored chain length checked. */
  checkedEvents: number;
  /** Related events included in this packet. */
  relatedEvents: number;
  /** Related events lacking the v2 organization binding. */
  legacyEvents: number;
}

export interface SurveyPacket {
  simulated: true;
  generatedAt: string;
  organization: { id: string; name: string; kind: OrgKind };
  scope: SurveyPacketScope;
  /** Template regulatory refs (template scope only); otherwise empty. */
  regulatoryRefs: RegulatorySourceRef[];
  /** Included tasks: explicit stored links only, never title inference. */
  tasks: ComplianceTask[];
  /**
   * Demo-user display names by id, resolved at generation. Ids with no demo
   * user (e.g. 'system') are absent; render the raw id as fallback.
   */
  actors: Record<string, string>;
  /** Related task/template audit events, org-contained. */
  audit: AuditEvent[];
  integrity: SurveyPacketIntegrity;
}

/** Packet heading follows the organization kind (healthcare vs cannabis). */
export function surveyPacketTitle(kind: OrgKind): string {
  return kind === 'cannabis_microbusiness'
    ? 'Sentinel OCM inspection record packet'
    : 'Sentinel survey record packet';
}

export const SURVEY_TEMPLATE_NOTE =
  'Includes only tasks explicitly linked to this standard/control template. Unlinked tasks are excluded; use the domain packet to review them. References are illustrative, not legal advice.';

export const SURVEY_DOMAIN_NOTE =
  'Includes all tasks in this regulatory domain, including tasks without a template link. A domain is broader than one standard.';

export const SURVEY_TASK_NOTE =
  'Single task record. No relationship to other tasks or standards is inferred from its title.';

/** Exact approved wording for a template with zero linked tasks. */
export const SURVEY_EMPTY_TEMPLATE =
  'No tasks explicitly linked to this standard/control template. Review the domain packet for unlinked tasks. This packet does not establish completeness or compliance.';

export const SURVEY_EMPTY_DOMAIN =
  'No tasks recorded in this regulatory domain. This packet does not establish completeness or compliance.';

export const SURVEY_INTEGRITY_NOTE =
  'The server checked the full stored audit chain when this packet was generated. That check covers recorded event hashes and links only: it does not verify current record contents, evidence labels, holders, or any attached files. The chain is not externally anchored, so a fully recomputed chain or removal of its newest events may go undetected. Related legacy events predate the organization-bound hash format and do not bind their organization into the hash.';

export const SURVEY_EVIDENCE_NOTE =
  'Simulated demonstration data only. Evidence entries are labels, holders, and custody metadata; attached documents and their contents are not stored or verified. This packet is not a compliance certification.';
