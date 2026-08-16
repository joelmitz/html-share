// content Worker の workerd 統合テスト設定。
// 実 workerd + ローカル R2 binding で、署名検証・CIDR強制・CSPを本物の実行経路で検証する。
import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => {
  const signing = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  return {
    plugins: [
      cloudflareTest({
        main: './workers/content/src/index.ts',
        singleWorker: true,
        miniflare: {
          compatibilityDate: '2026-08-01',
          compatibilityFlags: ['nodejs_compat'],
          r2Buckets: ['CONTENT'],
          bindings: {
            TEST_SIGNING_PRIVATE_KEY: signing.privateKey,
            SIGNING_PUBLIC_KEY: signing.publicKey,
            CONSOLE_ORIGIN: 'https://console.example.com',
          },
        },
      }),
    ],
    test: {
      include: ['test-workers/content/**/*.spec.ts'],
    },
  };
});
