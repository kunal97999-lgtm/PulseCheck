import { pool } from '../../db/pool.js';

const SELECT = `
  SELECT c.id, c.scheduled_for, c.checked_at,
         to_char(c.checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
         c.success, c.status_code, c.latency_ms, c.error_type, c.error_message
    FROM check_results c
    JOIN monitors m ON m.id = c.monitor_id
   WHERE c.monitor_id = $1::uuid AND m.user_id = $2::uuid
     AND c.checked_at >= $3::timestamptz AND c.checked_at < $4::timestamptz
     AND ($5::boolean IS NULL OR c.success = $5::boolean)`;

const AFTER_CURSOR = ` AND (c.checked_at, c.id) < ($7::timestamptz, $8::bigint)`;
const ORDER = ` ORDER BY c.checked_at DESC, c.id DESC LIMIT $6::int`;

export async function listChecks(userId, monitorId, { range, cursor, success, limit }, db = pool) {
  const params = [monitorId, userId, range.from, range.to, success ?? null, limit];
  let sql = SELECT;
  if (cursor) {
    sql += AFTER_CURSOR;
    params.push(cursor.ts, cursor.id);
  }
  const { rows } = await db.query(sql + ORDER, params);
  return rows;
}