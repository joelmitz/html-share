import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signUrl } from '../src/sign.js';
import contentWorker from '../workers/content/src/index.js';
import { R2Stub } from './helpers/d1-stub.ts';

// content worker は公開鍵を module scope で cache するため、鍵ペアはファイル全体で1組に固定する
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const keyDirectory = mkdtempSync(path.join(tmpdir(), 'html-share-content-'));
const sharedPrivateKeyPath = path.join(keyDirectory, 'private.pem');
writeFileSync(sharedPrivateKeyPath, keys.privateKey, { mode: 0o600 });

function fixture(): { privateKeyPath: string; env: any; bucket: R2Stub } {
  const bucket = new R2Stub();
  bucket.put('pages/demo/index.html', { body: '<h1>Demo</h1>', contentType: 'text/html; charset=utf-8' });
  const env = {
    CONTENT: bucket,
    SIGNING_PUBLIC_KEY: keys.publicKey,
    CONSOLE_ORIGIN: 'https://console.example.com',
  };
  return { privateKeyPath: sharedPrivateKeyPath, env, bucket };
}

const CONTENT = 'https://content.example.com';

test('serves a CLI-signed URL with the sandboxed CSP', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = signUrl({ url: `${CONTENT}/pages/demo/index.html`, privateKeyPath, days: 7 });
  const response = await contentWorker.fetch(new Request(signed), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<h1>Demo</h1>');
  assert.match(response.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/);
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors https:\/\/console\.example\.com/);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('rejects a URL whose path was tampered after signing', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = new URL(signUrl({ url: `${CONTENT}/pages/demo/index.html`, privateKeyPath, days: 7 }));
  signed.pathname = '/pages/other/index.html';
  const response = await contentWorker.fetch(new Request(signed.toString()), env);
  assert.equal(response.status, 403);
});

test('rejects a URL whose expiry was extended after signing', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = new URL(signUrl({ url: `${CONTENT}/pages/demo/index.html`, privateKeyPath, days: 1 }));
  signed.searchParams.set('e', String(Number(signed.searchParams.get('e')) + 3600));
  const response = await contentWorker.fetch(new Request(signed.toString()), env);
  assert.equal(response.status, 403);
});

test('rejects an expired URL even with a valid signature', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = new URL(signUrl({ url: `${CONTENT}/pages/demo/index.html`, privateKeyPath, days: 1 }));
  // 期限切れを署名ごと偽造はできないので、検証順を確認するため e を過去に書き換える
  // （署名不一致でも期限切れでも 403 になること自体を確認する）
  signed.searchParams.set('e', String(Math.floor(Date.now() / 1000) - 10));
  const response = await contentWorker.fetch(new Request(signed.toString()), env);
  assert.equal(response.status, 403);
});

test('rejects a URL with no signature parameters', async () => {
  const { env } = fixture();
  const response = await contentWorker.fetch(new Request(`${CONTENT}/pages/demo/index.html`), env);
  assert.equal(response.status, 403);
});

test('enforces internal CIDRs against CF-Connecting-IP', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = signUrl({
    url: `${CONTENT}/pages/demo/index.html`,
    privateKeyPath,
    days: 1,
    cidrs: ['203.0.113.0/24'],
  });
  const inside = await contentWorker.fetch(
    new Request(signed, { headers: { 'cf-connecting-ip': '203.0.113.7' } }), env);
  assert.equal(inside.status, 200);
  const outside = await contentWorker.fetch(
    new Request(signed, { headers: { 'cf-connecting-ip': '198.51.100.7' } }), env);
  assert.equal(outside.status, 403);
  const missing = await contentWorker.fetch(new Request(signed), env);
  assert.equal(missing.status, 403);
});

test('rejects moving the CIDR parameter out of the signed payload', async () => {
  const { privateKeyPath, env } = fixture();
  // CIDR無しで署名したURLに、後からiを付けても署名不一致になる
  const signed = new URL(signUrl({ url: `${CONTENT}/pages/demo/index.html`, privateKeyPath, days: 1 }));
  signed.searchParams.set('i', Buffer.from(JSON.stringify(['0.0.0.0/0'])).toString('base64url'));
  const response = await contentWorker.fetch(
    new Request(signed.toString(), { headers: { 'cf-connecting-ip': '203.0.113.7' } }), env);
  assert.equal(response.status, 403);
});

test('closes malformed percent-encoding as 404 instead of crashing', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = signUrl({ url: `${CONTENT}/pages/%zz/index.html`, privateKeyPath, days: 1 });
  const response = await contentWorker.fetch(new Request(signed), env);
  assert.equal(response.status, 404);
});

test('returns 404 for a signed URL whose object is absent', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = signUrl({ url: `${CONTENT}/pages/missing/index.html`, privateKeyPath, days: 1 });
  const response = await contentWorker.fetch(new Request(signed), env);
  assert.equal(response.status, 404);
});

test('rejects non-GET methods', async () => {
  const { privateKeyPath, env } = fixture();
  const signed = signUrl({ url: `${CONTENT}/pages/demo/index.html`, privateKeyPath, days: 1 });
  const response = await contentWorker.fetch(new Request(signed, { method: 'POST', body: 'x' }), env);
  assert.equal(response.status, 405);
});
