import { describe, it, expect } from 'vitest';
import { summarize } from '../../src/modules/stats/stats.service.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const range = { from: new Date(NOW - HOUR), to: NOW };
const monitor = { created_at: new Date(NOW - 30 * 24 * HOUR), interval_seconds: 300 }; // 12 expected/hour
const agg = (o) => ({ total: 0, successes: 0, failures: 0, avgMs: null, p95Ms: null, ...o });

describe('summarize', () => {
  it('no observations: uptime null, coverage 0 (we expected checks and saw none)', () => {
    const s = summarize(agg({}), monitor, range);
    expect(s).toMatchObject({ observations: 0, uptimePercent: null, expectedChecks: 12, coveragePercent: 0 });
    expect(s.latency).toEqual({ averageMs: null, p95Ms: null });
  });

  it('only failures: uptime is 0 (a verdict), latency is null (no successes to measure)', () => {
    const s = summarize(agg({ total: 4, failures: 4 }), monitor, range);
    expect(s.uptimePercent).toBe(0);
    expect(s.latency).toEqual({ averageMs: null, p95Ms: null });
  });

  it('half the expected checks present: coverage 50, uptime computed from what ran', () => {
    const s = summarize(agg({ total: 6, successes: 6, avgMs: 100, p95Ms: 150 }), monitor, range);
    expect(s).toMatchObject({ uptimePercent: 100, coveragePercent: 50, expectedChecks: 12 });
  });

  it('rounds uptime DOWN and average latency to 0.1 ms', () => {
    const s = summarize(agg({ total: 3, successes: 2, failures: 1, avgMs: 123.4567, p95Ms: 200 }), monitor, range);
    expect(s.uptimePercent).toBe(66.666);
    expect(s.latency.averageMs).toBe(123.5);
  });

  it('a monitor created after the window has nothing expected: coverage null', () => {
    const young = { ...monitor, created_at: new Date(NOW.getTime() + HOUR) };
    expect(summarize(agg({}), young, range)).toMatchObject({ expectedChecks: 0, coveragePercent: null });
  });
});