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

/**
 * D5b: true when every candidate verifier (all administrator/compliance
 * officer ids passed in) is ineligible. An empty candidate list means the
 * caller doesn't know the roster, so it never reports a deadlock.
 */
export function noEligibleVerifier(task: VerificationHistory, privilegedUserIds: string[]): boolean {
  if (privilegedUserIds.length === 0) return false;
  const blocked = new Set(ineligibleVerifiers(task));
  return privilegedUserIds.every((id) => blocked.has(id));
}

/**
 * D5c: fail-closed triage — a submitted task with no recorded submission has
 * no trustworthy submitter, so verification must wait for a send-back and
 * resubmit. Never derive eligibility from guesses.
 */
export function missingSubmissionHistory(
  task: Pick<ComplianceTask, 'status' | 'submissions'>
): boolean {
  return task.status === 'submitted' && (task.submissions ?? []).length === 0;
}
