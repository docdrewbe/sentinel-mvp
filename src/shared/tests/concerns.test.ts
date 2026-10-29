import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONCERN_CATEGORIES, CONCERN_STATUSES, CONCERN_TRANSITIONS, nextConcernStatus } from '../concerns.js';
import {
  CONCERN_CATEGORY_LABELS,
  CONCERN_CLOSED_MEANING_NOTICE,
  CONCERN_EMERGENCY_NOTICE,
  CONCERN_IDENTIFIED_NOTICE,
  CONCERN_NO_SENSITIVE_DETAILS_HINT,
  CONCERN_REVIEWER_ACCESS_NOTICE,
  CONCERN_STATUS_LABELS
} from '../types.js';

describe('concern workflow rules (slice 1)', () => {
  it('advances one step forward; closed is terminal', () => {
    assert.equal(nextConcernStatus('submitted'), 'acknowledged');
    assert.equal(nextConcernStatus('acknowledged'), 'in_review');
    assert.equal(nextConcernStatus('in_review'), 'closed');
    assert.equal(nextConcernStatus('closed'), null);
    assert.deepEqual(CONCERN_TRANSITIONS.closed, []);
  });

  it('covers every status and category with labels', () => {
    assert.deepEqual(CONCERN_STATUSES, ['submitted', 'acknowledged', 'in_review', 'closed']);
    for (const status of CONCERN_STATUSES) {
      assert.ok(CONCERN_STATUS_LABELS[status]);
    }
    assert.deepEqual(CONCERN_CATEGORIES, [
      'safety',
      'infection_prevention',
      'equipment_facilities',
      'policy_process',
      'other'
    ]);
    for (const category of CONCERN_CATEGORIES) {
      assert.ok(CONCERN_CATEGORY_LABELS[category]);
    }
  });
});

describe('concern reporter notices (F-4 wording pin)', () => {
  it('matches the approved wording exactly', () => {
    assert.equal(
      CONCERN_IDENTIFIED_NOTICE,
      'Demo only—use synthetic information. Sign-in is simulated. Reports are identified, not anonymous. Authorized reviewers can see your report.'
    );
    assert.equal(
      CONCERN_REVIEWER_ACCESS_NOTICE,
      'Reviewers are department managers in your organization, plus compliance officers and administrators, who have cross-organization demo access.'
    );
    assert.equal(
      CONCERN_EMERGENCY_NOTICE,
      'If there is immediate danger, follow your organization’s emergency procedures. This demo is not monitored for emergencies.'
    );
    assert.equal(
      CONCERN_NO_SENSITIVE_DETAILS_HINT,
      'Describe the situation only — do not include patient names or other sensitive personal details.'
    );
    assert.equal(
      CONCERN_CLOSED_MEANING_NOTICE,
      'Closing a concern means the reporting workflow ended. It does not establish that a hazard was fixed, that a CAPA is closed, or that effectiveness was verified.'
    );
  });
});
