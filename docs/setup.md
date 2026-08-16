# 初回セットアップ

HTML共有くん（Cloudflare版）は、自分のCloudflareアカウントへ構築して使います。セットアップ後の日常操作は、Claude Codeへ日本語で依頼できます。

## 必要なもの

- Node.js 22以降
- Cloudflareアカウントと、そこに追加済みのゾーン（ドメイン）
- そのゾーン配下の2つのホスト名（管理面・閲覧面。別オリジンにする）
- Cloudflare Zero Trust（無料プランで可。管理面のログインに使う）
- Claude CodeまたはCodex

証明書の発行は不要です（Cloudflareのカスタムドメインで自動発行されます）。

## インストール

```bash
git clone https://github.com/joelmitz/html-share.git
cd html-share
npm install
npm run build
npm link
cp html-share.config.example.yaml html-share.config.yaml
```

`html-share.config.yaml` のサンプル値を、自分のCloudflare環境とドメインへ置き換えてください。`content.roots` には、共有を許可するディレクトリだけを列挙します。

## R2バケットとD1データベースの作成

```bash
npx wrangler login
npx wrangler r2 bucket create html-share-console
npx wrangler r2 bucket create html-share-content
npx wrangler d1 create html-share-review
npx wrangler d1 migrations apply html-share-review --remote --config workers/console/wrangler.jsonc
```

`wrangler d1 create` が出力した `database_id` を `workers/console/wrangler.jsonc` へ書き込みます。あわせて両方の `workers/*/wrangler.jsonc` の `routes` と `vars`（ドメイン・オーナーメール等）を自分の値へ書き換えます。

## Cloudflare Access（管理面ログイン）の設定

Zero Trust ダッシュボードで次を作成します。

1. **Access → Applications → Self-hosted** でアプリを作成し、管理面ドメインの `/app`・`/review`・`/api/owner` の3パスを対象にする
2. ポリシーは「Allow / Include: Emails = 設定した `ownerEmail`」の1本だけにする（ログイン方法は One-time PIN で足りる）
3. アプリの **Audience (AUD) タグ** をコピーし、`workers/console/wrangler.jsonc` の `ACCESS_AUD` へ設定する
4. チームドメイン（`<team>.cloudflareaccess.com`）を `ACCESS_TEAM_DOMAIN` へ設定する

トップページ（`/`）と `/api/device/*`・`/api/pairings/*` はAccessの対象に含めません（端末はペアリングトークンで認証します）。

## 署名鍵の作成とデプロイ

```bash
html-share keys init
npm run deploy        # content → console の順に2つのWorkerをデプロイ
html-share keys store # 署名鍵を wrangler secret として登録
```

## アップロード用R2 APIトークン

CLIの `publish` はR2のS3互換APIでアップロードします。ダッシュボードの **R2 → Manage API Tokens** で2つのバケットへの Object Read & Write トークンを発行し、環境変数に設定します。

```bash
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
html-share publish
```

## スキルの追加

同梱の `create-html` は、メモや調査結果を読みやすいHTMLに整えます。`mobile` は、PC作業の確認依頼をスマホへ送ります。`inbox` は、スマホから置いた依頼をPCで引き取ります。

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/create-html" ~/.claude/skills/create-html
ln -s "$(pwd)/skills/mobile" ~/.claude/skills/mobile
ln -s "$(pwd)/skills/inbox" ~/.claude/skills/inbox
```

複数のプロジェクトで使う場合は、設定を `~/.config/html-share/config.yaml` へ置くか、`HTML_SHARE_CONFIG` で場所を指定します。

## 動作確認

Claude Codeへ「このHTMLを共有くんに追加して」と依頼し、本人専用の一覧にページが表示されれば完了です。

開発者向けの検証コマンドは [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。
