-- Up Migration
CREATE TABLE check_results (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monitor_id    uuid        NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  checked_at    timestamptz NOT NULL,
  success       boolean     NOT NULL,
  status_code   integer,
  latency_ms    integer,
  error_type    text,
  error_message text,

  -- The idempotency key: one result per monitor per scheduled slot.
  CONSTRAINT check_results_slot_unique UNIQUE (monitor_id, scheduled_for),

  CONSTRAINT check_results_status_code CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  CONSTRAINT check_results_latency     CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT check_results_error_type  CHECK (error_type IS NULL OR error_type IN
    ('http_status', 'timeout', 'dns', 'connection', 'tls', 'blocked', 'other')),
  CONSTRAINT check_results_message_len CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  -- A success has no error type; a failure always has one.
  CONSTRAINT check_results_consistent  CHECK (
    (success AND error_type IS NULL) OR (NOT success AND error_type IS NOT NULL)
  )
);

-- History and statistics: "latest checks for a monitor", "checks in a time range"
CREATE INDEX check_results_monitor_checked_idx ON check_results (monitor_id, checked_at DESC);

-- Down Migration
DROP TABLE check_results;