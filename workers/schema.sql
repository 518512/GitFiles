-- GitFiles Workers session and repository authorization schema.
-- Apply with: npx wrangler d1 execute <database> --file=workers/schema.sql

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  github_login TEXT,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS repository_access (
  session_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  can_read INTEGER NOT NULL DEFAULT 1,
  can_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, owner, repo),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
