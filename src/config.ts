import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';

export interface PageConfig {
  path: string;
  title?: string;
  slug?: string;
  repository?: string;
  stream?: string;
  streamLabel?: string;
}

export interface HtmlShareConfig {
  ownerEmail: string;
  cloudflare: {
    accountId: string;
    consoleDomain: string;
    contentDomain: string;
    contentBucket: string;
    publicKeyPath: string;
    privateKeyPath: string;
  };
  content: {
    roots: string[];
    pages: PageConfig[];
    ownerLinkDays: number;
    maximumShareDays: number;
    maximumAssetBytes: number;
    allowedInternalCidrs: string[];
  };
  configFile: string;
  baseDir: string;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function hostname(value: unknown, name: string): string {
  const result = text(value, name).toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(result)) {
    throw new Error(`${name} must be a hostname without a scheme or path`);
  }
  return result;
}

function cidr(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(result)) throw new Error(`${name} must be an IPv4 CIDR`);
  const [address, prefix] = result.split('/');
  if (Number(prefix) > 32 || address.split('.').some((part) => Number(part) > 255)) {
    throw new Error(`${name} must be an IPv4 CIDR`);
  }
  return result;
}

export function resolveFromConfig(config: HtmlShareConfig, value: string): string {
  return path.resolve(config.baseDir, value);
}

function configPath(file?: string): string {
  if (file) return path.resolve(file);
  if (process.env.HTML_SHARE_CONFIG) return path.resolve(process.env.HTML_SHARE_CONFIG);
  const local = path.resolve('html-share.config.yaml');
  if (existsSync(local)) return local;
  const global = path.join(homedir(), '.config', 'html-share', 'config.yaml');
  return existsSync(global) ? global : local;
}

export function loadConfig(file?: string): HtmlShareConfig {
  const configFile = configPath(file);
  if (!existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}. Copy html-share.config.example.yaml first.`);
  }
  const raw = parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
  const cloudflare = raw?.cloudflare ?? {};
  const content = raw?.content ?? {};
  const pages = Array.isArray(content.pages) ? content.pages : [];
  const roots = Array.isArray(content.roots) ? content.roots.map((item: unknown) => text(item, 'content.roots[]')) : [];
  const allowedInternalCidrs = Array.isArray(content.allowedInternalCidrs)
    ? content.allowedInternalCidrs.map((item: unknown) => cidr(item, 'content.allowedInternalCidrs[]'))
    : [];
  if (roots.length === 0) throw new Error('content.roots must contain at least one directory');
  if (pages.length === 0) throw new Error('content.pages must contain at least one page');
  const ownerEmail = text(raw?.ownerEmail, 'ownerEmail');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('ownerEmail must be an email address');
  const consoleDomain = hostname(cloudflare.consoleDomain, 'cloudflare.consoleDomain');
  const contentDomain = hostname(cloudflare.contentDomain, 'cloudflare.contentDomain');
  if (consoleDomain === contentDomain) throw new Error('cloudflare.consoleDomain and cloudflare.contentDomain must be different security origins');
  const accountId = text(cloudflare.accountId, 'cloudflare.accountId').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    throw new Error('cloudflare.accountId must be a 32-character Cloudflare account ID');
  }

  return {
    ownerEmail,
    cloudflare: {
      accountId,
      consoleDomain,
      contentDomain,
      contentBucket: text(cloudflare.contentBucket, 'cloudflare.contentBucket'),
      publicKeyPath: text(cloudflare.publicKeyPath, 'cloudflare.publicKeyPath'),
      privateKeyPath: text(cloudflare.privateKeyPath, 'cloudflare.privateKeyPath'),
    },
    content: {
      roots,
      pages: pages.map((item: unknown, index: number) => {
        const page = typeof item === 'string' ? { path: item } : item as Record<string, unknown>;
        return {
          path: text(page.path, `content.pages[${index}].path`),
          title: typeof page.title === 'string' ? page.title.trim() : undefined,
          slug: typeof page.slug === 'string' ? page.slug.trim() : undefined,
          repository: typeof page.repository === 'string' ? page.repository.trim() : undefined,
          stream: typeof page.stream === 'string' ? page.stream.trim() : undefined,
          streamLabel: typeof page.streamLabel === 'string' ? page.streamLabel.trim() : undefined,
        };
      }),
      ownerLinkDays: positiveInteger(content.ownerLinkDays, 30, 'content.ownerLinkDays'),
      maximumShareDays: positiveInteger(content.maximumShareDays, 30, 'content.maximumShareDays'),
      maximumAssetBytes: positiveInteger(content.maximumAssetBytes, 10 * 1024 * 1024, 'content.maximumAssetBytes'),
      allowedInternalCidrs,
    },
    configFile,
    baseDir: path.dirname(configFile),
  };
}

export function addPageToConfig(file: string | undefined, pagePath: string, title?: string): boolean {
  const configFile = configPath(file);
  const raw = parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
  raw.content ??= {};
  raw.content.pages ??= [];
  if (!Array.isArray(raw.content.pages)) throw new Error('content.pages must be an array');
  const storedPath = path.isAbsolute(pagePath) || path.dirname(configFile) === process.cwd()
    ? pagePath
    : path.resolve(pagePath);
  const exists = raw.content.pages.some((item: unknown) =>
    (typeof item === 'string' ? item : (item as Record<string, unknown>)?.path) === storedPath,
  );
  if (exists) return false;
  raw.content.pages.push(title ? { path: storedPath, title } : { path: storedPath });
  writeFileSync(configFile, stringify(raw, { lineWidth: 120 }));
  return true;
}

export function validatedRoots(config: HtmlShareConfig): string[] {
  return config.content.roots.map((root) => {
    const absolute = resolveFromConfig(config, root);
    if (!existsSync(absolute)) throw new Error(`Content root not found: ${absolute}`);
    return realpathSync(absolute);
  });
}

export function consoleUrl(config: HtmlShareConfig): string {
  return `https://${config.cloudflare.consoleDomain}`;
}

export function contentUrl(config: HtmlShareConfig): string {
  return `https://${config.cloudflare.contentDomain}`;
}
