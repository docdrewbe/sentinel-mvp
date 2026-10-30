import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../../vite.config.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..', '..', '..');
const posix = (p: string): string => p.replace(/\\/g, '/');

describe('vite watcher scratch exclusion (W-1)', () => {
  it('anchors the .tmp ignore to this checkout only', () => {
    const watch = config.server?.watch;
    const raw = watch && typeof watch === 'object' ? (watch.ignored ?? []) : [];
    const list = (Array.isArray(raw) ? raw : [raw]).map(String);
    assert.equal(list.length, 1);
    const pattern = list[0];
    // Absolute, forward-slash, rooted at the config's own directory.
    assert.equal(pattern, `${posix(rootDir)}/.tmp/**`);
    assert.match(pattern, /^(?:[A-Za-z]:)?\//);
    assert.doesNotMatch(pattern, /^\*\*\//);
    // Prefix semantics: own scratch matches; sources and ancestor
    // scratch (a checkout nested under some other .tmp) do not.
    const prefix = pattern.slice(0, -'/**'.length);
    assert.ok(posix(resolve(rootDir, '.tmp', 'x')).startsWith(prefix));
    assert.ok(!posix(resolve(rootDir, 'src', 'client', 'App.tsx')).startsWith(prefix));
    assert.ok(!posix(resolve(rootDir, '..', '.tmp', 'y')).startsWith(prefix));
    assert.ok(!posix(resolve(rootDir, '..', 'other', '.tmp', 'z')).startsWith(prefix));
  });
});
