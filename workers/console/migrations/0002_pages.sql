-- 複数マシンからの publish 対応（設計 docs/proposals/20260816-multi-machine-publish.md v5）
-- 適用: wrangler d1 migrations apply html-share-review --remote --config workers/console/wrangler.jsonc

CREATE TABLE pages (
  device_id TEXT NOT NULL,      -- ペアリング済みデバイスID（devices.id）。名前空間の境界
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  repository TEXT NOT NULL,
  stream TEXT NOT NULL,
  stream_label TEXT NOT NULL,
  object_key TEXT NOT NULL,     -- pages/<device_id>/<gen>/<slug>/index.html。
                                 -- サーバーが認証済みdevice_idとlock行のgenから導出する。
                                 -- クライアントが直接指定することはできない
  page_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, slug)
);

CREATE TABLE publish_locks (
  device_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,          -- 保持者の証明（bearer）。object_keyには埋め込まない
  gen TEXT NOT NULL,            -- "<epoch秒>-<乱数8バイトhex>"。世代付きobject_keyの一部
  expires_at INTEGER NOT NULL   -- epoch秒。TTL 30分
);

ALTER TABLE devices ADD COLUMN purging_at TEXT;
-- purging_atが設定されたデバイスはpublish lockの取得を拒否される（403）。
-- active(NULL,NULL) → purging(purging_at設定) → revoked(revoked_at設定) の単方向遷移。
