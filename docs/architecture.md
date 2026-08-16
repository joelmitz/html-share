# アーキテクチャ（Cloudflare版）

## 信頼境界

```text
Claude Code / Codex
        │ device token
        ▼
管理面: console.example.com ── Cloudflare Access ── console Worker ── D1 / R2(console)
        │ signed URL
        ▼
閲覧面: content.example.com ── content Worker（署名検証） ── R2(content)
```

管理面にはプロジェクト一覧、インボックス、認証APIだけを置きます。AIが生成したHTMLは閲覧面へ置き、管理面と同一オリジンにしません。この信頼境界はAWS版（本家）と同じです。

## 署名鍵

- RSA秘密鍵：ローカルの `.html-share/keys/private.pem` と console Worker の secret（`SIGNING_PRIVATE_KEY`）
- RSA公開鍵：content Worker の secret（`SIGNING_PUBLIC_KEY`）。閲覧面は検証しかできない
- CLI：短期の共有URLと、ダッシュボード用の本人URLを生成
- 共有URLの形式：`?e=<失効epoch秒>&i=<社内CIDRのbase64url。省略可>&s=<RSA-SHA256署名>`。署名対象は `pathname\ne\ni`
- 社内限定URL：`i` に埋めたCIDRを content Worker が `CF-Connecting-IP` と突き合わせる

CloudFrontの署名URL/署名Cookieの代わりに、Workerが自前で署名を検証します。管理面のログインセッションはCloudflare Accessが持つため、署名Cookieに相当するものはありません。

## 管理面の認証

- `/app/*`・`/review/*`・`/api/owner/*`：Cloudflare Access（One-time PIN等）で保護。console Worker も `Cf-Access-Jwt-Assertion` を独立に検証し、`aud`・発行者・失効・オーナーメール一致を確認する（Access設定ミスへの二重防御）
- `/auth/login`・`/auth/logout`：互換用のリダイレクトのみ（実際の認証はAccessがエッジで行う）
- Cognito・auth Lambda に相当するコードは存在しない

## インボックスと承認依頼

ブラウザ用APIと端末用APIをパスで分けます。

- `/api/owner/*`：Access JWT が必要
- `/api/device/*`：ペアリング済み端末トークンが必要
- `/api/pairings/claim`：10分で失効する一度限りのコードと交換

本人がスマホから置く依頼は `/api/owner/reviews` へ投稿し、宛先を持たない `inbox` セッションへ固定します。ペアリング済みのどのPCからでも取り込み、完了にできます。任意の `target` はプロジェクトの呼び名のヒントで、ファイルパスではありません。取り込む側が依頼文と合わせて作業フォルダを見極めます。

依頼の状態は `waiting` と `completed` の2つだけで、「取り込み済み」を表す状態を持ちません。そのためエージェントは、作業の完了を待たず取り込んだ時点で完了にします。開いたままの依頼が「まだどのPCも拾っていないもの」を意味するようになり、スマホの一覧がそのまま受け渡しの状態を表します。進捗と結果はインボックスではなくチャットで返します。

端末トークンは端末へだけ返し、D1にはSHA-256ハッシュを保存します。DynamoDBのTTLに相当する失効は、読み出し時の除外と遅延削除で行います。

## 閲覧面の表

スマホ幅では、はみ出した表を縦積みのカードへ畳みます。スクリプトはAPIを呼ばないので、閲覧面の `connect-src 'none'` はそのままです。相対パスのJSはCSPで読めないため、配信HTMLへインラインで埋め込みます。
