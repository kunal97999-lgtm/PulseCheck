-- Up Migration
CREATE TABLE monitors (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 text        NOT NULL,
  description          text,
  url                  text        NOT NULL,
  interval_seconds     integer     NOT NULL DEFAULT 300,
  timeout_ms           integer     NOT NULL DEFAULT 10000,
  expected_status_min  integer     NOT NULL DEFAULT 200,
  expected_status_max  integer     NOT NULL DEFAULT 299,
  failure_threshold    integer     NOT NULL DEFAULT 3,
  recovery_threshold   integer     NOT NULL DEFAULT 1,
  is_active            boolean     NOT NULL DEFAULT true,
  current_status       text        NOT NULL DEFAULT 'pending',
  consecutive_failures integer     NOT NULL DEFAULT 0,
  consecutive_successes integer    NOT NULL DEFAULT 0,
  next_check_at        timestamptz,
  last_checked_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT monitors_name_length        CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT monitors_description_length CHECK (description IS NULL OR char_length(description) <= 500),
  CONSTRAINT monitors_url_length         CHECK (char_length(url) <= 2048),
  CONSTRAINT monitors_interval_range     CHECK (interval_seconds BETWEEN 60 AND 86400),
  CONSTRAINT monitors_timeout_range      CHECK (timeout_ms BETWEEN 1000 AND 30000),
  CONSTRAINT monitors_status_range       CHECK (expected_status_min BETWEEN 100 AND 599
                                            AND expected_status_max BETWEEN 100 AND 599
                                            AND expected_status_min <= expected_status_max),
  CONSTRAINT monitors_failure_threshold  CHECK (failure_threshold BETWEEN 1 AND 10),
  CONSTRAINT monitors_recovery_threshold CHECK (recovery_threshold BETWEEN 1 AND 10),
  CONSTRAINT monitors_current_status     CHECK (current_status IN ('pending', 'up', 'down'))
);

-- "List my monitors, newest first" and stable pagination (id breaks ties)
CREATE INDEX monitors_user_created_idx ON monitors (user_id, created_at DESC, id DESC);

CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE is_active;

-- Down Migration
DROP TABLE monitors;