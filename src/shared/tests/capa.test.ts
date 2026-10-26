import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capaCriteriaLocked, latestReviewEntryAt, qualifyingEffectivenessEvidence } from '../capa.js';
import type { EvidenceRef } from '../types.js';

const item = (over: Partial<EvidenceRef> & { id: string; at: string }): EvidenceRef => {
  const { at, ...rest } = over;
  return {
    label: 'check (simulated)',
    holder: 'H',
    custody: [{ seq: 1, fromHolder: null, toHolder: 'H', byUserId: 'u', at }],
    updatedAt: at,
    kind: 'effectiveness',
    ...rest
  };
};

describe('review cycle scoping (C2/P5)', () => {
  it('fails closed when statusHistory is missing or has no review entry', () => {
    const evidence = [item({ id: 'e1', at: '2026-10-21T00:00:00.000Z' })];
    assert.equal(latestReviewEntryAt({}), null);
    assert.equal(latestReviewEntryAt({ statusHistory: [] }), null);
    assert.deepEqual(qualifyingEffectivenessEvidence({ evidence, statusHistory: undefined }), []);
    assert.deepEqual(qualifyingEffectivenessEvidence({ evidence, statusHistory: [] }), []);
    // Even kind-correct evidence cannot qualify without a review entry, so
    // the review endpoint rejects: legacy records stay unclosable rather
    // than laundering pre-review evidence into a cycle. No bypass exists.
  });

  it('qualifies only post-entry effectiveness evidence', () => {
    const statusHistory = [
      { status: 'open' as const, at: '2026-10-19T00:00:00.000Z', byUserId: 'u' },
      { status: 'effectiveness_review' as const, at: '2026-10-20T00:00:00.000Z', byUserId: 'u' }
    ];
    assert.equal(
      latestReviewEntryAt({ statusHistory }),
      '2026-10-20T00:00:00.000Z'
    );
    const evidence = [
      item({ id: 'before', at: '2026-10-19T12:00:00.000Z' }),
      item({ id: 'during', at: '2026-10-21T00:00:00.000Z' }),
      { ...item({ id: 'impl', at: '2026-10-22T00:00:00.000Z' }), kind: 'implementation' as const }
    ];
    assert.deepEqual(
      qualifyingEffectivenessEvidence({ evidence, statusHistory }).map((e) => e.id),
      ['during']
    );
  });
});

describe('criteria lock (P1)', () => {
  it('locks criteria during review and after closure only', () => {
    assert.equal(capaCriteriaLocked('open'), false);
    assert.equal(capaCriteriaLocked('investigation'), false);
    assert.equal(capaCriteriaLocked('action_in_progress'), false);
    assert.equal(capaCriteriaLocked('effectiveness_review'), true);
    assert.equal(capaCriteriaLocked('closed'), true);
  });
});
