// Shared CAPA phase-gate rules: the server enforces them, the dashboard
// mirrors them for button states. Single source of truth for what each
// transition requires.
import type { CapaRecord, CapaStatus } from './types.js';

export type CapaGateField = 'containment' | 'rootCause' | 'correctivePlan' | 'preventivePlan';

export const CAPA_GATE_FIELD_LABELS: Record<CapaGateField, string> = {
  containment: 'Containment',
  rootCause: 'Root cause',
  correctivePlan: 'Corrective plan',
  preventivePlan: 'Preventive plan'
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
      return ['containment', 'rootCause', 'correctivePlan', 'preventivePlan'];
  }
}

export type CapaGateEvidence = Pick<CapaRecord, 'containment' | 'rootCause' | 'correctivePlan' | 'preventivePlan'> & {
  evidence: readonly unknown[];
};

/**
 * Missing requirements for a transition, as complete sentences. Empty when
 * the gate is satisfied. Until C2 introduces evidence kinds, every evidence
 * item counts as implementation evidence.
 */
export function capaGateMissing(capa: CapaGateEvidence, target: CapaStatus): string[] {
  const missing: string[] = [];
  const need = (ok: boolean, message: string): void => {
    if (!ok) missing.push(message);
  };
  const has = (value: string | undefined): boolean => !!value?.trim();
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
        capa.evidence.length >= 1,
        'At least 1 implementation evidence item is required to request effectiveness review.'
      );
      break;
    case 'closed':
      need(has(capa.containment), 'Containment is still required to close.');
      need(has(capa.rootCause), 'Root cause is still required to close.');
      need(has(capa.correctivePlan), 'Corrective plan is still required to close.');
      need(has(capa.preventivePlan), 'Preventive plan is still required to close.');
      need(
        capa.evidence.length >= 1,
        'At least 1 implementation evidence item is still required to close.'
      );
      break;
  }
  return missing;
}
