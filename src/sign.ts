import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface SignOptions {
  url: string;
  privateKeyPath: string;
  days: number;
  cidrs?: string[];
}

export function signingPayload(pathname: string, expiresAt: number, cidrParam: string): string {
  return `${pathname}\n${expiresAt}\n${cidrParam}`;
}

export function signUrlWithKey(privateKeyPem: string, { url, days, cidrs }: Omit<SignOptions, 'privateKeyPath'>): string {
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive integer');
  const target = new URL(url);
  const expiresAt = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const cidrParam = cidrs?.length ? Buffer.from(JSON.stringify(cidrs)).toString('base64url') : '';
  const signature = createSign('RSA-SHA256')
    .update(signingPayload(target.pathname, expiresAt, cidrParam))
    .sign(privateKeyPem, 'base64url');
  target.search = new URLSearchParams({
    e: String(expiresAt),
    ...(cidrParam ? { i: cidrParam } : {}),
    s: signature,
  }).toString();
  return target.toString();
}

export function signUrl({ privateKeyPath, ...options }: SignOptions): string {
  return signUrlWithKey(readFileSync(privateKeyPath, 'utf8'), options);
}
