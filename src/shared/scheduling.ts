// Pure scheduling / escalation helpers for task templates. Shared by the API
// and the dashboard so both compute identical due dates and tiers.
import type { EscalationRule, RecurrenceFrequency, TaskTemplate } from './types.js';

/** Next due date after `fromISODate` (YYYY-MM-DD), or null for one-time work. */
export function nextDueDate(fromISODate: string, frequency: RecurrenceFrequency): string | null {
  if (frequency === 'once') return null;
  const [y, m, d] = fromISODate.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return null;
  switch (frequency) {
    case 'weekly':
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case 'monthly':
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
    case 'quarterly':
      date.setUTCMonth(date.getUTCMonth() + 3);
      break;
    case 'annually':
      date.setUTCFullYear(date.getUTCFullYear() + 1);
      break;
  }
  return date.toISOString().slice(0, 10);
}

/** Whole days overdue as of `asOfISODate`; verified work is never overdue. */
export function daysOverdue(dueDate: string, status: string, asOfISODate: string): number {
  if (status === 'verified') return 0;
  const ms = Date.parse(asOfISODate) - Date.parse(dueDate);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor(ms / 86400000));
}

/** Highest escalation tier whose threshold has been reached, if any. */
export function evaluateEscalation(
  template: TaskTemplate,
  input: { dueDate: string; status: string },
  asOfISODate: string
): EscalationRule | null {
  const days = daysOverdue(input.dueDate, input.status, asOfISODate);
  let hit: EscalationRule | null = null;
  for (const rule of template.escalation) {
    if (days >= rule.afterDaysOverdue && (!hit || rule.afterDaysOverdue > hit.afterDaysOverdue)) {
      hit = rule;
    }
  }
  return hit;
}
