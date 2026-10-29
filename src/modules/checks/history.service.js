import { NotFoundError } from '../../utils/errors.js';
import * as monitorsRepo from '../monitors/monitors.repository.js';
import { resolveRange } from '../stats/definitions.js';
import { decodeCursor, encodeCursor } from './history.cursor.js';
import * as queries from './history.queries.js';

export async function listHistory(userId, monitorId, q, now = new Date()) {
  const monitor = await monitorsRepo.findByIdForUser(monitorId, userId);
  if (!monitor) throw new NotFoundError('Monitor not found');

  const range = resolveRange({ from: q.from, to: q.to }, now);
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;

  // Fetch one extra row: its existence is the only reliable "there is more" signal.
  const rows = await queries.listChecks(userId, monitorId, {
    range, cursor, success: q.success, limit: q.limit + 1,
  });
  const hasMore = rows.length > q.limit;
  const checks = hasMore ? rows.slice(0, q.limit) : rows;

  return { checks, nextCursor: hasMore ? encodeCursor(checks[checks.length - 1]) : null };
}