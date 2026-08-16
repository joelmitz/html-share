import { S3Client } from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { publish, share } from '../src/publish.js';

const CONSOLE_DOMAIN = 'console.example.com';

function fixture(pages: Array<{ slug: string; title: string; objectKey: string }>): {
  config: ReturnType<typeof loadConfig>;
  credentialsPath: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-publish-'));
  mkdirSync(path.join(root, 'pages'));
  writeFileSync(path.join(root, 'pages', 'demo.html'), '<h1>Demo</h1>');
  const configFile = path.join(root, 'html-share.config.yaml');
  writeFileSync(configFile, `ownerEmail: owner@example.com
cloudflare:
  accountId: "0123456789abcdef0123456789abcdef"
  consoleDomain: ${CONSOLE_DOMAIN}
  contentDomain: content.example.com
  contentBucket: html-share-content
  publicKeyPath: keys/public.pem
  privateKeyPath: keys/private.pem
content:
  roots: [pages]
  pages:
    - path: pages/demo.html
  ownerLinkDays: 7
  maximumShareDays: 30
  maximumAssetBytes: 1024
`);
  const config = loadConfig(configFile);
  mkdirSync(path.join(root, '.html-share', 'build'), { recursive: true });
  writeFileSync(path.join(root, '.html-share', 'build', 'manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    pages: pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      source: 'pages/demo.html',
      updatedAt: new Date().toISOString(),
      date: new Date().toISOString(),
      repository: 'pages',
      stream: '',
      streamLabel: '',
      objectKey: page.objectKey,
    })),
  }));
  const credentialsPath = path.join(root, 'review-device.json');
  writeFileSync(credentialsPath, JSON.stringify({
    deviceToken: 'a'.repeat(43),
    deviceName: 'Test PC',
    apiBase: `https://${CONSOLE_DOMAIN}/api`,
  }));
  return { config, credentialsPath };
}

// 実際にサーバーへ届いたslugだけを記録する。署名の権威が常にサーバー側
// (/api/device/shares) にあり、ローカルのmanifest.jsonはクエリ解決にしか
// 使われていないことを、この「サーバーに何を聞いたか」で確認する。
function mockDeviceShares(): { calls: Array<{ slug: string }>; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Array<{ slug: string }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/device/shares')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ slug: body.slug });
      return new Response(JSON.stringify({ url: `https://content.example.com/pages/dev/gen/${body.slug}/index.html?e=1&s=sig`, expiresAt: 1 }), { status: 201 });
    }
    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('share resolves an exact slug even when it prefixes another slug, then asks the server to sign it', async () => {
  const { config, credentialsPath } = fixture([
    { slug: 'report-2026-08-04-141049', title: '利用状況レポート 2026-08-04', objectKey: 'pages/report-2026-08-04-141049/index.html' },
    { slug: 'report-2026-08-04-141049-ja', title: '利用状況レポート 2026-08-04(日本語)', objectKey: 'pages/report-2026-08-04-141049-ja/index.html' },
  ]);
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const mock = mockDeviceShares();
  try {
    const url = new URL(await share(config, 'report-2026-08-04-141049', 7));
    assert.equal(url.pathname, '/pages/dev/gen/report-2026-08-04-141049/index.html');
    assert.deepEqual(mock.calls, [{ slug: 'report-2026-08-04-141049' }]);
  } finally {
    mock.restore();
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('share still falls back to partial match when there is no exact slug', async () => {
  const { config, credentialsPath } = fixture([
    { slug: 'demo-report', title: 'デモレポート', objectKey: 'pages/demo-report/index.html' },
  ]);
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const mock = mockDeviceShares();
  try {
    const url = new URL(await share(config, 'demo', 7));
    assert.equal(url.pathname, '/pages/dev/gen/demo-report/index.html');
    assert.deepEqual(mock.calls, [{ slug: 'demo-report' }]);
  } finally {
    mock.restore();
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('share reports an ambiguous partial match when no exact slug exists, without contacting the server', async () => {
  const { config, credentialsPath } = fixture([
    { slug: 'weekly-report-a', title: 'A', objectKey: 'pages/a/index.html' },
    { slug: 'weekly-report-b', title: 'B', objectKey: 'pages/b/index.html' },
  ]);
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const mock = mockDeviceShares();
  try {
    await assert.rejects(share(config, 'weekly-report', 7), /Multiple pages match/);
    assert.deepEqual(mock.calls, []); // 一致が定まらない限りサーバーへは問い合わせない
  } finally {
    mock.restore();
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('share rejects a duration above the configured maximum without contacting the server', async () => {
  const { config, credentialsPath } = fixture([
    { slug: 'demo-report', title: 'デモレポート', objectKey: 'pages/demo-report/index.html' },
  ]);
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const mock = mockDeviceShares();
  try {
    await assert.rejects(share(config, 'demo', 31), /exceeds the configured maximum/);
    assert.deepEqual(mock.calls, []);
  } finally {
    mock.restore();
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

// publish() 本体のテスト。build→lock→(S3への直接PUT)→commit の一連を、fetch(Worker API)と
// S3Client.prototype.send(R2アップロード)の両方をモックして検証する。
function publishFixture(): { config: ReturnType<typeof loadConfig>; credentialsPath: string; deviceToken: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-publish-flow-'));
  mkdirSync(path.join(root, 'pages'));
  writeFileSync(path.join(root, 'pages', 'demo.html'), '<!doctype html><title>Demo</title><h1>Demo</h1>');
  const configFile = path.join(root, 'html-share.config.yaml');
  writeFileSync(configFile, `ownerEmail: owner@example.com
cloudflare:
  accountId: "0123456789abcdef0123456789abcdef"
  consoleDomain: ${CONSOLE_DOMAIN}
  contentDomain: content.example.com
  contentBucket: html-share-content
  publicKeyPath: keys/public.pem
  privateKeyPath: keys/private.pem
content:
  roots: [pages]
  pages:
    - path: pages/demo.html
      slug: demo
`);
  const config = loadConfig(configFile);
  const credentialsPath = path.join(root, 'review-device.json');
  const deviceToken = 'b'.repeat(43);
  writeFileSync(credentialsPath, JSON.stringify({
    deviceToken, deviceName: 'Publish PC', apiBase: `https://${CONSOLE_DOMAIN}/api`,
  }));
  return { config, credentialsPath, deviceToken };
}

function deviceIdFor(deviceToken: string): string {
  return createHash('sha256').update(deviceToken).digest('hex');
}

test('publish acquires a lock, uploads each page to the deviceId/gen-prefixed R2 key, and commits with matching bytes/md5', async () => {
  const { config, credentialsPath, deviceToken } = publishFixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  process.env.R2_ACCESS_KEY_ID = 'test-key';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  const deviceId = deviceIdFor(deviceToken);

  const fetchCalls: Array<{ path: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    fetchCalls.push({ path: url.pathname, body });
    if (url.pathname === '/api/device/publish/lock') {
      return new Response(JSON.stringify({ token: 'lock-token', gen: '1700000000-deadbeefcafebabe', expiresAt: 1700001800 }), { status: 200 });
    }
    if (url.pathname === '/api/device/publish/commit') {
      return new Response(JSON.stringify({ ok: true, pages: body.pages.length, gcDeleted: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected request' }), { status: 404 });
  }) as typeof fetch;

  const s3Calls: Array<{ Bucket: string; Key: string; ContentType: string; Body: Buffer }> = [];
  const originalSend = S3Client.prototype.send;
  (S3Client.prototype as any).send = async function send(command: any) {
    s3Calls.push({ ...command.input });
    return {};
  };

  try {
    const result = await publish(config);
    assert.equal(result.pages, 1);
    assert.equal(result.consoleUrl, `https://${CONSOLE_DOMAIN}/app/`);

    // lock取得→(このテストでは1件のみなので)renewは呼ばれない→commitの順
    assert.deepEqual(fetchCalls.map((call) => call.path), ['/api/device/publish/lock', '/api/device/publish/commit']);

    assert.equal(s3Calls.length, 1);
    const expectedBody = Buffer.from('<!doctype html><title>Demo</title><h1>Demo</h1>');
    // bundleHtml()がプライバシー用metaタグ等を注入するため、アップロード本文は
    // 元のソースそのものではない——ここではキー構造とcommitとの整合だけを見る。
    assert.equal(s3Calls[0].Bucket, 'html-share-content');
    assert.equal(s3Calls[0].Key, `pages/${deviceId}/1700000000-deadbeefcafebabe/demo/index.html`);
    assert.equal(s3Calls[0].ContentType, 'text/html; charset=utf-8');

    const commitCall = fetchCalls.find((call) => call.path === '/api/device/publish/commit')!;
    assert.equal(commitCall.body.lockToken, 'lock-token');
    assert.equal(commitCall.body.pages.length, 1);
    const [committedPage] = commitCall.body.pages;
    assert.equal(committedPage.slug, 'demo');
    assert.equal(committedPage.bytes, s3Calls[0].Body.length);
    assert.equal(committedPage.md5, createHash('md5').update(s3Calls[0].Body as Buffer).digest('hex'));
  } finally {
    globalThis.fetch = originalFetch;
    S3Client.prototype.send = originalSend;
    delete process.env.HTML_SHARE_CREDENTIALS;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
  }
});

test('publish refuses to run without R2 credentials in the environment', async () => {
  const { config, credentialsPath } = publishFixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  try {
    await assert.rejects(publish(config), /R2_ACCESS_KEY_ID/);
  } finally {
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});
