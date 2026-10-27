import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCAUDIT_MAX_FINDINGS,
  DOCAUDIT_MAX_OCCURRENCES,
  DOCAUDIT_MAX_PASSAGE_CHARS,
  DOCAUDIT_MAX_SUMMARY_CHARS,
  DOCAUDIT_MAX_TEXT_CHARS,
  DOCAUDIT_THROTTLE_MAX,
  FOLLOWUPS_UNAVAILABLE,
  FOLLOWUPS_UNAVAILABLE_CODE,
  IDEMPOTENCY_CONFLICT,
  MOCK_NOTICE,
  NO_MATCHING_PASSAGE,
  ProviderError,
  __resetDocAuditThrottle,
  __setDocAuditTimeoutMs,
  __setMockDocAuditMode,
  checkDocAuditThrottle,
  createMockProvider,
  currentTimeoutMs,
  docauditKeysHealth,
  findOccurrences,
  followupContentHash,
  resolveProvider,
  validateCompareInput,
  validateFollowupInput,
  validateProviderOutput
} from '../docaudit.js';
import { ValidationError } from '../store.js';
import type { DbShape } from '../store.js';

const TEXT_A = 'Alpha site stores fuel in locked cabinets. Nightly counts are logged by hand.';
const TEXT_B = 'Alpha site stores fuel in locked cabinets. Nightly counts are logged by scanner.';

afterEach(() => {
  delete process.env.DOCAUDIT_PROVIDER;
  __setMockDocAuditMode('ok');
  __setDocAuditTimeoutMs(null);
  __resetDocAuditThrottle();
});

describe('docaudit constants (Phase 1)', () => {
  it('pins the exact fixture notice and missing-passage label', () => {
    assert.equal(MOCK_NOTICE, 'Simulated fixture output — not actual document analysis.');
    assert.equal(NO_MATCHING_PASSAGE, 'No matching passage identified');
    assert.equal(DOCAUDIT_MAX_TEXT_CHARS, 4000);
    assert.equal(DOCAUDIT_MAX_SUMMARY_CHARS, 200);
    assert.equal(DOCAUDIT_MAX_PASSAGE_CHARS, 500);
    assert.equal(DOCAUDIT_MAX_FINDINGS, 20);
  });
});

describe('compare input validation (Phase 1)', () => {
  it('accepts two capped texts', () => {
    const clean = validateCompareInput({ orgId: 'org-cah', textA: TEXT_A, textB: 'x'.repeat(4000) });
    assert.equal(clean.textA, TEXT_A);
  });

  it('rejects blank, oversize, and non-string inputs', () => {
    assert.throws(() => validateCompareInput({ orgId: 'org-cah', textA: '   ', textB: TEXT_B }), ValidationError);
    assert.throws(
      () => validateCompareInput({ orgId: 'org-cah', textA: TEXT_A, textB: 'y'.repeat(4001) }),
      ValidationError
    );
    assert.throws(
      () => validateCompareInput({ orgId: 'org-cah', textA: 42 as unknown as string, textB: TEXT_B }),
      ValidationError
    );
    assert.throws(() => validateCompareInput({ orgId: '', textA: TEXT_A, textB: TEXT_B }), ValidationError);
  });
});

describe('provider output validation (Phase 1)', () => {
  const difference = {
    kind: 'difference',
    summary: 'Logging method differs between drafts.',
    passageA: 'logged by hand',
    passageB: 'logged by scanner'
  };

  it('verifies quotations, assigns ids, and computes offsets with context', () => {
    const findings = validateProviderOutput(
      { findings: [difference, { kind: 'missing_in_b', summary: 'Only in A.', passageA: 'locked cabinets', passageB: null }] },
      TEXT_A,
      TEXT_B
    );
    assert.equal(findings.length, 2);
    assert.equal(findings[0].id, 'f1');
    assert.equal(findings[1].id, 'f2');
    const first = findings[0].passageA?.occurrences[0];
    assert.equal(first?.start, TEXT_A.indexOf('logged by hand'));
    assert.equal(first?.end, TEXT_A.indexOf('logged by hand') + 'logged by hand'.length);
    assert.ok((first?.contextBefore.length ?? 0) > 0);
    assert.equal(findings[1].passageB, null);
  });

  it('rejects blank, over-long, and non-verbatim quotations', () => {
    const blank = { ...difference, passageA: '   ' };
    assert.throws(() => validateProviderOutput({ findings: [blank] }, TEXT_A, TEXT_B), ProviderError);
    const invent = { ...difference, passageA: 'logged by carrier pigeon' };
    assert.throws(() => validateProviderOutput({ findings: [invent] }, TEXT_A, TEXT_B), ProviderError);
    const big = { ...difference, passageA: 'x'.repeat(501) };
    assert.throws(() => validateProviderOutput({ findings: [big] }, TEXT_A, TEXT_B), ProviderError);
  });

  it('enforces kind shape, summary rules, count caps, and strips provider ids', () => {
    const wrongSide = { kind: 'missing_in_b', summary: 's', passageA: null, passageB: 'locked cabinets' };
    assert.throws(() => validateProviderOutput({ findings: [wrongSide] }, TEXT_A, TEXT_B), ProviderError);
    const bothMissing = { kind: 'difference', summary: 's', passageA: 'locked cabinets', passageB: null };
    assert.throws(() => validateProviderOutput({ findings: [bothMissing] }, TEXT_A, TEXT_B), ProviderError);
    const neither = { kind: 'missing_in_a', summary: 's', passageA: null, passageB: null };
    assert.throws(() => validateProviderOutput({ findings: [neither] }, TEXT_A, TEXT_B), ProviderError);
    const blankSummary = { ...difference, summary: '  ' };
    assert.throws(() => validateProviderOutput({ findings: [blankSummary] }, TEXT_A, TEXT_B), ProviderError);
    const longSummary = { ...difference, summary: 's'.repeat(201) };
    assert.throws(() => validateProviderOutput({ findings: [longSummary] }, TEXT_A, TEXT_B), ProviderError);
    const badKind = { ...difference, kind: 'verdict' };
    assert.throws(() => validateProviderOutput({ findings: [badKind] }, TEXT_A, TEXT_B), ProviderError);
    const tooMany = Array.from({ length: 21 }, () => ({ ...difference }));
    assert.throws(() => validateProviderOutput({ findings: tooMany }, TEXT_A, TEXT_B), ProviderError);
    assert.throws(() => validateProviderOutput({ findings: 'nope' }, TEXT_A, TEXT_B), ProviderError);
    assert.throws(() => validateProviderOutput(null, TEXT_A, TEXT_B), ProviderError);
    const [stripped] = validateProviderOutput(
      { findings: [{ ...difference, id: 'evil' }] },
      TEXT_A,
      TEXT_B
    );
    assert.equal(stripped.id, 'f1');
  });

  it('allows an empty finding list (no differences)', () => {
    assert.deepEqual(validateProviderOutput({ findings: [] }, TEXT_A, TEXT_B), []);
  });

  it('marks malformed output as a 502 provider failure without content', () => {
    try {
      validateProviderOutput({ findings: [{ kind: 'difference' }] }, TEXT_A, TEXT_B);
      assert.fail('expected ProviderError');
    } catch (e) {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).status, 502);
      assert.ok(!(e as Error).message.includes('cabinets'));
    }
  });
});

describe('provider selection (Phase 1)', () => {
  it('defaults to off; mock is explicit; baseten is not wired yet', () => {
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_PROVIDER = 'off';
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_PROVIDER = 'garbage';
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_PROVIDER = 'baseten';
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_PROVIDER = 'mock';
    const provider = resolveProvider();
    assert.ok(provider);
    assert.equal(provider?.name, 'mock');
    assert.equal(provider?.notice, MOCK_NOTICE);
  });
});

describe('mock provider (Phase 1)', () => {
  it('quotes the actual inputs so fixtures always validate', async () => {
    const provider = createMockProvider();
    const raw = await provider.compare({ textA: TEXT_A, textB: TEXT_B }, AbortSignal.timeout(1000));
    const findings = validateProviderOutput(raw, TEXT_A, TEXT_B);
    assert.ok(findings.length >= 2);
    assert.ok(findings.some((f) => f.kind === 'difference'));
    assert.ok(findings.some((f) => f.kind.startsWith('missing_in_')));
  });

  it('malformed mode fails validation; timeout mode rejects on abort', async () => {
    const provider = createMockProvider();
    __setMockDocAuditMode('malformed');
    const raw = await provider.compare({ textA: TEXT_A, textB: TEXT_B }, AbortSignal.timeout(1000));
    assert.throws(() => validateProviderOutput(raw, TEXT_A, TEXT_B), ProviderError);
    __setMockDocAuditMode('timeout');
    await assert.rejects(provider.compare({ textA: TEXT_A, textB: TEXT_B }, AbortSignal.timeout(20)), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).status, 504);
      return true;
    });
  });

  it('adversarial mode keeps injection text as data with valid quotes', async () => {
    const provider = createMockProvider();
    __setMockDocAuditMode('adversarial');
    const raw = await provider.compare({ textA: TEXT_A, textB: TEXT_B }, AbortSignal.timeout(1000));
    const findings = validateProviderOutput(raw, TEXT_A, TEXT_B);
    assert.ok(findings.some((f) => f.summary.includes('IGNORE PREVIOUS INSTRUCTIONS')));
  });
});

describe('comparison throttle and timeout (Phase 1)', () => {
  it('allows a bounded burst per user, then blocks', () => {
    for (let i = 0; i < DOCAUDIT_THROTTLE_MAX; i++) {
      assert.equal(checkDocAuditThrottle('u-reviewer'), true);
    }
    assert.equal(checkDocAuditThrottle('u-reviewer'), false);
    assert.equal(checkDocAuditThrottle('u-other'), true);
  });

  it('exposes an overridable timeout with a safe default', () => {
    assert.equal(currentTimeoutMs(), 30000);
    __setDocAuditTimeoutMs(25);
    assert.equal(currentTimeoutMs(), 25);
  });
});

describe('passage occurrence enumeration (Phase 2)', () => {
  it('enumerates every location without a single selected offset', () => {
    const source = 'Seal valve A. Seal valve A. Seal valve B.';
    const [finding] = validateProviderOutput(
      {
        findings: [
          { kind: 'missing_in_b', summary: 'Repeated seal step.', passageA: 'Seal valve A.', passageB: null }
        ]
      },
      source,
      TEXT_B
    );
    const passage = finding.passageA;
    assert.ok(passage);
    // No silent first selection: no top-level start/end at all.
    assert.ok(!('start' in passage));
    assert.ok(!('end' in passage));
    assert.equal(passage.totalOccurrences, 2);
    assert.deepEqual(
      passage.occurrences.map((o) => o.start),
      [0, 14]
    );
    for (const o of passage.occurrences) {
      assert.equal(source.slice(o.start, o.end), 'Seal valve A.');
    }
  });

  it('finds overlapping matches', () => {
    assert.deepEqual(findOccurrences('aaaa', 'aa'), [0, 1, 2]);
    assert.deepEqual(findOccurrences('abababa', 'aba'), [0, 2, 4]);
    assert.deepEqual(findOccurrences('abc', 'z'), []);
  });

  it('uses UTF-16 offsets that round-trip non-BMP characters', () => {
    // A@0, 🔬@1-2, B@3, 🔬@4-5, C@6: surrogate pairs occupy two units each.
    assert.deepEqual(findOccurrences('A🔬B🔬C', '🔬'), [1, 4]);
    assert.deepEqual(findOccurrences('🔬🔬🔬', '🔬🔬'), [0, 2]);
    const [finding] = validateProviderOutput(
      {
        findings: [
          { kind: 'missing_in_b', summary: 'Scope calibration mark.', passageA: '🔬', passageB: null }
        ]
      },
      'A🔬B🔬C',
      TEXT_B
    );
    assert.equal(finding.passageA?.totalOccurrences, 2);
    for (const o of finding.passageA?.occurrences ?? []) {
      assert.equal('A🔬B🔬C'.slice(o.start, o.end), '🔬');
    }
  });

  it('caps the listing while reporting the exact total', () => {
    assert.equal(DOCAUDIT_MAX_OCCURRENCES, 20);
    const source = `${'log '.repeat(30)}end`;
    const [finding] = validateProviderOutput(
      { findings: [{ kind: 'missing_in_b', summary: 'Frequent word.', passageA: 'log', passageB: null }] },
      source,
      TEXT_B
    );
    assert.equal(finding.passageA?.totalOccurrences, 30);
    assert.equal(finding.passageA?.occurrences.length, 20);
    assert.deepEqual(
      (finding.passageA?.occurrences ?? []).map((o) => o.start),
      findOccurrences(source, 'log').slice(0, 20)
    );
  });
});

describe('follow-up validation (Phase 2)', () => {
  const TEXT_B2 = 'Alpha site stores fuel in locked cabinets. Nightly counts are logged by scanner. Scanner recalibrated.';
  function validFollowup(): Record<string, unknown> {
    return {
      idempotencyKey: 'phase2-key-001',
      orgId: 'org-cah',
      domainId: 'dom-hipaa-h',
      title: 'Recheck nightly fuel counts',
      ownerId: 'u-nurse-mgr',
      dueDate: '2027-03-01',
      findingId: 'f1',
      kind: 'difference',
      summary: 'Logging method differs between drafts.',
      textA: TEXT_A,
      textB: TEXT_B2,
      passages: [
        { side: 'A', text: 'logged by hand', start: TEXT_A.indexOf('logged by hand'), end: TEXT_A.indexOf('logged by hand') + 'logged by hand'.length, occurrenceIndex: 0 },
        { side: 'B', text: 'logged by scanner', start: TEXT_B2.indexOf('logged by scanner'), end: TEXT_B2.indexOf('logged by scanner') + 'logged by scanner'.length, occurrenceIndex: 0 }
      ]
    };
  }

  it('accepts a verified selection and hashes the canonical payload', () => {
    const clean = validateFollowupInput(validFollowup());
    assert.equal(clean.key, 'phase2-key-001');
    assert.equal(clean.passages.length, 2);
    assert.equal(clean.passages[0].totalOccurrences, 1);
    assert.match(clean.contentHash, /^[0-9a-f]{64}$/);
    // The hash covers content, not the key: same payload, new key, same hash.
    const rekeyed = validateFollowupInput({ ...validFollowup(), idempotencyKey: 'phase2-key-002' });
    assert.equal(rekeyed.contentHash, clean.contentHash);
    assert.equal(
      followupContentHash({ ...clean, passages: clean.passages }),
      clean.contentHash
    );
  });

  it('accepts a non-first occurrence selected by the reviewer', () => {
    const textA = 'Seal valve A. Seal valve A. Seal valve B.';
    const starts = findOccurrences(textA, 'Seal valve A.');
    const clean = validateFollowupInput({
      ...validFollowup(),
      kind: 'missing_in_b',
      textA,
      passages: [
        { side: 'A', text: 'Seal valve A.', start: starts[1], end: starts[1] + 'Seal valve A.'.length, occurrenceIndex: 1 }
      ]
    });
    assert.equal(clean.passages[0].occurrenceIndex, 1);
    assert.equal(clean.passages[0].start, starts[1]);
    assert.equal(clean.passages[0].totalOccurrences, 2);
  });

  it('rejects tampered offsets, unknown locations, and non-verbatim text', () => {
    const good = validFollowup();
    const first = (good.passages as Array<Record<string, unknown>>)[0];
    assert.throws(
      () => validateFollowupInput({ ...good, passages: [{ ...first, start: (first.start as number) + 1 }, (good.passages as unknown[])[1]] }),
      (e: unknown) => e instanceof ValidationError && (e as Error).message === 'Finding passage 1 does not match the selected location.'
    );
    assert.throws(
      () => validateFollowupInput({ ...good, passages: [{ ...first, occurrenceIndex: 7 }, (good.passages as unknown[])[1]] }),
      (e: unknown) => e instanceof ValidationError && (e as Error).message === 'Finding passage 1 selects an unknown passage location.'
    );
    assert.throws(
      () => validateFollowupInput({ ...good, passages: [{ ...first, text: 'logged by carrier pigeon' }, (good.passages as unknown[])[1]] }),
      (e: unknown) => e instanceof ValidationError && !(e as Error).message.includes('pigeon')
    );
  });

  it('enforces kind shape and required fields with fixed messages', () => {
    const good = validFollowup();
    assert.throws(() => validateFollowupInput({ ...good, kind: 'verdict' }), ValidationError);
    assert.throws(
      () => validateFollowupInput({ ...good, kind: 'missing_in_b' }),
      (e: unknown) => e instanceof ValidationError && (e as Error).message === 'This finding kind needs exactly the first-text passage.'
    );
    assert.throws(() => validateFollowupInput({ ...good, idempotencyKey: '   ' }), ValidationError);
    assert.throws(() => validateFollowupInput({ ...good, summary: '  ' }), ValidationError);
    assert.throws(() => validateFollowupInput({ ...good, passages: [] }), ValidationError);
    assert.throws(() => validateFollowupInput('not-an-object'), ValidationError);
  });

  it('pins the fixed 409 conflict message', () => {
    assert.equal(IDEMPOTENCY_CONFLICT, 'Idempotency key already used with different content.');
  });
});

describe('follow-up storage health (WM2-1/WM2-2)', () => {
  const TASK = {
    id: 'task-followup-1',
    orgId: 'org-cah',
    docauditSource: { findingId: 'f1', kind: 'difference', summary: 's', passages: [] }
  };
  const RECORD = {
    key: 'k1',
    actorId: 'u-nurse-mgr',
    orgId: 'org-cah',
    taskId: 'task-followup-1',
    contentHash: 'a'.repeat(64),
    createdAt: '2027-01-01T00:00:00.000Z'
  };
  function fakeDb(over: { docauditKeys?: unknown; tasks?: unknown }): DbShape {
    return {
      version: 1,
      orgs: [],
      domains: [],
      users: [],
      tasks: [],
      templates: [],
      capas: [],
      obligations: [],
      audit: [],
      docauditKeys: [],
      ...over
    } as unknown as DbShape;
  }

  it('accepts healthy stores and returns the live array', () => {
    const db = fakeDb({ docauditKeys: [{ ...RECORD }], tasks: [{ ...TASK }] });
    const health = docauditKeysHealth(db);
    assert.equal(health.ok, true);
    if (health.ok) assert.equal(health.keys, db.docauditKeys);
    assert.equal(docauditKeysHealth(fakeDb({})).ok, true);
  });

  it('rejects missing and wrong-type collections', () => {
    for (const keys of [undefined, null, 42, 'keys', { k: 1 }, true]) {
      assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: keys, tasks: [{ ...TASK }] })).ok, false);
    }
    // Corrupt task lists fail closed rather than throwing.
    assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD }], tasks: 42 })).ok, false);
    assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD }], tasks: [null] })).ok, false);
  });

  it('rejects null, malformed, and duplicate entries', () => {
    const tasks = [{ ...TASK }];
    for (const entry of [null, {}, { key: 'k1' }, { ...RECORD, taskId: 42 }, { ...RECORD, key: '' }, 'x']) {
      assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [entry], tasks })).ok, false);
    }
    assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD }, { ...RECORD }], tasks })).ok, false);
    assert.equal(
      docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD }, { ...RECORD, contentHash: 'b'.repeat(64) }], tasks })).ok,
      false
    );
    // Distinct scopes stay healthy.
    const other = { ...RECORD, key: 'k2', taskId: 'task-followup-2' };
    const task2 = { ...TASK, id: 'task-followup-2' };
    assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD }, other], tasks: [{ ...TASK }, task2] })).ok, true);
  });

  it('rejects broken references, org mismatches, and orphaned tasks', () => {
    const tasks = [{ ...TASK }];
    assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD, taskId: 'task-nope' }], tasks })).ok, false);
    assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD, orgId: 'org-clinic' }], tasks })).ok, false);
    assert.equal(
      docauditKeysHealth(fakeDb({ docauditKeys: [{ ...RECORD }], tasks: [{ id: 'task-followup-1', orgId: 'org-cah' }] })).ok,
      false
    );
    assert.equal(docauditKeysHealth(fakeDb({ docauditKeys: [], tasks })).ok, false);
  });

  it('pins the fixed 503 message and diagnostic code', () => {
    assert.equal(FOLLOWUPS_UNAVAILABLE, 'Document-audit follow-ups are unavailable.');
    assert.equal(FOLLOWUPS_UNAVAILABLE_CODE, 'docaudit.keys.unavailable');
  });
});
