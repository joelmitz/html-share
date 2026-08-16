// console Worker の workerd 統合テスト設定。
// 実 workerd + ローカル D1/R2 binding で SELF.fetch により本物の実行経路を検証する。
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(HERE, '..', '..', 'workers', 'console', 'migrations'));
  const signing = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const access = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const accessJwk = { ...createPublicKey(access.publicKey).export({ format: 'jwk' }), kid: 'k1' };

  return {
    plugins: [
      cloudflareTest({
        main: './workers/console/src/index.ts',
        singleWorker: true,
        miniflare: {
          compatibilityDate: '2026-08-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['CONTENT'],
          // env.ASSETS（Workers Static Assets、設計§5）のスタブ。ディレクトリ要求の
          // 末尾スラッシュ付与・index.html解決はASSETS自体（プラットフォーム機能）の
          // 責務であり本番実測で確認する（移行手順§5.1）。ここでの関数バインディングは
          // 「認証ゲート通過後にASSETSへ委譲され、その応答へ自前のセキュリティヘッダーが
          // 正しく重ねられる」というWorker自身の責務だけを検証するための最小スタブ。
          serviceBindings: {
            ASSETS(request: Request) {
              const pathname = new URL(request.url).pathname;
              if (pathname === '/') {
                return new Response('<h1>Landing</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
              }
              if (pathname === '/app/index.html') {
                return new Response('<h1>App</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
              }
              return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
            },
          },
          // Worker からの外部fetchをNode側でモックする（Access certsエンドポイントのみ許可）
          outboundService(request: Request) {
            const url = new URL(request.url);
            if (url.hostname === 'team.cloudflareaccess.com' && url.pathname === '/cdn-cgi/access/certs') {
              return new Response(JSON.stringify({ keys: [accessJwk] }), {
                headers: { 'content-type': 'application/json' },
              });
            }
            return new Response('outbound network access is blocked in tests', { status: 503 });
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_ACCESS_PRIVATE_KEY: access.privateKey,
            TEST_ACCESS_JWK: accessJwk,
            SIGNING_PRIVATE_KEY: signing.privateKey,
            OWNER_EMAIL: 'owner@example.com',
            CONSOLE_ORIGIN: 'https://console.example.com',
            CONTENT_ORIGIN: 'https://content.example.com',
            MAXIMUM_SHARE_DAYS: '30',
            OWNER_LINK_DAYS: '30',
            ALLOWED_INTERNAL_CIDRS: '["203.0.113.0/24"]',
            ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
            ACCESS_AUD: 'aud-tag-1234',
          },
        },
      }),
    ],
    test: {
      include: ['test-workers/console/**/*.spec.ts'],
      setupFiles: ['./test-workers/console/setup.ts'],
    },
  };
});
