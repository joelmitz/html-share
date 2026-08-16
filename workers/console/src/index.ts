import { verifyAccessJwt } from './access.js';
import { cleanReadMarks } from './read-marks.js';

export interface Env {
  DB: D1Database;
  CONSOLE: R2Bucket;
  SIGNING_PRIVATE_KEY: string;
  OWNER_EMAIL: string;
  CONSOLE_ORIGIN: string;
  CONTENT_ORIGIN: string;
  MAXIMUM_SHARE_DAYS: string;
  ALLOWED_INTERNAL_CIDRS: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

const TASK_TTL_SECONDS = 90 * 24 * 60 * 60;
const PAIR_TTL_SECONDS = 10 * 60;
// 期待するJSONは最大でも数百KB（readMarks 800件）。isolateのメモリ(128MB)保護のため
// Content-Lengthに依存せずstreamを上限まで読み、超過は413で拒否する。
const MAX_BODY_BYTES = 1024 * 1024;
const OWNER_DEVICE_ID = 'OWNER';
const INBOX_SESSION_ID = 'inbox';
const encoder = new TextEncoder();
let privateKeyPromise: Promise<CryptoKey> | undefined;

function securityHeaders(env: Env, extra: Record<string, string> = {}): Headers {
  const headers = new Headers();
  headers.set(
    'content-security-policy',
    `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src ${env.CONTENT_ORIGIN}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-robots-tag', 'noindex, nofollow, nosnippet, noimageindex, noarchive');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function json(env: Env, statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: securityHeaders(env, { 'content-type': 'application/json; charset=utf-8' }),
  });
}

async function parseBody(request: Request): Promise<Record<string, any>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
  }
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    }
    chunks.push(value);
  }
  if (!total) return {};
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function clean(value: unknown, name: string, maximum: number, needed = false): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (needed && !result) throw Object.assign(new Error(`${name} is required`), { statusCode: 400 });
  if (result.length > maximum) throw Object.assign(new Error(`${name} is too long`), { statusCode: 400 });
  return result;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cleanSourceList(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw Object.assign(new Error(`${name} is invalid`), { statusCode: 400 });
  }
  return [...new Set(value.map((item) => clean(item, name, 500, true)))];
}

function titleFromBody(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
}

function internalCidrs(env: Env): string[] {
  try {
    const values = JSON.parse(env.ALLOWED_INTERNAL_CIDRS);
    return Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').replace(/[^A-Z2-9]/gi, '').toUpperCase();
}

function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const text = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

function randomToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validOrigin(request: Request, env: Env): boolean {
  return String(request.headers.get('origin') ?? '') === env.CONSOLE_ORIGIN;
}

interface TaskRow {
  id: string;
  device_id: string;
  source: string;
  session_id: string;
  title: string;
  question: string;
  context: string;
  recommendation: string;
  target: string | null;
  status: string;
  approved: number | null;
  response_text: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function publicTask(row: TaskRow): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    sessionId: row.session_id,
    title: row.title,
    question: row.question,
    context: row.context,
    recommendation: row.recommendation,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.target === null ? {} : { target: row.target }),
    ...(row.approved === null ? {} : { approved: row.approved === 1 }),
    ...(row.response_text === null ? {} : { responseText: row.response_text }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

async function device(request: Request, env: Env): Promise<{ id: string; name: string } | null> {
  const token = String(request.headers.get('x-review-device-token') ?? '');
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT name, revoked_at FROM devices WHERE id = ?1').bind(id).first<{ name: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return null;
  return { id, name: row.name ?? 'Computer' };
}

async function tasks(env: Env, now: number): Promise<TaskRow[]> {
  const result = await env.DB.prepare('SELECT * FROM tasks WHERE expires_at > ?1').bind(now).all<TaskRow>();
  return result.results ?? [];
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

function privateKey(env: Env): Promise<CryptoKey> {
  if (!privateKeyPromise) {
    privateKeyPromise = crypto.subtle.importKey(
      'pkcs8',
      pemToDer(env.SIGNING_PRIVATE_KEY),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return privateKeyPromise;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// CLI 側 src/sign.ts と同じ形式: `${pathname}\n${e}\n${i}` への RSA-SHA256 署名。
async function signShareUrl(env: Env, url: string, expiresAt: number, cidrs: string[]): Promise<string> {
  const target = new URL(url);
  const cidrParam = cidrs.length ? bytesToBase64Url(encoder.encode(JSON.stringify(cidrs))) : '';
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await privateKey(env),
    encoder.encode(`${target.pathname}\n${expiresAt}\n${cidrParam}`),
  );
  target.search = new URLSearchParams({
    e: String(expiresAt),
    ...(cidrParam ? { i: cidrParam } : {}),
    s: bytesToBase64Url(new Uint8Array(signature)),
  }).toString();
  return target.toString();
}

async function requireOwner(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return false;
  return verifyAccessJwt(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
    ownerEmail: env.OWNER_EMAIL,
  });
}

async function serveStatic(request: Request, env: Env, pathname: string): Promise<Response> {
  let key: string;
  try {
    key = decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return failure(env, 404, 'Not found.');
  }
  if (!key || key.endsWith('/')) key = `${key}index.html`;
  if (key.includes('..')) return failure(env, 404, 'Not found.');
  const object = await env.CONSOLE.get(key);
  if (!object) return failure(env, 404, 'Not found.');
  const headers = securityHeaders(env, {
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
  });
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

function failure(env: Env, status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${status}</title><h1>${status}</h1><p>${message}</p>`,
    { status, headers: securityHeaders(env, { 'content-type': 'text/html; charset=utf-8' }) },
  );
}

function redirect(env: Env, location: string): Response {
  const headers = securityHeaders(env);
  headers.set('location', location);
  return new Response(null, { status: 302, headers });
}

async function purgeExpired(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tasks WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('DELETE FROM pairings WHERE expires_at <= ?1').bind(now),
  ]);
}

async function handleApi(request: Request, env: Env, path: string, now: number): Promise<Response> {
  const verb = request.method;

  if (verb === 'POST' && path === '/api/pairings/claim') {
    const body = await parseBody(request);
    const code = normalizeCode(body.code);
    if (code.length !== 8) return json(env, 400, { error: 'Invalid pairing code' });
    const codeHash = await sha256Hex(code);
    const token = randomToken(32);
    const name = clean(body.deviceName, 'deviceName', 80) || 'Computer';
    // AWS版TransactWriteの意味論を保つ: batch()は1トランザクションで実行され、
    // 途中失敗で全体rollbackされる。INSERTは直前のUPDATE（同一トランザクション・
    // 同一接続）が1行をclaimできた場合のみ行を作る（SQLiteのchanges()で判定。
    // claim不成立なら0行になり、changes判定で409にする）。
    const [claimed, inserted] = await env.DB.batch([
      env.DB.prepare(
        'UPDATE pairings SET claimed_at = ?1 WHERE code_hash = ?2 AND claimed_at IS NULL AND expires_at > ?1',
      ).bind(now, codeHash),
      env.DB.prepare(
        `INSERT INTO devices (id, name, created_at)
         SELECT ?1, ?2, ?3 WHERE (SELECT changes()) = 1`,
      ).bind(await sha256Hex(token), name, new Date().toISOString()),
    ]);
    if (!claimed.meta.changes || !inserted.meta.changes) {
      return json(env, 409, { error: 'This request is expired or already used' });
    }
    return json(env, 200, { deviceToken: token, deviceName: name });
  }

  if (path.startsWith('/api/owner/')) {
    if (!await requireOwner(request, env)) return json(env, 401, { error: 'Owner authentication is required' });
    if (!validOrigin(request, env) && verb !== 'GET') return json(env, 403, { error: 'Invalid origin' });

    if (verb === 'POST' && path === '/api/owner/pairings') {
      const code = pairingCode();
      await env.DB.prepare('INSERT INTO pairings (code_hash, created_at, expires_at) VALUES (?1, ?2, ?3)')
        .bind(await sha256Hex(normalizeCode(code)), new Date().toISOString(), now + PAIR_TTL_SECONDS).run();
      return json(env, 201, { code, expiresAt: now + PAIR_TTL_SECONDS });
    }
    if (verb === 'GET' && path === '/api/owner/reviews') {
      const items = (await tasks(env, now))
        .filter((item) => item.status !== 'deleted')
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
        .map(publicTask);
      return json(env, 200, { items });
    }
    if (verb === 'POST' && path === '/api/owner/reviews') {
      const body = await parseBody(request);
      const question = clean(body.question, 'question', 2000, true);
      const id = crypto.randomUUID();
      const iso = new Date().toISOString();
      // target はプロジェクトの呼び名のヒント。取り込む側がパスへ解決する。
      await env.DB.prepare(
        `INSERT INTO tasks (id, device_id, source, session_id, title, question, context, recommendation, target, status, created_at, updated_at, expires_at)
         VALUES (?1, ?2, 'owner', ?3, ?4, ?5, '', '', ?6, 'waiting', ?7, ?7, ?8)`,
      ).bind(
        id, OWNER_DEVICE_ID, INBOX_SESSION_ID,
        clean(body.title, 'title', 120) || titleFromBody(question),
        question, clean(body.target, 'target', 60), iso, now + TASK_TTL_SECONDS,
      ).run();
      const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first<TaskRow>();
      return json(env, 201, { item: publicTask(row!) });
    }
    if (verb === 'GET' && path === '/api/owner/preferences') {
      const row = await env.DB.prepare('SELECT * FROM preferences WHERE id = 1').first<Record<string, any>>();
      return json(env, 200, {
        exists: Boolean(row),
        starredSources: row ? JSON.parse(row.starred_sources) : [],
        recentSources: row ? JSON.parse(row.recent_sources) : [],
        hiddenSources: row ? JSON.parse(row.hidden_sources) : [],
        readMarks: row?.read_marks ? JSON.parse(row.read_marks) : null,
        updatedAt: row?.updated_at ?? null,
      });
    }
    if (verb === 'PUT' && path === '/api/owner/preferences') {
      const body = await parseBody(request);
      const starredSources = cleanSourceList(body.starredSources ?? [], 'starredSources', 200);
      const recentSources = cleanSourceList(body.recentSources ?? [], 'recentSources', 6);
      const hiddenSources = cleanSourceList(body.hiddenSources ?? [], 'hiddenSources', 500);
      const readMarks = cleanReadMarks(body.readMarks ?? {}, 800);
      const updatedAt = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO preferences (id, starred_sources, recent_sources, hidden_sources, read_marks, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET starred_sources = ?1, recent_sources = ?2, hidden_sources = ?3, read_marks = ?4, updated_at = ?5`,
      ).bind(
        JSON.stringify(starredSources), JSON.stringify(recentSources), JSON.stringify(hiddenSources),
        JSON.stringify(readMarks), updatedAt,
      ).run();
      return json(env, 200, { starredSources, recentSources, hiddenSources, readMarks, updatedAt });
    }
    if (verb === 'POST' && path === '/api/owner/shares') {
      const body = await parseBody(request);
      const slug = clean(body.slug, 'slug', 128, true);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return json(env, 400, { error: 'Invalid slug' });
      const scope = body.scope === 'internal' ? 'internal' : body.scope === 'public' ? 'public' : '';
      if (!scope) return json(env, 400, { error: 'Invalid share scope' });
      const days = Number(body.days);
      const maximumDays = Number(env.MAXIMUM_SHARE_DAYS);
      if (!Number.isInteger(days) || days < 1 || days > maximumDays) {
        return json(env, 400, { error: `Share duration must be between 1 and ${maximumDays} days` });
      }
      const expiresAt = now + days * 24 * 60 * 60;
      const url = `${env.CONTENT_ORIGIN}/pages/${slug}/index.html`;
      let cidrs: string[] = [];
      if (scope === 'internal') {
        cidrs = internalCidrs(env);
        if (cidrs.length === 0) return json(env, 400, { error: 'Internal sharing is not configured' });
      }
      return json(env, 201, { url: await signShareUrl(env, url, expiresAt, cidrs), expiresAt });
    }
    const remove = path.match(/^\/api\/owner\/reviews\/([^/]+)$/);
    if (verb === 'DELETE' && remove) {
      const result = await env.DB.prepare('DELETE FROM tasks WHERE id = ?1').bind(remove[1]).run();
      if (!result.meta.changes) return json(env, 409, { error: 'This request is expired or already used' });
      return json(env, 200, { ok: true });
    }
    const answer = path.match(/^\/api\/owner\/reviews\/([^/]+)\/answer$/);
    if (verb === 'POST' && answer) {
      const body = await parseBody(request);
      const responseText = clean(body.responseText, 'responseText', 4000);
      const approved = body.approved === true;
      if (!approved && !responseText) return json(env, 400, { error: 'Approval or comment is required' });
      const result = await env.DB.prepare(
        `UPDATE tasks SET status = 'answered', approved = ?1, response_text = ?2, updated_at = ?3
         WHERE id = ?4 AND status = 'waiting'`,
      ).bind(approved ? 1 : 0, responseText, new Date().toISOString(), answer[1]).run();
      if (!result.meta.changes) return json(env, 409, { error: 'This request is expired or already used' });
      const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(answer[1]).first<TaskRow>();
      return json(env, 200, { item: publicTask(row!) });
    }
    return json(env, 404, { error: 'Not found' });
  }

  if (path.startsWith('/api/device/')) {
    const current = await device(request, env);
    if (!current) return json(env, 401, { error: 'Device authentication is required' });
    if (verb === 'POST' && path === '/api/device/reviews') {
      const body = await parseBody(request);
      const id = crypto.randomUUID();
      const iso = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO tasks (id, device_id, source, session_id, title, question, context, recommendation, status, created_at, updated_at, expires_at)
         VALUES (?1, ?2, 'claude-code', ?3, ?4, ?5, ?6, ?7, 'waiting', ?8, ?8, ?9)`,
      ).bind(
        id, current.id,
        clean(body.sessionId, 'sessionId', 180, true),
        clean(body.title, 'title', 160, true),
        clean(body.question, 'question', 1000, true),
        clean(body.context, 'context', 3000),
        clean(body.recommendation, 'recommendation', 1000),
        iso, now + TASK_TTL_SECONDS,
      ).run();
      const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first<TaskRow>();
      return json(env, 201, { item: publicTask(row!) });
    }
    if (verb === 'GET' && path === '/api/device/reviews') {
      const url = new URL(request.url);
      const status = url.searchParams.get('status');
      const sessionId = url.searchParams.get('sessionId');
      const items = (await tasks(env, now))
        .filter((item) => item.device_id === current.id || item.device_id === OWNER_DEVICE_ID)
        .filter((item) => !status || item.status === status)
        .filter((item) => !sessionId || item.session_id === sessionId)
        .map(publicTask);
      return json(env, 200, { items });
    }
    const complete = path.match(/^\/api\/device\/reviews\/([^/]+)\/complete$/);
    if (verb === 'POST' && complete) {
      const result = await env.DB.prepare(
        `UPDATE tasks SET status = 'completed', completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND (device_id = ?3 OR device_id = ?4)`,
      ).bind(new Date().toISOString(), complete[1], current.id, OWNER_DEVICE_ID).run();
      if (!result.meta.changes) return json(env, 409, { error: 'This request is expired or already used' });
      return json(env, 200, { ok: true });
    }
    return json(env, 404, { error: 'Not found' });
  }

  return json(env, 404, { error: 'Not found' });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const now = Math.floor(Date.now() / 1000);
      context.waitUntil(purgeExpired(env, now).catch(() => {}));

      // Cognito ログインフローの置き換え。認証は Cloudflare Access がエッジで行うため、
      // /auth/* は互換用のリダイレクトだけを担う。
      if (path === '/auth/login') return redirect(env, '/app/index.html');
      if (path === '/auth/logout') return redirect(env, '/cdn-cgi/access/logout');

      if (path.startsWith('/api/')) return await handleApi(request, env, path, now);

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return failure(env, 405, 'Method not allowed.');
      }
      // /app/* と /review/* は Access で保護される前提だが、Worker 側でも JWT を検証する。
      if (path.startsWith('/app/') || path.startsWith('/review/') || path === '/app' || path === '/review') {
        if (!await requireOwner(request, env)) return failure(env, 401, 'Owner authentication is required.');
      }
      return await serveStatic(request, env, path);
    } catch (error: any) {
      console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : 'Unknown error' }));
      if (new URL(request.url).pathname.startsWith('/api/')) {
        return json(env, error?.statusCode ?? 500, { error: error?.statusCode ? error.message : 'Request failed' });
      }
      return failure(env, 500, 'Please try again later.');
    }
  },
};
