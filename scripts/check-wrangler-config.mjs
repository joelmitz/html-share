// deploy直前の設定検査。workers/*/wrangler.jsoncはこのリポジトリでは意図的に
// placeholder（example.com等）のままcommitされ、実デプロイ時だけ.env.deploy.*の
// 実値で一時的に書き換える運用（docs/setup.md）。この検査は、書き換え忘れたまま
// deployしてしまう事故——「成功はしたが実際にはAccessが空AUDで誰も通さない」
// 「routesがexample.comのままでzoneが見つからず失敗する」等——を、wrangler自体の
// エラーより前に、分かりやすいメッセージで止める。
//
// Usage: node scripts/check-wrangler-config.mjs <path/to/wrangler.jsonc>

import { readFileSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/check-wrangler-config.mjs <path/to/wrangler.jsonc>');
  process.exit(2);
}

// JSONC（// 行コメント・/* */ ブロックコメント付きJSON）を文字列を壊さずに剥がす。
// wrangler.jsoncの値にコメント記号を含む文字列（URLの // 等）は現状無いが、
// 将来混入しても誤って剥がさないよう文字列区間を認識する。
function stripJsonComments(text) {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (char === '\n') { inLineComment = false; result += char; }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') { inBlockComment = false; index += 1; }
      continue;
    }
    if (inString) {
      result += char;
      if (char === '\\') { result += next ?? ''; index += 1; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; result += char; continue; }
    if (char === '/' && next === '/') { inLineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { inBlockComment = true; index += 1; continue; }
    result += char;
  }
  return result;
}

let config;
try {
  config = JSON.parse(stripJsonComments(readFileSync(target, 'utf8')));
} catch (error) {
  console.error(`${target}: failed to parse as JSONC (${error.message})`);
  process.exit(1);
}

const problems = [];

function checkPlaceholder(label, value) {
  if (typeof value !== 'string') return;
  if (/example\.com/i.test(value)) problems.push(`${label} still contains the template placeholder "example.com": ${value}`);
  if (/your-team\b/i.test(value)) problems.push(`${label} still contains the template placeholder "your-team": ${value}`);
  if (/^owner@example\.com$/i.test(value)) problems.push(`${label} still contains the template placeholder owner email: ${value}`);
}

for (const route of config.routes ?? []) {
  checkPlaceholder('routes[].pattern', route.pattern);
}
for (const [key, value] of Object.entries(config.vars ?? {})) {
  checkPlaceholder(`vars.${key}`, value);
  // ACCESS_AUD・ACCESS_TEAM_DOMAINは空文字のままだと、Accessが常に拒否側へ倒れて
  // machine上は「成功したが誰もログインできない」事故になる。空値の見逃しを防ぐ。
  if ((key === 'ACCESS_AUD' || key === 'ACCESS_TEAM_DOMAIN') && value === '') {
    problems.push(`vars.${key} is empty — Access will reject every request until this is set`);
  }
}
for (const database of config.d1_databases ?? []) {
  if (database.database_id === '00000000-0000-0000-0000-000000000000') {
    problems.push(`d1_databases[].database_id is still the placeholder zero-UUID: ${database.database_id}`);
  }
}

if (problems.length) {
  console.error(`${target}: not ready to deploy —\n${problems.map((line) => `  - ${line}`).join('\n')}`);
  console.error('\nこれはテンプレートのままdeployしようとしています。docs/setup.mdの手順どおり、実値へ一時的に書き換えてからdeployしてください。');
  process.exit(1);
}
console.log(`${target}: ok`);
