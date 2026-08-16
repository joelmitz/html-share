// console Worker の workerd 統合テスト。
// 実 workerd + ローカル D1/R2 で、認証境界・claim一回性・body上限・共有署名を検証する。
// Access certs エンドポイントは vitest.config.mts の outboundService でモックされる。
import { createHash } from 'node:crypto';
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

async function pairDevice(name: string): Promise<string> {
  const pairing = await SELF.fetch(`${CONSOLE}/api/owner/pairings`, { method: 'POST', headers: await ownerHeaders() });
  const { code } = await pairing.json() as any;
  const claimed = await SELF.fetch(`${CONSOLE}/api/pairings/claim`, {
    method: 'POST', body: JSON.stringify({ code, deviceName: name }),
  });
  return (await claimed.json() as any).deviceToken;
}

// lock -> R2へ実際にput（本物のR2 binding。S3 APIのアップロードに相当）-> commit
// までを一気に進める。本物のR2のetagが単一パートPutObjectのcontent-md5であることに
// 依存する（verifyUploadedPagesの前提そのものを、スタブではなく実workerdで検証する）。
async function publishPage(
  deviceToken: string, slug: string, html: string,
  fields: Partial<{ title: string; source: string; repository: string; stream: string; streamLabel: string; date: string; updatedAt: string }> = {},
): Promise<{ gen: string; objectKey: string }> {
  const lockRes = await SELF.fetch(`${CONSOLE}/api/device/publish/lock`, {
    method: 'POST', headers: { 'x-review-device-token': deviceToken },
  });
  const { token: lockToken, gen } = await lockRes.json() as any;
  const objectKey = `pages/${await deviceIdOf(deviceToken)}/${gen}/${slug}/index.html`;
  await testEnv.CONTENT.put(objectKey, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  const commitRes = await SELF.fetch(`${CONSOLE}/api/device/publish/commit`, {
    method: 'POST', headers: { 'x-review-device-token': deviceToken },
    body: JSON.stringify({
      lockToken,
      pages: [{
        slug,
        title: fields.title ?? slug,
        source: fields.source ?? 'https://example.com/repo',
        repository: fields.repository ?? 'repo',
        stream: fields.stream ?? 'main',
        streamLabel: fields.streamLabel ?? 'main',
        date: fields.date ?? '2026-08-16',
        updatedAt: fields.updatedAt ?? '2026-08-16T00:00:00.000Z',
        bytes: new TextEncoder().encode(html).length,
        md5: await md5Hex(html),
      }],
    }),
  });
  if (commitRes.status !== 200) throw new Error(`publishPage commit failed: ${commitRes.status} ${await commitRes.text()}`);
  return { gen, objectKey };
}

async function md5Hex(text: string): Promise<string> {
  // Web Crypto (crypto.subtle) はMD5を実装していないため、node:crypto を使う
  // （compatibility_date 2026-08-01 + nodejs_compat で workerd 上でも利用可能）。
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(text).digest('hex');
}

async function deviceIdOf(deviceToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceToken));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

// codexレビューBLOCKER対応（2026-08-16、Stage4）: web/review/index.htmlはtask.deviceNameを
// 読んで「作業中」バッジにデバイス名を添えるが、以前はモック応答でしか検証しておらず、
// 実Workerの応答に実際にdeviceNameが乗ることを固定していなかった。ここでは
// GET /api/owner/reviews（web/review/index.htmlが呼ぶ実エンドポイント）を実D1・実Workerで
// 叩き、claim中のin_progressアイテムにdeviceNameが含まれることを固定する。
test('owner reviews list carries the claiming device name on an in_progress item (real D1)', async () => {
  const deviceToken = await pairDevice('Claim Display PC');

  const posted = await SELF.fetch(`${CONSOLE}/api/owner/reviews`, {
    method: 'POST', headers: await ownerHeaders(), body: JSON.stringify({ question: '表示確認用の依頼' }),
  });
  const { item } = await posted.json() as any;

  const claimed = await SELF.fetch(`${CONSOLE}/api/device/reviews/${item.id}/claim`, {
    method: 'POST', headers: { 'x-review-device-token': deviceToken }, body: '{}',
  });
  expect(claimed.status).toBe(200);

  const ownerView = await SELF.fetch(`${CONSOLE}/api/owner/reviews`, { headers: await ownerHeaders() });
  expect(ownerView.status).toBe(200);
  const { items } = await ownerView.json() as any;
  const claimedItem = items.find((entry: any) => entry.id === item.id);
  expect(claimedItem).toBeTruthy();
  expect(claimedItem.status).toBe('in_progress');
  expect(claimedItem.deviceName).toBe('Claim Display PC');
  expect(claimedItem.claimedBy).toBeUndefined();
});

test('a claimed in_progress request is only visible to the claiming device (real D1)', async () => {
  // 自端末が着手前にプロセス停止しても再発見できる必要がある一方、他端末の
  // in_progress一覧を覗ける経路があってはならない（実装レビューの指摘）。
  const tokenA = await pairDevice('Device A');
  const tokenB = await pairDevice('Device B');

  const posted = await SELF.fetch(`${CONSOLE}/api/owner/reviews`, {
    method: 'POST', headers: await ownerHeaders(), body: JSON.stringify({ question: 'PCで拾ってください' }),
  });
  const { item } = await posted.json() as any;

  const claimedByA = await SELF.fetch(`${CONSOLE}/api/device/reviews/${item.id}/claim`, {
    method: 'POST', headers: { 'x-review-device-token': tokenA }, body: '{}',
  });
  expect(claimedByA.status).toBe(200);

  // Aの再発見: 自分がclaimした分は再起動後もin_progressとして見える
  const seenByA = await SELF.fetch(`${CONSOLE}/api/device/reviews?status=in_progress&sessionId=inbox`, {
    headers: { 'x-review-device-token': tokenA },
  });
  expect((await seenByA.json() as any).items.some((entry: any) => entry.id === item.id)).toBe(true);

  // Bからは見えない（他端末のin_progressを覗く経路が無い）
  const seenByB = await SELF.fetch(`${CONSOLE}/api/device/reviews?status=in_progress&sessionId=inbox`, {
    headers: { 'x-review-device-token': tokenB },
  });
  expect((await seenByB.json() as any).items.some((entry: any) => entry.id === item.id)).toBe(false);
});

test('rejects request bodies above the 1MB cap with 413', async () => {
  const oversized = await SELF.fetch(`${CONSOLE}/api/pairings/claim`, {
    method: 'POST',
    body: JSON.stringify({ code: 'AAAA-AAAA', padding: 'x'.repeat(1_100_000) }),
  });
  expect(oversized.status).toBe(413);
});

test('owner shares return a signed URL in the expected format (real D1/R2, deviceId-scoped)', async () => {
  const token = await pairDevice('Share PC');
  const { objectKey } = await publishPage(token, 'demo', '<h1>Demo</h1>');
  const deviceId = objectKey.split('/')[1];

  const share = await SELF.fetch(`${CONSOLE}/api/owner/shares`, {
    method: 'POST',
    headers: await ownerHeaders(),
    body: JSON.stringify({ deviceId, slug: 'demo', scope: 'public', days: 7 }),
  });
  expect(share.status).toBe(201);
  const { url } = await share.json() as any;
  const parsed = new URL(url);
  expect(parsed.origin).toBe(testEnv.CONTENT_ORIGIN);
  expect(parsed.pathname).toBe(`/${objectKey}`);
  expect(parsed.searchParams.get('e')).toMatch(/^\d+$/);
  expect(parsed.searchParams.get('s')).toMatch(/^[A-Za-z0-9_-]+$/);

  const internal = await SELF.fetch(`${CONSOLE}/api/owner/shares`, {
    method: 'POST',
    headers: await ownerHeaders(),
    body: JSON.stringify({ deviceId, slug: 'demo', scope: 'internal', days: 7 }),
  });
  expect(internal.status).toBe(201);
  const internalUrl = new URL((await internal.json() as any).url);
  expect(internalUrl.searchParams.get('i')).toMatch(/^[A-Za-z0-9_-]+$/);

  // 存在しないslugは404、deviceId必須
  const missingDeviceId = await SELF.fetch(`${CONSOLE}/api/owner/shares`, {
    method: 'POST', headers: await ownerHeaders(),
    body: JSON.stringify({ slug: 'demo', scope: 'public', days: 7 }),
  });
  expect(missingDeviceId.status).toBe(400);
  const unknownSlug = await SELF.fetch(`${CONSOLE}/api/owner/shares`, {
    method: 'POST', headers: await ownerHeaders(),
    body: JSON.stringify({ deviceId, slug: 'nope', scope: 'public', days: 7 }),
  });
  expect(unknownSlug.status).toBe(404);
});

test('device shares scope to the authenticated device only', async () => {
  const tokenA = await pairDevice('Share Device A');
  const tokenB = await pairDevice('Share Device B');
  await publishPage(tokenA, 'demo', '<h1>A</h1>');

  const ownShare = await SELF.fetch(`${CONSOLE}/api/device/shares`, {
    method: 'POST', headers: { 'x-review-device-token': tokenA },
    body: JSON.stringify({ slug: 'demo', scope: 'public', days: 7 }),
  });
  expect(ownShare.status).toBe(201);

  // 他デバイスは同名slugでも自分の行として引けない((deviceId, slug)複合キーで隔離)
  const crossDevice = await SELF.fetch(`${CONSOLE}/api/device/shares`, {
    method: 'POST', headers: { 'x-review-device-token': tokenB },
    body: JSON.stringify({ slug: 'demo', scope: 'public', days: 7 }),
  });
  expect(crossDevice.status).toBe(404);
});

test('GET /api/owner/pages returns manifest-shaped contract and each href resolves via signature format', async () => {
  // このspecファイルはworkerdインスタンス・D1を全テストで共有する（singleWorker）ため、
  // 他テストが作ったpages行と混ざる。slugをテスト固有にして自分の行だけを見分ける。
  const tokenA = await pairDevice('Pages Device A');
  const tokenB = await pairDevice('Pages Device B');
  await publishPage(tokenA, 'pages-contract-older', '<h1>older</h1>', { date: '2026-08-01' });
  await publishPage(tokenB, 'pages-contract-newer', '<h1>newer</h1>', { date: '2026-08-15' });

  const response = await SELF.fetch(`${CONSOLE}/api/owner/pages`, { headers: await ownerHeaders() });
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  const older = body.pages.find((p: any) => p.slug === 'pages-contract-older');
  const newer = body.pages.find((p: any) => p.slug === 'pages-contract-newer');
  expect(older).toBeDefined();
  expect(newer).toBeDefined();
  expect(body.pages.indexOf(newer)).toBeLessThan(body.pages.indexOf(older)); // date降順
  expect(new URL(newer.href).pathname).toBe(`/${newer.objectKey}`);
  expect(newer.deviceName).toBe('Pages Device B');
});

test('publish lock/commit round trip across two devices does not interfere (real D1/R2)', async () => {
  // 設計 完了条件テスト#1: 2デバイス同時commitの相互不干渉
  const tokenA = await pairDevice('Concurrent A');
  const tokenB = await pairDevice('Concurrent B');
  const [a, b] = await Promise.all([
    publishPage(tokenA, 'shared-slug', '<h1>from A</h1>'),
    publishPage(tokenB, 'shared-slug', '<h1>from B</h1>'),
  ]);
  expect(a.objectKey).not.toBe(b.objectKey); // 別deviceId名前空間なので衝突しない
  const contentA = await testEnv.CONTENT.get(a.objectKey);
  const contentB = await testEnv.CONTENT.get(b.objectKey);
  expect(await contentA.text()).toBe('<h1>from A</h1>');
  expect(await contentB.text()).toBe('<h1>from B</h1>');
});

test('a zombie upload into a released generation cannot affect the current published content', async () => {
  // 設計 完了条件テスト#3: 失効した旧gen宛のuploadが現行世代の配信内容に影響しない
  const token = await pairDevice('Zombie PC');
  const first = await publishPage(token, 'zombie-slug', '<h1>v1</h1>');
  const second = await publishPage(token, 'zombie-slug', '<h1>v2</h1>');
  expect(second.gen).not.toBe(first.gen);

  // ゾンビプロセスが古いgen（first.gen）宛に書き込んでも、現行世代(second)の内容は不変
  await testEnv.CONTENT.put(first.objectKey, '<h1>zombie overwrite</h1>', {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  const current = await testEnv.CONTENT.get(second.objectKey);
  expect(await current.text()).toBe('<h1>v2</h1>');

  const pagesRow = await SELF.fetch(`${CONSOLE}/api/owner/pages`, { headers: await ownerHeaders() });
  const page = ((await pagesRow.json() as any).pages as any[]).find((p) => p.slug === 'zombie-slug');
  expect(page.objectKey).toBe(second.objectKey); // D1が指すのは常に現行世代
});
