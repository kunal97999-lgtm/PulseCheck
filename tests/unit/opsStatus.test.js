import { describe, it, expect } from 'vitest';
import { evaluateStatus } from '../../src/modules/ops/status.js';

const cfg = { notificationLagSeconds: 900 };
const healthy = { redisOk: true, dbOk: true, liveWorkers: 2, overdueMonitors: 0, oldestPendingNotificationSeconds: 0 };
const eval_ = (over) => evaluateStatus({ ...healthy, ...over }, cfg);

describe('evaluateStatus', () => {
  it('healthy: ok with no reasons', () => {
    expect(eval_({})).toEqual({ status: 'ok', reasons: [] });
  });

  it.each([
    ['redis unreachable', { redisOk: false, liveWorkers: null }, ['redis_unavailable']],
    ['database unreachable', { dbOk: false, overdueMonitors: undefined, oldestPendingNotificationSeconds: undefined }, ['database_unavailable']],
    ['no live workers', { liveWorkers: 0 }, ['no_live_workers']],
  ])('down: %s', (_n, over, reasons) => {
    expect(eval_(over)).toEqual({ status: 'down', reasons });
  });

  it('overdue monitors with live workers: degraded (scheduler lagging)', () => {
    expect(eval_({ overdueMonitors: 3 })).toEqual({ status: 'degraded', reasons: ['scheduler_lagging'] });
  });

  it('overdue monitors with NO workers: down, and not double-reported as lagging', () => {
    expect(eval_({ liveWorkers: 0, overdueMonitors: 3 })).toEqual({ status: 'down', reasons: ['no_live_workers'] });
  });

  it('a pending notification older than the limit degrades; exactly at the limit does not', () => {
    expect(eval_({ oldestPendingNotificationSeconds: 901 }))
      .toEqual({ status: 'degraded', reasons: ['notifications_lagging'] });
    expect(eval_({ oldestPendingNotificationSeconds: 900 }).status).toBe('ok');
  });

  it('down outranks degraded, and reasons accumulate', () => {
    const r = eval_({ redisOk: false, liveWorkers: null, oldestPendingNotificationSeconds: 5000 });
    expect(r.status).toBe('down');
    expect(r.reasons).toEqual(['redis_unavailable', 'notifications_lagging']);
  });
});