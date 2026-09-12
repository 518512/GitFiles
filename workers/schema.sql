-- GitFiles Workers session and repository authorization schema.
-- Apply with: npx wrangler d1 execute <database> --file=workers/schema.sql
--
-- 幂等：本文件可以反复执行。为了能在已有部署上补齐新列（D1/SQLite 不支持
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`），这里采用 DROP + CREATE。
-- 代价是重建表会清空既有 session，用户需要重新登录一次；这不影响 GitHub
-- 仓库内容，因为仓库数据始终以 GitHub 为准。

DROP TABLE IF EXISTS repository_access;
DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  github_login TEXT,
  -- 用于顶栏账户菜单显示真实头像；旧行可能为 NULL，前端会回退到首字母
  github_avatar TEXT,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE repository_access (
  session_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  can_read INTEGER NOT NULL DEFAULT 1,
  can_write INTEGER NOT NULL DEFAULT 0,
  -- 最近一次用 GitHub 校验该 ACL 的时间。NULL 视为过期，强制回源校验。
  checked_at INTEGER,
  PRIMARY KEY (session_id, owner, repo),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX repository_access_checked_at_idx ON repository_access (checked_at);
