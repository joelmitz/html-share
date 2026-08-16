import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signUrl, signingPayload } from '../src/sign.js';

function keyPair(): { privateKeyPath: string; publicKey: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'html-share-sign-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const privateKeyPath = path.join(directory, 'private.pem');
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  return { privateKeyPath, publicKey };
}

test('creates a time-limited signed URL that verifies with the public key', () => {
  const { privateKeyPath, publicKey } = keyPair();
  const signed = new URL(signUrl({
    url: 'https://content.example.com/pages/demo/index.html',
    privateKeyPath,
    days: 7,
  }));
  const expires = Number(signed.searchParams.get('e'));
  assert.ok(expires > Date.now() / 1000);
  assert.ok(expires <= Date.now() / 1000 + 7 * 24 * 60 * 60);
  const verified = createVerify('RSA-SHA256')
    .update(signingPayload(signed.pathname, expires, ''))
    .verify(publicKey, signed.searchParams.get('s')!, 'base64url');
  assert.equal(verified, true);
});

test('embeds internal CIDRs into the signed payload', () => {
  const { privateKeyPath, publicKey } = keyPair();
  const signed = new URL(signUrl({
    url: 'https://content.example.com/pages/demo/index.html',
    privateKeyPath,
    days: 1,
    cidrs: ['203.0.113.0/24'],
  }));
  const cidrParam = signed.searchParams.get('i')!;
  assert.deepEqual(JSON.parse(Buffer.from(cidrParam, 'base64url').toString('utf8')), ['203.0.113.0/24']);
  const verified = createVerify('RSA-SHA256')
    .update(signingPayload(signed.pathname, Number(signed.searchParams.get('e')), cidrParam))
    .verify(publicKey, signed.searchParams.get('s')!, 'base64url');
  assert.equal(verified, true);
});

test('rejects a non-positive share duration', () => {
  const { privateKeyPath } = keyPair();
  assert.throws(() => signUrl({
    url: 'https://content.example.com/pages/demo/index.html',
    privateKeyPath,
    days: 0,
  }), /positive integer/);
});
