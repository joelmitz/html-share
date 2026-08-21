import { verifyAccessJwt } from '../../shared/access.js';
import { cleanReadMarks } from './read-marks.js';

export interface Env {
  DB: D1Database;
  // Workers Static Assets（設計§5）。web/配下の静的資産はwranglerが世代ごと
  // 原子的にデプロイする。CONSOLE R2バケットは廃止（旧console参照はゼロにする、
  // 移行手順§5.1のPhase A検証ゲート(d)）。
  ASSETS: Fetcher;
  CONTENT: R2Bucket;
  // visibility='internal'なページ専用バケット（internal Worker新設）。
  // 実オブジェクトの配信はinternal Worker（別デプロイ）が行い、この
  // Workerからはlock/commit検証・世代GC・purgeでのみ触る（CONTENTと同じ扱い）
  INTERNAL: R2Bucket;
  SIGNING_PRIVATE_KEY: string;
  OWNER_EMAIL: string;
  CONSOLE_ORIGIN: string;
  CONTENT_ORIGIN: string;
  // internal Workerのオリジン。オーナーリンク（GET /api/owner/pages）が
  // visibility='internal'なページのhrefを組み立てる際に使う
  INTERNAL_ORIGIN: string;
  MAXIMUM_SHARE_DAYS: string;
  OWNER_LINK_DAYS: string;
  ALLOWED_INTERNAL_CIDRS: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  // 省略時はDEFAULT_R2_OPERATION_BUDGET。テストが上限到達（繰り越し）の
  // 挙動を少量のオブジェクトで再現できるようにするための上書き口
  R2_OPERATION_BUDGET?: string;
}

const TASK_TTL_SECONDS = 90 * 24 * 60 * 60;
const PAIR_TTL_SECONDS = 10 * 60;
// 期待するJSONは最大でも数百KB（readMarks 800件）。isolateのメモリ(128MB)保護のため
// Content-Lengthに依存せずstreamを上限まで読み、超過は413で拒否する。
const MAX_BODY_BYTES = 1024 * 1024;
// 個々のページオブジェクトのサイズ上限。CLI側のconfig.content.maximumAssetBytes
// 既定値(10MB)に合わせる。commitのアップロード検証で使う。
const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const OWNER_DEVICE_ID = 'OWNER';
const INBOX_SESSION_ID = 'inbox';
const PUBLISH_LOCK_TTL_SECONDS = 30 * 60;
// 1回のcommit/purge呼び出しでR2に対して行うlist/delete操作の上限の既定値。
// 設計書の「~50サブリクエスト」を安全側に切り下げた値。上限到達は正常終了とし、
// 残りは次回の呼び出しへ繰り越す（fail-closed。孤児オブジェクトは無署名では
// 配信されないため、繰り越し自体に実害は無い）。
const DEFAULT_R2_OPERATION_BUDGET = 20;
const encoder = new TextEncoder();

function r2OperationBudget(env: Env): number {
  const value = Number(env.R2_OPERATION_BUDGET);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_R2_OPERATION_BUDGET;
}
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

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return [...raw].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// "<epoch秒>-<乱数8バイトhex>"。先頭の時刻部がGCの年齢判定に使われる
// （§4.4）ため、genはWorkerだけが発行する（クライアント指定不可）。
function newGeneration(now: number): string {
  return `${now}-${randomHex(8)}`;
}

// 不正な形式（時刻部が数値でない等）は年齢無限大＝「非常に古い」として安全側に倒す
// （GCが誤って現行世代を守り損ねるより、誤って古いものとして掃除対象に回る方が
// まし、という判断ではなく——実際には現行世代のgenはWorker自身が発行した形式
// しか存在しないため、ここに来るのは孤児化した過去データの異常系のみ）。
function generationAgeSeconds(gen: string, now: number): number {
  const epoch = Number(gen.split('-')[0]);
  return Number.isFinite(epoch) ? Math.max(0, now - epoch) : Number.POSITIVE_INFINITY;
}

function pageObjectKey(deviceId: string, gen: string, slug: string): string {
  return `pages/${deviceId}/${gen}/${slug}/index.html`;
}

type Visibility = 'public' | 'internal';

// visibility='public'はCONTENT（content Worker、署名URLなら誰でも閲覧可）、
// 'internal'はINTERNAL（internal Worker、Cloudflare Access限定）。
// CLI側のconfig.content.pages[].visibilityがそのまま伝播する——サーバー側で
// 「このslugは公開してよいか」を判断する材料は無いため、常にクライアント申告どおりに扱う。
function bucketForVisibility(env: Env, visibility: Visibility): R2Bucket {
  return visibility === 'public' ? env.CONTENT : env.INTERNAL;
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
  device_name: string | null; // devicesとのLEFT JOINで得る。'OWNER'等の非ペアリング済みIDはnullのまま
}

// devicesとのLEFT JOIN込みのSELECT。in_progress表示（作業中バッジ+デバイス名）が
// claim直後のレスポンス・一覧取得のいずれでも同じ形になるよう、tasksを読む
// 全箇所で共通化する（webの契約: deviceName。旧claimedByは使わない）。
const TASK_SELECT = 'SELECT t.*, d.name AS device_name FROM tasks t LEFT JOIN devices d ON d.id = t.device_id';

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
    ...(row.device_name === null ? {} : { deviceName: row.device_name }),
  };
}

interface PageRow {
  device_id: string;
  slug: string;
  title: string;
  source: string;
  repository: string;
  stream: string;
  stream_label: string;
  object_key: string;
  page_date: string;
  updated_at: string;
  visibility: string;
}

interface CommitPageInput {
  slug: string;
  title: string;
  source: string;
  repository: string;
  stream: string;
  streamLabel: string;
  date: string;
  updatedAt: string;
  bytes: number;
  md5: string;
  visibility: Visibility;
}

// PUT側の入力検証。object_key・hrefはリクエストに含めない（Workerが導出するため、
// クライアントが他デバイスのprefixや任意URLを注入する余地が構造的に無い）。
function cleanCommitPages(value: unknown): CommitPageInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw Object.assign(new Error('pages is invalid'), { statusCode: 400 });
  }
  const seenSlugs = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw Object.assign(new Error(`pages[${index}] is invalid`), { statusCode: 400 });
    }
    const page = raw as Record<string, unknown>;
    const slug = clean(page.slug, `pages[${index}].slug`, 128, true);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw Object.assign(new Error(`pages[${index}].slug is invalid`), { statusCode: 400 });
    }
    if (seenSlugs.has(slug)) {
      throw Object.assign(new Error(`pages[${index}].slug is duplicated`), { statusCode: 400 });
    }
    seenSlugs.add(slug);
    const bytes = Number(page.bytes);
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_PAGE_BYTES) {
      throw Object.assign(new Error(`pages[${index}].bytes is invalid`), { statusCode: 400 });
    }
    const md5 = String(page.md5 ?? '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(md5)) {
      throw Object.assign(new Error(`pages[${index}].md5 is invalid`), { statusCode: 400 });
    }
    // 未指定・不正な値はfail-closedで'internal'側へ倒す（CLIの既定と揃える。
    // 外部公開は'public'を明示した場合だけの opt-in）
    const visibility: Visibility = page.visibility === 'public' ? 'public' : 'internal';
    return {
      slug,
      title: clean(page.title, `pages[${index}].title`, 200, true),
      source: clean(page.source, `pages[${index}].source`, 500, true),
      repository: clean(page.repository, `pages[${index}].repository`, 100, true),
      stream: clean(page.stream, `pages[${index}].stream`, 100, true),
      streamLabel: clean(page.streamLabel, `pages[${index}].streamLabel`, 100, true),
      date: clean(page.date, `pages[${index}].date`, 40, true),
      updatedAt: clean(page.updatedAt, `pages[${index}].updatedAt`, 40, true),
      bytes, md5, visibility,
    };
  });
}

// commit時のアップロード実在検証。R2の単一パートPutObjectのetagはコンテンツの
// md5そのものであるため、追加サブリクエスト無しで内容一致まで検証できる。
// 防ぐのは事故（切断アップロード・誤バケット・別ファイルの取り違え・並行プロセスの
// 残骸）であり、R2書き込み資格情報の保持者による悪意（正しいmd5と共に偽内容を
// 置く攻撃）は防がない——upstreamから変わらない信頼境界であり、本設計の非ゴール。
async function verifyUploadedPages(
  bucket: R2Bucket, deviceId: string, gen: string, pages: CommitPageInput[],
): Promise<void> {
  if (pages.length === 0) return;
  const prefix = `pages/${deviceId}/${gen}/`;
  const actual = new Map<string, { size: number; etag: string }>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of listed.objects) actual.set(object.key, { size: object.size, etag: object.etag });
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  for (const page of pages) {
    const key = pageObjectKey(deviceId, gen, page.slug);
    const found = actual.get(key);
    if (!found) throw Object.assign(new Error(`Uploaded object is missing: ${page.slug}`), { statusCode: 400 });
    if (found.size !== page.bytes) {
      throw Object.assign(new Error(`Uploaded object size mismatch: ${page.slug}`), { statusCode: 400 });
    }
    const etag = found.etag.toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(etag)) {
      // マルチパートアップロードのetagは "<hash>-<partCount>" 形式でmd5ではない。
      // CLIは常に単一パートで送るため、ここに来るのは誤った経路での書き込みのみ。
      throw Object.assign(new Error(`Uploaded object is not a single-part upload: ${page.slug}`), { statusCode: 400 });
    }
    if (etag !== page.md5) {
      throw Object.assign(new Error(`Uploaded object content mismatch: ${page.slug}`), { statusCode: 400 });
    }
  }
}

// 年齢ベースの世代GC（§4.4）。現行世代でない、かつmaximumShareDaysより古い
// オブジェクトだけを削除する。進行中・直近の世代は年齢条件だけで構造的に対象外
// になるため、ゾンビプロセスの再開やlock TTLの超過とは独立に安全。
// 加えて、各deleteバッチの直前にlock保持者（token）とD1現行gen（publish_locks.gen。
// 呼び出し時点ではまだ解放されていない）を再読し、不変であることを確認する
// （§4.4の多重防御。年齢条件だけで既に安全だが、lock喪失や別publishによる
// gen更新が起きていたらそこでGCを打ち切る）。
async function gcStaleGenerations(
  env: Env, bucket: R2Bucket, deviceId: string, currentGen: string, lockToken: string, now: number,
): Promise<number> {
  const maxAgeSeconds = Number(env.MAXIMUM_SHARE_DAYS) * 24 * 60 * 60;
  const budget = r2OperationBudget(env);
  const prefix = `pages/${deviceId}/`;
  let cursor: string | undefined;
  let deleted = 0;
  let operations = 0;
  do {
    if (operations >= budget) break;
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    operations += 1;
    const staleKeys: string[] = [];
    for (const object of listed.objects) {
      const rest = object.key.slice(prefix.length); // "<gen>/<slug>/index.html"
      const gen = rest.split('/')[0];
      if (!gen || gen === currentGen) continue;
      if (generationAgeSeconds(gen, now) > maxAgeSeconds) staleKeys.push(object.key);
    }
    for (let index = 0; index < staleKeys.length && operations < budget; index += 1000) {
      const guard = await env.DB.prepare('SELECT token, gen FROM publish_locks WHERE device_id = ?1')
        .bind(deviceId).first<{ token: string; gen: string }>();
      if (!guard || guard.token !== lockToken || guard.gen !== currentGen) return deleted;
      const batch = staleKeys.slice(index, index + 1000);
      await bucket.delete(batch);
      operations += 1;
      deleted += batch.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && operations < budget);
  return deleted;
}

// publish lockの原始的な取得（行なし or 失効時のみ）。purge（§7 step1）はデバイスの
// purging状態に関わらずこれで取得する（purge自身がpurging_atを立てる主体のため、
// ここでpurging_atを見てしまうと自分自身の再実行を阻害する）。
async function acquirePublishLock(env: Env, deviceId: string, now: number): Promise<{ token: string; gen: string } | null> {
  const token = randomToken(32);
  const gen = newGeneration(now);
  const expiresAt = now + PUBLISH_LOCK_TTL_SECONDS;
  const result = await env.DB.prepare(
    `INSERT INTO publish_locks (device_id, token, gen, expires_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (device_id) DO UPDATE SET token = ?2, gen = ?3, expires_at = ?4
     WHERE publish_locks.expires_at <= ?5`,
  ).bind(deviceId, token, gen, expiresAt, now).run();
  if (!result.meta.changes) return null;
  return { token, gen };
}

// device向けpublish lock取得（§7 step2）。purging_atが立っているデバイスは取得不可。
// 事前の存在チェックと同じ条件をINSERT自体のWHERE句にも埋め込むことで、
// 「チェック→取得」の間にpurgeが割り込むTOCTOUを構造的に閉じる
// （呼び出し側は失敗後にdevicesを読み直して403/409を判定する）。
async function acquireDevicePublishLock(env: Env, deviceId: string, now: number): Promise<{ token: string; gen: string } | null> {
  const token = randomToken(32);
  const gen = newGeneration(now);
  const expiresAt = now + PUBLISH_LOCK_TTL_SECONDS;
  const notPurging = 'NOT EXISTS (SELECT 1 FROM devices WHERE id = ?1 AND purging_at IS NOT NULL)';
  const result = await env.DB.prepare(
    `INSERT INTO publish_locks (device_id, token, gen, expires_at)
     SELECT ?1, ?2, ?3, ?4 WHERE ${notPurging}
     ON CONFLICT (device_id) DO UPDATE SET token = ?2, gen = ?3, expires_at = ?4
     WHERE publish_locks.expires_at <= ?5 AND ${notPurging}`,
  ).bind(deviceId, token, gen, expiresAt, now).run();
  if (!result.meta.changes) return null;
  return { token, gen };
}

// purge（§7）: device配下の全世代を無条件削除する。gcStaleGenerationsと違い年齢・現行世代の
// 判定はない（対象デバイスは既にpurging状態＝以後publishされないため、残っている
// オブジェクトは全て不要）。作業量上限は共通のR2_OPERATION_BUDGETを使い、超過時は
// done:falseとして呼び出し元（curl手順）が次回へ繰り越す。
// nowFnは既定でMath.floor(Date.now()/1000)（テストが時刻注入で「バッチ毎に本当に
// 現在時刻を取り直しているか」を検証できるようにするための差し替え口。本番では
// 常に既定値のまま使う）。
export async function purgeDeviceObjects(
  env: Env, bucket: R2Bucket, deviceId: string, lockToken: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<{ done: boolean; remaining: number }> {
  const budget = r2OperationBudget(env);
  const prefix = `pages/${deviceId}/`;
  let cursor: string | undefined;
  let operations = 0;
  let remaining = 0;
  let stopped = false; // budget超過またはlock喪失のいずれかで打ち切った
  do {
    if (operations >= budget) { stopped = true; break; }
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    operations += 1;
    const keys = listed.objects.map((object) => object.key);
    for (let index = 0; index < keys.length; index += 1000) {
      if (operations >= budget) {
        stopped = true;
        remaining += keys.length - index;
        break;
      }
      const batch = keys.slice(index, index + 1000);
      // 削除に時間がかかってもlockが失効しないよう、deleteの「前」にバッチ毎の
      // 「今の」時刻でlease延長する（実装レビューBLOCKER: delete後にrenewしていると、
      // delete自体に時間がかかってTTLが切れた場合、そのbatchはlock保護の外側で
      // 削除されてしまう。renewを先に行い、失敗したらそのbatchは削除しない）。
      // device_id/tokenが一致しUPDATEが1行も当たらない場合はlockを失った
      // （横取り・失効）とみなし、それ以上の削除を安全側で打ち切る。
      const renewNow = nowFn();
      const renewed = await env.DB.prepare(
        'UPDATE publish_locks SET expires_at = ?1 WHERE device_id = ?2 AND token = ?3',
      ).bind(renewNow + PUBLISH_LOCK_TTL_SECONDS, deviceId, lockToken).run();
      if (!renewed.meta.changes) {
        stopped = true;
        remaining += keys.length - index;
        break;
      }
      await bucket.delete(batch);
      operations += 1;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (stopped) break;
  } while (cursor);
  return { done: !stopped && !cursor, remaining };
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
  const result = await env.DB.prepare(`${TASK_SELECT} WHERE t.expires_at > ?1`).bind(now).all<TaskRow>();
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

// owner/deviceの両sharesエンドポイントで共有するロジック。D1のpages行から
// object_keyを引いて署名する——クライアントが指定したパス文字列を署名する経路は
// 存在しない（v3以降の設計転換。旧実装はslugからobjectKeyを直接組み立てていた）。
async function handleShare(env: Env, deviceId: string, body: Record<string, any>, now: number): Promise<Response> {
  const slug = clean(body.slug, 'slug', 128, true);
  const scope = body.scope === 'internal' ? 'internal' : body.scope === 'public' ? 'public' : '';
  if (!scope) return json(env, 400, { error: 'Invalid share scope' });
  const days = Number(body.days);
  const maximumDays = Number(env.MAXIMUM_SHARE_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > maximumDays) {
    return json(env, 400, { error: `Share duration must be between 1 and ${maximumDays} days` });
  }
  const row = await env.DB.prepare('SELECT object_key, visibility FROM pages WHERE device_id = ?1 AND slug = ?2')
    .bind(deviceId, slug).first<{ object_key: string; visibility: string }>();
  if (!row) return json(env, 404, { error: 'Page not found' });
  // このscope('public'|'internal')はCONTENTバケット上でのCIDR制限の有無を選ぶだけの軸で、
  // ページ自体のvisibility（どのバケットに実在するか）とは別物。visibility='internal'な
  // ページはCONTENTバケットに実体が無いため、scopeに関わらずここで拒否する
  // （internal Worker限定のページを、うっかり外部共有できてしまわないための歯止め）
  if (row.visibility === 'internal') {
    return json(env, 400, { error: 'This page is internal-only and cannot be shared publicly' });
  }
  const expiresAt = now + days * 24 * 60 * 60;
  const url = `${env.CONTENT_ORIGIN}/${row.object_key}`;
  let cidrs: string[] = [];
  if (scope === 'internal') {
    cidrs = internalCidrs(env);
    if (cidrs.length === 0) return json(env, 400, { error: 'Internal sharing is not configured' });
  }
  return json(env, 201, { url: await signShareUrl(env, url, expiresAt, cidrs), expiresAt });
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

// Workers Static Assets（設計§5）。ディレクトリ要求の末尾スラッシュ付与・index.html
// 解決・パストラバーサル対策は、いずれもASSETS binding（プラットフォーム側の資産
// ルーター）が担う——手製のR2キー解決だった旧serveStatic()のロジックはもう不要。
// ここでの責務は、ASSETSの応答へ自前のセキュリティヘッダーを重ねて返すことだけ
// （リダイレクト応答のlocationは保持する）。
async function serveStatic(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = securityHeaders(env, {
    'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
  });
  const location = response.headers.get('location');
  if (location) headers.set('location', location);
  return new Response(response.body, { status: response.status, headers });
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
      const row = await env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?1`).bind(id).first<TaskRow>();
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
      const deviceId = clean(body.deviceId, 'deviceId', 128, true);
      return handleShare(env, deviceId, body, now);
    }
    if (verb === 'GET' && path === '/api/owner/pages') {
      const result = await env.DB.prepare(
        `SELECT p.*, d.name AS device_name FROM pages p
         JOIN devices d ON d.id = p.device_id
         ORDER BY p.page_date DESC`,
      ).all<PageRow & { device_name: string }>();
      const ownerLinkExpiresAt = now + Number(env.OWNER_LINK_DAYS) * 24 * 60 * 60;
      // visibility='internal'なページはINTERNAL_ORIGIN（Access限定）を平文で指すだけでよい。
      // 署名URLの仕組み（期限・CIDR）はcontent Worker向けの「誰でも」モデルの
      // ためのものであり、Accessが本人確認そのものを行うinternal側には不要
      // （internal Worker自体はAccess JWTを都度検証するので、期限切れの心配も無い）
      const pages = await Promise.all((result.results ?? []).map(async (row) => ({
        slug: row.slug,
        title: row.title,
        source: row.source,
        repository: row.repository,
        stream: row.stream,
        streamLabel: row.stream_label,
        date: row.page_date,
        updatedAt: row.updated_at,
        objectKey: row.object_key,
        visibility: row.visibility,
        href: row.visibility === 'internal'
          ? `${env.INTERNAL_ORIGIN}/${row.object_key}`
          : await signShareUrl(env, `${env.CONTENT_ORIGIN}/${row.object_key}`, ownerLinkExpiresAt, []),
        deviceId: row.device_id,
        deviceName: row.device_name,
      })));
      return json(env, 200, { generatedAt: new Date().toISOString(), pages });
    }
    if (verb === 'GET' && path === '/api/owner/devices') {
      const result = await env.DB.prepare(
        'SELECT id, name, created_at, purging_at, revoked_at FROM devices ORDER BY created_at DESC',
      ).all<{ id: string; name: string; created_at: string; purging_at: string | null; revoked_at: string | null }>();
      const items = (result.results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        ...(row.purging_at === null ? {} : { purgingAt: row.purging_at }),
        ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
      }));
      return json(env, 200, { items });
    }
    const purge = path.match(/^\/api\/owner\/devices\/([^/]+)\/purge$/);
    if (verb === 'POST' && purge) {
      const deviceId = purge[1];
      const deviceRow = await env.DB.prepare('SELECT purging_at FROM devices WHERE id = ?1')
        .bind(deviceId).first<{ purging_at: string | null }>();
      if (!deviceRow) return json(env, 404, { error: 'Device not found' });
      const lock = await acquirePublishLock(env, deviceId, now);
      if (!lock) return json(env, 409, { error: 'Publish lock is held' });
      if (deviceRow.purging_at === null) {
        await env.DB.batch([
          env.DB.prepare('UPDATE devices SET purging_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), deviceId),
          env.DB.prepare('DELETE FROM pages WHERE device_id = ?1').bind(deviceId),
        ]);
      }
      // deviceがpublicとinternal両方のページを持ち得るため、両バケットを毎回とも試みる
      // （片方が予算切れで停止しても、もう片方は独立した予算で消化を試みる）
      const contentResult = await purgeDeviceObjects(env, env.CONTENT, deviceId, lock.token);
      const internalResult = await purgeDeviceObjects(env, env.INTERNAL, deviceId, lock.token);
      const result = {
        done: contentResult.done && internalResult.done,
        remaining: contentResult.remaining + internalResult.remaining,
      };
      if (!result.done) {
        await env.DB.prepare('DELETE FROM publish_locks WHERE device_id = ?1 AND token = ?2').bind(deviceId, lock.token).run();
        return json(env, 202, { done: false, ...(result.remaining ? { remaining: result.remaining } : {}) });
      }
      await env.DB.batch([
        env.DB.prepare('UPDATE devices SET revoked_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), deviceId),
        env.DB.prepare('DELETE FROM publish_locks WHERE device_id = ?1 AND token = ?2').bind(deviceId, lock.token),
      ]);
      return json(env, 200, { done: true });
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
      const row = await env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?1`).bind(answer[1]).first<TaskRow>();
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
      const row = await env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?1`).bind(id).first<TaskRow>();
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
    // claim: owner投稿のinbox項目（source='owner'・waiting）を、着手前に原子的に取得する。
    // 2台が同じ依頼をGETで同時に見つけても、claimに成功するのは先着1台だけになる
    // （後着は409）。complete前のこの取得自体を原子化することで、GET〜作業完了の
    // 全期間に及んでいた「両方が着手してしまう」raceを閉じる。
    // source='owner'限定なのは、review push/pull のQ&Aフロー（waiting→answered。
    // /api/owner/reviews/:id/answer が status='waiting' を要求する）のタスクを
    // claimがin_progressへ動かしてしまうと、answerが二度と一致条件を満たせず
    // 永久に回答不能になるため。
    const claim = path.match(/^\/api\/device\/reviews\/([^/]+)\/claim$/);
    if (verb === 'POST' && claim) {
      const result = await env.DB.prepare(
        `UPDATE tasks SET status = 'in_progress', device_id = ?1, updated_at = ?2
         WHERE id = ?3 AND status = 'waiting' AND source = 'owner'`,
      ).bind(current.id, new Date().toISOString(), claim[1]).run();
      if (!result.meta.changes) return json(env, 409, { error: 'This request is expired or already used' });
      const row = await env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?1`).bind(claim[1]).first<TaskRow>();
      return json(env, 200, { item: publicTask(row!) });
    }
    const complete = path.match(/^\/api\/device\/reviews\/([^/]+)\/complete$/);
    if (verb === 'POST' && complete) {
      // claimでin_progressを取得した本人だけが完了にできる。
      // （review push/pull のQ&Aフローはcompleteを呼ばずanswered/pullで完結するため、
      // ここにwaiting直接完了のパスは不要）
      const result = await env.DB.prepare(
        `UPDATE tasks SET status = 'completed', completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND status = 'in_progress' AND device_id = ?3`,
      ).bind(new Date().toISOString(), complete[1], current.id).run();
      if (!result.meta.changes) return json(env, 409, { error: 'This request is expired or already used' });
      return json(env, 200, { ok: true });
    }
    if (verb === 'POST' && path === '/api/device/publish/lock') {
      const lock = await acquireDevicePublishLock(env, current.id, now);
      if (!lock) {
        const deviceRow = await env.DB.prepare('SELECT purging_at FROM devices WHERE id = ?1')
          .bind(current.id).first<{ purging_at: string | null }>();
        if (deviceRow?.purging_at) return json(env, 403, { error: 'Device is being purged' });
        return json(env, 409, { error: 'Publish lock is held' });
      }
      return json(env, 200, { token: lock.token, gen: lock.gen, expiresAt: now + PUBLISH_LOCK_TTL_SECONDS });
    }
    if (verb === 'POST' && path === '/api/device/publish/renew') {
      const body = await parseBody(request);
      const token = clean(body.lockToken, 'lockToken', 200, true);
      const result = await env.DB.prepare(
        'UPDATE publish_locks SET expires_at = ?1 WHERE device_id = ?2 AND token = ?3',
      ).bind(now + PUBLISH_LOCK_TTL_SECONDS, current.id, token).run();
      if (!result.meta.changes) return json(env, 409, { error: 'Publish lock is not held' });
      return json(env, 200, { expiresAt: now + PUBLISH_LOCK_TTL_SECONDS });
    }
    if (verb === 'POST' && path === '/api/device/publish/commit') {
      const body = await parseBody(request);
      const lockToken = clean(body.lockToken, 'lockToken', 200, true);
      const lockRow = await env.DB.prepare(
        'SELECT gen FROM publish_locks WHERE device_id = ?1 AND token = ?2 AND expires_at > ?3',
      ).bind(current.id, lockToken, now).first<{ gen: string }>();
      if (!lockRow) return json(env, 409, { error: 'Publish lock is not held' });
      const pages = cleanCommitPages(body.pages);
      // ここで例外が投げられた場合はD1に一切触れていないため不変（§4.3 step2/3）。
      // visibilityごとに別バケットへアップロードされているため、検証も分けて行う
      // （同じgen配下でも、片方のバケットにしか実在しないオブジェクトを他方の
      // バケットへ問い合わせて誤って"missing"と判定しないようにする）
      const publicPages = pages.filter((page) => page.visibility === 'public');
      const internalPages = pages.filter((page) => page.visibility === 'internal');
      await verifyUploadedPages(env.CONTENT, current.id, lockRow.gen, publicPages);
      await verifyUploadedPages(env.INTERNAL, current.id, lockRow.gen, internalPages);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM pages WHERE device_id = ?1').bind(current.id),
        ...pages.map((page) => env.DB.prepare(
          `INSERT INTO pages (device_id, slug, title, source, repository, stream, stream_label, object_key, page_date, updated_at, visibility)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        ).bind(
          current.id, page.slug, page.title, page.source, page.repository, page.stream, page.streamLabel,
          pageObjectKey(current.id, lockRow.gen, page.slug), page.date, page.updatedAt, page.visibility,
        )),
      ]);
      // 両バケットとも毎回GCを試みる（このcommitがどちらのvisibilityも含まなくても、
      // 過去の別世代の孤児が残っている可能性があるため）
      const gcDeleted =
        await gcStaleGenerations(env, env.CONTENT, current.id, lockRow.gen, lockToken, now)
        + await gcStaleGenerations(env, env.INTERNAL, current.id, lockRow.gen, lockToken, now);
      await env.DB.prepare('DELETE FROM publish_locks WHERE device_id = ?1 AND token = ?2').bind(current.id, lockToken).run();
      return json(env, 200, { ok: true, pages: pages.length, gcDeleted });
    }
    if (verb === 'POST' && path === '/api/device/shares') {
      const body = await parseBody(request);
      return handleShare(env, current.id, body, now);
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
      return await serveStatic(request, env);
    } catch (error: any) {
      console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : 'Unknown error' }));
      if (new URL(request.url).pathname.startsWith('/api/')) {
        return json(env, error?.statusCode ?? 500, { error: error?.statusCode ? error.message : 'Request failed' });
      }
      return failure(env, 500, 'Please try again later.');
    }
  },
};
