-- Up Migration
CREATE TABLE notification_preferences (
  user_id          uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_on_open    boolean     NOT NULL DEFAULT true,
  email_on_resolve boolean     NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_deliveries (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id             uuid        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_type              text        NOT NULL,
  channel                 text        NOT NULL DEFAULT 'email',
  status                  text        NOT NULL DEFAULT 'pending',
  attempt_count           integer     NOT NULL DEFAULT 0,
  last_attempt_at         timestamptz,
  sent_at                 timestamptz,
  sanitized_error_message text,
  created_at              timestamptz NOT NULL DEFAULT now(),

  -- One delivery per incident, event and channel: duplicate alerts are impossible.
  CONSTRAINT notification_deliveries_unique UNIQUE (incident_id, event_type, channel),

  CONSTRAINT notification_deliveries_event   CHECK (event_type IN ('incident_opened', 'incident_resolved')),
  CONSTRAINT notification_deliveries_channel CHECK (channel IN ('email')),
  CONSTRAINT notification_deliveries_status  CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT notification_deliveries_attempts CHECK (attempt_count >= 0),
  CONSTRAINT notification_deliveries_error_len CHECK (
    sanitized_error_message IS NULL OR char_length(sanitized_error_message) <= 500),
  -- "sent" and sent_at can never disagree
  CONSTRAINT notification_deliveries_sent_consistent CHECK (
    (status = 'sent' AND sent_at IS NOT NULL) OR (status <> 'sent' AND sent_at IS NULL))
);

-- The sender's work queue (Day 5): only unfinished rows, oldest first.
CREATE INDEX notification_deliveries_pending_idx
  ON notification_deliveries (created_at) WHERE status = 'pending';

-- Down Migration
DROP TABLE notification_deliveries;
DROP TABLE notification_preferences;