// content Worker の workerd 統合テスト。
// CLIと同一形式の署名をWebCryptoで生成し、実 workerd 上の検証・R2配信・CSPを確かめる。
import { SELF, env } from 'cloudflare:test';
import { beforeAll, expect, test } from 'vitest';

const CONTENT = 'https://content.example.com';
const testEnv = env as any;

function base64UrlEncode(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string'
    ? bytes
    : [...bytes].map((byte) => String.fromCharCode(byte)).join('');
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

// src/sign.ts と同じ署名形式（pathname\ne\ni への RSA-SHA256）を WebCrypto で再現する
async function signUrl(pathname: string, options: { expiresAt?: number; cidrs?: string[] } = {}): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(testEnv.TEST_SIGNING_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const expiresAt = options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600;
  const cidrParam = options.cidrs?.length ? base64UrlEncode(JSON.stringify(options.cidrs)) : '';
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(`${pathname}\n${expiresAt}\n${cidrParam}`),
  );
  const url = new URL(pathname, CONTENT);
  url.search = new URLSearchParams({
    e: String(expiresAt),
    ...(cidrParam ? { i: cidrParam } : {}),
    s: base64UrlEncode(new Uint8Array(signature)),
  }).toString();
  return url.toString();
}

beforeAll(async () => {
  await testEnv.CONTENT.put('pages/demo/index.html', '<h1>Demo</h1>', {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
});

test('serves a signed URL with the sandboxed CSP (interop with the CLI format)', async () => {
  const response = await SELF.fetch(await signUrl('/pages/demo/index.html'));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('<h1>Demo</h1>');
  expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  expect(response.headers.get('content-security-policy')).toContain('frame-ancestors https://console.example.com');
});

test('rejects tampered or unsigned requests', async () => {
  const signed = new URL(await signUrl('/pages/demo/index.html'));
  signed.pathname = '/pages/other/index.html';
  expect((await SELF.fetch(signed.toString())).status).toBe(403);

  const extended = new URL(await signUrl('/pages/demo/index.html'));
  extended.searchParams.set('e', String(Number(extended.searchParams.get('e')) + 3600));
  expect((await SELF.fetch(extended.toString())).status).toBe(403);

  expect((await SELF.fetch(`${CONTENT}/pages/demo/index.html`)).status).toBe(403);
});

test('rejects an expired URL', async () => {
  const expired = await signUrl('/pages/demo/index.html', {
    expiresAt: Math.floor(Date.now() / 1000) - 10,
  });
  expect((await SELF.fetch(expired)).status).toBe(403);
});

test('enforces internal CIDRs against CF-Connecting-IP', async () => {
  const signed = await signUrl('/pages/demo/index.html', { cidrs: ['203.0.113.0/24'] });
  const inside = await SELF.fetch(signed, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  expect(inside.status).toBe(200);
  const outside = await SELF.fetch(signed, { headers: { 'cf-connecting-ip': '198.51.100.7' } });
  expect(outside.status).toBe(403);
});

test('rejects a CIDR parameter added after signing', async () => {
  const signed = new URL(await signUrl('/pages/demo/index.html'));
  signed.searchParams.set('i', base64UrlEncode(JSON.stringify(['203.0.113.0/24'])));
  const response = await SELF.fetch(signed.toString(), { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  expect(response.status).toBe(403);
});
