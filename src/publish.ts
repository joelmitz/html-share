import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest, BuiltPage } from './bundle.js';
import { buildSite } from './bundle.js';
import type { HtmlShareConfig } from './config.js';
import { contentUrl, consoleUrl, resolveFromConfig } from './config.js';
import { signUrl } from './sign.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function files(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name);
    return entry.isDirectory() ? files(root, full) : [path.relative(root, full)];
  });
}

function copyConsole(buildRoot: string, manifest: object): void {
  const consoleRoot = path.join(buildRoot, 'console');
  mkdirSync(consoleRoot, { recursive: true });
  for (const relative of files(path.join(PACKAGE_ROOT, 'web'))) {
    const source = path.join(PACKAGE_ROOT, 'web', relative);
    const target = path.join(consoleRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
  mkdirSync(path.join(consoleRoot, 'app'), { recursive: true });
  writeFileSync(path.join(consoleRoot, 'app', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(consoleRoot, 'app.webmanifest'), `${JSON.stringify({
    name: 'HTML共有くん',
    short_name: '共有くん',
    lang: 'ja',
    start_url: '/app/index.html',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#0e0d6a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)}\n`);
}

function r2Client(config: HtmlShareConfig): S3Client {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 API token with Object Read & Write).');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.cloudflare.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function emptyBucket(client: S3Client, bucket: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    const objects = (listed.Contents ?? []).flatMap((item) => item.Key ? [{ Key: item.Key }] : []);
    if (objects.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    continuationToken = listed.NextContinuationToken;
  } while (continuationToken);
}

async function uploadTree(client: S3Client, bucket: string, root: string): Promise<void> {
  await emptyBucket(client, bucket);
  for (const relative of files(root)) {
    const file = path.join(root, relative);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: relative.split(path.sep).join('/'),
      Body: readFileSync(file),
      ContentType: TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      CacheControl: 'no-store, max-age=0',
    }));
  }
}

function ownerManifest(manifest: BuildManifest, config: HtmlShareConfig): object {
  const privateKeyPath = resolveFromConfig(config, config.cloudflare.privateKeyPath);
  return {
    generatedAt: manifest.generatedAt,
    pages: manifest.pages.map((page: BuiltPage) => ({
      ...page,
      href: signUrl({
        url: `${contentUrl(config)}/${page.objectKey}`,
        privateKeyPath,
        days: config.content.ownerLinkDays,
      }),
    })),
  };
}

export function buildOnly(config: HtmlShareConfig): { buildRoot: string; manifest: BuildManifest } {
  const buildRoot = path.resolve(config.baseDir, '.html-share', 'build');
  const manifest = buildSite(config, buildRoot);
  copyConsole(buildRoot, { generatedAt: manifest.generatedAt, pages: manifest.pages.map((page) => ({ ...page, href: null })) });
  return { buildRoot, manifest };
}

export async function publish(config: HtmlShareConfig): Promise<{ consoleUrl: string; pages: number }> {
  const { buildRoot, manifest } = buildOnly(config);
  copyConsole(buildRoot, ownerManifest(manifest, config));
  const client = r2Client(config);
  await uploadTree(client, config.cloudflare.contentBucket, path.join(buildRoot, 'content'));
  await uploadTree(client, config.cloudflare.consoleBucket, path.join(buildRoot, 'console'));
  return { consoleUrl: `${consoleUrl(config)}/app/index.html`, pages: manifest.pages.length };
}

export function share(config: HtmlShareConfig, query: string, days: number): string {
  if (days > config.content.maximumShareDays) {
    throw new Error(`Share duration exceeds the configured maximum of ${config.content.maximumShareDays} days`);
  }
  const buildRoot = path.resolve(config.baseDir, '.html-share', 'build');
  const manifest = JSON.parse(readFileSync(path.join(buildRoot, 'manifest.json'), 'utf8')) as BuildManifest;
  // slugの完全一致を最優先する。他ページのslug/titleの接頭辞になっているだけで
  // 「複数一致」エラーになっていた（例: report-2026-08-04-141049 と
  // report-2026-08-04-141049-ja）。完全一致が無いときだけ部分一致にフォールバックする。
  const exact = manifest.pages.filter((page) => page.slug === query);
  const matches = exact.length === 1
    ? exact
    : manifest.pages.filter((page) => page.slug.includes(query) || page.title.includes(query));
  if (matches.length !== 1) throw new Error(matches.length ? `Multiple pages match ${query}: ${matches.map((p) => p.slug).join(', ')}` : `Page not found: ${query}`);
  return signUrl({
    url: `${contentUrl(config)}/${matches[0].objectKey}`,
    privateKeyPath: resolveFromConfig(config, config.cloudflare.privateKeyPath),
    days,
  });
}
