// Shared evidence-submission rule: the server enforces it, the dashboard
// mirrors it for display. Single source of truth for the required count.
import type { ComplianceTask, TaskTemplate } from './types.js';

/**
 * Evidence items a task must hold before submission: the template's required
 * entry count for template tasks, or 1 for ad-hoc tasks (MVP rule). A
 * dangling template reference falls back to 1, and the count never drops
 * below 1 even when a template lists zero requirements (D4a).
 */
export function requiredEvidenceCount(
  task: Pick<ComplianceTask, 'templateId'>,
  templates: Array<Pick<TaskTemplate, 'id' | 'evidenceRequired'>>
): number {
  if (!task.templateId) return 1;
  const template = templates.find((t) => t.id === task.templateId);
  return template ? Math.max(1, template.evidenceRequired.length) : 1;
}
