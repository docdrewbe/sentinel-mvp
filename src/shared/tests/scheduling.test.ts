import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDaysISO, daysInMonth, nextDueDate, nextOccurrence } from '../scheduling.js';

describe('calendar math (calendar slice 1)', () => {
  it('counts month days with leap years', () => {
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2000, 2), 29);
    assert.equal(daysInMonth(1900, 2), 28);
    assert.equal(daysInMonth(2026, 1), 31);
    assert.equal(daysInMonth(2026, 4), 30);
    assert.equal(daysInMonth(2026, 0), 0);
    assert.equal(daysInMonth(2026, 13), 0);
  });

  it('adds days across month and year boundaries', () => {
    assert.equal(addDaysISO('2026-01-28', 7), '2026-02-04');
    assert.equal(addDaysISO('2026-12-29', 7), '2027-01-05');
    assert.equal(addDaysISO('2024-02-27', 2), '2024-02-29');
    assert.equal(addDaysISO('2026-10-26', 0), '2026-10-26');
    assert.equal(addDaysISO('not-a-date', 1), null);
    assert.equal(addDaysISO('2026-02-30', 1), null);
    assert.equal(addDaysISO('2026-10-26', 1.5), null);
  });

  it('steps weekly by exactly seven days across DST boundaries', () => {
    // US DST starts 2026-03-08 and ends 2026-11-01; pure calendar math is
    // unaffected either way.
    assert.equal(nextOccurrence('2026-03-02', 'weekly', 2), '2026-03-09');
    assert.equal(nextOccurrence('2026-10-26', 'weekly', 26), '2026-11-02');
    assert.equal(nextOccurrence('2026-12-29', 'weekly', 29), '2027-01-05');
    // Cross-check a full year of weekly steps against UTC arithmetic.
    for (let day = 1; day <= 365; day += 7) {
      const from = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
      const expected = new Date(Date.UTC(2026, 0, day + 7)).toISOString().slice(0, 10);
      assert.equal(nextOccurrence(from, 'weekly', 1), expected);
    }
  });

  it('clamps monthly steps to the anchor without drifting', () => {
    assert.equal(nextOccurrence('2026-01-31', 'monthly', 31), '2026-02-28');
    assert.equal(nextOccurrence('2026-02-28', 'monthly', 31), '2026-03-31');
    assert.equal(nextOccurrence('2024-01-31', 'monthly', 31), '2024-02-29');
    assert.equal(nextOccurrence('2024-02-29', 'monthly', 31), '2024-03-31');
    assert.equal(nextOccurrence('2026-01-15', 'monthly', 15), '2026-02-15');
    assert.equal(nextOccurrence('2026-12-10', 'monthly', 10), '2027-01-10');
  });

  it('steps quarterly and annually with the same clamp', () => {
    assert.equal(nextOccurrence('2026-01-31', 'quarterly', 31), '2026-04-30');
    assert.equal(nextOccurrence('2026-04-30', 'quarterly', 31), '2026-07-31');
    assert.equal(nextOccurrence('2026-11-30', 'quarterly', 30), '2027-02-28');
    assert.equal(nextOccurrence('2024-02-29', 'annually', 29), '2025-02-28');
    assert.equal(nextOccurrence('2023-06-15', 'annually', 15), '2024-06-15');
    assert.equal(nextOccurrence('2026-12-31', 'annually', 31), '2027-12-31');
  });

  it('returns null for one-time schedules and invalid input', () => {
    assert.equal(nextOccurrence('2026-10-26', 'once', 26), null);
    assert.equal(nextOccurrence('not-a-date', 'monthly', 15), null);
    assert.equal(nextOccurrence('2026-02-30', 'monthly', 15), null);
    assert.equal(nextOccurrence('2026-10-26', 'fortnightly' as 'monthly', 26), null);
  });

  it('clamps out-of-range anchors into 1..31', () => {
    assert.equal(nextOccurrence('2026-01-15', 'monthly', 0), '2026-02-01');
    assert.equal(nextOccurrence('2026-01-15', 'monthly', 99), '2026-02-28');
  });

  it('keeps the legacy template helper for instantiate defaults', () => {
    assert.equal(nextDueDate('2026-10-26', 'once'), null);
    assert.equal(nextDueDate('2026-10-26', 'weekly'), '2026-11-02');
  });
});
