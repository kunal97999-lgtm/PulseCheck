
-- Up Migration
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);

-- Down Migration
DROP TABLE users;
