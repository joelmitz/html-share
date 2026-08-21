import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import test from 'node:test';
import { resetAccessKeyCacheForTests, verifyAccessJwt } from '../workers/shared/access.js';

const CONFIG = {
  teamDomain: 'team.cloudflareaccess.com',
  audience: 'aud-tag-1234',
  ownerEmail: 'owner@example.com',
};

function keyPair(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { privateKey, jwk };
}

function makeJwt(privateKey: KeyObject, options: {
  kid?: string;
  alg?: string;
  aud?: unknown;
  iss?: string;
  exp?: number;
  email?: string;
  breakSignature?: boolean;
} = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: options.aud ?? [CONFIG.audience],
    iss: options.iss ?? `https://${CONFIG.teamDomain}`,
    exp: options.exp ?? Math.floor(Date.now() / 1000) + 600,
    email: options.email ?? CONFIG.ownerEmail,
  })).toString('base64url');
  let signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey, 'base64url');
  if (options.breakSignature) signature = signature.slice(0, -4) + (signature.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  return `${header}.${payload}.${signature}`;
}

function stubCerts(responses: Array<Record<string, unknown>[]>): () => number {
  let calls = 0;
  (globalThis as any).fetch = async () => {
    const keys = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/json' } });
  };
  return () => calls;
}

const originalFetch = globalThis.fetch;

test('access jwt verification', async (t) => {
  t.beforeEach(() => resetAccessKeyCacheForTests());
  t.afterEach(() => { (globalThis as any).fetch = originalFetch; });

  await t.test('accepts a valid owner JWT', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey), CONFIG), true);
  });

  await t.test('rejects a tampered signature', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { breakSignature: true }), CONFIG), false);
  });

  await t.test('rejects a JWT signed by a different key', async () => {
    const attacker = keyPair();
    const { jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(attacker.privateKey), CONFIG), false);
  });

  await t.test('rejects non-RS256 algorithms', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { alg: 'HS256' }), CONFIG), false);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { alg: 'none' }), CONFIG), false);
  });

  await t.test('rejects an unknown kid even after a forced refresh', async () => {
    const { privateKey, jwk } = keyPair();
    const count = stubCerts([[{ ...jwk, kid: 'other' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { kid: 'k1' }), CONFIG), false);
    assert.equal(count(), 2); // cache miss後に1回だけ強制再取得している
  });

  await t.test('finds a rotated kid via forced refresh within the cache TTL', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'old' }], [{ ...jwk, kid: 'old' }, { ...jwk, kid: 'k1' }]]);
    // 1回目でcacheに'old'のみが載る
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { kid: 'old' }), CONFIG), true);
    // rotation後の'k1'はcacheに無いが、強制refreshで見つかる
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { kid: 'k1' }), CONFIG), true);
  });

  await t.test('does not refetch certs for a second unknown kid within the cooldown', async () => {
    const { privateKey, jwk } = keyPair();
    const count = stubCerts([[{ ...jwk, kid: 'other' }]]);
    // 1回目の未知kid: cache構築 + 強制refreshで計2 fetch
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { kid: 'k1' }), CONFIG), false);
    assert.equal(count(), 2);
    // cooldown中の2回目の未知kid: 追加fetchせず即false
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { kid: 'k2' }), CONFIG), false);
    assert.equal(count(), 2);
  });

  await t.test('rejects a wrong audience', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { aud: ['other-aud'] }), CONFIG), false);
  });

  await t.test('rejects a wrong issuer', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { iss: 'https://evil.cloudflareaccess.com' }), CONFIG), false);
  });

  await t.test('rejects an expired JWT', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { exp: Math.floor(Date.now() / 1000) - 10 }), CONFIG), false);
  });

  await t.test('rejects a different authenticated email', async () => {
    const { privateKey, jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt(makeJwt(privateKey, { email: 'intruder@example.com' }), CONFIG), false);
  });

  await t.test('rejects structurally invalid tokens', async () => {
    const { jwk } = keyPair();
    stubCerts([[{ ...jwk, kid: 'k1' }]]);
    assert.equal(await verifyAccessJwt('', CONFIG), false);
    assert.equal(await verifyAccessJwt('a.b', CONFIG), false);
    assert.equal(await verifyAccessJwt('not-base64!.payload.sig', CONFIG), false);
  });
});
