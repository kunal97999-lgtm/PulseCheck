-- Up Migration
ALTER TABLE monitors ADD COLUMN failure_streak_started_at timestamptz;

-- Down Migration
ALTER TABLE monitors DROP COLUMN failure_streak_started_at;