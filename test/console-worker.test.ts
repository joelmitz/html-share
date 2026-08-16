import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import consoleWorker from '../workers/console/src/index.js';
import contentWorker from '../workers/content/src/index.js';
import { resetAccessKeyCacheForTests } from '../workers/console/src/access.js';
import { D1Stub, R2Stub, executionContextStub } from './helpers/d1-stub.ts';

const CONSOLE = 'https://console.example.com';
const CONTENT = 'https://content.example.com';
const OWNER_EMAIL = 'owner@example.com';
const TEAM_DOMAIN = 'team.cloudflareaccess.com';
const AUD = 'aud-tag-1234';

// console worker は署名秘密鍵を module scope で cache するため、
// 鍵ペアはファイル全体で1組に固定する
const signing = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
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

interface Fixture {
  env: any;
  db: D1Stub;
  consoleBucket: R2Stub;
  context: ExecutionContext;
}

function fixture(overrides: Record<string, string> = {}): Fixture {
  resetAccessKeyCacheForTests();
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ keys: [accessJwk] }), { headers: { 'content-type': 'application/json' } });
  const db = new D1Stub();
  const consoleBucket = new R2Stub();
  consoleBucket.put('index.html', { body: '<h1>Landing</h1>', contentType: 'text/html; charset=utf-8' });
  consoleBucket.put('app/index.html', { body: '<h1>App</h1>', contentType: 'text/html; charset=utf-8' });
  const env = {
    DB: db,
    CONSOLE: consoleBucket,
    SIGNING_PRIVATE_KEY: signing.privateKey,
    OWNER_EMAIL,
    CONSOLE_ORIGIN: CONSOLE,
    CONTENT_ORIGIN: CONTENT,
    MAXIMUM_SHARE_DAYS: '30',
    ALLOWED_INTERNAL_CIDRS: '["203.0.113.0/24"]',
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    ...overrides,
  };
  return { env, db, consoleBucket, context: executionContextStub() };
}

function ownerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'cf-access-jwt-assertion': ownerJwt(), origin: CONSOLE, ...extra };
}

async function createPairingCode(f: Fixture): Promise<string> {
  const response = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/pairings`, { method: 'POST', headers: ownerHeaders() }), f.env, f.context);
  assert.equal(response.status, 201);
  return (await response.json() as any).code;
}

async function claimDevice(f: Fixture, code: string, deviceName = 'Test PC'): Promise<string> {
  const response = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/pairings/claim`, {
      method: 'POST',
      body: JSON.stringify({ code, deviceName }),
    }), f.env, f.context);
  assert.equal(response.status, 200);
  return (await response.json() as any).deviceToken;
}

test('pairing claim is one-time and stores only the token hash', async () => {
  const f = fixture();
  const code = await createPairingCode(f);
  const token = await claimDevice(f, code);
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  const device = f.db.database.prepare('SELECT id, name FROM devices').get() as any;
  assert.equal(device.name, 'Test PC');
  assert.notEqual(device.id, token); // 生トークンは保存しない

  const again = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/pairings/claim`, {
      method: 'POST', body: JSON.stringify({ code, deviceName: 'Second PC' }),
    }), f.env, f.context);
  assert.equal(again.status, 409);
  assert.equal((f.db.database.prepare('SELECT COUNT(*) AS c FROM devices').get() as any).c, 1);
});

test('pairing claim rejects malformed codes', async () => {
  const f = fixture();
  const response = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/pairings/claim`, { method: 'POST', body: JSON.stringify({ code: 'short' }) }),
    f.env, f.context);
  assert.equal(response.status, 400);
});

test('pairing claim rolls back when the device insert fails', async () => {
  const f = fixture();
  const code = await createPairingCode(f);
  f.db.options.failOn = /INSERT INTO devices/;
  const failed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/pairings/claim`, {
      method: 'POST', body: JSON.stringify({ code, deviceName: 'Test PC' }),
    }), f.env, f.context);
  assert.equal(failed.status, 500);
  // rollbackによりコードは未claimのまま残り、再claimできる
  assert.equal((f.db.database.prepare('SELECT claimed_at FROM pairings').get() as any).claimed_at, null);
  f.db.options.failOn = undefined;
  await claimDevice(f, code);
});

test('rejects an oversized declared request body with 413', async () => {
  const f = fixture();
  const fake = {
    method: 'POST',
    url: `${CONSOLE}/api/pairings/claim`,
    headers: new Headers({ 'content-length': String(2 * 1024 * 1024) }),
    body: null,
  };
  const response = await consoleWorker.fetch(fake as any, f.env, f.context);
  assert.equal(response.status, 413);
});

test('rejects an oversized streamed request body with 413', async () => {
  const f = fixture();
  const chunk = new Uint8Array(64 * 1024);
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < 20; index += 1) controller.enqueue(chunk); // 1.25MB
      controller.close();
    },
  });
  const response = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/pairings/claim`, { method: 'POST', body: stream, duplex: 'half' } as any),
    f.env, f.context);
  assert.equal(response.status, 413);
});

test('device API requires a paired token', async () => {
  const f = fixture();
  const missing = await consoleWorker.fetch(new Request(`${CONSOLE}/api/device/reviews`), f.env, f.context);
  assert.equal(missing.status, 401);
  const unknown = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews`, {
      headers: { 'x-review-device-token': 'A'.repeat(43) },
    }), f.env, f.context);
  assert.equal(unknown.status, 401);
});

test('owner API requires a verified Access JWT and same-origin for writes', async () => {
  const f = fixture();
  const anonymous = await consoleWorker.fetch(new Request(`${CONSOLE}/api/owner/reviews`), f.env, f.context);
  assert.equal(anonymous.status, 401);
  const intruder = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews`, {
      headers: { 'cf-access-jwt-assertion': ownerJwt('intruder@example.com'), origin: CONSOLE },
    }), f.env, f.context);
  assert.equal(intruder.status, 401);
  const wrongOrigin = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews`, {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': ownerJwt(), origin: 'https://evil.example.com' },
      body: JSON.stringify({ question: 'x' }),
    }), f.env, f.context);
  assert.equal(wrongOrigin.status, 403);
});

test('owner inbox request flows to a paired device via claim then completes', async () => {
  const f = fixture();
  const token = await claimDevice(f, await createPairingCode(f));

  const posted = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ question: '明日の資料をまとめて', target: 'html-share' }),
    }), f.env, f.context);
  assert.equal(posted.status, 201);
  const created = (await posted.json() as any).item;
  assert.equal(created.sessionId, 'inbox');
  assert.equal(created.source, 'owner');
  assert.equal(created.target, 'html-share');
  assert.equal(created.status, 'waiting');

  const inbox = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews?status=waiting&sessionId=inbox`, {
      headers: { 'x-review-device-token': token },
    }), f.env, f.context);
  const items = (await inbox.json() as any).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, created.id);

  // completeはclaim済みでないと失敗する（着手前の取得を原子化するのがStage 1の要点）
  const prematureComplete = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/complete`, {
      method: 'POST', headers: { 'x-review-device-token': token }, body: '{}',
    }), f.env, f.context);
  assert.equal(prematureComplete.status, 409);

  const claimed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/claim`, {
      method: 'POST', headers: { 'x-review-device-token': token }, body: '{}',
    }), f.env, f.context);
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json() as any).item.status, 'in_progress');

  const completed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/complete`, {
      method: 'POST', headers: { 'x-review-device-token': token }, body: '{}',
    }), f.env, f.context);
  assert.equal(completed.status, 200);

  const after = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews`, { headers: ownerHeaders() }), f.env, f.context);
  const list = (await after.json() as any).items;
  assert.equal(list[0].status, 'completed');
  assert.ok(list[0].completedAt);
});

test('claim prevents two devices from starting the same inbox request', async () => {
  const f = fixture();
  const tokenA = await claimDevice(f, await createPairingCode(f), 'Device A');
  const tokenB = await claimDevice(f, await createPairingCode(f), 'Device B');

  const posted = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ question: 'どちらかのPCで拾ってください' }),
    }), f.env, f.context);
  const created = (await posted.json() as any).item;

  const claimA = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/claim`, {
      method: 'POST', headers: { 'x-review-device-token': tokenA }, body: '{}',
    }), f.env, f.context);
  assert.equal(claimA.status, 200);

  // 後着は409（先着が既に着手している旨を検知できる）
  const claimB = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/claim`, {
      method: 'POST', headers: { 'x-review-device-token': tokenB }, body: '{}',
    }), f.env, f.context);
  assert.equal(claimB.status, 409);

  // claimしていないBはcompleteもできない
  const completeB = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/complete`, {
      method: 'POST', headers: { 'x-review-device-token': tokenB }, body: '{}',
    }), f.env, f.context);
  assert.equal(completeB.status, 409);

  const completeA = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/complete`, {
      method: 'POST', headers: { 'x-review-device-token': tokenA }, body: '{}',
    }), f.env, f.context);
  assert.equal(completeA.status, 200);
});

test('owner can delete an in_progress inbox item, orphaning the claiming device\'s complete', async () => {
  const f = fixture();
  const token = await claimDevice(f, await createPairingCode(f));

  const posted = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews`, {
      method: 'POST', headers: ownerHeaders(), body: JSON.stringify({ question: 'やっぱりやめます' }),
    }), f.env, f.context);
  const created = (await posted.json() as any).item;

  const claimed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/claim`, {
      method: 'POST', headers: { 'x-review-device-token': token }, body: '{}',
    }), f.env, f.context);
  assert.equal(claimed.status, 200);

  const deleted = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews/${created.id}`, { method: 'DELETE', headers: ownerHeaders() }),
    f.env, f.context);
  assert.equal(deleted.status, 200);

  // ownerの削除が優先される。claim済みデバイスのcompleteは対象が既に無く失敗する
  const complete = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${created.id}/complete`, {
      method: 'POST', headers: { 'x-review-device-token': token }, body: '{}',
    }), f.env, f.context);
  assert.equal(complete.status, 409);
});

test('claim only applies to owner-sourced inbox items, not the device Q&A flow', async () => {
  const f = fixture();
  const token = await claimDevice(f, await createPairingCode(f));

  const pushed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews`, {
      method: 'POST', headers: { 'x-review-device-token': token },
      body: JSON.stringify({ sessionId: 's1', title: '確認', question: 'これでいいですか' }),
    }), f.env, f.context);
  const item = (await pushed.json() as any).item;

  // source='claude-code'のQ&Aタスクはclaim対象外（answerがwaitingを要求し続けられる）
  const claimed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews/${item.id}/claim`, {
      method: 'POST', headers: { 'x-review-device-token': token }, body: '{}',
    }), f.env, f.context);
  assert.equal(claimed.status, 409);

  const answered = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews/${item.id}/answer`, {
      method: 'POST', headers: ownerHeaders(), body: JSON.stringify({ approved: true }),
    }), f.env, f.context);
  assert.equal(answered.status, 200);
});

test('device review is answered once by the owner', async () => {
  const f = fixture();
  const token = await claimDevice(f, await createPairingCode(f));

  const pushed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews`, {
      method: 'POST', headers: { 'x-review-device-token': token },
      body: JSON.stringify({ sessionId: 's1', title: 'デプロイ確認', question: '本番反映してよいですか' }),
    }), f.env, f.context);
  assert.equal(pushed.status, 201);
  const item = (await pushed.json() as any).item;
  assert.equal(item.target, undefined); // 端末投稿はtargetを持たない

  const answered = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews/${item.id}/answer`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ approved: true, responseText: 'OKです' }),
    }), f.env, f.context);
  assert.equal(answered.status, 200);

  const again = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews/${item.id}/answer`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ approved: false, responseText: 'やっぱりだめ' }),
    }), f.env, f.context);
  assert.equal(again.status, 409); // waiting以外は書き換え不可

  const pulled = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews?status=answered&sessionId=s1`, {
      headers: { 'x-review-device-token': token },
    }), f.env, f.context);
  const answers = (await pulled.json() as any).items;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].approved, true);
  assert.equal(answers[0].responseText, 'OKです');
});

test('preferences round-trip through D1', async () => {
  const f = fixture();
  const empty = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/preferences`, { headers: ownerHeaders() }), f.env, f.context);
  assert.equal((await empty.json() as any).exists, false);

  const saved = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/preferences`, {
      method: 'PUT', headers: ownerHeaders(),
      body: JSON.stringify({
        starredSources: ['repo-a'],
        recentSources: ['repo-a'],
        hiddenSources: [],
        readMarks: { 'repo-a': { v: null, at: '2026-08-15T01:00:00.000Z' } },
      }),
    }), f.env, f.context);
  assert.equal(saved.status, 200);

  const loaded = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/preferences`, { headers: ownerHeaders() }), f.env, f.context);
  const body = await loaded.json() as any;
  assert.equal(body.exists, true);
  assert.deepEqual(body.starredSources, ['repo-a']);
  assert.deepEqual(body.readMarks, { 'repo-a': { v: null, at: '2026-08-15T01:00:00.000Z' } });
});

test('owner share URLs interoperate with the content worker', async () => {
  const f = fixture();
  const contentBucket = new R2Stub();
  contentBucket.put('pages/demo/index.html', { body: '<h1>Demo</h1>', contentType: 'text/html; charset=utf-8' });
  const contentEnv = {
    CONTENT: contentBucket,
    SIGNING_PUBLIC_KEY: signing.publicKey,
    CONSOLE_ORIGIN: CONSOLE,
  };

  const publicShare = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/shares`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ slug: 'demo', scope: 'public', days: 7 }),
    }), f.env, f.context);
  assert.equal(publicShare.status, 201);
  const publicUrl = (await publicShare.json() as any).url;
  const served = await contentWorker.fetch(new Request(publicUrl), contentEnv);
  assert.equal(served.status, 200);

  const internalShare = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/shares`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ slug: 'demo', scope: 'internal', days: 7 }),
    }), f.env, f.context);
  assert.equal(internalShare.status, 201);
  const internalUrl = (await internalShare.json() as any).url;
  const inside = await contentWorker.fetch(
    new Request(internalUrl, { headers: { 'cf-connecting-ip': '203.0.113.9' } }), contentEnv);
  assert.equal(inside.status, 200);
  const outside = await contentWorker.fetch(
    new Request(internalUrl, { headers: { 'cf-connecting-ip': '198.51.100.9' } }), contentEnv);
  assert.equal(outside.status, 403);
});

test('owner share validation mirrors the AWS version', async () => {
  const f = fixture({ ALLOWED_INTERNAL_CIDRS: '[]' });
  const notConfigured = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/shares`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ slug: 'demo', scope: 'internal', days: 7 }),
    }), f.env, f.context);
  assert.equal(notConfigured.status, 400);

  const tooLong = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/shares`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ slug: 'demo', scope: 'public', days: 31 }),
    }), f.env, f.context);
  assert.equal(tooLong.status, 400);

  const badSlug = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/shares`, {
      method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({ slug: '../etc', scope: 'public', days: 7 }),
    }), f.env, f.context);
  assert.equal(badSlug.status, 400);
});

test('expired tasks are excluded from every listing', async () => {
  const f = fixture();
  const token = await claimDevice(f, await createPairingCode(f));
  const past = Math.floor(Date.now() / 1000) - 60;
  f.db.database.prepare(
    `INSERT INTO tasks (id, device_id, source, session_id, title, question, status, created_at, updated_at, expires_at)
     VALUES ('expired-1', 'OWNER', 'owner', 'inbox', '古い依頼', 'q', 'waiting', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', ?1)`,
  ).run(past);

  const owner = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/owner/reviews`, { headers: ownerHeaders() }), f.env, f.context);
  assert.equal((await owner.json() as any).items.length, 0);
  const device = await consoleWorker.fetch(
    new Request(`${CONSOLE}/api/device/reviews`, { headers: { 'x-review-device-token': token } }), f.env, f.context);
  assert.equal((await device.json() as any).items.length, 0);
});

test('static console pages enforce the auth boundary', async () => {
  const f = fixture();
  const landing = await consoleWorker.fetch(new Request(`${CONSOLE}/`), f.env, f.context);
  assert.equal(landing.status, 200); // landingは公開

  const blocked = await consoleWorker.fetch(new Request(`${CONSOLE}/app/index.html`), f.env, f.context);
  assert.equal(blocked.status, 401); // JWT無しの/app/*は拒否

  const allowed = await consoleWorker.fetch(
    new Request(`${CONSOLE}/app/index.html`, { headers: { 'cf-access-jwt-assertion': ownerJwt() } }),
    f.env, f.context);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), '<h1>App</h1>');

  const login = await consoleWorker.fetch(new Request(`${CONSOLE}/auth/login`), f.env, f.context);
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/app/index.html');
  const logout = await consoleWorker.fetch(new Request(`${CONSOLE}/auth/logout`), f.env, f.context);
  assert.equal(logout.headers.get('location'), '/cdn-cgi/access/logout');

  const malformed = await consoleWorker.fetch(new Request(`${CONSOLE}/%zz`), f.env, f.context);
  assert.equal(malformed.status, 404);
});

test('redirects a directory path with no trailing slash instead of serving it directly', async () => {
  // Access認証後のリダイレクトは元のリクエストパスへ戻るため、
  // "/app/index.html" ではなく末尾スラッシュ省略の "/app" で来ることがある。
  // ここを直接配信するとブラウザ上のURLが"/app"のままになり、ページ内の
  // 相対fetch（例: fetch('manifest.json')）が一階層上の"/manifest.json"へ
  // 解決されてしまうため、末尾スラッシュ付きへ302リダイレクトする。
  const f = fixture();
  const noSlash = await consoleWorker.fetch(
    new Request(`${CONSOLE}/app`, { headers: { 'cf-access-jwt-assertion': ownerJwt() } }), f.env, f.context);
  assert.equal(noSlash.status, 302);
  assert.equal(noSlash.headers.get('location'), '/app/');

  const withSlash = await consoleWorker.fetch(
    new Request(`${CONSOLE}/app/`, { headers: { 'cf-access-jwt-assertion': ownerJwt() } }), f.env, f.context);
  assert.equal(withSlash.status, 200);
  assert.equal(await withSlash.text(), '<h1>App</h1>');

  // 拡張子を持つファイルパスは従来どおりそのまま解決される（リダイレクトしない）
  const asset = await consoleWorker.fetch(new Request(`${CONSOLE}/app/index.html`), f.env, f.context);
  assert.equal(asset.status, 401); // JWTを付けていないので認証境界は健在（404でもリダイレクトでもない）
});
