import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlShareConfig } from './config.js';
import { resolveFromConfig } from './config.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function initializeKeys(config: HtmlShareConfig, overwrite = false): { privateKeyPath: string; publicKeyPath: string } {
  const privateKeyPath = resolveFromConfig(config, config.cloudflare.privateKeyPath);
  const publicKeyPath = resolveFromConfig(config, config.cloudflare.publicKeyPath);
  if (!overwrite && (existsSync(privateKeyPath) || existsSync(publicKeyPath))) {
    throw new Error('Key files already exist. Use --overwrite only when intentionally rotating keys.');
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mkdirSync(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(publicKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });
  chmodSync(privateKeyPath, 0o600);
  return { privateKeyPath, publicKeyPath };
}

function workerConfig(worker: 'console' | 'content'): string {
  return path.join(PACKAGE_ROOT, 'workers', worker, 'wrangler.jsonc');
}

function secretExists(config: HtmlShareConfig, worker: 'console' | 'content', name: string): boolean {
  const result = spawnSync('npx', ['wrangler', 'secret', 'list', '--config', workerConfig(worker)], {
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId },
  });
  if (result.status !== 0) return false;
  try {
    const secrets = JSON.parse(result.stdout) as Array<{ name?: string }>;
    return secrets.some((secret) => secret.name === name);
  } catch {
    return false;
  }
}

function putSecret(config: HtmlShareConfig, worker: 'console' | 'content', name: string, value: string): void {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--config', workerConfig(worker)], {
    input: value,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId },
  });
  if (result.status !== 0) {
    throw new Error(`wrangler secret put ${name} failed for the ${worker} worker: ${result.stderr || result.stdout}`);
  }
}

export async function storePrivateKey(config: HtmlShareConfig, overwrite = false): Promise<void> {
  const privateKeyPath = resolveFromConfig(config, config.cloudflare.privateKeyPath);
  const publicKeyPath = resolveFromConfig(config, config.cloudflare.publicKeyPath);
  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    throw new Error('Key files not found. Run `html-share keys init` first.');
  }
  if (!overwrite && (
    secretExists(config, 'console', 'SIGNING_PRIVATE_KEY') || secretExists(config, 'content', 'SIGNING_PUBLIC_KEY')
  )) {
    throw new Error('Signing secrets already exist. Use --overwrite only when intentionally rotating keys.');
  }
  putSecret(config, 'console', 'SIGNING_PRIVATE_KEY', readFileSync(privateKeyPath, 'utf8'));
  putSecret(config, 'content', 'SIGNING_PUBLIC_KEY', readFileSync(publicKeyPath, 'utf8'));
}
