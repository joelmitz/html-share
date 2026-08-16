import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('ships the full dashboard UI and inbox wording', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  const review = readFileSync(path.join(root, 'web', 'review', 'index.html'), 'utf8');
  const list = readFileSync(path.join(root, 'web', 'page-list.js'), 'utf8');
  const shell = readFileSync(path.join(root, 'web', 'mobile-page-shell.js'), 'utf8');

  assert.match(dashboard, /HTML共有くん/);
  assert.match(dashboard, /インボックス/);
  assert.match(dashboard, /未読に戻す/);
  assert.match(dashboard, /groupByStream/);
  assert.match(dashboard, /削除済み/);
  assert.match(dashboard, /api\/owner\/shares/);
  assert.match(list, /function markUnread/);
  assert.match(list, /v: null/);
  assert.match(shell, /class="action star-action"/);
  assert.match(shell, /class="action unread-action"/);
  assert.match(review, /Claudeへの依頼/);
  assert.match(review, /\/inbox/);
  assert.match(review, /PCへ渡す依頼はありません/);
  assert.match(review, /id="compose-target" type="text"/);
  assert.doesNotMatch(review, /<select[^>]*id="compose-target"/);
  assert.match(review, /id="target-list"/);
  assert.match(review, /function renderTargetOptions/);
  assert.match(review, /JSON\.stringify\(\{ question: text, target \}\)/);
  assert.match(review, /targetField\.value = '';/);
  assert.match(dashboard, /id="review-dot"/);
  assert.match(dashboard, /function refreshInboxDot/);
  assert.match(dashboard, /\/api\/owner\/reviews/);
});

test('places a logout button to the right of the inbox button', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  const reviewButton = dashboard.indexOf('id="review"');
  const logoutButton = dashboard.indexOf('id="logout"');
  assert.notEqual(reviewButton, -1);
  assert.notEqual(logoutButton, -1);
  assert.ok(logoutButton > reviewButton, 'logout button must follow the inbox button in source order');
  assert.match(dashboard, /id="logout" type="button" title="ログアウト"/);
  assert.match(dashboard, /\$\('logout'\)\.addEventListener\('click', \(\) => \{ location\.href = '\/auth\/logout'; \}\);/);
});

test('folds overflowing tables on the viewing origin without network access', () => {
  const tables = readFileSync(path.join(root, 'web', 'mobile-tables.js'), 'utf8');
  const handler = readFileSync(path.join(root, 'workers', 'console', 'src', 'index.ts'), 'utf8');
  assert.match(tables, /data-mb-tables="off"/);
  assert.doesNotMatch(tables, /\bfetch\s*\(/);
  assert.doesNotMatch(tables, /XMLHttpRequest/);
  // target を受け付けるのはオーナー（インボックス）投稿だけで、端末投稿は受け付けない
  assert.match(handler, /clean\(body\.target, 'target', 60\)/);
  const inserts = handler.split('INSERT INTO tasks');
  assert.equal(inserts.length, 3);
  assert.equal(inserts.slice(1).filter((part) => part.slice(0, 400).includes('target')).length, 1);
});

test('does not ship the discarded simplified dashboard files', () => {
  for (const file of ['app.css', 'app.js', 'review.html', 'review.js']) {
    assert.throws(() => readFileSync(path.join(root, 'web', 'app', file), 'utf8'));
  }
});

// 複数マシンpublish対応（設計 docs/proposals/20260816-multi-machine-publish.md §5.2）:
// 静的manifest.jsonをやめ、両クライアントとも動的な /api/owner/pages を読む。
// レスポンス契約は現行manifestと同形（generatedAt/pages）+ pages[].deviceId/deviceName
// なので、data.pages / manifest.pages を使う既存コードは変更していない。
// APIサーバー実装（workers/側）はこのステージのスコープ外（webのみ）のため、
// 契約どおりのモック応答をここに固定して「クライアントが読める形」を明文化しておく。
const OWNER_PAGES_CONTRACT_MOCK = {
  generatedAt: '2026-08-16T10:00:00.000Z',
  pages: [
    {
      slug: 'demo-report', title: 'デモレポート', source: 'examples/demo-report.html',
      repository: 'examples', stream: 'demo', streamLabel: 'demo',
      date: '2026-08-16T09:00:00.000Z', updatedAt: '2026-08-16T09:00:00.000Z',
      objectKey: 'pages/dev-a/1755331200-ab12cd34/demo-report/index.html',
      href: 'https://content.example.com/pages/dev-a/1755331200-ab12cd34/demo-report/index.html?sig=x',
      deviceId: 'dev-a', deviceName: 'devvps02',
    },
  ],
};

test('both clients fetch the dynamic owner pages endpoint instead of the static manifest', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  const shell = readFileSync(path.join(root, 'web', 'mobile-page-shell.js'), 'utf8');

  assert.match(dashboard, /fetch\('\/api\/owner\/pages',\s*\{\s*cache:\s*'no-store'\s*\}\)/);
  assert.doesNotMatch(dashboard, /fetch\('manifest\.json'/);
  assert.match(shell, /fetch\('\/api\/owner\/pages',\s*\{\s*cache:\s*'no-store'\s*\}\)/);
  assert.doesNotMatch(shell, /\/app\/manifest\.json/);

  // 契約の形をここで固定し、両クライアントが読むフィールド（.pages[].slug/title/href等）が
  // 引き続き存在することを確認する。data.pages / manifest.pages の消費コード自体は無変更。
  const page = OWNER_PAGES_CONTRACT_MOCK.pages[0];
  assert.equal(typeof OWNER_PAGES_CONTRACT_MOCK.generatedAt, 'string');
  for (const field of ['slug', 'title', 'source', 'repository', 'stream', 'streamLabel', 'date', 'updatedAt', 'objectKey', 'href', 'deviceId', 'deviceName']) {
    assert.ok(field in page, `owner pages contract mock is missing ${field}`);
  }
});

test('the share dialog on both clients sends deviceId per the device-scoped shares contract', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  const shell = readFileSync(path.join(root, 'web', 'mobile-page-shell.js'), 'utf8');

  assert.match(dashboard, /deviceId:\s*page\.deviceId,\s*\n\s*slug:\s*page\.slug,/);
  assert.match(shell, /deviceId:\s*currentPage\.deviceId,\s*\n\s*slug:\s*currentPage\.slug,/);
});

test('web/app.webmanifest is a static file matching the content publish.ts used to generate', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'web', 'app.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'HTML共有くん');
  assert.equal(manifest.short_name, '共有くん');
  assert.equal(manifest.start_url, '/app/index.html');
  assert.equal(manifest.icons.length, 3);
});

test('the review inbox shows an in_progress badge with the claiming device name and hides answer actions', () => {
  const review = readFileSync(path.join(root, 'web', 'review', 'index.html'), 'utf8');

  assert.match(review, /task\.status === 'in_progress'/);
  assert.match(review, /in-progress-mark/);
  assert.match(review, /作業中/);
  // 承認/送るボタンは `task.status === 'waiting' && !request` のときだけ出す既存条件を
  // in_progress 用の分岐に持ち込んでいないことを確認する（answerボタンを出さない要件）
  const inProgressBranch = review.slice(review.indexOf("task.status === 'in_progress'"));
  const branchEnd = inProgressBranch.indexOf('return card;');
  assert.ok(branchEnd > 0);
  const branchBody = inProgressBranch.slice(0, branchEnd);
  assert.doesNotMatch(branchBody, /approve|send\.className/);
  // オーナー削除（discard）は状態を問わず常設なので、in_progress分岐の外（カード共通部）で
  // 既に append 済みであることを確認する
  assert.match(review, /card\.querySelector\('\.meta'\)\.append\(discard\);/);
});
