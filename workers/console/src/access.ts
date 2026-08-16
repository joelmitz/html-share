// Cloudflare Access が付与する JWT (Cf-Access-Jwt-Assertion) の検証。
// Access はエッジで未認証アクセスを遮断するが、設定ミスで素通りした場合に
// オーナーAPIが開かないよう、Worker 側でも二重に検証する。

interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const KEY_TTL_MILLISECONDS = 60 * 60 * 1000;
let cachedKeys: CachedKeys | undefined;

// テスト専用: module scope の certs cache を破棄する（本番コードからは呼ばない）
export function resetAccessKeyCacheForTests(): void {
  cachedKeys = undefined;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

async function signingKeys(teamDomain: string, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  if (!forceRefresh && cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_TTL_MILLISECONDS) return cachedKeys.keys;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Access certs fetch failed: ${response.status}`);
  const body = await response.json() as { keys?: AccessJwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    ));
  }
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

export interface AccessConfig {
  teamDomain: string;
  audience: string;
  ownerEmail: string;
}

export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<boolean> {
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) return false;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; email?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart)));
  } catch {
    return false;
  }
  if (header.alg !== 'RS256' || !header.kid) return false;
  let key = (await signingKeys(config.teamDomain)).get(header.kid);
  if (!key) {
    // 鍵rotation直後はcacheに新kidが無い。TTL内でも1回だけ強制再取得する。
    key = (await signingKeys(config.teamDomain, true)).get(header.kid);
    if (!key) return false;
  }
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!verified) return false;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) return false;
  if (payload.iss !== `https://${config.teamDomain}`) return false;
  if (!Number.isInteger(payload.exp) || payload.exp! <= Math.floor(Date.now() / 1000)) return false;
  return String(payload.email ?? '').toLowerCase() === config.ownerEmail.toLowerCase();
}
