// console Worker の workerd 統合テスト。
// 実 workerd + ローカル D1/R2 で、認証境界・claim一回性・body上限・共有署名を検証する。
// Access certs エンドポイントは vitest.config.mts の outboundService でモックされる。
import { SELF, env } from 'cloudflare:test';
import { beforeAll, expect, test } from 'vitest';

const CONSOLE = 'https://console.example.com';
const testEnv = env as any;

function base64UrlEncode(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string'
    ? bytes
    : [...bytes].map((byte) => String.fromCharCode(byte)).join('');
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string, label: string): ArrayBuffer {
  const body = pem.replace(new RegExp(`-----(BEGIN|END) ${label}-----`, 'g'), '').replace(/\s+/g, '');
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

async function ownerJwt(email: string = testEnv.OWNER_EMAIL): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(testEnv.TEST_ACCESS_PRIVATE_KEY, 'PRIVATE KEY'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const payload = base64UrlEncode(JSON.stringify({
    aud: [testEnv.ACCESS_AUD],
    iss: `https://${testEnv.ACCESS_TEAM_DOMAIN}`,
    exp: Math.floor(Date.now() / 1000) + 600,
    email,
  }));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function ownerHeaders(): Promise<Record<string, string>> {
  return { 'cf-access-jwt-assertion': await ownerJwt(), origin: testEnv.CONSOLE_ORIGIN };
}

beforeAll(async () => {
  await testEnv.CONSOLE.put('index.html', '<h1>Landing</h1>', {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  await testEnv.CONSOLE.put('app/index.html', '<h1>App</h1>', {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
});

test('auth boundary: landing is public, /app and owner API require Access JWT', async () => {
  const landing = await SELF.fetch(`${CONSOLE}/`);
  expect(landing.status).toBe(200);

  const blockedPage = await SELF.fetch(`${CONSOLE}/app/index.html`);
  expect(blockedPage.status).toBe(401);

  const blockedApi = await SELF.fetch(`${CONSOLE}/api/owner/reviews`);
  expect(blockedApi.status).toBe(401);

  const intruder = await SELF.fetch(`${CONSOLE}/api/owner/reviews`, {
    headers: { 'cf-access-jwt-assertion': await ownerJwt('intruder@example.com') },
  });
  expect(intruder.status).toBe(401);

  const allowedPage = await SELF.fetch(`${CONSOLE}/app/index.html`, {
    headers: { 'cf-access-jwt-assertion': await ownerJwt() },
  });
  expect(allowedPage.status).toBe(200);
});

test('pairing claim succeeds once and is rejected afterwards (real D1)', async () => {
  const pairing = await SELF.fetch(`${CONSOLE}/api/owner/pairings`, {
    method: 'POST',
    headers: await ownerHeaders(),
  });
  expect(pairing.status).toBe(201);
  const { code } = await pairing.json() as any;

  const claim = await SELF.fetch(`${CONSOLE}/api/pairings/claim`, {
    method: 'POST',
    body: JSON.stringify({ code, deviceName: 'Workerd PC' }),
  });
  expect(claim.status).toBe(200);
  const { deviceToken } = await claim.json() as any;
  expect(deviceToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

  const again = await SELF.fetch(`${CONSOLE}/api/pairings/claim`, {
    method: 'POST',
    body: JSON.stringify({ code, deviceName: 'Second PC' }),
  });
  expect(again.status).toBe(409);

  // 取得したトークンで device API に到達できる（認証境界の正側）
  const inbox = await SELF.fetch(`${CONSOLE}/api/device/reviews`, {
    headers: { 'x-review-device-token': deviceToken },
  });
  expect(inbox.status).toBe(200);
});

test('device API rejects unpaired tokens', async () => {
  const missing = await SELF.fetch(`${CONSOLE}/api/device/reviews`);
  expect(missing.status).toBe(401);
  const unknown = await SELF.fetch(`${CONSOLE}/api/device/reviews`, {
    headers: { 'x-review-device-token': 'A'.repeat(43) },
  });
  expect(unknown.status).toBe(401);
});

test('owner request flows to a device via claim and completes (real D1)', async () => {
  const pairing = await SELF.fetch(`${CONSOLE}/api/owner/pairings`, {
    method: 'POST', headers: await ownerHeaders(),
  });
  const { code } = await pairing.json() as any;
  const claim = await SELF.fetch(`${CONSOLE}/api/pairings/claim`, {
    method: 'POST', body: JSON.stringify({ code, deviceName: 'Flow PC' }),
  });
  const { deviceToken } = await claim.json() as any;

  const posted = await SELF.fetch(`${CONSOLE}/api/owner/reviews`, {
    method: 'POST',
    headers: await ownerHeaders(),
    body: JSON.stringify({ question: '資料をまとめて', target: 'html-share' }),
  });
  expect(posted.status).toBe(201);
  const { item } = await posted.json() as any;
  expect(item.sessionId).toBe('inbox');

  const pulled = await SELF.fetch(`${CONSOLE}/api/device/reviews?status=waiting&sessionId=inbox`, {
    headers: { 'x-review-device-token': deviceToken },
  });
  const { items } = await pulled.json() as any;
  expect(items.some((entry: any) => entry.id === item.id)).toBe(true);

  const claimed = await SELF.fetch(`${CONSOLE}/api/device/reviews/${item.id}/claim`, {
    method: 'POST', headers: { 'x-review-device-token': deviceToken }, body: '{}',
  });
  expect(claimed.status).toBe(200);
  expect((await claimed.json() as any).item.status).toBe('in_progress');

  const completed = await SELF.fetch(`${CONSOLE}/api/device/reviews/${item.id}/complete`, {
    method: 'POST', headers: { 'x-review-device-token': deviceToken }, body: '{}',
  });
  expect(completed.status).toBe(200);
});

test('rejects request bodies above the 1MB cap with 413', async () => {
  const oversized = await SELF.fetch(`${CONSOLE}/api/pairings/claim`, {
    method: 'POST',
    body: JSON.stringify({ code: 'AAAA-AAAA', padding: 'x'.repeat(1_100_000) }),
  });
  expect(oversized.status).toBe(413);
});

test('owner shares return a signed URL in the expected format', async () => {
  const share = await SELF.fetch(`${CONSOLE}/api/owner/shares`, {
    method: 'POST',
    headers: await ownerHeaders(),
    body: JSON.stringify({ slug: 'demo', scope: 'public', days: 7 }),
  });
  expect(share.status).toBe(201);
  const { url } = await share.json() as any;
  const parsed = new URL(url);
  expect(parsed.origin).toBe(testEnv.CONTENT_ORIGIN);
  expect(parsed.searchParams.get('e')).toMatch(/^\d+$/);
  expect(parsed.searchParams.get('s')).toMatch(/^[A-Za-z0-9_-]+$/);

  const internal = await SELF.fetch(`${CONSOLE}/api/owner/shares`, {
    method: 'POST',
    headers: await ownerHeaders(),
    body: JSON.stringify({ slug: 'demo', scope: 'internal', days: 7 }),
  });
  expect(internal.status).toBe(201);
  const internalUrl = new URL((await internal.json() as any).url);
  expect(internalUrl.searchParams.get('i')).toMatch(/^[A-Za-z0-9_-]+$/);
});
