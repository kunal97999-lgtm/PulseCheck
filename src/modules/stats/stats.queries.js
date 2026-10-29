import { pool } from '../../db/pool.js';

/**
 * Aggregates one monitor's checks in [from, to). Ownership is part of the query.
 * Always returns exactly one row (zeros and nulls for an empty window).
 * Latency statistics use SUCCESSFUL checks that have a latency, nothing else.
 */
export async function aggregateChecks(monitorId, userId, range, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int                                        AS total,
            (count(*) FILTER (WHERE c.success))::int             AS successes,
            (count(*) FILTER (WHERE NOT c.success))::int         AS failures,
            avg(c.latency_ms) FILTER (WHERE c.success AND c.latency_ms IS NOT NULL)
                                                                 AS avg_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY c.latency_ms)
              FILTER (WHERE c.success AND c.latency_ms IS NOT NULL)
                                                                 AS p95_ms
       FROM check_results c
       JOIN monitors m ON m.id = c.monitor_id
      WHERE c.monitor_id = $1::uuid
        AND m.user_id    = $2::uuid
        AND c.checked_at >= $3::timestamptz
        AND c.checked_at <  $4::timestamptz`,
    [monitorId, userId, range.from, range.to],
  );
  const r = rows[0];
  return {
    total: r.total,
    successes: r.successes,
    failures: r.failures,
    avgMs: r.avg_ms === null ? null : Number(r.avg_ms), // numeric arrives as a string
    p95Ms: r.p95_ms === null ? null : Number(r.p95_ms),
  };
}

/**
 * Incident count and total downtime overlapping [from, to). Open incidents run until `now`.
 * Sums per-incident clipped overlap, floored to whole seconds like overlapSeconds().
 */
export async function aggregateIncidents(monitorId, userId, range, now, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS incident_count,
            COALESCE(sum(
              GREATEST(0, floor(extract(epoch FROM (
                LEAST(COALESCE(i.resolved_at, $5::timestamptz), $4::timestamptz)
                - GREATEST(i.started_at, $3::timestamptz)
              ))))
            ), 0)::bigint AS downtime_seconds
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      WHERE i.monitor_id = $1::uuid
        AND m.user_id    = $2::uuid
        AND i.started_at < $4::timestamptz
        AND COALESCE(i.resolved_at, $5::timestamptz) > $3::timestamptz`,
    [monitorId, userId, range.from, range.to, now],
  );
  return {
    incidentCount: rows[0].incident_count,
    downtimeSeconds: Number(rows[0].downtime_seconds), // bigint arrives as a string
  };
}