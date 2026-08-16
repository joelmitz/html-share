import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { claimReviews, listInbox } from '../src/review-client.js';

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
