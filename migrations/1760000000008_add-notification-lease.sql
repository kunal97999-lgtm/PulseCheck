-- Up Migration
ALTER TABLE notification_deliveries ADD COLUMN claimed_until timestamptz;

-- Down Migration
ALTER TABLE notification_deliveries DROP COLUMN claimed_until;