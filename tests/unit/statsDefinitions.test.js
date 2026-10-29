import { describe, it, expect } from 'vitest';
import {
  resolveRange, uptimePercent, expectedChecks, coveragePercent, overlapSeconds,
  MAX_RANGE_DAYS,
} from '../../src/modules/stats/definitions.js';
import { ValidationError } from '../../src/utils/errors.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('resolveRange', () => {
  it('defaults to the last 24 hours ending now', () => {
    expect(resolveRange({}, NOW)).toEqual({ from: ago(24 * HOUR), to: NOW });
    expect(resolveRange(undefined, NOW)).toEqual({ from: ago(24 * HOUR), to: NOW });
  });

  it('with only `to`, the window is the 24 hours before it', () => {
    const to = ago(2 * DAY);
    expect(resolveRange({ to }, NOW)).toEqual({ from: new Date(to.getTime() - 24 * HOUR), to });
  });

  it('clamps a future `to` to now', () => {
    const r = resolveRange({ from: ago(HOUR), to: new Date(NOW.getTime() + DAY) }, NOW);
    expect(r.to).toEqual(NOW);
  });

  it.each([
    ['from equals to', { from: ago(HOUR), to: ago(HOUR) }],
    ['from after to', { from: ago(HOUR), to: ago(2 * HOUR) }],
    ['from in the future', { from: new Date(NOW.getTime() + HOUR) }],
    ['range over the maximum', { from: ago(MAX_RANGE_DAYS * DAY + 1) }],
  ])('rejects: %s', (_n, input) => {
    let err;
    try { resolveRange(input, NOW); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details[0].field).toBe('from');
  });

  it('accepts exactly the maximum range', () => {
    expect(() => resolveRange({ from: ago(MAX_RANGE_DAYS * DAY) }, NOW)).not.toThrow();
  });
});

describe('uptimePercent', () => {
  it('is null with no observations, never 0 or 100', () => {
    expect(uptimePercent(0, 0)).toBeNull();
  });
  it.each([
    [0, 10, 0], [10, 10, 100], [999, 1000, 99.9], [1, 3, 33.333],
  ])('%i of %i = %f', (ok, total, expected) => {
    expect(uptimePercent(ok, total)).toBe(expected);
  });
  it('rounds DOWN: 2 of 3 is 66.666, not 66.667', () => {
    expect(uptimePercent(2, 3)).toBe(66.666);
  });
  it('one failure in a million never displays as 100', () => {
    expect(uptimePercent(999_999, 1_000_000)).toBe(99.999);
    expect(uptimePercent(999_999, 1_000_000)).toBeLessThan(100);
  });
});

describe('expectedChecks and coverage', () => {
  const base = { rangeStart: ago(DAY), rangeEnd: NOW, monitorCreatedAt: ago(30 * DAY), intervalSeconds: 300 };

  it('counts one check per interval across the window', () => {
    expect(expectedChecks(base)).toBe(288);
  });
  it('starts at monitor creation when the monitor is newer than the window', () => {
    expect(expectedChecks({ ...base, monitorCreatedAt: ago(HOUR), intervalSeconds: 60 })).toBe(60);
  });
  it('is 0 for a monitor created after the window ended', () => {
    expect(expectedChecks({ ...base, monitorCreatedAt: new Date(NOW.getTime() + HOUR) })).toBe(0);
  });
  it('floors partial intervals', () => {
    expect(expectedChecks({ ...base, rangeStart: ago(310_000) })).toBe(1);
  });

  it('coverage is null with nothing expected, and capped at 100', () => {
    expect(coveragePercent(0, 0)).toBeNull();
    expect(coveragePercent(289, 288)).toBe(100);
  });
  it('a half-observed window reports 50, not 100 (missing checks are not successes)', () => {
    expect(coveragePercent(144, 288)).toBe(50);
  });
});

describe('overlapSeconds', () => {
  const range = { from: ago(10 * HOUR), to: NOW };
  const inc = (startedAgoH, resolvedAgoH) => ({
    startedAt: ago(startedAgoH * HOUR),
    resolvedAt: resolvedAgoH === null ? null : ago(resolvedAgoH * HOUR),
  });

  it('an incident fully inside counts in full', () => {
    expect(overlapSeconds(inc(5, 4), range, NOW)).toBe(3600);
  });
  it('is clipped at the window start', () => {
    expect(overlapSeconds(inc(12, 8), range, NOW)).toBe(2 * 3600);
  });
  it('is clipped at the window end', () => {
    const early = { from: ago(10 * HOUR), to: ago(4 * HOUR) };
    expect(overlapSeconds(inc(5, 1), early, NOW)).toBe(3600);
  });
  it('an open incident runs until now', () => {
    expect(overlapSeconds(inc(3, null), range, NOW)).toBe(3 * 3600);
  });
  it('an incident outside the window is 0', () => {
    expect(overlapSeconds(inc(20, 15), range, NOW)).toBe(0);
  });
  it('an incident spanning the whole window equals the window length', () => {
    expect(overlapSeconds(inc(20, null), range, NOW)).toBe(10 * 3600);
  });
});