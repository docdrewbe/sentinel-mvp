// Shared concern-reporting workflow rules: the server enforces them, the
// dashboard mirrors them for button states. Single source of truth for the
// slice-1 linear workflow.
import type { ConcernCategory, ConcernStatus } from './types.js';

export const CONCERN_CATEGORIES: ConcernCategory[] = [
  'safety',
  'infection_prevention',
  'equipment_facilities',
  'policy_process',
  'other'
];

export const CONCERN_STATUSES: ConcernStatus[] = ['submitted', 'acknowledged', 'in_review', 'closed'];

/**
 * Slice-1 workflow: strict single-step forward progression. Closed is
 * terminal: no deletion or reopening in this slice.
 */
export const CONCERN_TRANSITIONS: Record<ConcernStatus, ConcernStatus[]> = {
  submitted: ['acknowledged'],
  acknowledged: ['in_review'],
  in_review: ['closed'],
  closed: []
};

/** Next workflow step, or null when the concern is closed. */
export function nextConcernStatus(status: ConcernStatus): ConcernStatus | null {
  return CONCERN_TRANSITIONS[status][0] ?? null;
}
