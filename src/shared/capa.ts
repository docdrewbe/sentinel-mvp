// Shared CAPA phase-gate rules: the server enforces them, the dashboard
// mirrors them for button states. Single source of truth for what each
// transition requires.
import type { CapaRecord, CapaStatus, EvidenceRef } from './types.js';

export type CapaGateField =
  | 'containment'
  | 'rootCause'
  | 'correctivePlan'
  | 'preventivePlan'
  | 'effectivenessCriteria';

export const CAPA_GATE_FIELD_LABELS: Record<CapaGateField, string> = {
  containment: 'Containment',
  rootCause: 'Root cause',
  correctivePlan: 'Corrective plan',
  preventivePlan: 'Preventive plan',
  effectivenessCriteria: 'Effectiveness criteria'
};

/**
 * Text fields that must stay non-blank once the CAPA has reached (or passed)
 * the gate that required them. Amendments are allowed; blanking is not.
 */
export function capaRequiredFields(status: CapaStatus): CapaGateField[] {
  switch (status) {
    case 'open':
      return [];
    case 'investigation':
      return ['containment'];
    case 'action_in_progress':
      return ['containment', 'rootCause'];
    case 'effectiveness_review':
    case 'closed':
      return ['containment', 'rootCause', 'correctivePlan', 'preventivePlan', 'effectivenessCriteria'];
  }
}

/**
 * P1: effectiveness criteria are locked during review (a review must judge
 * the criteria set before it) and after closure. Used by the server
 * (enforced) and the dashboard (field disabled with an explanation).
 */
export function capaCriteriaLocked(status: CapaStatus): boolean {
  return status === 'effectiveness_review' || status === 'closed';
}

/**
 * P2: first body field (checked in order) whose present value is not a
 * string — numbers, booleans, objects, arrays, and null all qualify — or
 * null when every present value is a string. CAPA routes call this after
 * the authorization checks and report `400 "<field> must be text."`
 * before any no-op detection or mutation.
 */
export function nonStringField(body: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = body[field];
    if (value !== undefined && typeof value !== 'string') return field;
  }
  return null;
}

export type CapaGateEvidence = Pick<
  CapaRecord,
  'containment' | 'rootCause' | 'correctivePlan' | 'preventivePlan' | 'effectivenessCriteria'
> & {
  evidence: ReadonlyArray<Pick<EvidenceRef, 'kind'>>;
};

/** Implementation-phase evidence: explicit kind, or legacy/task evidence without one. */
export function isImplementationEvidence(item: Pick<EvidenceRef, 'kind'>): boolean {
  return (item.kind ?? 'implementation') === 'implementation';
}

/**
 * Missing requirements for a transition, as complete sentences. Empty when
 * the gate is satisfied.
 */
export function capaGateMissing(capa: CapaGateEvidence, target: CapaStatus): string[] {
  const missing: string[] = [];
  const need = (ok: boolean, message: string): void => {
    if (!ok) missing.push(message);
  };
  const has = (value: string | undefined): boolean => !!value?.trim();
  const implementationCount = capa.evidence.filter(isImplementationEvidence).length;
  switch (target) {
    case 'open':
      break;
    case 'investigation':
      need(has(capa.containment), 'Containment is required to start the investigation.');
      break;
    case 'action_in_progress':
      need(has(capa.containment), 'Containment is required to begin action.');
      need(has(capa.rootCause), 'Root cause is required to begin action.');
      break;
    case 'effectiveness_review':
      need(has(capa.containment), 'Containment is required to request effectiveness review.');
      need(has(capa.rootCause), 'Root cause is required to request effectiveness review.');
      need(has(capa.correctivePlan), 'Corrective plan is required to request effectiveness review.');
      need(has(capa.preventivePlan), 'Preventive plan is required to request effectiveness review.');
      need(
        has(capa.effectivenessCriteria),
        'Effectiveness criteria are required to request effectiveness review.'
      );
      need(
        implementationCount >= 1,
        'At least 1 implementation evidence item is required to request effectiveness review.'
      );
      break;
    case 'closed':
      need(has(capa.containment), 'Containment is still required to close.');
      need(has(capa.rootCause), 'Root cause is still required to close.');
      need(has(capa.correctivePlan), 'Corrective plan is still required to close.');
      need(has(capa.preventivePlan), 'Preventive plan is still required to close.');
      need(has(capa.effectivenessCriteria), 'Effectiveness criteria are still required to close.');
      need(
        implementationCount >= 1,
        'At least 1 implementation evidence item is still required to close.'
      );
      break;
  }
  return missing;
}

/**
 * Latest entry into effectiveness review (ISO timestamp), or null when the
 * CAPA never entered review. Review cycles are scoped by this timestamp.
 */
export function latestReviewEntryAt(capa: Pick<CapaRecord, 'statusHistory'>): string | null {
  let latest: string | null = null;
  for (const entry of capa.statusHistory ?? []) {
    if (entry.status === 'effectiveness_review' && (latest === null || entry.at > latest)) {
      latest = entry.at;
    }
  }
  return latest;
}

/**
 * Effectiveness evidence belonging to the current review cycle: kind-tagged
 * items whose custody genesis postdates the latest review entry. Used by the
 * review endpoint (enforced) and the dashboard picker (mirrored).
 *
 * KNOWN LIMITATION (fail-closed, no bypass): a CAPA at
 * effectiveness_review with no recorded statusHistory entry for that
 * status — possible only for legacy records predating history tracking —
 * yields no qualifying evidence, so the review endpoint rejects every
 * review with 'Each referenced evidence item must be current-cycle
 * effectiveness evidence.' That record is unclosable through the API until
 * its history is repaired out of band. Deliberately no recovery bypass is
 * offered here: any bypass would let a caller launder pre-review evidence
 * into a review cycle. See the C2 regression tests for the rejection path.
 */
export function qualifyingEffectivenessEvidence(
  capa: Pick<CapaRecord, 'evidence' | 'statusHistory'>
): EvidenceRef[] {
  const entry = latestReviewEntryAt(capa);
  if (!entry) return [];
  return capa.evidence.filter(
    (item) => item.kind === 'effectiveness' && (item.custody[0]?.at ?? '') > entry
  );
}

export type CapaInvolvement = Pick<
  CapaRecord,
  'ownerId' | 'createdBy' | 'ownerHistory' | 'actionsBy'
>;

/**
 * C3: everyone who must never review this CAPA — the creator, every past
 * and present owner, and everyone who did the work — so reassignment can
 * never launder eligibility.
 */
export function capaReviewIneligible(capa: CapaInvolvement): string[] {
  const out = new Set<string>();
  out.add(capa.ownerId);
  if (capa.createdBy) out.add(capa.createdBy);
  for (const entry of capa.ownerHistory ?? []) out.add(entry.ownerId);
  for (const userId of capa.actionsBy ?? []) out.add(userId);
  return [...out];
}

/**
 * C3: true when every candidate reviewer (all administrator/compliance
 * officer ids passed in) is ineligible. An empty roster means the caller
 * doesn't know it, so it never reports a deadlock.
 */
export function capaNoEligibleReviewer(capa: CapaInvolvement, privilegedUserIds: string[]): boolean {
  if (privilegedUserIds.length === 0) return false;
  const blocked = new Set(capaReviewIneligible(capa));
  return privilegedUserIds.every((id) => blocked.has(id));
}
