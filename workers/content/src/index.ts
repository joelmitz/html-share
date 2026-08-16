export interface Env {
  CONTENT: R2Bucket;
  SIGNING_PUBLIC_KEY: string;
  CONSOLE_ORIGIN: string;
}

const encoder = new TextEncoder();
let publicKeyPromise: Promise<CryptoKey> | undefined;

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

function publicKey(env: Env): Promise<CryptoKey> {
  if (!publicKeyPromise) {
    publicKeyPromise = crypto.subtle.importKey(
      'spki',
      pemToDer(env.SIGNING_PUBLIC_KEY),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  }
  return publicKeyPromise;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const raw = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!/^\d{1,3}$/.test(part) || value > 255) return null;
    result = result * 256 + value;
  }
  return result;
}

function ipInCidrs(address: string, cidrs: string[]): boolean {
  const ip = ipv4ToNumber(address);
  if (ip === null) return false;
  return cidrs.some((cidr) => {
    const [network, prefixText] = cidr.split('/');
    const base = ipv4ToNumber(network);
    const prefix = Number(prefixText);
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function decodeCidrs(cidrParam: string): string[] | null {
  const bytes = base64UrlToBytes(cidrParam);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function securityHeaders(env: Env, contentType: string): Headers {
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set(
    'content-security-policy',
    `default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; frame-src 'none'; connect-src 'none'; form-action 'none'; frame-ancestors ${env.CONSOLE_ORIGIN}; base-uri 'none'; sandbox allow-scripts`,
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-robots-tag', 'noindex, nofollow, nosnippet, noimageindex, noarchive');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  return headers;
}

function failure(env: Env, status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Access denied</title><h1>${status}</h1><p>${message}</p>`,
    { status, headers: securityHeaders(env, 'text/html; charset=utf-8') },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failure(env, 405, 'Method not allowed.');
    }
    const url = new URL(request.url);
    const expiresText = url.searchParams.get('e') ?? '';
    const cidrParam = url.searchParams.get('i') ?? '';
    const signatureParam = url.searchParams.get('s') ?? '';
    if (!/^\d{1,12}$/.test(expiresText) || !signatureParam) {
      return failure(env, 403, 'This URL is missing its signature.');
    }
    if (Number(expiresText) <= Math.floor(Date.now() / 1000)) {
      return failure(env, 403, 'This URL has expired.');
    }
    const signature = base64UrlToBytes(signatureParam);
    if (!signature) return failure(env, 403, 'This URL has an invalid signature.');
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      await publicKey(env),
      signature,
      encoder.encode(`${url.pathname}\n${expiresText}\n${cidrParam}`),
    );
    if (!verified) return failure(env, 403, 'This URL has an invalid signature.');
    if (cidrParam) {
      const cidrs = decodeCidrs(cidrParam);
      const clientIp = request.headers.get('cf-connecting-ip') ?? '';
      if (!cidrs || !ipInCidrs(clientIp, cidrs)) {
        return failure(env, 403, 'This URL is limited to the allowed network.');
      }
    }
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
      return failure(env, 404, 'Not found.');
    }
    if (!key || key.includes('..')) return failure(env, 404, 'Not found.');
    const object = await env.CONTENT.get(key);
    if (!object) return failure(env, 404, 'Not found.');
    const headers = securityHeaders(env, object.httpMetadata?.contentType ?? 'application/octet-stream');
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
  },
};
