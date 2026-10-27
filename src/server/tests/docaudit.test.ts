import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCAUDIT_MAX_FINDINGS,
  DOCAUDIT_MAX_PASSAGE_CHARS,
  DOCAUDIT_MAX_SUMMARY_CHARS,
  DOCAUDIT_MAX_TEXT_CHARS,
  DOCAUDIT_THROTTLE_MAX,
  MOCK_NOTICE,
  NO_MATCHING_PASSAGE,
  ProviderError,
  __resetDocAuditThrottle,
  __setDocAuditTimeoutMs,
  __setMockDocAuditMode,
  checkDocAuditThrottle,
  createMockProvider,
  currentTimeoutMs,
  resolveProvider,
  validateCompareInput,
  validateProviderOutput
} from '../docaudit.js';
import { ValidationError } from '../store.js';

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
    assert.equal(findings[0].passageA?.start, TEXT_A.indexOf('logged by hand'));
    assert.equal(findings[0].passageA?.end, TEXT_A.indexOf('logged by hand') + 'logged by hand'.length);
    assert.ok((findings[0].passageA?.contextBefore.length ?? 0) > 0);
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
