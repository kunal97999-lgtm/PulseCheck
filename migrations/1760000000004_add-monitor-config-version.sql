-- Up Migration
ALTER TABLE monitors ADD COLUMN config_version integer NOT NULL DEFAULT 1;

-- Down Migration
ALTER TABLE monitors DROP COLUMN config_version;