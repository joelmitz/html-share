# 初回セットアップ

HTML共有くん（Cloudflare版）は、自分のCloudflareアカウントへ構築して使います。セットアップ後の日常操作は、Claude Codeへ日本語で依頼できます。

## 必要なもの

- Node.js 22以降
- Cloudflareアカウントと、そこに追加済みのゾーン（ドメイン）
- そのゾーン配下の3つのホスト名（管理面・閲覧面・Access限定閲覧面。すべて別オリジンにする）
- Cloudflare Zero Trust（無料プランで可。管理面とAccess限定閲覧面のログインに使う）
- Claude CodeまたはCodex

証明書の発行は不要です（Cloudflareのカスタムドメインで自動発行されます）。

## インストール

```bash
git clone https://github.com/joelmitz/html-share-cloudflare.git
cd html-share-cloudflare
npm install
npm run build
npm link
cp html-share.config.example.yaml html-share.config.yaml
```

`html-share.config.yaml` のサンプル値を、自分のCloudflare環境とドメインへ置き換えてください。`content.roots` には、共有を許可するディレクトリだけを列挙します。

## R2バケットとD1データベースの作成

```bash
npx wrangler login
npx wrangler r2 bucket create html-share-content
npx wrangler r2 bucket create html-share-internal
npx wrangler d1 create html-share-review
```

**先に** `wrangler d1 create` が出力した `database_id` を `workers/console/wrangler.jsonc` へ書き込みます（placeholder のままだと次の migration が失敗します）。あわせて `workers/content` `workers/internal` `workers/console` の3つ全ての `wrangler.jsonc` の `routes` と `vars`（ドメイン・オーナーメール等）を自分の値へ書き換えます。そのうえで migration を適用します。

```bash
npx wrangler d1 migrations apply html-share-review --remote --config workers/console/wrangler.jsonc
```

## Cloudflare Access（管理面ログイン）の設定

Zero Trust ダッシュボード（`dash.cloudflare.com` の左メニュー「Zero Trust」）で次を作成します。UIは頻繁に変わるため、メニュー名より「何をするか」を目印にしてください。

1. **Access コントロール → アプリケーション → 新規アプリケーションを作成 → Self-hosted** でアプリを作成し、管理面ドメインの `/app`・`/review`・`/api/owner` の3パスを対象にする（「パブリックホスト名」を3回追加する）
2. ポリシーは「Allow / Include: Emails = 設定した `ownerEmail`」の1本だけにする
3. アプリの **Audience (AUD) タグ**（アプリ作成後、詳細タブに表示）をコピーし、`workers/console/wrangler.jsonc` の `ACCESS_AUD` へ設定する
4. チームドメイン（`<team>.cloudflareaccess.com`。Zero Trust → 設定 → チーム名とドメイン に表示）を `ACCESS_TEAM_DOMAIN` へ設定する

トップページ（`/`）と `/api/device/*`・`/api/pairings/*` はAccessの対象に含めません（端末はペアリングトークンで認証します）。

## Cloudflare Access（Access限定閲覧面ログイン）の設定

`visibility: internal`（既定値）で publish したページを見るための、管理面とは別のAccessアプリを作ります。上と同じ手順で、対象ドメインと書き込み先だけが異なります。

1. **Access コントロール → アプリケーション → 新規アプリケーションを作成 → Self-hosted** でアプリを作成し、Access限定閲覧面ドメイン全体（パス指定なし）を対象にする
2. ポリシーは管理面と同じく「Allow / Include: Emails = 設定した `ownerEmail`」の1本だけにする
3. アプリの **Audience (AUD) タグ** をコピーし、`workers/internal/wrangler.jsonc` の `ACCESS_AUD` へ設定する
4. `ACCESS_TEAM_DOMAIN` は管理面アプリと同じチームドメインを使う

管理面アプリとAccess限定閲覧面アプリは、**それぞれ別のAUDを持つ別々のAccessアプリケーション**にします（1つのAUDを使い回さない。`workers/internal/src/index.ts` は `workers/console/src/index.ts` と独立にJWTを検証するため、AUDを混同すると誤って通す/誤って拒否するどちらの事故にもつながります）。

### ログイン方法の追加（GitHub・Google・パスキー/セキュリティキー）

デフォルトは One-time PIN（メールで届くコードでのログイン）だけです。他の方法を足す場合の導線は次のとおりです（2026年8月時点。「Settings → Authentication → Login methods」という旧UIの案内は現行版には存在しません）。

**GitHub・Google などの外部IdPを追加する:**

1. Zero Trust → **Access コントロール → 概要**（一覧の左メニュー最上部）を開く
2. 「推奨事項」の **「アプリケーションのログイン方法を追加する」** をクリックすると、右側に「ID プロバイダーを統合する」パネルが開く
   - 同じ画面へ直接行きたい場合は、左メニューの **インテグレーション → ID プロバイダー** から「+ ID プロバイダーを追加する」でも同じ一覧に入れる
3. GitHub・Google それぞれの「追加」を押すと、**アプリ ID（Client ID）** と **クライアント シークレット（Client Secret）** の入力欄が出る
4. 事前に外部サービス側でOAuthクライアントを作成し、コールバックURLを次の形式で登録しておく（`<team>` はチームドメインの1段目）:
   ```
   https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
   ```
   - GitHub: `https://github.com/settings/developers` → **New OAuth App**
   - Google: `https://console.cloud.google.com/apis/credentials` → **認証情報を作成 → OAuth クライアント ID**（種類: ウェブ アプリケーション）
5. 取得した Client ID・Client Secret を3の画面へ入力して保存する
6. 保護対象のアプリ（例: `share`）の編集画面 → **ログイン方法** タブを開き、「このアプリケーションで使用可能なIDプロバイダーを選択」へ追加したIdPを足して保存する（追加しただけではどのアプリにも反映されない）

**パスキー/セキュリティキー（WebAuthn）を追加する:**

これは独立したIdPではなく、**MFA（第2要素）の一種**として設定します。

1. Zero Trust → **Access コントロール → Access 設定**
2. 「多要素認証（MFA）を許可する」セクションの **生体認証**（パスキー相当）・**セキュリティキー**（物理キー相当）のトグルをONにする

ここはアカウント全体の設定で、個々のAccessアプリケーション側でIdPのように選択する必要はありません。

## 署名鍵の作成とデプロイ

```bash
html-share keys init
npm run deploy        # content → internal → console の順に3つのWorkerをデプロイ
html-share keys store # 署名鍵を wrangler secret として登録
```

`npm run deploy`（内部で呼ぶ各`deploy:*`）は、`routes`・`vars`が`example.com`のままだったり`ACCESS_AUD`が空のままだったりすると、実際にWorkerへ反映する前に失敗します（`scripts/check-wrangler-config.mjs`。書き換え忘れたまま「成功」扱いになるのを防ぐための機械的な検査）。

## アップロード用R2 APIトークン

CLIの `publish` はcontent・internal両バケットへR2のS3互換APIで直接アップロードします（`visibility`ごとにどちらへ送るか決まります。console資産＝`web/`配下はWorkers Static Assetsとして`wrangler deploy`が配布するため、バケットもCLIアップロードも不要です）。ダッシュボードの **R2 → Manage API Tokens** で **両方のバケット**（または全バケット）への **Object Write** トークン（Read/List/Deleteは不要）を発行し、環境変数に設定します。

`publish` はこのマシンがペアリング済みであることも前提とします（`html-share review pair <code>`。ペアリングコードはオーナーコンソールで発行します）。ページの実体は `pages/<このマシンのdeviceId>/<世代>/<slug>/index.html` として世代ごとに分離され、共有中のURLをpublishが壊すことはありません。

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
