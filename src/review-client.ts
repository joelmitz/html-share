import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import type { HtmlShareConfig } from './config.js';

interface DeviceCredentials {
  deviceToken: string;
  deviceName: string;
  apiBase: string;
}

export interface ReviewCard {
  id?: string;
  sessionId?: string;
  title: string;
  question: string;
  context?: string;
  recommendation?: string;
  status?: string;
  source?: string;
  target?: string | null;
  responseText?: string;
  updatedAt?: string;
  createdAt?: string;
}

function credentialsPath(): string {
  return process.env.HTML_SHARE_CREDENTIALS
    ?? path.join(homedir(), '.config', 'html-share', 'review-device.json');
}

function apiBase(config: HtmlShareConfig): string {
  return `https://${config.cloudflare.consoleDomain}/api`;
}

function loadCredentials(): DeviceCredentials | null {
  const file = credentialsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeviceCredentials;
    return parsed.deviceToken ? parsed : null;
  } catch {
    return null;
  }
}

function saveCredentials(value: DeviceCredentials): void {
  const file = credentialsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// pairing済みトークンの読み込み＋apiBase整合検証。requestとpairedDeviceId
// （publish系: §3「review-client.tsの既存のapiBase整合検証をpublishにも適用」）で共有する。
function requireCredentials(config: HtmlShareConfig): DeviceCredentials {
  const saved = loadCredentials();
  if (!saved) throw new Error('This computer is not paired. Run `html-share review pair <code>`.');
  if (saved.apiBase !== apiBase(config)) {
    throw new Error('The paired console does not match this config. Pair this computer again before sending credentials.');
  }
  return saved;
}

async function request(config: HtmlShareConfig, pathname: string, options: {
  method?: string;
  body?: unknown;
  authenticated?: boolean;
} = {}): Promise<any> {
  const authenticated = options.authenticated !== false;
  const saved = authenticated ? requireCredentials(config) : null;
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${apiBase(config)}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(serialized ? {
        'content-type': 'application/json',
        'x-content-sha256': createHash('sha256').update(serialized).digest('hex'),
      } : {}),
      ...(authenticated ? { 'x-review-device-token': saved!.deviceToken } : {}),
    },
    body: serialized,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Review API returned ${response.status}`) as RequestError;
    error.status = response.status;
    throw error;
  }
  return payload;
}

// 名前空間キー＝ペアリング済みデバイスID（設計§3）。サーバーはx-review-device-token
// から同じ値を導出するため、リクエストボディへ載せる必要はない——CLIがローカルで
// 必要とするのは、R2への直接アップロード先キー（pages/<deviceId>/<gen>/<slug>/...）を
// 組み立てるためだけ。
export function pairedDeviceId(config: HtmlShareConfig): string {
  return createHash('sha256').update(requireCredentials(config).deviceToken).digest('hex');
}

// HTTPステータスを保持したエラー。呼び出し側（claimReviews等）が「409=正常な競合」と
// 「それ以外=本当の失敗（認証切れ・サーバ障害・タイムアウト等）」を区別するために使う。
// fetch自体の失敗（ネットワーク断・AbortSignal.timeout）はstatusを持たないため
// 区別不要（常に非409＝致命的として扱われる）。
type RequestError = Error & { status?: number };

export async function pair(config: HtmlShareConfig, code: string, name = `Computer / ${hostname()}`): Promise<string> {
  const result = await request(config, '/pairings/claim', {
    method: 'POST',
    authenticated: false,
    body: { code, deviceName: name },
  });
  saveCredentials({ deviceToken: result.deviceToken, deviceName: result.deviceName, apiBase: apiBase(config) });
  return result.deviceName;
}

export interface PublishLock {
  token: string;
  gen: string;
  expiresAt: number;
}

// 設計§4.2。取得不可（保持中/purging中）は409/403としてrequest()がそのまま投げる
// ——publishコマンドは特別扱いせず、他のAPIエラーと同様にコマンド全体を失敗させる。
export async function acquirePublishLock(config: HtmlShareConfig): Promise<PublishLock> {
  const result = await request(config, '/device/publish/lock', { method: 'POST', body: {} });
  return { token: result.token, gen: result.gen, expiresAt: result.expiresAt };
}

export async function renewPublishLock(config: HtmlShareConfig, lockToken: string): Promise<{ expiresAt: number }> {
  const result = await request(config, '/device/publish/renew', { method: 'POST', body: { lockToken } });
  return { expiresAt: result.expiresAt };
}

export interface CommitPageInput {
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
}

// 設計§4.3。object_keyはリクエストに含めない——Workerがlock行のgenとslugから導出する
// （CLIが他デバイスのprefixや任意のURLを注入する余地が構造的に無い）。
export async function commitPublish(
  config: HtmlShareConfig, lockToken: string, pages: CommitPageInput[],
): Promise<{ pages: number; gcDeleted: number }> {
  const result = await request(config, '/device/publish/commit', { method: 'POST', body: { lockToken, pages } });
  return { pages: result.pages, gcDeleted: result.gcDeleted };
}

// 設計§6。署名主体はWorkerに一本化されるため、CLIはローカル秘密鍵を持たない
// （scope='public'のみCLIから使う。internal共有は現状owner console側の機能）。
export async function deviceShare(
  config: HtmlShareConfig, slug: string, scope: 'public' | 'internal', days: number,
): Promise<{ url: string; expiresAt: number }> {
  const result = await request(config, '/device/shares', { method: 'POST', body: { slug, scope, days } });
  return { url: result.url, expiresAt: result.expiresAt };
}

export async function pushReviews(config: HtmlShareConfig, sessionId: string, cards: ReviewCard[]): Promise<ReviewCard[]> {
  const created: ReviewCard[] = [];
  for (const card of cards) {
    const result = await request(config, '/device/reviews', {
      method: 'POST',
      body: { ...card, sessionId },
    });
    created.push(result.item);
  }
  return created;
}

export async function pullReviews(config: HtmlShareConfig, sessionId?: string): Promise<ReviewCard[]> {
  const query = new URLSearchParams({ status: 'answered' });
  if (sessionId) query.set('sessionId', sessionId);
  const result = await request(config, `/device/reviews?${query}`);
  return result.items ?? [];
}

export async function listInbox(config: HtmlShareConfig): Promise<ReviewCard[]> {
  // waitingは未着手の依頼、in_progressは「このデバイスが」既にclaim済みで作業途中の依頼
  // （GET /api/device/reviewsはdevice_id=自分 or OWNERでしか絞り込まないサーバー実装のため、
  // 他デバイスがclaim中の依頼は含まれない）。プロセス再起動後もin_progressが再発見できる
  // ようにするため、両方を1回のinboxで返す。
  const [waiting, inProgress] = await Promise.all([
    request(config, `/device/reviews?${new URLSearchParams({ status: 'waiting', sessionId: 'inbox' })}`),
    request(config, `/device/reviews?${new URLSearchParams({ status: 'in_progress', sessionId: 'inbox' })}`),
  ]);
  return [...(waiting.items ?? []), ...(inProgress.items ?? [])]
    .filter((item) => item.source === 'owner' || item.sessionId === 'inbox')
    .sort((left, right) => String(left.updatedAt ?? '').localeCompare(String(right.updatedAt ?? '')))
    .map((item) => ({
      ...item,
      target: item.target || null,
    }));
}

export async function completeReviews(config: HtmlShareConfig, ids: string[]): Promise<void> {
  for (const id of ids) {
    await request(config, `/device/reviews/${encodeURIComponent(id)}/complete`, { method: 'POST', body: {} });
  }
}

export interface ClaimResult {
  id: string;
  ok: boolean;
  item?: ReviewCard;
  error?: string;
}

// completeReviewsと異なり、409（他デバイスが先に着手済み）1件だけは全体を止めずその
// idをスキップして続行する——skillが「409なら次へ」と機械的に判断できるようにするため。
// それ以外の失敗（401=pairing失効・403・404・500・ネットワーク断・timeout等）は握り潰さず
// 例外を再送出し、コマンド全体を失敗させる（非0終了）。これらを409と同列に扱うと、
// 認証切れやサーバ障害を「他PCに取られた」と誤認して作業を続けてしまう。
export async function claimReviews(config: HtmlShareConfig, ids: string[]): Promise<ClaimResult[]> {
  const results: ClaimResult[] = [];
  for (const id of ids) {
    try {
      const result = await request(config, `/device/reviews/${encodeURIComponent(id)}/claim`, { method: 'POST', body: {} });
      results.push({ id, ok: true, item: result.item });
    } catch (error) {
      if ((error as RequestError)?.status === 409) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      throw error;
    }
  }
  return results;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pidFile = (sessionId: string) => path.join(
  homedir(),
  '.cache',
  'html-share',
  `review-watch-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.pid`,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function watchReviews(config: HtmlShareConfig, sessionId: string, timeoutMinutes = 240): Promise<ReviewCard[]> {
  const file = pidFile(sessionId);
  if (existsSync(file)) {
    const previous = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(previous) && alive(previous)) throw new Error(`This session is already being watched by PID ${previous}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${process.pid}\n`);
  const cleanup = () => { if (existsSync(file)) rmSync(file); };
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  const deadline = Date.now() + timeoutMinutes * 60_000;
  try {
    while (Date.now() < deadline) {
      const items = await pullReviews(config, sessionId);
      if (items.length) return items;
      await sleep(20_000);
    }
    return [];
  } finally {
    cleanup();
  }
}

export function stopWatching(sessionId: string): boolean {
  const file = pidFile(sessionId);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (Number.isInteger(pid) && alive(pid)) process.kill(pid, 'SIGTERM');
  if (existsSync(file)) rmSync(file);
  return true;
}
