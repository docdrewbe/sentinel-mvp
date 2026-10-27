import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDaysISO, daysInMonth, isValidIsoDate, isValidTimeZone, nextDueDate, nextOccurrence, orgToday, periodKeyFor } from '../scheduling.js';

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

describe('recurrence period keys (CAL2)', () => {
  it('names weekly periods by ISO week, including year boundaries', () => {
    assert.equal(periodKeyFor('2027-06-15', 'weekly'), '2027-W24');
    assert.equal(periodKeyFor('2027-06-17', 'weekly'), '2027-W24');
    assert.equal(periodKeyFor('2027-06-21', 'weekly'), '2027-W25');
    assert.equal(periodKeyFor('2026-01-01', 'weekly'), '2026-W01');
    assert.equal(periodKeyFor('2026-12-31', 'weekly'), '2026-W53');
    assert.equal(periodKeyFor('2027-01-01', 'weekly'), '2026-W53');
    assert.equal(periodKeyFor('2027-01-04', 'weekly'), '2027-W01');
    assert.equal(periodKeyFor('2025-12-29', 'weekly'), '2026-W01');
  });

  it('names monthly, quarterly, annual, and one-time periods', () => {
    assert.equal(periodKeyFor('2027-06-15', 'monthly'), '2027-06');
    assert.equal(periodKeyFor('2027-06-28', 'monthly'), '2027-06');
    assert.equal(periodKeyFor('2026-01-31', 'quarterly'), '2026-Q1');
    assert.equal(periodKeyFor('2026-03-31', 'quarterly'), '2026-Q1');
    assert.equal(periodKeyFor('2026-04-01', 'quarterly'), '2026-Q2');
    assert.equal(periodKeyFor('2026-12-31', 'quarterly'), '2026-Q4');
    assert.equal(periodKeyFor('2026-06-01', 'annually'), '2026');
    assert.equal(periodKeyFor('2026-12-31', 'annually'), '2026');
    assert.equal(periodKeyFor('2026-11-15', 'once'), 'once');
    assert.equal(periodKeyFor('not-a-date', 'monthly'), null);
    assert.equal(periodKeyFor('2027-02-30', 'monthly'), null);
    assert.equal(periodKeyFor('2026-11-15', 'fortnightly' as 'monthly'), null);
  });
});

describe('organization-local today (CAL3)', () => {
  const at = (iso: string): Date => new Date(iso);

  it('maps instants to Chicago civil dates on both sides of midnight', () => {
    assert.equal(orgToday('America/Chicago', at('2027-03-15T04:30:00Z')), '2027-03-14');
    assert.equal(orgToday('America/Chicago', at('2027-03-15T06:30:00Z')), '2027-03-15');
    assert.equal(orgToday('America/Chicago', at('2027-11-08T05:30:00Z')), '2027-11-07');
    assert.equal(orgToday('America/Chicago', at('2027-11-08T07:30:00Z')), '2027-11-08');
    assert.equal(orgToday('America/Chicago', at('2027-11-03T04:59:00Z')), '2027-11-02');
    assert.equal(orgToday('America/Chicago', at('2027-11-03T06:01:00Z')), '2027-11-03');
  });

  it('stays on civil days across DST transitions', () => {
    // Spring forward 2027-03-14: 01:30 CST and 03:30 CDT are the same date.
    assert.equal(orgToday('America/Chicago', at('2027-03-14T07:30:00Z')), '2027-03-14');
    assert.equal(orgToday('America/Chicago', at('2027-03-14T08:30:00Z')), '2027-03-14');
    // Fall back 2027-11-07: both 01:30s are the same date.
    assert.equal(orgToday('America/Chicago', at('2027-11-07T06:30:00Z')), '2027-11-07');
    assert.equal(orgToday('America/Chicago', at('2027-11-07T07:30:00Z')), '2027-11-07');
    // Due-soon windows are civil-day windows, not 24-hour spans.
    assert.equal(addDaysISO('2027-03-07', 7), '2027-03-14');
    assert.equal(addDaysISO('2027-10-31', 7), '2027-11-07');
  });

  it('classifies the same instant per organization zone', () => {
    // 09:30Z is already Mar 15 in Chicago but still Mar 14 in Honolulu.
    assert.equal(orgToday('America/Chicago', at('2027-03-15T09:30:00Z')), '2027-03-15');
    assert.equal(orgToday('Pacific/Honolulu', at('2027-03-15T09:30:00Z')), '2027-03-14');
  });

  it('falls back to UTC for unknown zones', () => {
    assert.equal(isValidTimeZone('America/Chicago'), true);
    assert.equal(isValidTimeZone('Pacific/Honolulu'), true);
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false);
    assert.equal(orgToday('Mars/Olympus_Mons', at('2027-03-15T04:30:00Z')), '2027-03-15');
    assert.equal(orgToday('', at('2027-03-15T04:30:00Z')), '2027-03-15');
  });
});

describe('strict date validation (CAL1)', () => {
  it('accepts only real calendar dates in strict shape', () => {
    for (const good of ['2028-02-29', '2000-02-29', '2027-12-31', '2027-01-31', '2026-10-26']) {
      assert.equal(isValidIsoDate(good), true, good);
    }
    for (const bad of [
      '2027-02-29',
      '2027-02-30',
      '2027-04-31',
      '2027-06-31',
      '2100-02-29',
      '2027-00-10',
      '2027-13-01',
      '2027-1-5',
      '2027/10/26',
      '',
      'not-a-date'
    ]) {
      assert.equal(isValidIsoDate(bad), false, bad);
    }
  });
});
