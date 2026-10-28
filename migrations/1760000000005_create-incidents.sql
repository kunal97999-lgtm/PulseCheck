-- Up Migration
CREATE TABLE incidents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id        uuid        NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status            text        NOT NULL DEFAULT 'open',
  first_failed_at   timestamptz NOT NULL,
  started_at        timestamptz NOT NULL,
  resolved_at       timestamptz,
  resolution_reason text,
  failure_type      text,
  failure_reason    text,
  last_updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT incidents_status_valid CHECK (status IN ('open', 'resolved')),
  CONSTRAINT incidents_resolution_valid CHECK (
    resolution_reason IS NULL OR
    resolution_reason IN ('recovered', 'monitor_paused', 'monitor_reconfigured')
  ),
  CONSTRAINT incidents_failure_type_valid CHECK (
    failure_type IS NULL OR
    failure_type IN ('http_status', 'timeout', 'dns', 'connection', 'tls', 'blocked', 'other')
  ),
  CONSTRAINT incidents_reason_length CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
  -- status and resolution fields can never disagree
  CONSTRAINT incidents_resolved_consistent CHECK (
    (status = 'open'     AND resolved_at IS NULL     AND resolution_reason IS NULL) OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL)
  ),
  CONSTRAINT incidents_time_order CHECK (
    first_failed_at <= started_at AND (resolved_at IS NULL OR resolved_at >= started_at)
  )
);

-- At most one open incident per monitor, enforced by the database.
CREATE UNIQUE INDEX incidents_one_open_per_monitor
  ON incidents (monitor_id) WHERE status = 'open';

-- "Incidents for a monitor, newest first" and the stats time-range queries.
CREATE INDEX incidents_monitor_started_idx ON incidents (monitor_id, started_at DESC);

-- Down Migration
DROP TABLE incidents;