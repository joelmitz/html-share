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
