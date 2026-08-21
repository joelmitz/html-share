// internal Worker: Cloudflare Access限定の閲覧面。
//
// content Workerは「知っている人なら誰でも」を前提にした
// 署名URL方式（外部共有が目的）。このWorkerは逆に「オーナー本人だけ」を前提にし、
// 署名URLではなくAccess JWTそのものをリクエストごとに検証する（consoleと同じ
// verifyAccessJwtを再利用。Accessアプリ設定のミスで素通りしても塞げるよう、
// エッジのAccess判定に加えてWorker側でも独立に検証する——脅威モデル「Access設定の誤り」
// と同じ設計）。
//
// visibility='internal'なページはCLI publishの時点でCONTENTバケットへは一切
// アップロードされない（別バケットINTERNAL）ため、このWorkerを経由しない限り
// どこからも到達できない。
import { verifyAccessJwt } from '../../shared/access.js';

export interface Env {
  INTERNAL: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
  CONSOLE_ORIGIN: string;
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

async function requireAccess(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return false;
  return verifyAccessJwt(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
    ownerEmail: env.OWNER_EMAIL,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failure(env, 405, 'Method not allowed.');
    }
    if (!await requireAccess(request, env)) {
      return failure(env, 401, 'Owner authentication is required.');
    }
    const url = new URL(request.url);
    let key: string;
    try {
      key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    } catch {
      return failure(env, 404, 'Not found.');
    }
    if (!key || key.includes('..')) return failure(env, 404, 'Not found.');
    const object = await env.INTERNAL.get(key);
    if (!object) return failure(env, 404, 'Not found.');
    const headers = securityHeaders(env, object.httpMetadata?.contentType ?? 'application/octet-stream');
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
  },
};
