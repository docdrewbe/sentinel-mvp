import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../../vite.config.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..', '..', '..');
const posix = (p: string): string => p.replace(/\\/g, '/');

function ignoredList(): string[] {
  const watch = config.server?.watch;
  const raw = watch && typeof watch === 'object' ? (watch.ignored ?? []) : [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

/** Shared anchoring semantics: absolute, this-checkout-only, no loose globs. */
function assertAnchored(pattern: string, dir: string): void {
  // Absolute, forward-slash, rooted at the config's own directory.
  assert.equal(pattern, `${posix(rootDir)}/${dir}/**`);
  assert.match(pattern, /^(?:[A-Za-z]:)?\//);
  assert.doesNotMatch(pattern, /^\*\*\//);
  // Prefix semantics: own dir matches; sources and ancestor
  // dirs (a checkout nested under some other dir) do not.
  const prefix = pattern.slice(0, -'/**'.length);
  assert.ok(posix(resolve(rootDir, dir, 'x')).startsWith(prefix));
  assert.ok(!posix(resolve(rootDir, 'src', 'client', 'App.tsx')).startsWith(prefix));
  assert.ok(!posix(resolve(rootDir, '..', dir, 'y')).startsWith(prefix));
  assert.ok(!posix(resolve(rootDir, '..', 'other', dir, 'z')).startsWith(prefix));
}

describe('vite watcher scratch exclusion (W-1, W-2)', () => {
  it('ignores exactly .tmp and data/backups', () => {
    assert.deepEqual(ignoredList().map((p) => p.slice(posix(rootDir).length)), ['/.tmp/**', '/data/backups/**']);
  });

  it('anchors the .tmp ignore to this checkout only', () => {
    assertAnchored(ignoredList()[0], '.tmp');
  });

  it('anchors the data/backups ignore to this checkout only', () => {
    assertAnchored(ignoredList()[1], 'data/backups');
  });
});
