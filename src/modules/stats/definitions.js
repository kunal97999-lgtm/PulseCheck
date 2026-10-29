import { ValidationError } from '../../utils/errors.js';

export const MAX_RANGE_DAYS = 30;
export const DEFAULT_RANGE_HOURS = 24;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Turns optional `from`/`to` Dates into a validated half-open window.
 * `to` in the future is clamped to now. Throws ValidationError (a 400) otherwise.
 */
export function resolveRange({ from, to } = {}, now = new Date()) {
  const end = to && to < now ? to : now;
  const start = from ?? new Date(end.getTime() - DEFAULT_RANGE_HOURS * HOUR_MS);

  if (!(start < end)) {
    throw new ValidationError([{ field: 'from', message: '"from" must be before "to"' }]);
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new ValidationError([
      { field: 'from', message: `Range must be at most ${MAX_RANGE_DAYS} days` },
    ]);
  }
  return { from: start, to: end };
}

/** Rounded DOWN to 3 decimals so a single failure can never display as 100%. */
const pct = (part, whole) => Math.floor((part * 100000) / whole) / 1000;

/** null (not 0, not 100) when there is nothing to measure. */
export function uptimePercent(successes, total) {
  return total === 0 ? null : pct(successes, total);
}

export function expectedChecks({ rangeStart, rangeEnd, monitorCreatedAt, intervalSeconds }) {
  const start = Math.max(rangeStart.getTime(), monitorCreatedAt.getTime());
  const seconds = (rangeEnd.getTime() - start) / 1000;
  return seconds <= 0 ? 0 : Math.floor(seconds / intervalSeconds);
}

export function coveragePercent(observed, expected) {
  return expected === 0 ? null : Math.min(100, pct(observed, expected));
}

/** Seconds of one incident that fall inside the window. An open incident runs until `now`. */
export function overlapSeconds(incident, range, now = new Date()) {
  const start = Math.max(incident.startedAt.getTime(), range.from.getTime());
  const end = Math.min((incident.resolvedAt ?? now).getTime(), range.to.getTime());
  return Math.max(0, Math.floor((end - start) / 1000));
}