import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorLogLine } from '../app.js';

const PATH_CANARY = 'WM12-PATH-CANARY-a1b2c3';
const QUERY_CANARY = 'WM12-QUERY-CANARY-d4e5f6';

describe('WM1-2: fallback log context', () => {
  it('uses the server route pattern, never the supplied URL', () => {
    const req = {
      route: { path: '/api/tasks/:id' },
      method: 'PATCH',
      path: `/api/tasks/${PATH_CANARY}`,
      url: `/api/tasks/${PATH_CANARY}?probe=${QUERY_CANARY}`,
      originalUrl: `/api/tasks/${PATH_CANARY}?probe=${QUERY_CANARY}`
    };
    assert.equal(errorLogLine('error.route.unexpected', req), '[sentinel] error.route.unexpected route=/api/tasks/:id');
    assert.equal(
      errorLogLine('error.middleware.unexpected', req),
      '[sentinel] error.middleware.unexpected route=/api/tasks/:id'
    );
  });

  it('falls back to unknown without touching the URL', () => {
    for (const shape of [{}, { route: {} }, { route: { path: 42 } }, { route: { path: ['/a'] } }]) {
      const req = { ...shape, path: `/api/${PATH_CANARY}?q=${QUERY_CANARY}` };
      const line = errorLogLine('error.middleware.unexpected', req);
      assert.equal(line, '[sentinel] error.middleware.unexpected route=unknown');
      assert.ok(!line.includes('WM12'));
    }
  });
});
