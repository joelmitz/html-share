# Security Policy

## Reporting a vulnerability

セキュリティ上の問題を見つけた場合は、公開Issueへ認証情報、共有URL、個人情報、再現用の実データを書かないでください。

GitHubのSecurity Advisoriesから非公開で報告してください。

https://github.com/joelmitz/html-share/security/advisories/new

受領から7日以内に一次回答を行い、影響範囲と修正方針を連絡します。修正が公開されるまで、脆弱性の詳細な公開は控えてください。

## Supported versions

正式リリース後は、最新のマイナーバージョンだけをサポートします。`0.x` は公開前評価版として扱います。

## Deployment responsibility

HTML共有くんはセルフホスト型です。Cloudflareアカウント、ドメイン、認証ユーザー、配信するコンテンツ、共有URLの管理は各利用者が行います。

本番依存関係は `npm run audit:prod` で検査します。wranglerはローカルでデプロイに使う開発依存として分離しています。
