# SNS一括投稿（Instagram / Facebook）の設定手順

管理者専用ページ **`https://（サイトのドメイン）/admin/sns/`** から、
出展者の画像とキャプションを Instagram・Facebook へワンタッチで投稿できます。
即時投稿と日時指定（予約投稿）に対応し、複数人をまとめて処理できます。

複数選択したときの投稿のしかたは2通りから選べます。

| 投稿の形式 | 内容 |
| --- | --- |
| 一人ずつ個別に投稿 | 出展者1人につき1投稿。日時をずらして順番に流せます |
| まとめて1投稿（複数画像） | 選んだ全員の画像を1件の投稿にまとめます（Instagramはカルーセル、Facebookは複数写真）。本文は各自のキャプションをつないだものが自動で入り、その場で編集できます。画像の並び順も ←→ で入れ替えられます |

まとめ投稿の上限は **Instagram 10枚** です（Metaの仕様）。10枚を超える場合は投稿前にエラーになります。

このページは管理画面と同じパスワードで保護されています（管理画面のヘッダーからも移動できます）。

---

## 1. 用意するもの

| 必要なもの | 説明 |
| --- | --- |
| Facebookページ | 投稿先のページ。個人アカウントには投稿できません |
| Instagramプロアカウント | 「ビジネス」または「クリエイター」。上のFacebookページと連携済みであること |
| Meta（Facebook）開発者アプリ | Graph APIを使うためのアプリ |

Instagramの投稿はMetaの仕様上、**プロアカウント＋Facebookページ連携**が必須です。
（Instagram → 設定 → アカウントの種類とツール → プロアカウントに切り替え → Facebookページとリンク）

---

## 2. アクセストークンなどを取得する

1. <https://developers.facebook.com/apps/> でアプリを作成（種類は「ビジネス」）。
2. 「ツール」→「グラフAPIエクスプローラ」を開く。
3. 右上でアプリを選び、**ユーザーまたはページ** で対象のFacebookページを選択。
4. 次の権限（アクセス許可）を追加して「アクセストークンを生成」:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management`
5. 生成されたトークンは短期（数時間）なので、**長期トークンに変換**します。
   「アクセストークンデバッガ」（<https://developers.facebook.com/tools/debug/accesstoken/>）に貼り付け
   →「アクセストークンを延長」→ 表示された長期トークンを控える。
   ※ページアクセストークンは、長期のユーザートークンから取得すると無期限になります。

### 必要なIDの調べ方

グラフAPIエクスプローラで以下を実行します。

- **FacebookページID**
  `GET /me/accounts` → 対象ページの `id`
- **InstagramビジネスアカウントID**
  `GET /{ページID}?fields=instagram_business_account` → `instagram_business_account.id`

---

## 3. Cloudflare Workers に登録する

Cloudflareダッシュボード →
**Workers & Pages → buchiiyashi-festa-form → 設定 → 変数とシークレット** で、
以下を **シークレット（暗号化）** として追加します。

| 変数名 | 内容 |
| --- | --- |
| `FB_PAGE_ID` | 投稿先FacebookページのID |
| `FB_PAGE_ACCESS_TOKEN` | 長期のページアクセストークン |
| `IG_USER_ID` | InstagramビジネスアカウントのID |
| `IG_ACCESS_TOKEN` | 省略可。未設定なら `FB_PAGE_ACCESS_TOKEN` を使います |

コマンドで登録する場合:

```bash
cd worker
npx wrangler secret put FB_PAGE_ID
npx wrangler secret put FB_PAGE_ACCESS_TOKEN
npx wrangler secret put IG_USER_ID
```

登録後、`/admin/sns/` の「接続テスト」ボタンで確認できます。
ページ名とInstagramのユーザー名が表示されれば設定完了です。

> ⚠️ トークンは絶対にGitHubへ書かないでください（このリポジトリは公開されています）。

---

## 4. 予約投稿の仕組み

- 予約は Cloudflare R2（`buchiiyashi-images` バケットの `social/jobs/` 配下）に保存されます。
- Worker の Cron Trigger が **5分ごと** に予約時刻を過ぎた投稿を実行します。
  そのため、指定時刻から最大5分ほど遅れて投稿されます。
- 1回のチェックで処理するのは **3件まで** です（Workerの1リクエストあたりの外部呼び出し数の上限に合わせています）。
  同じ時刻に大量に予約すると順番に処理され、5分ごとに3件ずつ投稿されます。
  まとめて投稿したいときは、投稿画面の「◯分ずつずらす」で間隔を空けてください。
  上限を変える場合は Worker の環境変数 `SOCIAL_MAX_JOBS_PER_TICK` を設定します。
- 予約は `/admin/sns/` の「予約一覧」からいつでも取り消せます。
- Cronを待たずに実行したいときは「予約分を今すぐ実行」ボタンを押してください。

Cron Trigger は `worker/wrangler.toml` の `[triggers]` で設定しています。
GitHub Actions（`.github/workflows/deploy-worker.yml`）で `worker/` を変更すると自動デプロイされ、
Cronもあわせて登録されます。

---

## 5. 画像について

- 投稿画像は、管理画面の「画像生成」で作られ Google Drive に保存された画像を使います。
  参照先フォルダは管理画面の「基本設定 → 確認ページ参照フォルダ」で指定します。
- **InstagramはJPEG画像しか受け付けません。** 生成画像はPNGのため、Workerが自動でJPEGに変換します
  （Googleの画像配信でJPEG取得 → 失敗時はGAS側で変換）。
  GAS側の変換を使うには、管理画面の「デプロイ → GASスクリプト」で最新のスクリプトを反映してください。
- 変換した画像はR2にコピーされ、その公開URLをMetaに渡しています。

---

## 6. よくあるエラー

| メッセージ | 原因と対処 |
| --- | --- |
| `FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN が未設定です` | 手順3の登録がまだ、またはデプロイ前 |
| `[code 190] ...` | アクセストークンの期限切れ・失効。手順2で取り直す |
| `[code 200] ...` | 権限不足。手順2の権限をすべて付けてトークンを取り直す |
| `InstagramはJPEG画像のみ投稿できます` | 画像がJPEGに変換できていない。GASを最新にデプロイする |
| `画像を取得できませんでした` | Drive画像の共有設定が「リンクを知っている全員」になっていない |
| `Instagramの画像処理がタイムアウトしました` | 画像サイズが大きすぎる可能性。生成し直して再投稿 |

Instagramには **24時間あたり50投稿** の上限があります。大量投稿は日時をずらして予約するか、
「まとめて1投稿」を使ってください（まとめ投稿は何人分でも1投稿として数えられます）。
