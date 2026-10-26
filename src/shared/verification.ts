// Shared verification-eligibility rule: the server enforces it, the dashboard
// mirrors it for display. Eligibility is derived from who was responsible
// for the work (submission + ownership history), never just the current
// owner and latest submitter.
import type { ComplianceTask } from './types.js';

export type VerificationHistory = Pick<
  ComplianceTask,
  'ownerId' | 'submittedBy' | 'submissions' | 'ownersWhileSubmitted'
>;

/**
 * Every user who must never verify this task: each submitter, each owner at
 * submission, everyone who owned it while submitted, the current owner, and
 * (for pre-history records) the latest submitter.
 */
export function ineligibleVerifiers(task: VerificationHistory): string[] {
  const out = new Set<string>();
  for (const s of task.submissions ?? []) {
    out.add(s.submittedBy);
    out.add(s.ownerAtSubmission);
  }
  for (const owner of task.ownersWhileSubmitted ?? []) {
    out.add(owner);
  }
  out.add(task.ownerId);
  if (task.submittedBy) out.add(task.submittedBy);
  return [...out];
}
