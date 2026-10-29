import { describe, it, expect } from 'vitest';
import { incidentAction, nextStreakStart } from '../../src/modules/checks/monitorState.js';

describe('incidentAction', () => {
  it.each([
    ['pending', 'down', 'open'],
    ['up', 'down', 'open'],
    ['down', 'down', null],
    ['down', 'up', 'resolve'],
    ['down', 'pending', null],
    ['up', 'up', null],
    ['pending', 'up', null],
    ['pending', 'pending', null],
  ])('%s -> %s = %s', (from, to, expected) => {
    expect(incidentAction(from, to)).toBe(expected);
  });
});

describe('nextStreakStart', () => {
  const t1 = new Date(1000);
  const t2 = new Date(2000);

  it('starts a streak on the first failure', () => {
    expect(nextStreakStart({ consecutive_failures: 0, failure_streak_started_at: null }, false, t1)).toBe(t1);
  });
  it('keeps the original start while failures continue', () => {
    expect(nextStreakStart({ consecutive_failures: 2, failure_streak_started_at: t1 }, false, t2)).toBe(t1);
  });
  it('clears on success', () => {
    expect(nextStreakStart({ consecutive_failures: 2, failure_streak_started_at: t1 }, true, t2)).toBeNull();
  });
  it('falls back to the current check if a streak has no recorded start', () => {
    expect(nextStreakStart({ consecutive_failures: 2, failure_streak_started_at: null }, false, t2)).toBe(t2);
  });
});