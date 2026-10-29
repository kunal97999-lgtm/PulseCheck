import { ValidationError } from '../../utils/errors.js';

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/; // microseconds, UTC
const ID = /^\d{1,18}$/; // fits a bigint

const invalid = () => new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }]);

/** `row` carries cursor_ts (Postgres text, microsecond precision) and id. */
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ t: row.cursor_ts, i: String(row.id) })).toString('base64url');
}

/** Strict: anything unexpected is a 400, so nothing odd ever reaches SQL. */
export function decodeCursor(token) {
  let obj;
  try {
    obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!obj || typeof obj.t !== 'string' || typeof obj.i !== 'string') throw invalid();
  if (!TS.test(obj.t) || !ID.test(obj.i)) throw invalid();
  // Calendar sanity (month 13, Feb 31). Compare at millisecond precision.
  if (Number.isNaN(Date.parse(`${obj.t.slice(0, 23)}Z`))) throw invalid();
  return { ts: obj.t, id: obj.i };
}