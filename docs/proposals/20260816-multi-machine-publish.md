# 複数マシンからの publish・inbox race 対応（設計提案 v5）

- 日付: 2026-08-16
- 起草: claude（devvps02）
- 状態: v1(5点)→v2(7点)→v3(6点)→v4(4点。ただし中核方向性は承認)→本書 v5。未実装・レビュー依頼中。

## v3 からの変更点（codex 指摘 6 点への対応サマリ）

| codex指摘(v3) | v4での対応 | 節 |
|---|---|---|
| #1 serveStaticが任意パス配信のためconsoleバケットの残骸が配信され続ける | **consoleバケット自体を廃止**。web資産はWorkers Static Assetsとして`wrangler deploy`に同梱（世代ごと原子的に入れ替わる）。serveStaticは削除 | §5 |
| #2 lock TTLとcleanup実行時間の競合 | **世代方式＋年齢ベースGC**。cleanupは「現行世代以外かつmaximumShareDaysより古い世代」だけを対象にするため、進行中uploadの世代（数分齢）に構造的に触れない。加えてバッチ毎のlock再検証と作業量上限 | §4.4 |
| #3 purgeのTOCTOU | purge自身が同じpublish lockを原子的に取得し、削除完了まで保持する | §7 |
| #4 commitがCLIの自己申告依存 | commit時にWorkerが**新世代prefixをR2 bindingでlist**し、期待キー集合と**サイズ**を照合。不一致は400でD1不変更 | §4.3 |
| #5 ゾンビuploadの内容汚染 | **世代付きobject_key**（`pages/${deviceId}/${gen}/${slug}/`）。各publishは自分の世代にしか書かないため、ゾンビは現行世代を汚染できない | §4.1 |
| #6 href署名の実測完了条件 | 署名対象=D1 object_key一致・revoked deviceの扱い・500件時の応答時間を完了条件に明記 | §6, §11 |
| #7 未決事項の承認 | 破壊的移行と`OWNER_LINK_DAYS`はレビュー提出前にユーザー承認を取得し、本書に承認状況を記録する | §9, §12 |

**世代方式の副次効果（v3からの改善）**: 現行設計では再publishのたびに共有済みURLが即死ぬ懸念があったが、
年齢ベースGCにより**共有URLは署名の有効期間中ずっと生き続ける**（旧世代のオブジェクトは
maximumShareDays経過まで削除されないため）。

## v4 からの変更点（codex 指摘 4 点への対応サマリ）

| codex指摘(v4) | v5での対応 | 節 |
|---|---|---|
| #1 purgeのlease未更新・途中失敗の状態未定義 | purgeに**purging状態機械**を導入: `devices.purging_at` を先に立て、以後この
デバイスのpublish lock取得を拒否（lock失効後の再publish経路を遮断）。バッチ毎lease更新・
作業量上限つきで**再実行可能・冪等**にし、完了時のみ `revoked_at` 設定 | §7 |
| #2 owner pages APIの契約未定義・CLI shareの世代不整合 | `GET /api/owner/pages` のレスポンス形を**現行manifestと同形**で明文化。
CLI shareの**ローカル署名を廃止**し、device認証の `POST /api/device/shares` に統一
（署名主体がWorkerに一本化され、世代不整合が構造的に消滅。`last-publish.json` 案は撤回） | §5.2, §6 |
| #3 サイズのみの検証では内容真正性が無い | commitに**per-pageのmd5**を追加し、R2 listの**etag**（単一パートPutのetag=md5）と照合。
ゼロ追加サブリクエストで内容一致を検証。防げるのは事故（切断・誤バケット・取り違え）で
あり、R2書き込み資格情報の保持者による悪意は**信頼境界の内側**（upstream同様）と明記 | §4.3 |
| #4 Static Assets移行の切替・ロールバック手順不足 | **2段階移行**を定義: Phase A（assetsデプロイ+検証ゲート5項目、console R2は温存
=ロールバック可能）→ 安定確認後に Phase B（旧資産の削除）。各ゲートを完了条件化 | §5.1 |

## 1. 背景（不変）

devvps02とWSLが別々の`content.pages`を持つ状態で`publish`し合い、後発が先発のR2オブジェクトを
削除する事故が発生した（`emptyBucket()`後にローカル認識のみで再構築する設計のため）。応急復旧済み。

## 2. ゴール／非ゴール

- ゴール: 各マシンは自分の担当ページだけを把握。他マシンへの不干渉。自分の削除の正しい反映。
  slug衝突の構造的防止。並行・途中失敗・ゾンビ再開のどの場合too見える状態が壊れないこと。
  共有済みURLが署名有効期間中に publish 起因で死なないこと。
- 非ゴール: config同期。他マシンのページ操作（purgeは孤児掃除として例外）。

## 3. 名前空間キー＝ペアリング済みデバイスID（v2から不変）

`devices.id`（端末トークンのSHA-256、構造的に一意）を名前空間キーに使う。CLIは
`sha256(deviceToken)`でローカル導出。publishはペアリング済みが前提条件。
`review-client.ts`の既存のapiBase整合検証をpublishにも適用。

## 4. publish のフロー（v4の中核）

### 4.1 世代付き objectKey

- objectKey: **`pages/${deviceId}/${gen}/${slug}/index.html`**
- `gen` は **lock取得時にWorkerが発行**する世代ID。形式は `<epoch秒>-<乱数8バイトhex>`
  （先頭に生成時刻を含み、§4.4の年齢判定に使う）。lock行に保存され、commitでは
  **サーバー側のlock行から読む**（クライアント指定値は使わない）。
- lockのtokenとgenは別の値にする。object_keyは署名URLを通じて第三者の目に触れるため、
  bearerであるtokenを埋め込まない。
- 各publishは自分のgen配下にしか書かない。**ゾンビプロセスが再開しても書き先は自分の
  （古い）gen**であり、現行世代・進行中の新世代を汚染する経路が存在しない（codex #5）。

### 4.2 ロック

```sql
CREATE TABLE publish_locks (
  device_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  gen TEXT NOT NULL,
  expires_at INTEGER NOT NULL   -- epoch秒。TTL 30分
);
```

- `POST /api/device/publish/lock`: 条件付きUPSERT（行なし or 失効時のみ）。
  応答 `{ token, gen, expiresAt }`。取得不可なら409。
- `POST /api/device/publish/renew`: `UPDATE ... SET expires_at=? WHERE device_id=? AND token=?`。
  CLIはアップロードがN件（例:50ファイル）を超えるごとに延長する。
- CLIはS3 APIで `pages/${deviceId}/${gen}/` 配下へ全量アップロード（削除操作なし。
  R2トークンは書き込み用途のみに使われる）。

### 4.3 commit（アップロード検証つき・v4 codex #4/#3）

`POST /api/device/publish/commit { lockToken, pages: [{slug, title, source, repository,
stream, streamLabel, date, bytes, md5}] }`

Worker内の処理（この順）:

1. lock検証（device_id・token一致・未失効）。失敗は409
2. 入力検証（v3 §4.3と同じ: slug形式/一意/長さ・各フィールド長・件数≤500・body≤1MiB。
   `md5` は32桁hex必須）
3. **アップロード検証**: `env.CONTENT.list({ prefix: "pages/${deviceId}/${gen}/" })` で
   実在キー・サイズ・**etag**を取得し、期待集合（`gen`と各slugから導出したキー + 申告
   `bytes` + 申告`md5`）と照合。R2のS3 API単一パートPutObjectのetagはコンテンツのmd5で
   あるため、**追加サブリクエストゼロで内容一致まで検証できる**。CLIのアップロードは
   常に単一パート（ページHTMLは1MiB上限未満）とし、etagがmd5形式でない場合も400。
   欠落・サイズ不一致・md5不一致は **400でD1不変更**
4. D1トランザクション: `DELETE FROM pages WHERE device_id=?` → 新行INSERT
   （object_keyはサーバーが`gen`から導出）
5. §4.4のGC（作業量上限つき）
6. lock解放

3〜4の間に見える状態は常に「直前の成功状態」、4以降は「新状態」。部分状態を経由しない。

**信頼境界（明記・v4 codex #3）**: この検証が防ぐのは**事故**（切断アップロード・誤バケット・
別ファイルの取り違え・並行プロセスの残骸）である。R2書き込み資格情報の保持者が悪意を
持って正しいmd5と共に偽内容を置く攻撃は防がない——これはupstream（CLIがバケット全権を
持つ）から変わらない信頼境界であり、本設計の非ゴールである。同様に、commit後に資格情報
保持者が現行世代オブジェクトを直接上書きする攻撃も同じ境界の内側にある。

### 4.4 世代GC（codex #2）

削除対象: `pages/${deviceId}/` 配下のうち、**(a) 現行世代（D1が参照するgen）ではなく、
かつ (b) gen IDの時刻部が `maximumShareDays`（サーバー側は`MAXIMUM_SHARE_DAYS` var）より
古い**世代のオブジェクトのみ。

- (b)により、進行中・直近のアップロード世代（高々数十分齢）は**年齢条件だけで構造的に
  対象外**。ゾンビのGCが並行publishの新世代を消す経路がない
- (a)により、1ヶ月以上publishしていないデバイスの現行世代も守られる
- 共有済みURL（旧世代を指す）は署名有効期間が尽きるまで配信可能なまま残る
- 実装: list（ページングループ）→ 対象keyを最大1000件ずつ `bucket.delete(keys)`。
  **1回のcommitでのGCサブリクエスト数に上限**（list+delete合計で~50）を設け、残りは
  次回publishへ繰り越す（fail-closed: 上限到達は正常終了であり、孤児は無署名では
  配信されないため実害がない）
- 各deleteバッチの直前にlock行（token）とD1現行genを再読して不変を確認、変化していれば
  GCを中断する（年齢条件で既に安全だが、多重の防御として）

### 4.5 storage影響

世代方式により、publishごとにそのデバイスの全ページの複製が最大`maximumShareDays`分
蓄積する。HTMLページ（数十KB/件）×上限500件×高頻度publishでも実用上軽微と判断する
（1日10回publish×30日×500件×50KB ≈ 7.5GB が理論上限。実運用は2〜3桁下）。

## 5. console 資産の Worker 同梱化（codex #1）

**consoleバケットを廃止する。** v3までのconsole資産（web/のHTML/JS/CSS/アイコン）は、
静的manifest.jsonの廃止（v3）により「リポジトリが変わったときだけ変わる純粋なアプリ資産」に
なった。これはpublishで配るものではなく、Workerのデプロイに属する。

- `workers/console/wrangler.jsonc` に `assets: { directory: "../../web", binding: "ASSETS",
  run_worker_first: true }` を追加。`wrangler deploy` が資産を**世代ごと原子的に**入れ替える
- Workerの静的配信は `env.ASSETS.fetch(request)` へ委譲する。`serveStatic()`・R2 CONSOLE
  binding・`copyConsole()`（app.webmanifest生成含む。webmanifestはリポジトリに直接置く）は削除
- **認証境界は維持**: `run_worker_first` によりWorkerが先に実行されるため、`/app/*`・
  `/review/*` のAccess JWT検証は現行どおりWorkerで行い、通過後にASSETSへ委譲する
- 残骸配信の問題は消滅する: 旧デプロイの資産はデプロイ切替で不可達になる（プラットフォーム
  保証）。R2に「配信されうる古いファイル」という概念自体が無くなる
- publishの権限・手順も縮小: R2 APIトークンはcontentバケットのみ、consoleアップロードの
  コードパスは削除

### 5.1 移行手順とロールバック（v4 codex #4）

**Phase A（切替。console R2は温存）**:

1. assets設定込みのWorkerをデプロイ（`wrangler versions`で旧版へ即時rollback可能。
   console R2バケットとその内容はこの段階では一切触らない＝R2側のロールバック考慮は不要）
2. 検証ゲート（全通過するまでPhase Bに進まない。§11-10/11に対応）:
   - (a) 未認証 `/app/index.html`・`/review/index.html` が引き続き302（Access）/401になる
   - (b) 認証済みリクエストがASSETS経由で200・正しいcontent-typeを得る（workerd＋本番実測）
   - (c) `GET /api/owner/pages` がページ一覧を返し、ダッシュボードが表示される（本番実測）
   - (d) `rg` で旧console参照（CONSOLE binding・serveStatic・copyConsole・manifest.json）ゼロ
   - (e) assetsデプロイ成果物（web/）に `manifest.json`・ビルド中間物が混入していない
     （web/はリポジトリ管理の静的ファイルのみで構成され、ビルド出力は `.html-share/` 配下
     ＝web/の外、という構造で保証。CIで `git status --short web/` clean を確認）
3. 問題発生時のロールバック: `wrangler rollback`（または直前版の再デプロイ）のみで完結。
   console R2が温存されているため旧Workerはそのまま動く

**Phase B（Phase A安定確認後の別段階。破壊的・§9の承認済み事項）**:

4. consoleバケット削除・旧フラットkeyオブジェクト削除・旧`app/manifest.json`削除
5. Phase B実施後は旧Workerへのロールバック不能になる（承認済みの破壊的変更の一部として
   ユーザーへ明示してから実施する）

### 5.2 `GET /api/owner/pages` の契約（v4 codex #2）

レスポンスは**現行 `app/manifest.json` と同形**にし、クライアント改修を最小化する:

```json
{
  "generatedAt": "<応答生成時刻ISO8601>",
  "pages": [
    {
      "slug": "...", "title": "...", "source": "...",
      "repository": "...", "stream": "...", "streamLabel": "...",
      "date": "...", "updatedAt": "...",
      "objectKey": "pages/<deviceId>/<gen>/<slug>/index.html",
      "href": "<応答時にOWNER_LINK_DAYSで署名した完全URL>",
      "deviceId": "...", "deviceName": "..."
    }
  ]
}
```

- 既存フィールド名は現行manifestの `BuiltPage` と同一。`deviceId`/`deviceName` のみ追加
  （共有ダイアログの§6呼び出しと管理表示に使用）
- ソート: `date` 降順（現行クライアントのソートロジックを変えない）
- 空一覧は `{ generatedAt, pages: [] }`（200）。Access未認証はエッジで302/401（現行どおり）
- クライアント置換手順:
  - `web/app/index.html`: `fetch('manifest.json')` → `fetch('/api/owner/pages',
    { cache: 'no-store' })`。以降の `data.pages` 利用コードは無変更で動く
  - `web/mobile-page-shell.js`: `/app/manifest.json` → `/api/owner/pages`（同様）
  - 失敗時は既存のエラーハンドリング（「一覧の読み込みに失敗しました」）へ接続

## 6. shares・href（v4から変更: CLI署名の廃止・codex #2）

- `POST /api/owner/shares { deviceId, slug, scope, days }`: D1の`pages`行から`object_key`を
  引いて署名（v4どおり。クライアント指定パスは署名しない）
- **`POST /api/device/shares { slug, scope, days }` を新設**: 端末トークン認証。Workerが
  `(認証済みdeviceId, slug)` でD1から現行行を引いて署名する。CLI `share` コマンドはこれを
  呼ぶ形に変更し、**ローカル秘密鍵署名を廃止**する
  - 署名主体がWorkerに一本化され、v4の「CLIのlast-publish.jsonのgenとD1現行genの不整合で
    同一slugに異なる世代を署名しうる」問題が構造的に消滅する（last-publish.json案は撤回）
  - `maximumShareDays` の強制もサーバー側（`MAXIMUM_SHARE_DAYS` var）に一本化。CLI configの
    同名値はクライアント側の事前チェックのみに残す（権威はサーバー）
  - CLIのローカル秘密鍵の用途は消滅する。`keys init`/`keys store` は「Workerのsecretを
    プロビジョニングする手段」として残る（鍵ペアの生成場所・登録フローは不変）。
    オフラインでのshare発行はできなくなるが、publish自体が要ネットワークなので
    実質的な後退はない
- `GET /api/owner/pages` のhrefオンザフライ署名（`OWNER_LINK_DAYS` var）はv4どおり。
  **完了条件**: 署名対象パス=D1のobject_keyであることのassert、500件時の応答時間の
  実測（workerdテストでスモーク上限を設ける）、revoked deviceのページは
  purge（§7）で行ごと消えるため一覧に出ない——「revokeされたがpurgeされていない」状態は
  API上作らない（purgeがrevokeを兼ねる）ことを仕様として明記

## 7. purge（v4 codex #1: 状態機械・lease更新・再実行可能）

`devices` に `purging_at TEXT` カラムを追加し、purgeを**再実行可能な状態機械**にする。

状態遷移: `active（purging_at=NULL, revoked_at=NULL）→ purging（purging_at≠NULL）→
revoked（revoked_at≠NULL）`。逆遷移は無い。

`POST /api/owner/devices/:id/purge` の1回の呼び出し:

1. 対象デバイスのpublish lockを取得（取得不可なら409。既に`purging`状態の再実行では
   失効済みlockを通常ルールで奪取できる）
2. **最初に `purging_at` を設定**（冪等: 設定済みならそのまま）。
   **`purging_at` が立っているデバイスは `POST /api/device/publish/lock` を403で拒否**する。
   これにより「R2削除が途中失敗→lock失効→再publish」という経路が遮断される
   （v4の指摘した『pagesは消えたのにdeviceは未revokeで再publishできる』状態が無くなる）
3. D1 `pages` 行削除（冪等）
4. `pages/${id}/` 配下をlist→バッチ削除。**バッチ毎にlock leaseを延長**し（publishの
   renewと同じUPDATE）、**1呼び出しの作業量上限**（サブリクエスト~50）に達したら
   `{ done: false, remaining: <概数> }` の202で返して中断する（fail-closed）。
   呼び出し側（curl手順）は `done: true` になるまで再実行する
5. listが空になったら `revoked_at` を設定し `purging_at` はそのまま残す（履歴として）。
   lock解放。`{ done: true }` の200

- 途中失敗（R2障害・Worker中断）时: デバイスは`purging`のまま＝publish不能のまま。
  再実行で続きから削除される（削除は冪等）。「pagesが消えたのに再publishできる」
  中間状態は存在しない
- publish lock取得側の変更: lockエンドポイントは `purging_at IS NULL` を取得条件に加える
- `GET /api/owner/devices` は `purging_at`/`revoked_at` を含めて返し、curl手順書で
  再実行の要否を判断できるようにする

## 8. inbox claim（v3から不変）

claim（`waiting→in_progress`の原子取得・409）、completeの所有者条件、
`web/review/index.html`のin_progress表示（作業中バッジ+デバイス名）、owner削除優先、
`skills/inbox/SKILL.md`のclaimフロー改訂——すべてv3 §8のとおり。

## 9. 破壊的変更と移行（承認事項）

- 既存フラットkeyの共有URLは無効になる。現在の公開ページ（社内向け一時ページのみ）は
  実装後に各デバイスから再publishする
- 旧フラットkeyオブジェクト・旧`app/manifest.json`・consoleバケット自体を手動で削除する
- `OWNER_LINK_DAYS` 既定値は30日
- **承認状況**: 2026-08-16、じょえるさんが承認済み（AskUserQuestion。破壊的移行=承認、
  `OWNER_LINK_DAYS`=30日）。設計上の未決事項は本書に残っていない。

## 10. 実装への影響ファイル

- `workers/console/migrations/0002_pages.sql`: `pages`・`publish_locks`・
  `devices.purging_at` 追加、tasksのstatusコメント
- `workers/console/wrangler.jsonc`: assets設定・CONSOLE binding削除・`OWNER_LINK_DAYS`
- `workers/console/src/index.ts`: lock/renew/commit・GC・owner pages/devices/purge・
  shares契約変更・claim・serveStatic削除→ASSETS委譲
- `src/publish.ts`: lock→upload(gen prefix)→renew→commitフロー。削除系・console系コードの撤去
- `src/bundle.ts`: objectKey導出の変更（deviceId/genはpublish時に注入）
- `src/review-client.ts`: deviceId導出・publish系APIヘルパー
- `src/cli.ts`: shareコマンドを `POST /api/device/shares` 呼び出しへ変更（§6）。
  `src/sign.ts` のCLI署名コードは削除（署名主体はWorkerに一本化。sign相当のロジックは
  Worker側の既存実装のみになる）
- `web/app/index.html`・`web/mobile-page-shell.js`・`web/review/index.html`: v3どおり
- `web/app.webmanifest`: リポジトリへ静的に追加（copyConsole生成をやめる）
- `skills/inbox/SKILL.md`・`docs/setup.md`・`docs/architecture.md`
- 既存テスト更新＋§11

## 11. 完了条件テスト

1. 2デバイス同時commitの相互不干渉（workerd+実D1）
2. lock: 保持中の2本目409／renew成功／失効後のゾンビcommitがtoken不一致で409
3. **ゾンビupload**: 失効した旧gen宛のuploadが現行世代の配信内容に影響しないこと
   （旧genへ書いた後、現行URLの内容が不変であることを実測）
4. commit検証: 期待キー欠落・サイズ不一致・**md5(etag)不一致**・etagがmd5形式でない
   （多パート混入）で400、D1不変更
5. GC: 現行世代と若い世代が削除されないこと／maximumShareDays超の非現行世代が削除される
   こと／GC上限到達時に正常終了し次回へ繰り越すこと
6. purge: publish lock保持中のpurgeが409／**purging中のpublish lock取得が403**／
   途中失敗→再実行で完遂し冪等であること／purging中間状態から再publishできないこと／
   purge後（revoked）に一覧・配信から消えること
7. shares(owner): 不在(deviceId,slug)で404／署名対象=D1 object_key一致のassert。
   **shares(device)**: 自デバイスの現行行だけが署名されること／未pair端末は401
8. `GET /api/owner/pages`: 契約形（§5.2のフィールド集合）のassert／hrefがcontent workerで
   実際に200になること／500件時の応答時間スモーク
9. claim系: 同時claim片方409／他デバイスcomplete拒否／owner削除後complete失敗
10. assets Phase A検証ゲート: `/app/*`未認証が引き続き401/302（run_worker_first検証）／
    認証済み200＋正しいcontent-type／web/にビルド中間物が混入しないことのCI検査
11. 旧manifest参照ゼロ・旧shares契約ゼロ・旧consoleバケット参照ゼロ・CLI署名コード残存ゼロ（rg）

## 12. 未決事項

（§9の承認のみ。設計上の未決は残していない）
