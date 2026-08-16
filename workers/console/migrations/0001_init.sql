-- HTML共有くん review データベース（DynamoDB 単一テーブルの D1 移植）
-- 適用: wrangler d1 migrations apply html-share-review --remote --config workers/console/wrangler.jsonc

CREATE TABLE devices (
  id TEXT PRIMARY KEY,          -- 端末トークンの SHA-256（トークン自体は保存しない）
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE pairings (
  code_hash TEXT PRIMARY KEY,   -- ペアリングコードの SHA-256
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,  -- epoch 秒。10 分で失効
  claimed_at INTEGER            -- 一度 claim されたら再利用不可
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,      -- 'OWNER' はスマホからのインボックス投稿
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  target TEXT,                  -- プロジェクトの呼び名のヒント（ファイルパスではない）
  status TEXT NOT NULL,         -- waiting / answered / completed
  approved INTEGER,
  response_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at INTEGER NOT NULL   -- epoch 秒。90 日で失効（読み出し時に除外し、遅延削除）
);

CREATE TABLE preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  starred_sources TEXT NOT NULL,
  recent_sources TEXT NOT NULL,
  hidden_sources TEXT NOT NULL,
  read_marks TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX tasks_expires_at ON tasks (expires_at);
CREATE INDEX pairings_expires_at ON pairings (expires_at);
