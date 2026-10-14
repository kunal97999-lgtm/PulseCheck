
-- Up Migration
CREATE TABLE sessions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX sessions_user_id_idx
  ON sessions (user_id);

CREATE INDEX sessions_expires_at_idx
  ON sessions (expires_at);

-- Down Migration
DROP TABLE sessions;
