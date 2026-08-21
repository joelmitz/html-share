-- share-internal.mk7.jp（Cloudflare Access限定領域）対応（Issue: share-internal 新設）
-- 適用: wrangler d1 migrations apply html-share-review --remote --config workers/console/wrangler.jsonc

-- DEFAULT 'public' は既存行（このマイグレーション適用前に commit された全ページ）の実態に
-- 合わせたもの。既存ページは全て CONTENT バケット（署名URL・認証なし）へ publish 済みであり、
-- それを正しく表す値は 'internal' ではなく 'public' である。
-- 新規 commit は必ず CLI 側が明示的に visibility を送るため、このデフォルトは
-- 「未指定時のアプリ既定」ではなく「過去データの後方互換のための値」としてのみ働く。
ALTER TABLE pages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
