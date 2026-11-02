// Minnesota cannabis microbusiness: security and access procedure review (v1).
//
// Smaller Drew-approved scope: a fixed checklist of SIX verified official
// requirements (5 base + 1 conditional). The matcher below only SUGGESTS
// verbatim passages; it never decides anything. The signed-in reviewer
// decides each item (Addressed / Gap identified / Unclear / Not applicable,
// with a rationale), and the summary derives from those decisions only.
//
//Verified 2026-11-02 against the live Revisor text (links per item). Exact
// official wording is quoted in each excerpt ("…" marks omitted spans).
// Rule currency: ch. 9810 expedited rulemaking effective 2025-04-14, no
// later amendment on the Revisor status page as of the check date.
// Statutes: 2026 Minnesota Statutes.
//
// Explicitly out of this smaller scope (omit unverified / unlisted):
// SEC-01, SEC-03, SEC-04, SEC-06, SEC-08, SEC-09, ACC-01, ACC-03, ACC-04,
// CND-02 (retail rules not verified), CND-03..CND-05, medical
// endorsements, local ordinances, non-security operational rules.
//
// Pasted policy text is response-only: never persisted, never logged, and
// the audit event carries counts only. Matching suggests — by keyword, or
// optionally by a model whose quotes are verified verbatim — and the
// reviewer decides. No verdicts from text analysis either way.
import { createHash } from 'node:crypto';
import {
  DOCAUDIT_MAX_OCCURRENCES,
  DOCAUDIT_MAX_PASSAGE_CHARS,
  DOCAUDIT_MAX_TEXT_CHARS,
  findOccurrences,
  NO_MATCHING_PASSAGE
} from './docaudit.js';
import { ValidationError } from './store.js';

export const MN_CHECKLIST_DATE = '2026-11-02';
export const MN_MAX_SUGGESTIONS = 3;
export const MN_MAX_RATIONALE_CHARS = 1000;
export const MN_MAX_INSTRUCTION_FLAGS = 5;
/** Fixed overall labels. "compliant"/"noncompliant" appear nowhere. */
export const MN_OVERALL_GAPS = 'Gaps found';
export const MN_OVERALL_NEEDS_REVIEW = 'Needs human review';
export const MN_OVERALL_NO_GAPS = 'No gaps found against the listed requirements';
export type MnOverall = typeof MN_OVERALL_GAPS | typeof MN_OVERALL_NEEDS_REVIEW | typeof MN_OVERALL_NO_GAPS;
/** Reviewer decision statuses. Chosen by a person, never computed. */
export const MN_DECISIONS = ['addressed', 'gap', 'unclear', 'not-applicable'] as const;
export type MnDecisionStatus = (typeof MN_DECISIONS)[number];

export interface MnSource {
  citation: string;
  url: string;
}

export interface MnRequirement {
  id: string;
  title: string;
  excerpt: string;
  sources: MnSource[];
  /** 'base' applies to every microbusiness; otherwise the profile key. */
  applies: 'base' | 'outdoor-canopy';
  /** Lowercase substring cues used ONLY to suggest candidate passages. */
  keywords: string[];
  dateChecked: string;
}

export const MN_SECURITY_REQUIREMENTS: MnRequirement[] = [
  {
    id: 'SEC-02',
    title: 'Required security measures and 30-minute response',
    excerpt:
      'Security measures under this part must include: (1) an alarm system; (2) video surveillance; ' +
      '(3) lighting; (4) locks; and (5) an immediate response protocol that must be initiated within 30 minutes ' +
      'after a security event occurs.',
    sources: [{ citation: 'Minn. R. 9810.1500, subp. 2(A)(1)–(5)', url: 'https://www.revisor.mn.gov/rules/9810.1500/' }],
    applies: 'base',
    keywords: ['alarm', 'video', 'surveillance', 'lighting', 'light', 'lock', 'response', '30 minute', '30-minute', 'security event'],
    dateChecked: MN_CHECKLIST_DATE
  },
  {
    id: 'SEC-05',
    title: 'Alarm system: around-the-clock monitored protection',
    excerpt:
      "A cannabis business must install, operate, and maintain in good working order a security alarm system on the business's " +
      'premises. The alarm system must be active 24 hours per day, seven days per week. The alarm system must be monitored ' +
      'by a contracted security company or a cannabis worker employed by the cannabis business. … ' +
      'an audible alarm capable of being heard by an individual within a 100-foot radius from entrances and exits of the premises … ' +
      'the capability to remotely disable the audio alarm by authorized personnel.',
    sources: [{ citation: 'Minn. R. 9810.1500, subp. 8(A)', url: 'https://www.revisor.mn.gov/rules/9810.1500/' }],
    applies: 'base',
    keywords: ['alarm', '24 hour', 'seven days', 'monitor', 'backup', 'power', '100', 'audible', 'remote', 'disable', 'alert'],
    dateChecked: MN_CHECKLIST_DATE
  },
  {
    id: 'SEC-07',
    title: 'Video quality and 90-day retention',
    excerpt:
      'Video cameras must have: (1) video files produced by the video surveillance system that the cannabis business stores ' +
      'in a secure place for a minimum of 90 days; (2) 24-hour recording at a minimum of 15 frames per second; ' +
      '(3) a minimum camera resolution of 720p; (4) date-and-time stamps on all recordings; and (5) the capability ' +
      'to continue recording for an additional eight hours during a power outage.',
    sources: [
      {
        citation: 'Minn. R. 9810.1500, subp. 9(E)(1)–(5), 9(F)(2)–(3)',
        url: 'https://www.revisor.mn.gov/rules/9810.1500/'
      }
    ],
    applies: 'base',
    keywords: ['video', 'camera', '15', 'fps', '720', '90 day', 'record', 'stamp', 'outage', 'footage', 'retention'],
    dateChecked: MN_CHECKLIST_DATE
  },
  {
    id: 'ACC-02',
    title: 'Restricted-area entry log and 3-year names record',
    excerpt:
      "a cannabis business may not permit any individual to enter a restricted area unless the cannabis business records the individual's " +
      'name, time of entry, time of exit, and authorization to enter the restricted area through the use of an electronic or manual entry log … ' +
      'A cannabis business shall ensure that all areas of entry to restricted areas within its licensed premises are conspicuously marked … ' +
      'A cannabis business must maintain a record of the names of individuals who enter restricted areas for at least three years.',
    sources: [
      { citation: 'Minn. Stat. § 342.24, subd. 3(a)–(b)', url: 'https://www.revisor.mn.gov/statutes/cite/342.24' },
      { citation: 'Minn. R. 9810.1500, subp. 13', url: 'https://www.revisor.mn.gov/rules/9810.1500/' }
    ],
    applies: 'base',
    keywords: ['restrict', 'entry log', 'log', 'authorization', 'entry', 'exit', 'conspicuous', 'three year', '3 year', 'names'],
    dateChecked: MN_CHECKLIST_DATE
  },
  {
    id: 'TRN-01',
    title: 'Annual security and emergency training with records',
    excerpt:
      'a license holder must ensure that a cannabis or hemp worker or volunteer receives annual training that applies to the role, ' +
      'authority, and responsibilities of the cannabis or hemp worker or volunteer … ' +
      '(4) the proper use of security measures and controls that have been adopted by the cannabis business in compliance with part 9810.1500 ' +
      'and Minnesota Statutes, chapter 342; (5) procedures on responding to an emergency, including a fire, loss of electrical power, robbery, ' +
      'natural disaster, and workplace violence … ' +
      'A license holder must maintain records containing information about each worker who conducts activities authorized by the office, ' +
      'including records that the worker completed training required by this part.',
    sources: [
      { citation: 'Minn. R. 9810.1102, subp. 2(B)(4)–(5), 2(D)', url: 'https://www.revisor.mn.gov/rules/9810.1102/' }
    ],
    applies: 'base',
    keywords: ['train', 'annual', 'robbery', 'emergency', 'security measures', 'controls', 'records', 'worker'],
    dateChecked: MN_CHECKLIST_DATE
  },
  {
    id: 'CND-01',
    title: 'Outdoor cultivation fencing (conditional)',
    excerpt:
      'A cannabis business must ensure that an outdoor cultivation area is enclosed by fencing and locked gates to prevent access ' +
      'to the area by unauthorized persons. A cannabis business must ensure that all fencing and gates are secure, are at least ' +
      'six feet high, and obscure or have a cover that obscures the fenced area from being readily viewed from outside the fenced area. ' +
      "A cannabis business must ensure that fencing around an outdoor cultivation area on the business's premises is commercial or " +
      'security grade, is not agricultural or residential grade, and is designed to prevent access to the cultivation area by unauthorized persons.',
    sources: [{ citation: 'Minn. R. 9810.1500, subp. 15', url: 'https://www.revisor.mn.gov/rules/9810.1500/' }],
    applies: 'outdoor-canopy',
    keywords: ['fenc', 'outdoor', 'six feet', '6 feet', 'gate', 'locked', 'obscure', 'commercial', 'security grade'],
    dateChecked: MN_CHECKLIST_DATE
  }
];

export interface MnProfile {
  outdoorCanopy: 'yes' | 'no' | 'not-sure';
}

export interface MnDecisionInput {
  itemId: string;
  status: MnDecisionStatus;
  rationale: string;
  inputHash: string;
}

export interface MnReviewInput {
  orgId: string;
  policyText: string;
  profile: MnProfile;
  decisions: MnDecisionInput[];
}

export interface MnPassageLocation {
  start: number;
  end: number;
}

/** Where a suggestion came from: keyword overlap or a verified model quote. */
export type MnSuggestionSource = 'keyword' | 'muse-spark';

export interface MnSuggestedPassage {
  text: string;
  occurrences: MnPassageLocation[];
  totalOccurrences: number;
  source: MnSuggestionSource;
}

export interface MnItemResult {
  id: string;
  title: string;
  excerpt: string;
  sources: MnSource[];
  /** Profile-derived hint only; never a decision. Null = unknown. */
  appliesToYou: boolean | null;
  dateChecked: string;
  suggestions: MnSuggestedPassage[];
  decision: MnDecisionStatus | null;
  rationale: string | null;
  decisionComplete: boolean;
}

export interface MnReviewResult {
  runId: string;
  inputHash: string;
  items: MnItemResult[];
  overall: MnOverall;
  reasons: string[];
  /** Decisions ignored because they were made against older inputs. */
  invalidated: number;
  instructionNotice: MnSuggestedPassage[];
  notEvaluated: boolean;
  missingLabel: string;
  disclaimers: string[];
}

/** Fixed text carried on every result and shown by the panel. */
export const MN_DISCLAIMERS: string[] = [
  'Document review only: compares the written procedure with the listed requirements. ' +
    'It does not show that controls are installed or working; operational performance is a separate check.',
  `Not a determination by the Office of Cannabis Management. Requirements current as of ${MN_CHECKLIST_DATE}; ` +
    'citations link to the official text.',
  '"No matching passage identified" means no candidate passage was suggested. ' +
    'It is not proof that the business lacks the control.'
];

/** Canonical binding of decisions to one exact policy text + profile. */
export function mnInputHash(policyText: string, profile: MnProfile): string {
  return createHash('sha256').update(JSON.stringify([policyText, profile.outdoorCanopy]), 'utf8').digest('hex');
}

/** Split into sentences for suggestion matching. Pure. */
export function mnSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Suggest candidate passages for one requirement. Keyword overlap only;
 * the top sentences are suggestions, never findings. Every suggestion is
 * a verbatim sentence with verified locations; over-long sentences are
 * skipped rather than cut.
 */
export function suggestPassages(policyText: string, item: MnRequirement): MnSuggestedPassage[] {
  const scored: Array<{ text: string; score: number; order: number }> = [];
  mnSentences(policyText).forEach((sentence, order) => {
    if (sentence.length > DOCAUDIT_MAX_PASSAGE_CHARS) return;
    const lower = sentence.toLowerCase();
    const hits = new Set(item.keywords.filter((k) => lower.includes(k)));
    if (hits.size > 0) scored.push({ text: sentence, score: hits.size, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, MN_MAX_SUGGESTIONS).map(({ text }) => {
    const starts = findOccurrences(policyText, text);
    return {
      text,
      occurrences: starts
        .slice(0, DOCAUDIT_MAX_OCCURRENCES)
        .map((start) => ({ start, end: start + text.length })),
      totalOccurrences: starts.length,
      source: 'keyword' as const
    };
  });
}

/**
 * Wrap one model quote as a suggestion. The quote is verified verbatim
 * again here; anything unverifiable answers no suggestion, never keyword
 * backfill — a model run reports honestly what the model found.
 */
export function modelPassage(policyText: string, quote: string): MnSuggestedPassage[] {
  const starts = findOccurrences(policyText, quote);
  if (starts.length === 0) return [];
  return [
    {
      text: quote,
      occurrences: starts
        .slice(0, DOCAUDIT_MAX_OCCURRENCES)
        .map((start) => ({ start, end: start + quote.length })),
      totalOccurrences: starts.length,
      source: 'muse-spark' as const
    }
  ];
}

/** Fixed instruction-like patterns. Detection quotes; it never decides. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /report\s+no\s+gaps/i,
  /mark\s+(every|each|all)\s+requirements?\s+as\s+compliant/i,
  /ignore\s+(all\s+|any\s+)?(previous\s+|above\s+)?instructions?/i,
  /disregard\s+[^.!?]*\b(requirements?|rules?|checklist)\b/i,
  /do\s+not\s+(flag|report|mention)\b/i
];

/**
 * Flag instruction-like sentences (misleading document instructions).
 * Returns verbatim passages with locations. Callers must never let this
 * change decisions or item results; it only adds a notice (and, per the
 * aggregation rules, blocks a green summary).
 */
export function detectInstructionLike(policyText: string): MnSuggestedPassage[] {
  const flagged: MnSuggestedPassage[] = [];
  for (const sentence of mnSentences(policyText)) {
    if (sentence.length > DOCAUDIT_MAX_PASSAGE_CHARS) continue;
    if (!INSTRUCTION_PATTERNS.some((p) => p.test(sentence))) continue;
    const starts = findOccurrences(policyText, sentence);
    if (starts.length === 0) continue;
    flagged.push({
      text: sentence,
      occurrences: starts
        .slice(0, DOCAUDIT_MAX_OCCURRENCES)
        .map((start) => ({ start, end: start + sentence.length })),
      totalOccurrences: starts.length,
      source: 'keyword' as const
    });
    if (flagged.length >= MN_MAX_INSTRUCTION_FLAGS) break;
  }
  return flagged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the review request body. Fixed messages; inputs never echo. */
export function validateReviewInput(body: unknown): MnReviewInput {
  if (!isRecord(body)) throw new ValidationError('Request body is required.');
  const { orgId, policyText, profile, decisions } = body;
  if (typeof orgId !== 'string' || !orgId.trim()) throw new ValidationError('orgId is required.');
  if (typeof policyText !== 'string' || !policyText.trim()) {
    throw new ValidationError('policyText must be non-empty text.');
  }
  let outdoorCanopy: MnProfile['outdoorCanopy'] = 'not-sure';
  if (profile !== undefined) {
    if (!isRecord(profile)) throw new ValidationError('profile must be an object.');
    const raw = profile.outdoorCanopy;
    if (raw !== undefined && raw !== 'yes' && raw !== 'no' && raw !== 'not-sure') {
      throw new ValidationError('profile.outdoorCanopy must be yes, no, or not-sure.');
    }
    if (raw !== undefined) outdoorCanopy = raw;
  }
  const cleanDecisions: MnDecisionInput[] = [];
  if (decisions !== undefined) {
    if (!Array.isArray(decisions)) throw new ValidationError('decisions must be an array.');
    const known = new Set(MN_SECURITY_REQUIREMENTS.map((r) => r.id));
    for (const d of decisions) {
      if (!isRecord(d)) throw new ValidationError('Each decision must be an object.');
      if (typeof d.itemId !== 'string' || !known.has(d.itemId)) {
        throw new ValidationError('Each decision must name a listed requirement.');
      }
      if (typeof d.status !== 'string' || !(MN_DECISIONS as readonly string[]).includes(d.status)) {
        throw new ValidationError('Each decision must choose addressed, gap, unclear, or not-applicable.');
      }
      if (typeof d.rationale !== 'string') throw new ValidationError('Each decision needs a text rationale.');
      if (d.rationale.trim().length > MN_MAX_RATIONALE_CHARS) {
        throw new ValidationError(`Rationale exceeds ${MN_MAX_RATIONALE_CHARS} characters.`);
      }
      if (typeof d.inputHash !== 'string' || !/^[0-9a-f]{64}$/.test(d.inputHash)) {
        throw new ValidationError('Each decision must carry its input hash.');
      }
      cleanDecisions.push({
        itemId: d.itemId,
        status: d.status as MnDecisionStatus,
        rationale: d.rationale,
        inputHash: d.inputHash
      });
    }
  }
  return { orgId, policyText, profile: { outdoorCanopy }, decisions: cleanDecisions };
}

/**
 * Aggregate reviewer decisions into the fixed overall labels. Only
 * decisions that are complete (status + non-empty rationale) AND bound to
 * the current inputs (matching hash) count. Stale or incomplete decisions
 * are reported, never silently dropped into a green result.
 */
export function summarizeReview(
  decisions: MnDecisionInput[],
  currentHash: string,
  instructionFlagged: boolean
): { overall: MnOverall; reasons: string[]; invalidated: number; complete: Map<string, MnDecisionInput> } {
  const complete = new Map<string, MnDecisionInput>();
  let invalidated = 0;
  for (const d of decisions) {
    if (d.inputHash !== currentHash || d.rationale.trim().length === 0) {
      invalidated += 1;
      continue;
    }
    complete.set(d.itemId, d);
  }
  const reasons: string[] = [];
  const pending: string[] = [];
  let gaps = 0;
  let unclear = 0;
  for (const item of MN_SECURITY_REQUIREMENTS) {
    const d = complete.get(item.id);
    if (!d) {
      pending.push(item.id);
    } else if (d.status === 'gap') {
      gaps += 1;
    } else if (d.status === 'unclear') {
      unclear += 1;
    }
  }
  if (gaps > 0) {
    reasons.push(`${gaps} gap${gaps === 1 ? '' : 's'} identified by the reviewer`);
    if (pending.length > 0 || unclear > 0) {
      reasons.push(`Also needs human review: ${[...pending, ...(unclear > 0 ? [`${unclear} unclear`] : [])].join(', ')}`);
    }
    if (instructionFlagged) reasons.push('Instruction-like text was flagged (quoted, not acted on)');
    return { overall: MN_OVERALL_GAPS, reasons, invalidated, complete };
  }
  if (pending.length > 0) reasons.push(`Awaiting reviewer decisions: ${pending.join(', ')}`);
  if (unclear > 0) reasons.push(`${unclear} item${unclear === 1 ? '' : 's'} marked unclear by the reviewer`);
  if (instructionFlagged) reasons.push('Instruction-like text was flagged (quoted, not acted on)');
  if (invalidated > 0 && pending.length === 0 && unclear === 0 && !instructionFlagged) {
    reasons.push(`${invalidated} decision${invalidated === 1 ? '' : 's'} ignored (older inputs or empty rationale)`);
  }
  if (pending.length > 0 || unclear > 0 || instructionFlagged || (invalidated > 0 && complete.size < MN_SECURITY_REQUIREMENTS.length)) {
    return { overall: MN_OVERALL_NEEDS_REVIEW, reasons, invalidated, complete };
  }
  return { overall: MN_OVERALL_NO_GAPS, reasons: [], invalidated, complete };
}

/**
 * Run one stateless review. Over-length input is never evaluated and never
 * truncated: it answers Needs human review with notEvaluated set. When the
 * caller passes model quotes (one verified quote or null per requirement),
 * each item shows the model suggestion instead of keyword matches; a null
 * or missing quote answers no suggestion for that item.
 */
export function runSecurityReview(
  input: MnReviewInput,
  runId: string,
  modelQuotes?: Map<string, string | null>
): MnReviewResult {
  if (input.policyText.length > DOCAUDIT_MAX_TEXT_CHARS) {
    return {
      runId,
      inputHash: mnInputHash(input.policyText, input.profile),
      items: [],
      overall: MN_OVERALL_NEEDS_REVIEW,
      reasons: [`Document exceeds ${DOCAUDIT_MAX_TEXT_CHARS} characters; paste one section of at most that length`],
      invalidated: input.decisions.length,
      instructionNotice: [],
      notEvaluated: true,
      missingLabel: NO_MATCHING_PASSAGE,
      disclaimers: MN_DISCLAIMERS
    };
  }
  const hash = mnInputHash(input.policyText, input.profile);
  const instructionNotice = detectInstructionLike(input.policyText);
  const { overall, reasons, invalidated, complete } = summarizeReview(input.decisions, hash, instructionNotice.length > 0);
  const items: MnItemResult[] = MN_SECURITY_REQUIREMENTS.map((req) => {
    const d = complete.get(req.id) ?? null;
    const appliesToYou = req.applies === 'base' ? true : input.profile.outdoorCanopy === 'yes' ? true : input.profile.outdoorCanopy === 'no' ? false : null;
    let suggestions: MnSuggestedPassage[];
    if (modelQuotes === undefined) {
      suggestions = suggestPassages(input.policyText, req);
    } else {
      const quote = modelQuotes.get(req.id);
      suggestions = typeof quote === 'string' ? modelPassage(input.policyText, quote) : [];
    }
    return {
      id: req.id,
      title: req.title,
      excerpt: req.excerpt,
      sources: req.sources,
      appliesToYou,
      dateChecked: req.dateChecked,
      suggestions,
      decision: d ? d.status : null,
      rationale: d ? d.rationale : null,
      decisionComplete: d !== null
    };
  });
  return { runId, inputHash: hash, items, overall, reasons, invalidated, instructionNotice, notEvaluated: false, missingLabel: NO_MATCHING_PASSAGE, disclaimers: MN_DISCLAIMERS };
}
