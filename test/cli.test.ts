import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const cliEntry = path.join(root, 'src', 'cli.ts');
const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');

function fixture(): { root: string; config: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'html-share-cli-'));
  mkdirSync(path.join(dir, 'pages'));
  writeFileSync(path.join(dir, 'pages', 'demo.html'), '<h1>Demo</h1>');
  const config = path.join(dir, 'html-share.config.yaml');
  // content.pages が空の、初回セットアップ直後を模した設定
  writeFileSync(config, `ownerEmail: owner@example.com
cloudflare:
  accountId: "0123456789abcdef0123456789abcdef"
  consoleDomain: console.example.com
  contentDomain: content.example.com
  contentBucket: html-share-content
  publicKeyPath: .html-share/keys/public.pem
  privateKeyPath: .html-share/keys/private.pem
content:
  roots: [pages]
  pages: []
`);
  return { root: dir, config };
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(tsxBin, [cliEntry, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test('page add succeeds on a fresh config whose content.pages is still empty', () => {
  const { config } = fixture();
  // loadConfig()はcontent.pagesが空だと例外を投げるが、page addはそれを
  // 経由しないため、新規セットアップ直後の最初の1件追加が通る必要がある。
  const result = runCli(['page', 'add', 'pages/demo.html', '--title', 'デモ', '--config', config]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.added, true);

  const raw = readFileSync(config, 'utf8');
  assert.match(raw, /pages\/demo\.html/);
});

test('build still rejects a config whose content.pages is genuinely empty', () => {
  const { config } = fixture();
  // page addを経由しない他コマンドでは、従来どおりcontent.pagesの非空検証が効く
  const result = runCli(['build', '--config', config]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /content\.pages must contain at least one page/);
});
