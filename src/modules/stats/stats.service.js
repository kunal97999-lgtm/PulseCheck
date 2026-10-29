import { NotFoundError } from '../../utils/errors.js';
import * as monitorsRepo from '../monitors/monitors.repository.js';
import { resolveRange, uptimePercent, expectedChecks, coveragePercent } from './definitions.js';
import * as queries from './stats.queries.js';

/** Pure: shapes raw aggregates into the documented numbers. No I/O. */
export function summarize(agg, monitor, range) {
  const expected = expectedChecks({
    rangeStart: range.from,
    rangeEnd: range.to,
    monitorCreatedAt: monitor.created_at,
    intervalSeconds: monitor.interval_seconds,
  });
  return {
    window: { from: range.from, to: range.to },
    observations: agg.total,
    successes: agg.successes,
    failures: agg.failures,
    uptimePercent: uptimePercent(agg.successes, agg.total),
    expectedChecks: expected,
    coveragePercent: coveragePercent(agg.total, expected),
    latency: {
      averageMs: agg.avgMs === null ? null : Math.round(agg.avgMs * 10) / 10,
      p95Ms: agg.p95Ms,
    },
  };
}

export async function getCheckStats(userId, monitorId, q = {}, now = new Date()) {
  const monitor = await monitorsRepo.findByIdForUser(monitorId, userId);
  if (!monitor) throw new NotFoundError('Monitor not found');

  const range = resolveRange({ from: q.from, to: q.to }, now);
  const agg = await queries.aggregateChecks(monitorId, userId, range);
  return summarize(agg, monitor, range);
}

/** Full stats response: check statistics, incident count, downtime, current status. */
export async function getMonitorStats(userId, monitorId, q = {}, now = new Date()) {
  const monitor = await monitorsRepo.findByIdForUser(monitorId, userId);
  if (!monitor) throw new NotFoundError('Monitor not found');

  const range = resolveRange({ from: q.from, to: q.to }, now);
  const [agg, inc] = await Promise.all([
    queries.aggregateChecks(monitorId, userId, range),
    queries.aggregateIncidents(monitorId, userId, range, now),
  ]);

  return {
    monitor: {
      id: monitor.id,
      status: monitor.current_status,
      isActive: monitor.is_active,
      lastCheckedAt: monitor.last_checked_at,
    },
    ...summarize(agg, monitor, range),
    incidents: { count: inc.incidentCount, downtimeSeconds: inc.downtimeSeconds },
  };
}