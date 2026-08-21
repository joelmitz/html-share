# HTML共有くん（Cloudflare版）

> [!NOTE]
> これは [minorun365/html-share](https://github.com/minorun365/html-share)（AWS版）のforkで、実行基盤をCloudflare（Workers / R2 / D1 / Access）へ置き換えたものです。CLI・スキル・使い方は本家と同じです。

HTML共有くんは、AIコーディングエージェントに作らせたHTMLを1か所へためて、スマホからも読めるようにするツールです。自分のCloudflareアカウントで動かすセルフホスト型で、作者へページや回答が送られることはありません。

<p align="center">
  <img src="docs/images/dashboard.png" alt="HTML共有くんのメインダッシュボード" width="66%">
  &nbsp;
  <img src="docs/images/mobile-approval-actions-native.png" alt="AIから届いた承認依頼をスマホで確認" width="31%">
</p>

## 主な機能

- メモや調査結果を見やすいHTMLに整える
- 作ったHTMLを自分専用の一覧にためる
- 社内限定や期限付きのURLで共有する
- 外部共有する予定のないページは、Cloudflare Access限定の閲覧面（`share-internal`）へ置く（既定はこちら。`--public`を明示したページだけ署名URLで外部共有できる）
- スマホとPCの間で依頼や承認をやり取りする

## 対応エージェント

中身はCLIとスキルなので、Claude Code、Codex、Cursorなど手元のどのエージェントからでも同じように呼び出せます。

## スマホとの連携

- 思いついた作業は、スマホのインボックスへ置いておける。戻って `/inbox` と頼めばエージェントが引き取る
- 逆向きの `/mobile` は、PCの確認依頼をスマホへ送る。外出先で返した承認やコメントはPC側へ引き継がれる

> [!NOTE]
> Claude Codeのリモートコントロールとは仕組みが違います。あちらは母艦のPCでセッションを起動したままにしておく必要がありますが、共有くんのやり取りは非同期です。作業をスマホへ送ったあとはPCの電源を切ってよく、外出先で返した回答は、次にPCを開いたときに続きとして取り込めます。

## 頼み方の例

セットアップが済んだあとは、いつもどおりエージェントへ日本語で頼みます。コマンドは覚えなくてOKです。

> このHTMLを共有くんに追加して

> このページを社内限定で7日間共有して

> `/inbox` で、スマホから置いた依頼を引き取って

## セットアップ

導入方法は [初回セットアップ](docs/setup.md) にまとめています。公開前に確認したい仕組みは [セキュリティ設計](docs/threat-model.md) を参照してください。

## ライセンス

Apache License 2.0
