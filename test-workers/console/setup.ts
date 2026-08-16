import { applyD1Migrations, env } from 'cloudflare:test';

// 各テストファイルの実行前に、本番と同じ migration をローカルD1へ適用する
await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
