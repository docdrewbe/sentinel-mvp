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

/** Gregorian days in a 1-based month; 0 for anything out of range. */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 0;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Strict YYYY-MM-DD parse into civil parts, or null. No Date involved. */
function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/**
 * CAL1: strict org-local date check — shape, month 1–12, and a day that
 * really exists (no February 30, no 2100-02-29). `Date.parse` is
 * deliberately not used: V8 leniently rolls impossible dates forward.
 * Single source for every task/obligation date input and dashboard hint.
 */
export function isValidIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad4 = (n: number): string => String(n).padStart(4, '0');

/** Days since 1970-01-01 (Howard Hinnant's days_from_civil). */
function toSerial(y: number, m: number, d: number): number {
  const prime = m <= 2 ? y - 1 : y;
  const era = Math.floor(prime / 400);
  const yoe = prime - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of toSerial (civil_from_days). */
function fromSerial(z: number): string {
  const a = z + 719468;
  const era = Math.floor(a / 146097);
  const doe = a - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return `${pad4(mp < 10 ? y : y + 1)}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Next occurrence after an org-local target date. Pure calendar math — no
 * Date objects, time zones, or DST transitions. Monthly and longer steps
 * clamp to `anchorDay` (the schedule's intended day-of-month), so a
 * January-31 schedule yields February 28/29 then March 31, never drifting
 * or skipping. Returns null for 'once' schedules and invalid input.
 */
export function nextOccurrence(
  fromISODate: string,
  frequency: RecurrenceFrequency,
  anchorDay: number
): string | null {
  if (frequency === 'once') return null;
  const parsed = parseIsoDate(fromISODate);
  if (!parsed) return null;
  const anchor = Math.min(31, Math.max(1, Math.floor(anchorDay)));
  if (frequency === 'weekly') {
    return fromSerial(toSerial(parsed.y, parsed.m, parsed.d) + 7);
  }
  const step = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
  if (frequency !== 'monthly' && frequency !== 'quarterly' && frequency !== 'annually') return null;
  const totalMonths = (parsed.y * 12 + (parsed.m - 1)) + step;
  const y = Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;
  return `${pad4(y)}-${pad2(m)}-${pad2(Math.min(anchor, daysInMonth(y, m)))}`;
}

/** Org-local date plus N days (pure calendar math, DST-free); null when invalid. */
export function addDaysISO(fromISODate: string, days: number): string | null {
  const parsed = parseIsoDate(fromISODate);
  if (!parsed || !Number.isInteger(days)) return null;
  return fromSerial(toSerial(parsed.y, parsed.m, parsed.d) + days);
}

/** ISO 8601 week label (`2027-W24`) for a civil date, or null when invalid. */
export function isoWeekLabel(fromISODate: string): string | null {
  const parsed = parseIsoDate(fromISODate);
  if (!parsed) return null;
  const serial = toSerial(parsed.y, parsed.m, parsed.d);
  // Monday = 0 (1970-01-01 was a Thursday).
  const dow = (((serial + 3) % 7) + 7) % 7;
  // The Thursday of this week names the week-numbering year.
  const thursday = serial + (3 - dow);
  const weekYear = Number(fromSerial(thursday).slice(0, 4));
  const jan4 = toSerial(weekYear, 1, 4);
  const jan4Dow = (((jan4 + 3) % 7) + 7) % 7;
  const week1Monday = jan4 - jan4Dow;
  const week = Math.floor((serial - week1Monday) / 7) + 1;
  return `${weekYear}-W${pad2(week)}`;
}

/**
 * CAL2: recurrence-period key for a due date under a template frequency:
 * weekly → ISO week (`2027-W24`), monthly → `YYYY-MM`, quarterly →
 * `YYYY-Qn`, annually → `YYYY`, once → `once`. The key names the period
 * independent of the exact target day, so moving a target within a
 * generated period cannot mint a second instance. Null when invalid.
 */
export function periodKeyFor(fromISODate: string, frequency: RecurrenceFrequency): string | null {
  if (frequency === 'once') return isValidIsoDate(fromISODate) ? 'once' : null;
  const parsed = parseIsoDate(fromISODate);
  if (!parsed) return null;
  switch (frequency) {
    case 'weekly':
      return isoWeekLabel(fromISODate);
    case 'monthly':
      return `${pad4(parsed.y)}-${pad2(parsed.m)}`;
    case 'quarterly':
      return `${pad4(parsed.y)}-Q${Math.floor((parsed.m - 1) / 3) + 1}`;
    case 'annually':
      return `${pad4(parsed.y)}`;
    default:
      return null;
  }
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
