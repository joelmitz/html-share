import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import internalWorker from '../workers/internal/src/index.js';
import { resetAccessKeyCacheForTests } from '../workers/shared/access.js';
import { R2Stub } from './helpers/d1-stub.ts';

// internal Worker: 署名URLではなくCloudflare Access JWTそのものを検証する
// （console workerと同じ仕組み）。テストの型はtest/access-jwt.test.tsおよび
// test/console-worker.test.tsのAccess JWT検証テストと揃える。

const OWNER_EMAIL = 'owner@example.com';
const TEAM_DOMAIN = 'team.cloudflareaccess.com';
const AUD = 'internal-aud-tag';
const CONSOLE_ORIGIN = 'https://console.example.com';
const INTERNAL = 'https://internal.example.com';

const accessKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const accessJwk = { ...accessKey.publicKey.export({ format: 'jwk' }), kid: 'k1' };

function ownerJwt(email = OWNER_EMAIL): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: [AUD],
    iss: `https://${TEAM_DOMAIN}`,
    exp: Math.floor(Date.now() / 1000) + 600,
    email,
  })).toString('base64url');
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(accessKey.privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

function fixture(): { env: any; bucket: R2Stub } {
  resetAccessKeyCacheForTests();
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ keys: [accessJwk] }), { headers: { 'content-type': 'application/json' } });
  const bucket = new R2Stub();
  bucket.put('pages/demo/index.html', { body: '<h1>Internal Demo</h1>', contentType: 'text/html; charset=utf-8' });
  const env = {
    INTERNAL: bucket,
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    OWNER_EMAIL,
    CONSOLE_ORIGIN,
  };
  return { env, bucket };
}

test('serves an object when the Access JWT is valid and owned by OWNER_EMAIL', async () => {
  const { env } = fixture();
  const response = await internalWorker.fetch(
    new Request(`${INTERNAL}/pages/demo/index.html`, { headers: { 'cf-access-jwt-assertion': ownerJwt() } }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<h1>Internal Demo</h1>');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(response.headers.get('content-security-policy') ?? '', /sandbox allow-scripts/);
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors https:\/\/console\.example\.com/);
});

test('rejects a request with no Access JWT at all', async () => {
  const { env } = fixture();
  const response = await internalWorker.fetch(new Request(`${INTERNAL}/pages/demo/index.html`), env);
  assert.equal(response.status, 401);
});

test('rejects a JWT for a different email than OWNER_EMAIL', async () => {
  const { env } = fixture();
  const response = await internalWorker.fetch(
    new Request(`${INTERNAL}/pages/demo/index.html`, {
      headers: { 'cf-access-jwt-assertion': ownerJwt('intruder@example.com') },
    }), env);
  assert.equal(response.status, 401);
});

test('rejects a JWT whose audience does not match ACCESS_AUD (e.g. a token minted for the console app)', async () => {
  const { env } = fixture();
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: ['some-other-aud'],
    iss: `https://${TEAM_DOMAIN}`,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: OWNER_EMAIL,
  })).toString('base64url');
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(accessKey.privateKey, 'base64url');
  const response = await internalWorker.fetch(
    new Request(`${INTERNAL}/pages/demo/index.html`, {
      headers: { 'cf-access-jwt-assertion': `${header}.${payload}.${signature}` },
    }), env);
  assert.equal(response.status, 401);
});

test('returns 404 for a valid Access session but a missing object', async () => {
  const { env } = fixture();
  const response = await internalWorker.fetch(
    new Request(`${INTERNAL}/pages/missing/index.html`, { headers: { 'cf-access-jwt-assertion': ownerJwt() } }), env);
  assert.equal(response.status, 404);
});

test('rejects path traversal even with a valid Access session', async () => {
  const { env } = fixture();
  const response = await internalWorker.fetch(
    new Request(`${INTERNAL}/pages/../../../etc/passwd`, { headers: { 'cf-access-jwt-assertion': ownerJwt() } }), env);
  assert.equal(response.status, 404);
});

test('rejects non-GET methods even with a valid Access session', async () => {
  const { env } = fixture();
  const response = await internalWorker.fetch(
    new Request(`${INTERNAL}/pages/demo/index.html`, {
      method: 'POST', body: 'x', headers: { 'cf-access-jwt-assertion': ownerJwt() },
    }), env);
  assert.equal(response.status, 405);
});
