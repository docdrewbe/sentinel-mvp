// Baseten adapter checks with injected mock transports. No test here performs
// a real provider call: every comparison runs against a stub fetch, so these
// tests prove adapter behavior (selection, request shape, parsing, limits,
// error mapping, cancellation, containment) — never real-model accuracy.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASETEN_ACCESS_REFUSED,
  BASETEN_LIMIT_REACHED,
  BASETEN_OUTPUT_TRUNCATED,
  BASETEN_OUTPUT_UNUSABLE,
  BASETEN_UPSTREAM_FAILED,
  DOCAUDIT_BASETEN_DEFAULT_BASE_URL,
  DOCAUDIT_BASETEN_MAX_RESPONSE_BYTES,
  DOCAUDIT_BASETEN_MAX_TOKENS,
  DOCAUDIT_BASETEN_TEMPERATURE,
  __setBasetenFetch,
  createBasetenProvider,
  isBasetenConfigured,
  resolveBasetenConfig
} from '../docaudit-baseten.js';
import {
  DOCAUDIT_MAX_TEXT_CHARS,
  PROVIDER_NOT_CONFIGURED,
  ProviderError,
  __resetDocAuditThrottle,
  __setDocAuditTimeoutMs,
  resolveProvider,
  validateProviderOutput
} from '../docaudit.js';
import { DOCAUDIT_EVAL_CASES, DOCAUDIT_EVAL_STATUS } from './docaudit-eval-fixtures.js';

const TEST_KEY = 'test-key-synthetic';
const TEST_MODEL = 'meta-models/muse-spark-open';
const CANARY = 'CANARY-BASETEN-7q2x';

function setBasetenEnv(): void {
  process.env.DOCAUDIT_PROVIDER = 'baseten';
  process.env.DOCAUDIT_BASETEN_API_KEY = TEST_KEY;
  process.env.DOCAUDIT_BASETEN_MODEL = TEST_MODEL;
}

afterEach(() => {
  delete process.env.DOCAUDIT_PROVIDER;
  delete process.env.DOCAUDIT_BASETEN_API_KEY;
  delete process.env.DOCAUDIT_BASETEN_MODEL;
  delete process.env.DOCAUDIT_BASETEN_BASE_URL;
  __setBasetenFetch(null);
  __resetDocAuditThrottle();
  __setDocAuditTimeoutMs(null);
});

/** Minimal Chat Completions envelope carrying assistant `content`. */
function envelope(content: string, finishReason = 'stop'): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }]
  });
}

function stubFetch(handler: (url: unknown, init: unknown) => unknown): typeof fetch {
  return handler as unknown as typeof fetch;
}

async function rejectsProvider(
  run: Promise<unknown>,
  status: 502 | 503 | 504,
  message: string
): Promise<void> {
  await assert.rejects(
    run,
    (e: unknown) => e instanceof ProviderError && e.status === status && e.message === message
  );
}

describe('baseten selection and configuration', () => {
  it('stays off by default: unset, off, and unknown resolve to null', () => {
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_PROVIDER = 'off';
    process.env.DOCAUDIT_BASETEN_API_KEY = TEST_KEY;
    process.env.DOCAUDIT_BASETEN_MODEL = TEST_MODEL;
    assert.equal(resolveProvider(), null);
    assert.equal(isBasetenConfigured(), true);
    process.env.DOCAUDIT_PROVIDER = 'bogus';
    assert.equal(resolveProvider(), null);
  });

  it('requires explicit key and model: gaps resolve to null', () => {
    process.env.DOCAUDIT_PROVIDER = 'baseten';
    assert.equal(resolveBasetenConfig(), null);
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_BASETEN_API_KEY = TEST_KEY;
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_BASETEN_API_KEY = '   ';
    process.env.DOCAUDIT_BASETEN_MODEL = TEST_MODEL;
    assert.equal(resolveProvider(), null);
  });

  it('rejects unsafe or malformed base URLs', () => {
    setBasetenEnv();
    for (const baseUrl of ['ftp://example.com/v1', 'http://example.com/v1', 'not-a-url']) {
      process.env.DOCAUDIT_BASETEN_BASE_URL = baseUrl;
      assert.equal(resolveBasetenConfig(), null, baseUrl);
    }
  });

  it('falls back to the documented endpoint and allows loopback stubs', () => {
    setBasetenEnv();
    assert.equal(resolveBasetenConfig()?.baseUrl, DOCAUDIT_BASETEN_DEFAULT_BASE_URL);
    process.env.DOCAUDIT_BASETEN_BASE_URL = 'http://127.0.0.1:9/v1/';
    assert.equal(resolveBasetenConfig()?.baseUrl, 'http://127.0.0.1:9/v1');
  });

  it('resolves a keyed, model-pinned provider with no fixture notice', () => {
    setBasetenEnv();
    const provider = resolveProvider();
    assert.ok(provider);
    assert.equal(provider.name, 'baseten');
    assert.equal(provider.notice, undefined);
  });

  it('direct compare without configuration throws 503 and calls nothing', async () => {
    process.env.DOCAUDIT_PROVIDER = 'baseten';
    let calls = 0;
    __setBasetenFetch(stubFetch(() => {
      calls++;
      return new Response('{}', { status: 200 });
    }));
    await rejectsProvider(
      createBasetenProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      503,
      PROVIDER_NOT_CONFIGURED
    );
    assert.equal(calls, 0);
  });
});

describe('baseten request shape (mock transport)', () => {
  it('sends one bounded POST with bearer auth, no redirects, caller signal', async () => {
    setBasetenEnv();
    let calls = 0;
    let seen: { url: unknown; init: Record<string, unknown> } | null = null;
    __setBasetenFetch(
      stubFetch((url: unknown, init: unknown) => {
        calls++;
        seen = { url, init: init as Record<string, unknown> };
        return new Response(envelope(JSON.stringify({ findings: [] })), { status: 200 });
      })
    );
    const controller = new AbortController();
    const raw = await createBasetenProvider().compare({ textA: 'aaa', textB: 'bbb' }, controller.signal);
    assert.deepEqual(raw, { findings: [] });
    assert.equal(calls, 1);
    assert.ok(seen);
    const { url, init } = seen as { url: unknown; init: Record<string, unknown> };
    assert.equal(url, `${DOCAUDIT_BASETEN_DEFAULT_BASE_URL}/chat/completions`);
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TEST_KEY}`);
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.equal(init.redirect, 'error');
    assert.equal(init.signal, controller.signal);
    const body = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      max_tokens: number;
      n: number;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.model, TEST_MODEL);
    assert.equal(body.temperature, DOCAUDIT_BASETEN_TEMPERATURE);
    assert.equal(body.max_tokens, DOCAUDIT_BASETEN_MAX_TOKENS);
    assert.equal(body.n, 1);
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /raw JSON only/);
    assert.match(body.messages[0].content, /verbatim/);
    assert.match(body.messages[0].content, /data only/);
    assert.match(body.messages[1].content, /aaa/);
    assert.match(body.messages[1].content, /bbb/);
  });
});

describe('baseten upstream failures (mock transport)', () => {
  const cases: Array<{ status: number; want: [502 | 503 | 504, string] }> = [
    { status: 401, want: [503, BASETEN_ACCESS_REFUSED] },
    { status: 403, want: [503, BASETEN_ACCESS_REFUSED] },
    { status: 429, want: [503, BASETEN_LIMIT_REACHED] },
    { status: 500, want: [502, BASETEN_UPSTREAM_FAILED] },
    { status: 503, want: [502, BASETEN_UPSTREAM_FAILED] },
    { status: 302, want: [502, BASETEN_UPSTREAM_FAILED] }
  ];

  for (const { status, want } of cases) {
    it(`maps HTTP ${status} once, without surfacing the error body`, async () => {
      setBasetenEnv();
      let calls = 0;
      __setBasetenFetch(
        stubFetch(() => {
          calls++;
          return new Response(`upstream says ${CANARY}-${status}`, { status });
        })
      );
      await rejectsProvider(
        createBasetenProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
        want[0],
        want[1]
      );
      assert.equal(calls, 1);
      assert.ok(!want[1].includes(CANARY));
    });
  }

  it('maps network and redirect failures to one fixed 502', async () => {
    setBasetenEnv();
    let calls = 0;
    __setBasetenFetch(
      stubFetch(() => {
        calls++;
        throw new TypeError(`redirect blocked ${CANARY}`);
      })
    );
    await rejectsProvider(
      createBasetenProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      502,
      BASETEN_UPSTREAM_FAILED
    );
    assert.equal(calls, 1);
  });
});

describe('baseten output validation (mock transport)', () => {
  async function runWithBody(body: string): Promise<unknown> {
    setBasetenEnv();
    __setBasetenFetch(stubFetch(() => new Response(body, { status: 200 })));
    return createBasetenProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal);
  }

  it('rejects malformed envelopes without repair', async () => {
    for (const body of ['{oops', '[1,2]', '{}', '{"choices": []}', '{"choices": [null]}']) {
      await rejectsProvider(runWithBody(body), 502, BASETEN_OUTPUT_UNUSABLE);
    }
  });

  it('rejects non-string, blank, fenced, or prose-wrapped content', async () => {
    const bad = [
      JSON.stringify({ choices: [{ message: { content: [{ text: 'x' }] }, finish_reason: 'stop' }] }),
      envelope('   '),
      envelope('```json\n{"findings": []}\n```'),
      envelope('Here are the findings: {"findings": []}'),
      envelope('{"findings": [oops]}')
    ];
    for (const body of bad) {
      await rejectsProvider(runWithBody(body), 502, BASETEN_OUTPUT_UNUSABLE);
    }
  });

  it('rejects token-truncated output even when it would still parse', async () => {
    await rejectsProvider(
      runWithBody(envelope(JSON.stringify({ findings: [] }), 'length')),
      502,
      BASETEN_OUTPUT_TRUNCATED
    );
  });

  it('rejects oversized bodies, stopping the stream read early', async () => {
    setBasetenEnv();
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));
      }
    });
    __setBasetenFetch(stubFetch(() => new Response(stream, { status: 200 })));
    await rejectsProvider(
      createBasetenProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      502,
      BASETEN_OUTPUT_UNUSABLE
    );
    assert.ok(pulls <= 10, `expected early stop, pulls=${pulls}`);
    assert.ok(DOCAUDIT_BASETEN_MAX_RESPONSE_BYTES, 'byte cap is configured');
  });

  it('caps the null-body fallback path too', async () => {
    setBasetenEnv();
    const huge = { ok: true, status: 200, body: null, text: async () => 'y'.repeat(70000) };
    __setBasetenFetch(stubFetch(() => huge));
    await rejectsProvider(
      createBasetenProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      502,
      BASETEN_OUTPUT_UNUSABLE
    );
  });
});

describe('baseten cancellation (mock transport)', () => {
  it('maps a pre-aborted signal to 504', async () => {
    setBasetenEnv();
    __setBasetenFetch(
      stubFetch((_url: unknown, init: unknown) => {
        if ((init as { signal: AbortSignal }).signal.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        return new Response(envelope('{}'), { status: 200 });
      })
    );
    const controller = new AbortController();
    controller.abort();
    await rejectsProvider(
      createBasetenProvider().compare({ textA: 'a', textB: 'b' }, controller.signal),
      504,
      'Comparison timed out.'
    );
  });

  it('maps mid-flight aborts and timeouts to 504', async () => {
    setBasetenEnv();
    __setBasetenFetch(
      stubFetch(
        (_url: unknown, init: unknown) =>
          new Promise((_resolve, reject) => {
            (init as { signal: AbortSignal }).signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            );
          })
      )
    );
    const controller = new AbortController();
    const pending = createBasetenProvider().compare(
      { textA: 'a', textB: 'b' },
      controller.signal
    );
    controller.abort();
    await rejectsProvider(pending, 504, 'Comparison timed out.');
    await rejectsProvider(
      createBasetenProvider().compare({ textA: 'a', textB: 'b' }, AbortSignal.timeout(10)),
      504,
      'Comparison timed out.'
    );
  });
});

describe('baseten log containment (mock transport)', () => {
  it('logs nothing: no key, prompts, completions, or upstream bodies', async () => {
    setBasetenEnv();
    const logged: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    console.log = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      __setBasetenFetch(
        stubFetch(() => {
          throw new Error(`carrier ${CANARY} key=${TEST_KEY}`);
        })
      );
      await rejectsProvider(
        createBasetenProvider().compare(
          { textA: `alpha ${CANARY}`, textB: `beta ${CANARY}` },
          new AbortController().signal
        ),
        502,
        BASETEN_UPSTREAM_FAILED
      );
      __setBasetenFetch(stubFetch(() => new Response(`{oops ${CANARY}}`, { status: 200 })));
      await rejectsProvider(
        createBasetenProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
        502,
        BASETEN_OUTPUT_UNUSABLE
      );
    } finally {
      console.error = origError;
      console.log = origLog;
      console.warn = origWarn;
    }
    assert.deepEqual(logged, []);
  });
});

// HTTP suite: isolated temp database, ephemeral ports. Mirrors api.test.ts.
const workdir = mkdtempSync(join(tmpdir(), 'sentinel-baseten-'));
process.env.SENTINEL_DATA_FILE = join(workdir, 'sentinel.json');
const dataFile = process.env.SENTINEL_DATA_FILE;

const { createApp } = await import('../app.js');
const { seedDatabase } = await import('../seed.js');
const store = await import('../store.js');

interface TestServer {
  db: ReturnType<typeof seedDatabase>;
  base: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const db = seedDatabase();
  store.saveDb(db);
  const app = createApp(db);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    db,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

async function call(
  base: string,
  userId: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/docaudit/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-demo-user-id': userId },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

const TEXT_A = `Depot log ${CANARY}-A: counts by hand. Cabinets locked.`;
const TEXT_B = `Depot log ${CANARY}-B: counts by scanner. Cabinets locked.`;

function findingsBody(): string {
  return JSON.stringify({
    findings: [
      { kind: 'difference', summary: 'Counting method differs.', passageA: 'counts by hand', passageB: 'counts by scanner' }
    ]
  });
}

describe('baseten compare route (HTTP, mock transport)', () => {
  it('verifies stubbed findings through the existing contract, metadata-only audit', async () => {
    setBasetenEnv();
    __setBasetenFetch(stubFetch(() => new Response(envelope(findingsBody()), { status: 200 })));
    const { db, base, close } = await startServer();
    try {
      const before = db.audit.length;
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: TEXT_A, textB: TEXT_B });
      assert.equal(res.status, 200);
      assert.equal(res.json.provider, 'baseten');
      assert.ok(!('notice' in res.json));
      const findings = res.json.findings as Array<{ kind: string; passageA: unknown; passageB: unknown }>;
      assert.equal(findings.length, 1);
      assert.equal(findings[0].kind, 'difference');
      assert.ok(findings[0].passageA);
      assert.ok(findings[0].passageB);
      assert.equal(db.audit.length, before + 1);
      const event = db.audit[db.audit.length - 1] as { action: string; detail: string };
      assert.equal(event.action, 'docaudit.completed');
      assert.match(event.detail, /via baseten/);
      assert.ok(!event.detail.includes(CANARY));
      assert.ok(!JSON.stringify(res.json).includes(TEST_KEY));
    } finally {
      await close();
    }
  });

  it('missing configuration answers 503 without consuming throttle budget', async () => {
    const { base, close } = await startServer();
    try {
      process.env.DOCAUDIT_PROVIDER = 'baseten';
      for (let i = 0; i < 10; i++) {
        const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: 'a', textB: 'b' });
        assert.equal(res.status, 503);
        assert.equal(res.json.error, PROVIDER_NOT_CONFIGURED);
      }
      setBasetenEnv();
      __setBasetenFetch(stubFetch(() => new Response(envelope('{"findings": []}'), { status: 200 })));
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: 'a', textB: 'b' });
      assert.equal(res.status, 200);
    } finally {
      await close();
    }
  });

  it('upstream failures answer fixed errors and leave data and audit history unchanged', async () => {
    setBasetenEnv();
    __setBasetenFetch(stubFetch(() => new Response(`nope ${CANARY}`, { status: 429 })));
    const { db, base, close } = await startServer();
    try {
      const diskBefore = readFileSync(dataFile, 'utf8');
      const auditBefore = db.audit.length;
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: TEXT_A, textB: TEXT_B });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, BASETEN_LIMIT_REACHED);
      assert.ok(!JSON.stringify(res.json).includes(CANARY));
      assert.equal(db.audit.length, auditBefore);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
    } finally {
      await close();
    }
  });

  it('timeouts cancel the stubbed request and answer 504 without writes', async () => {
    setBasetenEnv();
    __setDocAuditTimeoutMs(20);
    __setBasetenFetch(
      stubFetch(
        (_url: unknown, init: unknown) =>
          new Promise((_resolve, reject) => {
            (init as { signal: AbortSignal }).signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            );
          })
      )
    );
    const { db, base, close } = await startServer();
    try {
      const auditBefore = db.audit.length;
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: 'a', textB: 'b' });
      assert.equal(res.status, 504);
      assert.equal(res.json.error, 'Comparison timed out.');
      assert.equal(db.audit.length, auditBefore);
    } finally {
      await close();
    }
  });

  it('preserves role checks: staff cannot run comparisons', async () => {
    setBasetenEnv();
    __setBasetenFetch(stubFetch(() => new Response(envelope('{"findings": []}'), { status: 200 })));
    const { base, close } = await startServer();
    try {
      const res = await call(base, 'u-staff', { orgId: 'org-cah', textA: 'a', textB: 'b' });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('equivalent texts with an empty stubbed set answer 200 with zero findings', async () => {
    setBasetenEnv();
    __setBasetenFetch(stubFetch(() => new Response(envelope('{"findings": []}'), { status: 200 })));
    const { base, close } = await startServer();
    try {
      const same = 'Cabinet keys are signed out at the front desk.';
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: same, textB: same });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.findings, []);
    } finally {
      await close();
    }
  });
});

describe('synthetic evaluation fixtures (mocked harness only)', () => {
  it('pins the mock-harness-only status: no real-model accuracy claims', () => {
    assert.match(DOCAUDIT_EVAL_STATUS, /^mock-harness-only/);
    assert.match(DOCAUDIT_EVAL_STATUS, /real-model accuracy unevaluated/);
  });

  it('keeps fixtures well-formed, capped, and uniquely identified', () => {
    const ids = new Set<string>();
    for (const c of DOCAUDIT_EVAL_CASES) {
      assert.ok(c.id && !ids.has(c.id));
      ids.add(c.id);
      assert.ok(c.textA.trim() && c.textB.trim());
      assert.ok(c.textA.length <= DOCAUDIT_MAX_TEXT_CHARS);
      assert.ok(c.textB.length <= DOCAUDIT_MAX_TEXT_CHARS);
      for (const kind of c.expectedKinds) {
        assert.ok(kind === 'difference' || kind === 'missing_in_a' || kind === 'missing_in_b');
      }
      assert.ok(c.qualityNotes.length > 0);
    }
    assert.ok(
      DOCAUDIT_EVAL_CASES.some((c) => c.expectedKinds.length === 0),
      'equivalent-texts case present'
    );
  });

  it('HARNESS ONLY: canned per-fixture output flows through compare plus validation', async () => {
    for (const c of DOCAUDIT_EVAL_CASES) {
      setBasetenEnv();
      const canned = {
        findings: c.expectedKinds.map((kind, i) => ({
          kind,
          summary: `Harness finding ${i + 1} for ${c.id}.`,
          passageA: kind === 'missing_in_a' ? null : c.textA.slice(0, 60),
          passageB: kind === 'missing_in_b' ? null : c.textB.slice(0, 60)
        }))
      };
      __setBasetenFetch(stubFetch(() => new Response(envelope(JSON.stringify(canned)), { status: 200 })));
      const raw = await createBasetenProvider().compare(
        { textA: c.textA, textB: c.textB },
        new AbortController().signal
      );
      const findings = validateProviderOutput(raw, c.textA, c.textB);
      assert.deepEqual(
        findings.map((f) => f.kind).sort(),
        [...c.expectedKinds].sort(),
        c.id
      );
    }
  });

  it('isolates state: temp database file and ephemeral ports only', () => {
    assert.ok(dataFile.startsWith(workdir));
    assert.notEqual(dataFile, join(process.cwd(), 'data', 'sentinel.json'));
  });
});
