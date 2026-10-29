# Reliability statistics: definitions

All statistics cover a half-open window [from, to). Default: the last 24 hours.
Maximum: 30 days. `to` is clamped to the current time.

## Observations
An observation is one stored `check_results` row with `checked_at` inside the window.
Checks that never ran (paused, workers down, discarded as stale) leave no row and are
NOT counted as successes or failures.

## Uptime
uptimePercent = successes / observations * 100, rounded DOWN to 3 decimals.
`null` when there are no observations.

## Coverage
expectedChecks = floor(monitoredSeconds / intervalSeconds), where monitoredSeconds runs from
max(window start, monitor creation) to window end.
coveragePercent = min(100, observations / expectedChecks * 100), rounded down; `null` if
expectedChecks is 0.
Coverage below 100% means unmonitored time: paused periods, a worker outage, skipped slots,
or an interval that changed during the window.

## Downtime
downtimeSeconds = sum over incidents of overlap([started_at, resolved_at or now), window).
Not derived from uptimePercent. An incident that ended because the monitor was paused or
reconfigured ends at that moment.

## Latency
Average and p95 over SUCCESSFUL observations that have a latency. p95 is the smallest
observed value with at least 95% of values at or below it (`percentile_disc`).

## Known limitations
- Check-based: outages shorter than the interval can be missed entirely, and a failure is
  assumed to last until the next check.
- Each observation has equal weight, so uneven spacing (gaps) is not time-weighted.
- Coverage uses the CURRENT interval, so it is approximate if the interval changed.
- Downtime starts at `started_at`: up to (failure_threshold - 1) intervals after the target
  actually began failing.
- Pause history is not stored, so paused time and pipeline outages look identical.