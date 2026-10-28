// Modal Shared Endpoint adapter checks with injected mock transports. No test
// here performs a real provider call: every comparison runs against a stub
// fetch or a loopback stub server, so these tests prove adapter behavior
// (selection, request shape, parsing, limits, error mapping, cancellation,
// containment) — never real-model accuracy.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODAL_ACCESS_REFUSED,
  MODAL_LIMIT_REACHED,
  MODAL_OUTPUT_TRUNCATED,
  MODAL_OUTPUT_UNUSABLE,
  MODAL_UPSTREAM_FAILED,
  DOCAUDIT_MODAL_DEFAULT_BASE_URL,
  DOCAUDIT_MODAL_MAX_RESPONSE_BYTES,
  DOCAUDIT_MODAL_MAX_TOKENS,
  DOCAUDIT_MODAL_TEMPERATURE,
  DOCAUDIT_MODAL_ALLOWED_HOST,
  __setModalBaseUrlOverride,
  __setModalFetch,
  createModalProvider,
  isModalConfigured,
  resolveModalConfig
} from '../docaudit-modal.js';
import {
  PROVIDER_NOT_CONFIGURED,
  ProviderError,
  __resetDocAuditThrottle,
  __setDocAuditTimeoutMs,
  resolveProvider
} from '../docaudit.js';

const TEST_KEY = 'test-key-synthetic';
const TEST_MODEL = 'meta-models/Muse-Spark-Open-816B-A42B';
const CANARY = 'CANARY-MODAL-9k4z';
const DASHBOARD_ORIGIN = `https://${DOCAUDIT_MODAL_ALLOWED_HOST}`;

function setModalEnv(): void {
  process.env.DOCAUDIT_PROVIDER = 'modal';
  process.env.DOCAUDIT_MODAL_API_KEY = TEST_KEY;
  process.env.DOCAUDIT_MODAL_MODEL = TEST_MODEL;
}

afterEach(() => {
  delete process.env.DOCAUDIT_PROVIDER;
  delete process.env.DOCAUDIT_MODAL_API_KEY;
  delete process.env.DOCAUDIT_MODAL_MODEL;
  delete process.env.DOCAUDIT_MODAL_BASE_URL;
  __setModalFetch(null);
  __setModalBaseUrlOverride(null);
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

describe('modal selection and configuration', () => {
  it('stays off by default: unset, off, and unknown resolve to null', () => {
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_PROVIDER = 'off';
    process.env.DOCAUDIT_MODAL_API_KEY = TEST_KEY;
    process.env.DOCAUDIT_MODAL_MODEL = TEST_MODEL;
    assert.equal(resolveProvider(), null);
    assert.equal(isModalConfigured(), true);
    process.env.DOCAUDIT_PROVIDER = 'bogus';
    assert.equal(resolveProvider(), null);
  });

  it('requires explicit key and model: gaps resolve to null', () => {
    process.env.DOCAUDIT_PROVIDER = 'modal';
    assert.equal(resolveModalConfig(), null);
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_MODAL_API_KEY = TEST_KEY;
    assert.equal(resolveProvider(), null);
    process.env.DOCAUDIT_MODAL_API_KEY = '   ';
    process.env.DOCAUDIT_MODAL_MODEL = TEST_MODEL;
    assert.equal(resolveProvider(), null);
  });

  it('pins production to the exact dashboard origin and API path', () => {
    setModalEnv();
    assert.equal(resolveModalConfig()?.baseUrl, DOCAUDIT_MODAL_DEFAULT_BASE_URL);
    // Equivalent spellings of the same pinned endpoint canonicalize,
    // including the bare dashboard origin exactly as the dashboard shows it.
    for (const baseUrl of [
      DASHBOARD_ORIGIN,
      `${DASHBOARD_ORIGIN}/`,
      `https://${DOCAUDIT_MODAL_ALLOWED_HOST}/v1`,
      `https://${DOCAUDIT_MODAL_ALLOWED_HOST}/v1/`,
      `https://${DOCAUDIT_MODAL_ALLOWED_HOST}:443/v1`,
      `https://${DOCAUDIT_MODAL_ALLOWED_HOST.toUpperCase()}/v1`,
      `  https://${DOCAUDIT_MODAL_ALLOWED_HOST}/v1  `,
      `https://${DOCAUDIT_MODAL_ALLOWED_HOST}/x/../v1`
    ]) {
      process.env.DOCAUDIT_MODAL_BASE_URL = baseUrl;
      assert.equal(resolveModalConfig()?.baseUrl, DOCAUDIT_MODAL_DEFAULT_BASE_URL, baseUrl);
    }
  });

  it('rejects other hosts, ports, paths, credentials, queries, fragments', () => {
    setModalEnv();
    const host = DOCAUDIT_MODAL_ALLOWED_HOST;
    const rejected = [
      `https://${host}.evil.com/v1`,
      `https://evil-${host}/v1`,
      'https://other--ep-muse-spark-open-816b-a42b-server.us-west.modal.direct/v1',
      'https://us-west.modal.direct/v1',
      'https://modal.direct/v1',
      `https://${host}./v1`,
      `https://user:pass@${host}/v1`,
      `https://${host}@evil.com/v1`,
      `https://${host}:8443/v1`,
      `https://${host}/v1/extra`,
      `https://${host}/v2`,
      `https://${host}/V1`,
      `https://${host}/v1/chat`,
      `https://${host}/v1?key=x`,
      `https://${host}/v1#frag`,
      `https://${host}/%76%31`,
      `http://${host}/v1`,
      `ftp://${host}/v1`,
      'not-a-url'
    ];
    for (const baseUrl of rejected) {
      process.env.DOCAUDIT_MODAL_BASE_URL = baseUrl;
      assert.equal(resolveModalConfig(), null, baseUrl);
      assert.equal(resolveProvider(), null, baseUrl);
    }
  });

  it('rejects loopback through normal configuration', () => {
    setModalEnv();
    for (const baseUrl of [
      'http://127.0.0.1:9/v1',
      'http://localhost:9/v1',
      'http://[::1]:9/v1',
      'https://127.0.0.1/v1'
    ]) {
      process.env.DOCAUDIT_MODAL_BASE_URL = baseUrl;
      assert.equal(resolveModalConfig(), null, baseUrl);
      assert.equal(resolveProvider(), null, baseUrl);
    }
  });

  it('rejected addresses make zero requests and never receive the key', async () => {
    const host = DOCAUDIT_MODAL_ALLOWED_HOST;
    const rejected = [
      `https://${host}.evil.com/v1`,
      `https://user:pass@${host}/v1`,
      `https://${host}:8443/v1`,
      `https://${host}/v1/extra`,
      `https://${host}/v1?key=x`,
      'http://127.0.0.1:9/v1',
      'not-a-url'
    ];
    for (const baseUrl of rejected) {
      setModalEnv();
      process.env.DOCAUDIT_MODAL_BASE_URL = baseUrl;
      let calls = 0;
      let leaked = '';
      __setModalFetch(
        stubFetch((url: unknown, init: unknown) => {
          calls++;
          leaked = JSON.stringify({ url, init });
          return new Response('{}', { status: 200 });
        })
      );
      await rejectsProvider(
        createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
        503,
        PROVIDER_NOT_CONFIGURED
      );
      assert.equal(calls, 0, baseUrl);
      assert.equal(leaked, '', baseUrl);
    }
  });

  it('test-only override enables loopback stubs and rejects everything else', () => {
    setModalEnv();
    __setModalBaseUrlOverride('http://127.0.0.1:9/v1/');
    assert.equal(resolveModalConfig()?.baseUrl, 'http://127.0.0.1:9/v1');
    assert.ok(resolveProvider());
    __setModalBaseUrlOverride('http://localhost:9/stub');
    assert.equal(resolveModalConfig()?.baseUrl, 'http://localhost:9/stub');
    __setModalBaseUrlOverride('http://[::1]:9/v1');
    assert.equal(resolveModalConfig()?.baseUrl, 'http://[::1]:9/v1');
    // Non-loopback, wrong scheme, credentials, queries, and bare hosts throw.
    for (const bad of [
      `https://${DOCAUDIT_MODAL_ALLOWED_HOST}/v1`,
      'http://example.com/v1',
      'https://127.0.0.1.evil.com/v1',
      'ftp://127.0.0.1/v1',
      'http://user@127.0.0.1/v1',
      'http://127.0.0.1/v1?x=1',
      'http://127.0.0.1/v1#y',
      'http://127.0.0.1',
      'not-a-url'
    ]) {
      assert.throws(() => __setModalBaseUrlOverride(bad), Error, bad);
    }
    // A failed override never sticks: restoring null returns to production.
    __setModalBaseUrlOverride(null);
    assert.equal(resolveModalConfig()?.baseUrl, DOCAUDIT_MODAL_DEFAULT_BASE_URL);
  });

  it('resolves a keyed, model-pinned provider with no fixture notice', () => {
    setModalEnv();
    const provider = resolveProvider();
    assert.ok(provider);
    assert.equal(provider.name, 'modal');
    assert.equal(provider.notice, undefined);
  });

  it('direct compare without configuration throws 503 and calls nothing', async () => {
    process.env.DOCAUDIT_PROVIDER = 'modal';
    let calls = 0;
    __setModalFetch(stubFetch(() => {
      calls++;
      return new Response('{}', { status: 200 });
    }));
    await rejectsProvider(
      createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      503,
      PROVIDER_NOT_CONFIGURED
    );
    assert.equal(calls, 0);
  });
});

describe('modal loopback stub (real HTTP, test-only override)', () => {
  it('drives an isolated stub server through the override seam', async () => {
    setModalEnv();
    __setModalFetch(null);
    const seen: { method?: string; url?: string; auth?: string; body?: string } = {};
    const stub: Server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.body = data;
        res.setHeader('content-type', 'application/json');
        res.end(envelope(JSON.stringify({ findings: [] })));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (stub.address() as AddressInfo).port;
      __setModalBaseUrlOverride(`http://127.0.0.1:${port}/v1`);
      const raw = await createModalProvider().compare(
        { textA: 'aa', textB: 'bb' },
        new AbortController().signal
      );
      assert.deepEqual(raw, { findings: [] });
      assert.equal(seen.method, 'POST');
      assert.equal(seen.url, '/v1/chat/completions');
      assert.equal(seen.auth, `Bearer ${TEST_KEY}`);
      const body = JSON.parse(seen.body ?? '') as {
        model: string;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(body.model, TEST_MODEL);
      assert.equal(body.max_tokens, DOCAUDIT_MODAL_MAX_TOKENS);
      assert.match(body.messages[1].content, /aa/);
    } finally {
      __setModalBaseUrlOverride(null);
      await new Promise<void>((resolve, reject) =>
        stub.close((e) => (e ? reject(e) : resolve()))
      );
    }
  });
});

describe('modal request shape (mock transport)', () => {
  it('sends one bounded POST with Bearer [REDACTED], no redirects, caller signal', async () => {
    setModalEnv();
    let calls = 0;
    let seen: { url: unknown; init: Record<string, unknown> } | null = null;
    __setModalFetch(
      stubFetch((url: unknown, init: unknown) => {
        calls++;
        seen = { url, init: init as Record<string, unknown> };
        return new Response(envelope(JSON.stringify({ findings: [] })), { status: 200 });
      })
    );
    const controller = new AbortController();
    const raw = await createModalProvider().compare({ textA: 'aaa', textB: 'bbb' }, controller.signal);
    assert.deepEqual(raw, { findings: [] });
    assert.equal(calls, 1);
    assert.ok(seen);
    const { url, init } = seen as { url: unknown; init: Record<string, unknown> };
    assert.equal(url, `${DOCAUDIT_MODAL_DEFAULT_BASE_URL}/chat/completions`);
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
    assert.equal(body.temperature, DOCAUDIT_MODAL_TEMPERATURE);
    assert.equal(body.max_tokens, DOCAUDIT_MODAL_MAX_TOKENS);
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

describe('modal upstream failures (mock transport)', () => {
  const cases: Array<{ status: number; want: [502 | 503 | 504, string] }> = [
    { status: 401, want: [503, MODAL_ACCESS_REFUSED] },
    { status: 403, want: [503, MODAL_ACCESS_REFUSED] },
    { status: 429, want: [503, MODAL_LIMIT_REACHED] },
    { status: 500, want: [502, MODAL_UPSTREAM_FAILED] },
    { status: 503, want: [502, MODAL_UPSTREAM_FAILED] },
    { status: 302, want: [502, MODAL_UPSTREAM_FAILED] }
  ];

  for (const { status, want } of cases) {
    it(`maps HTTP ${status} once, without surfacing the error body`, async () => {
      setModalEnv();
      let calls = 0;
      __setModalFetch(
        stubFetch(() => {
          calls++;
          return new Response(`upstream says ${CANARY}-${status}`, { status });
        })
      );
      await rejectsProvider(
        createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
        want[0],
        want[1]
      );
      assert.equal(calls, 1);
      assert.ok(!want[1].includes(CANARY));
    });
  }

  it('maps network and redirect failures to one fixed 502', async () => {
    setModalEnv();
    let calls = 0;
    __setModalFetch(
      stubFetch(() => {
        calls++;
        throw new TypeError(`redirect blocked ${CANARY}`);
      })
    );
    await rejectsProvider(
      createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      502,
      MODAL_UPSTREAM_FAILED
    );
    assert.equal(calls, 1);
  });
});

describe('modal output validation (mock transport)', () => {
  async function runWithBody(body: string): Promise<unknown> {
    setModalEnv();
    __setModalFetch(stubFetch(() => new Response(body, { status: 200 })));
    return createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal);
  }

  it('rejects malformed envelopes without repair', async () => {
    for (const body of ['{oops', '[1,2]', '{}', '{"choices": []}', '{"choices": [null]}']) {
      await rejectsProvider(runWithBody(body), 502, MODAL_OUTPUT_UNUSABLE);
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
      await rejectsProvider(runWithBody(body), 502, MODAL_OUTPUT_UNUSABLE);
    }
  });

  it('rejects token-truncated output even when it would still parse', async () => {
    await rejectsProvider(
      runWithBody(envelope(JSON.stringify({ findings: [] }), 'length')),
      502,
      MODAL_OUTPUT_TRUNCATED
    );
  });

  it('rejects oversized bodies, stopping the stream read early', async () => {
    setModalEnv();
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));
      }
    });
    __setModalFetch(stubFetch(() => new Response(stream, { status: 200 })));
    await rejectsProvider(
      createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      502,
      MODAL_OUTPUT_UNUSABLE
    );
    assert.ok(pulls <= 10, `expected early stop, pulls=${pulls}`);
    assert.ok(DOCAUDIT_MODAL_MAX_RESPONSE_BYTES, 'byte cap is configured');
  });

  it('caps the null-body fallback path too', async () => {
    setModalEnv();
    const huge = { ok: true, status: 200, body: null, text: async () => 'y'.repeat(70000) };
    __setModalFetch(stubFetch(() => huge));
    await rejectsProvider(
      createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
      502,
      MODAL_OUTPUT_UNUSABLE
    );
  });
});

describe('modal cancellation (mock transport)', () => {
  it('maps a pre-aborted signal to 504', async () => {
    setModalEnv();
    __setModalFetch(
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
      createModalProvider().compare({ textA: 'a', textB: 'b' }, controller.signal),
      504,
      'Comparison timed out.'
    );
  });

  it('maps mid-flight aborts and timeouts to 504', async () => {
    setModalEnv();
    __setModalFetch(
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
    const pending = createModalProvider().compare(
      { textA: 'a', textB: 'b' },
      controller.signal
    );
    controller.abort();
    await rejectsProvider(pending, 504, 'Comparison timed out.');
    await rejectsProvider(
      createModalProvider().compare({ textA: 'a', textB: 'b' }, AbortSignal.timeout(10)),
      504,
      'Comparison timed out.'
    );
  });
});

describe('modal log containment (mock transport)', () => {
  it('logs nothing: no key, prompts, completions, or upstream bodies', async () => {
    setModalEnv();
    const logged: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    console.log = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      __setModalFetch(
        stubFetch(() => {
          throw new Error(`carrier ${CANARY} key=${TEST_KEY}`);
        })
      );
      await rejectsProvider(
        createModalProvider().compare(
          { textA: `alpha ${CANARY}`, textB: `beta ${CANARY}` },
          new AbortController().signal
        ),
        502,
        MODAL_UPSTREAM_FAILED
      );
      __setModalFetch(stubFetch(() => new Response(`{oops ${CANARY}}`, { status: 200 })));
      await rejectsProvider(
        createModalProvider().compare({ textA: 'a', textB: 'b' }, new AbortController().signal),
        502,
        MODAL_OUTPUT_UNUSABLE
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
const workdir = mkdtempSync(join(tmpdir(), 'sentinel-modal-'));
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

describe('modal compare route (HTTP, mock transport)', () => {
  it('verifies stubbed findings through the existing contract, metadata-only audit', async () => {
    setModalEnv();
    __setModalFetch(stubFetch(() => new Response(envelope(findingsBody()), { status: 200 })));
    const { db, base, close } = await startServer();
    try {
      const before = db.audit.length;
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: TEXT_A, textB: TEXT_B });
      assert.equal(res.status, 200);
      assert.equal(res.json.provider, 'modal');
      assert.ok(!('notice' in res.json));
      const findings = res.json.findings as Array<{ kind: string; passageA: unknown; passageB: unknown }>;
      assert.equal(findings.length, 1);
      assert.equal(findings[0].kind, 'difference');
      assert.ok(findings[0].passageA);
      assert.ok(findings[0].passageB);
      assert.equal(db.audit.length, before + 1);
      const event = db.audit[db.audit.length - 1] as { action: string; detail: string };
      assert.equal(event.action, 'docaudit.completed');
      assert.match(event.detail, /via modal/);
      assert.ok(!event.detail.includes(CANARY));
      assert.ok(!JSON.stringify(res.json).includes(TEST_KEY));
    } finally {
      await close();
    }
  });

  it('missing configuration answers 503 without consuming throttle budget', async () => {
    const { base, close } = await startServer();
    try {
      process.env.DOCAUDIT_PROVIDER = 'modal';
      for (let i = 0; i < 10; i++) {
        const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: 'a', textB: 'b' });
        assert.equal(res.status, 503);
        assert.equal(res.json.error, PROVIDER_NOT_CONFIGURED);
      }
      setModalEnv();
      __setModalFetch(stubFetch(() => new Response(envelope('{"findings": []}'), { status: 200 })));
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: 'a', textB: 'b' });
      assert.equal(res.status, 200);
    } finally {
      await close();
    }
  });

  it('upstream failures answer fixed errors and leave data and audit history unchanged', async () => {
    setModalEnv();
    __setModalFetch(stubFetch(() => new Response(`nope ${CANARY}`, { status: 429 })));
    const { db, base, close } = await startServer();
    try {
      const diskBefore = readFileSync(dataFile, 'utf8');
      const auditBefore = db.audit.length;
      const res = await call(base, 'u-officer', { orgId: 'org-cah', textA: TEXT_A, textB: TEXT_B });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, MODAL_LIMIT_REACHED);
      assert.ok(!JSON.stringify(res.json).includes(CANARY));
      assert.equal(db.audit.length, auditBefore);
      assert.equal(readFileSync(dataFile, 'utf8'), diskBefore);
    } finally {
      await close();
    }
  });

  it('timeouts cancel the stubbed request and answer 504 without writes', async () => {
    setModalEnv();
    __setDocAuditTimeoutMs(20);
    __setModalFetch(
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
    setModalEnv();
    __setModalFetch(stubFetch(() => new Response(envelope('{"findings": []}'), { status: 200 })));
    const { base, close } = await startServer();
    try {
      const res = await call(base, 'u-staff', { orgId: 'org-cah', textA: 'a', textB: 'b' });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('equivalent texts with an empty stubbed set answer 200 with zero findings', async () => {
    setModalEnv();
    __setModalFetch(stubFetch(() => new Response(envelope('{"findings": []}'), { status: 200 })));
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

  it('isolates state: temp database file and ephemeral ports only', () => {
    assert.ok(dataFile.startsWith(workdir));
    assert.notEqual(dataFile, join(process.cwd(), 'data', 'sentinel.json'));
  });
});
