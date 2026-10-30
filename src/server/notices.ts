// Manual safety-notice workflow (slice 1): intake validation, one final
// applicability decision, and idempotent follow-up task creation.
//
// Every field is human supplied and human reviewed: notices are pasted
// manually (nothing is fetched), applicability is an explicit reviewer
// decision with rationale, and follow-up actions/assignments are typed
// by the reviewer. This module performs no automated discovery,
// matching, or verdicts.
import { createHash } from 'node:crypto';
import { isValidIsoDate } from '../shared/scheduling.js';
import {
  NOTICE_RATIONALE_MAX,
  NOTICE_SOURCE_MAX,
  NOTICE_TEXT_MAX,
  NOTICE_TITLE_MAX,
  type NoticeFollowupKeyRecord,
  type NoticeRecord,
  type NoticeStatus
} from '../shared/types.js';
import { ValidationError, type DbShape } from './store.js';

export const NOTICE_MAX_KEY_CHARS = 128;
/** Fixed 409 message: same idempotency key reused with different content. */
export const NOTICE_IDEMPOTENCY_CONFLICT = 'Idempotency key already used with different content.';
/** Fixed 503 message: stored follow-up key data is missing or corrupt. */
export const NOTICE_FOLLOWUPS_UNAVAILABLE = 'Notice follow-ups are unavailable.';
/** Fixed diagnostic code accompanying the 503 above. */
export const NOTICE_FOLLOWUPS_UNAVAILABLE_CODE = 'notice.keys.unavailable';

/**
 * Typed failure for unusable key storage, including a retained record
 * that references a missing task. Mapped to the fixed 503 (never a 500,
 * never request content, never a repair attempt).
 */
export class NoticeFollowupsUnavailable extends Error {
  constructor() {
    super(NOTICE_FOLLOWUPS_UNAVAILABLE);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Required capped string; trims. Fixed messages only — inputs never echo. */
function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${label} is required.`);
  if (value.length > max) throw new ValidationError(`${label} exceeds ${max} characters.`);
  return value.trim();
}

export interface ValidatedNoticeIntake {
  orgId: string;
  source: string;
  title: string;
  noticeDate: string;
  text: string;
}

/** Intake-time validation. Types, lengths, and a real calendar date. */
export function validateNoticeIntake(body: unknown): ValidatedNoticeIntake {
  if (!isRecord(body)) throw new ValidationError('Notice body must be an object.');
  const orgId = body.orgId;
  if (typeof orgId !== 'string' || !orgId.trim()) throw new ValidationError('orgId is required.');
  const source = requiredText(body.source, NOTICE_SOURCE_MAX, 'Source');
  const title = requiredText(body.title, NOTICE_TITLE_MAX, 'Title');
  const noticeDate = body.noticeDate;
  if (typeof noticeDate !== 'string' || !isValidIsoDate(noticeDate)) {
    throw new ValidationError('noticeDate must be a real calendar date (YYYY-MM-DD).');
  }
  const text = requiredText(body.text, NOTICE_TEXT_MAX, 'Notice text');
  return { orgId, source, title, noticeDate, text };
}

export interface ValidatedNoticeReview {
  status: 'applicable' | 'not_applicable';
  rationale: string;
}

/**
 * Review validation: exactly one decision from needs_review, rationale
 * required for BOTH outcomes. Source material is immutable — any attempt
 * to change it is rejected rather than silently ignored.
 */
export function validateNoticeReview(body: unknown, current: NoticeRecord): ValidatedNoticeReview {
  if (!isRecord(body)) throw new ValidationError('Review body must be an object.');
  for (const field of ['source', 'title', 'noticeDate', 'text'] as const) {
    if (body[field] !== undefined) {
      throw new ValidationError('Saved notice material cannot be changed in this slice.');
    }
  }
  if (current.status !== 'needs_review') {
    throw new ValidationError('This notice already has a final applicability decision.');
  }
  const status: unknown = body.status;
  if (status !== 'applicable' && status !== 'not_applicable') {
    throw new ValidationError('status must be applicable or not_applicable.');
  }
  const rationale = requiredText(body.rationale, NOTICE_RATIONALE_MAX, 'Rationale');
  return { status, rationale };
}

export interface ValidatedNoticeFollowup {
  key: string;
  orgId: string;
  domainId: string;
  title: string;
  ownerId: string;
  dueDate: string;
  noticeId: string;
  contentHash: string;
}

/** Canonical payload hash: identical retries match, any change conflicts. */
export function noticeFollowupContentHash(payload: {
  orgId: string;
  domainId: string;
  title: string;
  ownerId: string;
  dueDate: string;
  noticeId: string;
}): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Follow-up validation against the path notice: the notice must be
 * applicable in the request org, and task fields follow ordinary task
 * rules (same-org active domain, same-org owner, real calendar date).
 */
export function validateNoticeFollowup(body: unknown, notice: NoticeRecord): ValidatedNoticeFollowup {
  if (!isRecord(body)) throw new ValidationError('Follow-up body must be an object.');
  const key = requiredText(body.idempotencyKey, NOTICE_MAX_KEY_CHARS, 'idempotencyKey');
  const orgId = body.orgId;
  if (typeof orgId !== 'string' || !orgId.trim()) throw new ValidationError('orgId is required.');
  if (orgId !== notice.orgId) {
    throw new ValidationError('Follow-up organization must match the notice.');
  }
  if (notice.status !== 'applicable') {
    throw new ValidationError('Only applicable notices may create follow-up tasks.');
  }
  const domainId = requiredText(body.domainId, 128, 'domainId');
  const title = requiredText(body.title, 200, 'Title');
  const ownerId = requiredText(body.ownerId, 128, 'ownerId');
  const dueDate = body.dueDate;
  if (typeof dueDate !== 'string' || !isValidIsoDate(dueDate)) {
    throw new ValidationError('dueDate must be a real calendar date (YYYY-MM-DD).');
  }
  const canonical = { orgId, domainId, title, ownerId, dueDate, noticeId: notice.id };
  return { key, ...canonical, contentHash: noticeFollowupContentHash(canonical) };
}

function isNoticeKeyRecord(value: unknown): value is NoticeFollowupKeyRecord {
  if (!isRecord(value)) return false;
  for (const field of ['key', 'actorId', 'orgId', 'taskId', 'contentHash', 'createdAt'] as const) {
    const entry = value[field];
    if (typeof entry !== 'string' || !entry.trim()) return false;
  }
  return true;
}

export type NoticeKeysHealth =
  | { ok: true; keys: NoticeFollowupKeyRecord[] }
  | { ok: false };

/**
 * Fail-closed storage gate (mirrors docauditKeysHealth): only a fully
 * valid array is usable. Anything else disables creation and replay
 * with a fixed 503; the stored value itself is never repaired here.
 */
export function noticeKeysHealth(db: DbShape): NoticeKeysHealth {
  const stored: unknown = db.noticeFollowupKeys;
  if (!Array.isArray(stored) || !stored.every(isNoticeKeyRecord)) return { ok: false };
  return { ok: true, keys: stored };
}

/** Notice applicability transition guard shared by server and UI copy. */
export function isNoticeStatus(value: unknown): value is NoticeStatus {
  return value === 'needs_review' || value === 'applicable' || value === 'not_applicable';
}
