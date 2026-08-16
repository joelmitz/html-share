import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  acquirePublishLock,
  claimReviews,
  commitPublish,
  deviceShare,
  listInbox,
  pairedDeviceId,
  renewPublishLock,
} from '../src/review-client.js';

const CONSOLE_DOMAIN = 'console.example.com';

function fixture(): { config: ReturnType<typeof loadConfig>; credentialsPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-review-client-'));
  mkdirSync(path.join(root, 'pages'));
  writeFileSync(path.join(root, 'pages', 'demo.html'), '<h1>Demo</h1>');
  const configFile = path.join(root, 'html-share.config.yaml');
  writeFileSync(configFile, `ownerEmail: owner@example.com
cloudflare:
  accountId: "0123456789abcdef0123456789abcdef"
  consoleDomain: ${CONSOLE_DOMAIN}
  contentDomain: content.example.com
  consoleBucket: html-share-console
  contentBucket: html-share-content
  publicKeyPath: keys/public.pem
  privateKeyPath: keys/private.pem
content:
  roots: [pages]
  pages:
    - path: pages/demo.html
`);
  const credentialsPath = path.join(root, 'review-device.json');
  writeFileSync(credentialsPath, JSON.stringify({
    deviceToken: 'a'.repeat(43),
    deviceName: 'Test PC',
    apiBase: `https://${CONSOLE_DOMAIN}/api`,
  }));
  return { config: loadConfig(configFile), credentialsPath };
}

function mockFetch(statusById: Record<string, number>): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const match = url.match(/\/device\/reviews\/([^/]+)\/claim$/);
    const id = match?.[1] ?? '';
    const status = statusById[id] ?? 404;
    const body = status === 200
      ? { item: { id, status: 'in_progress' } }
      : { error: `mock ${status}` };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('claimReviews skips only 409s and continues to remaining ids', async () => {
  const { config, credentialsPath } = fixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const mock = mockFetch({ a: 200, b: 409, c: 200 });
  try {
    const results = await claimReviews(config, ['a', 'b', 'c']);
    assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
    assert.equal(mock.calls.length, 3); // 409はスキップされるが後続のidは処理される
  } finally {
    mock.restore();
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('claimReviews does not swallow a non-409 failure as a per-item skip', async () => {
  const { config, credentialsPath } = fixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const mock = mockFetch({ a: 200, b: 401 });
  try {
    // 401（pairing失効等）はclaimReviews内で握り潰さず例外として全体を止める。
    // 「他PCに取られた」と誤認して後続idの処理へ進んではいけない。
    await assert.rejects(() => claimReviews(config, ['a', 'b', 'c']), /mock 401/);
    assert.equal(mock.calls.length, 2); // bで停止し、cは呼ばれない
  } finally {
    mock.restore();
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('claimReviews treats 500 and other server errors as fatal too', async () => {
  const { config, credentialsPath } = fixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const mock = mockFetch({ a: 500 });
  try {
    await assert.rejects(() => claimReviews(config, ['a']), /mock 500/);
  } finally {
    mock.restore();
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('listInbox merges waiting and in_progress so a stranded claim is rediscovered', async () => {
  const { config, credentialsPath } = fixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('status=waiting')) {
      return new Response(JSON.stringify({
        items: [{ id: 'w1', status: 'waiting', source: 'owner', sessionId: 'inbox', updatedAt: '2026-08-16T01:00:00Z', title: '', question: '' }],
      }), { status: 200 });
    }
    if (url.includes('status=in_progress')) {
      return new Response(JSON.stringify({
        items: [{ id: 'p1', status: 'in_progress', source: 'owner', sessionId: 'inbox', updatedAt: '2026-08-16T00:00:00Z', title: '', question: '' }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const requests = await listInbox(config);
    assert.equal(calls.length, 2); // waitingとin_progressを両方問い合わせる
    const ids = requests.map((r) => r.id).sort();
    assert.deepEqual(ids, ['p1', 'w1']);
    assert.equal(requests.find((r) => r.id === 'p1')?.status, 'in_progress');
    assert.equal(requests.find((r) => r.id === 'w1')?.status, 'waiting');
  } finally {
    globalThis.fetch = original;
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('pairedDeviceId derives sha256(deviceToken) locally, matching the server’s device() derivation', () => {
  const { config, credentialsPath } = fixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  try {
    const deviceToken = 'a'.repeat(43); // fixture()が書き込む値と一致させる
    assert.equal(pairedDeviceId(config), createHash('sha256').update(deviceToken).digest('hex'));
  } finally {
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('pairedDeviceId refuses to derive an identity when the paired console does not match this config (§3)', () => {
  const { credentialsPath } = fixture();
  // 別のconsoleDomainを指す設定——ペアリング時と異なるサーバーへ向いている状態を模す
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-review-client-mismatch-'));
  mkdirSync(path.join(root, 'pages'));
  writeFileSync(path.join(root, 'pages', 'demo.html'), '<h1>Demo</h1>');
  const otherConfigFile = path.join(root, 'html-share.config.yaml');
  writeFileSync(otherConfigFile, `ownerEmail: owner@example.com
cloudflare:
  accountId: "0123456789abcdef0123456789abcdef"
  consoleDomain: other-console.example.com
  contentDomain: content.example.com
  consoleBucket: html-share-console
  contentBucket: html-share-content
  publicKeyPath: keys/public.pem
  privateKeyPath: keys/private.pem
content:
  roots: [pages]
  pages:
    - path: pages/demo.html
`);
  const otherConfig = loadConfig(otherConfigFile);
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  try {
    assert.throws(() => pairedDeviceId(otherConfig), /paired console does not match/);
  } finally {
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});

test('publish lock/renew/commit and device shares call the expected endpoints with the expected bodies', async () => {
  const { config, credentialsPath } = fixture();
  process.env.HTML_SHARE_CREDENTIALS = credentialsPath;
  const calls: Array<{ path: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname === '/api/device/publish/lock') {
      return new Response(JSON.stringify({ token: 't1', gen: 'g1', expiresAt: 111 }), { status: 200 });
    }
    if (url.pathname === '/api/device/publish/renew') {
      return new Response(JSON.stringify({ expiresAt: 222 }), { status: 200 });
    }
    if (url.pathname === '/api/device/publish/commit') {
      return new Response(JSON.stringify({ ok: true, pages: 2, gcDeleted: 3 }), { status: 200 });
    }
    if (url.pathname === '/api/device/shares') {
      return new Response(JSON.stringify({ url: 'https://content.example.com/pages/x/index.html?e=1&s=sig', expiresAt: 333 }), { status: 201 });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 404 });
  }) as typeof fetch;
  try {
    const lock = await acquirePublishLock(config);
    assert.deepEqual(lock, { token: 't1', gen: 'g1', expiresAt: 111 });
    assert.deepEqual(calls[0], { path: '/api/device/publish/lock', body: {} });

    const renewed = await renewPublishLock(config, 't1');
    assert.deepEqual(renewed, { expiresAt: 222 });
    assert.deepEqual(calls[1], { path: '/api/device/publish/renew', body: { lockToken: 't1' } });

    const page = { slug: 's', title: 't', source: 'src', repository: 'r', stream: 'm', streamLabel: 'M', date: 'd', updatedAt: 'u', bytes: 5, md5: 'a'.repeat(32) };
    const committed = await commitPublish(config, 't1', [page]);
    assert.deepEqual(committed, { pages: 2, gcDeleted: 3 });
    assert.deepEqual(calls[2], { path: '/api/device/publish/commit', body: { lockToken: 't1', pages: [page] } });

    const shared = await deviceShare(config, 'x', 'public', 7);
    assert.equal(shared.expiresAt, 333);
    assert.deepEqual(calls[3], { path: '/api/device/shares', body: { slug: 'x', scope: 'public', days: 7 } });
  } finally {
    globalThis.fetch = original;
    delete process.env.HTML_SHARE_CREDENTIALS;
  }
});
