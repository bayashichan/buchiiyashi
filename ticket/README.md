# 抽選式オンライン整理券システム

当日の会場前に行列をつくらないための、事前申込・抽選・整理券配信のしくみ。

- 申込ページ … `/ticket/`
- 整理券ページ … `/ticket/my/`
- 管理画面 … `/admin/tickets/`
- API・抽選エンジン … `worker/src/tickets.js`
- データベース定義 … `worker/schema/tickets.sql`

## 設計の考え方

**抽選するのは「人」ではなく「申込」。** 1件の申込 = 1グループとして扱い、当たった
グループには人数分の連番をまとめて確保する。人単位でシャッフルすると家族の番号が
必ずバラバラになるため、ここは分割しない。

**番号だけでなく集合時刻を配る。** 番号だけを配ると全員が開場前に集まるので行列は
残る。番号レンジごとに集合時刻を紐づけて、来場そのものを時間で分散させる。

**券は「LINEに届いた1通」で完結する。** アプリを入れない・ログインしない・QRを
読ませない。受付は画面を見せてもらい、番号と姓を目視で確認するだけ。読み取り機材は
使わない（電波が悪いと止まり、それ自体が行列の原因になる）。

## 初期セットアップ

### 1. データベースを作る

> **順番が大事。** `wrangler.toml` の `database_id` がプレースホルダのままだと
> Worker のデプロイが失敗する。**D1を作って database_id を書き込むまで、この
> ブランチを main にマージしないこと。**（デプロイが失敗しても現在動いている
> Worker はそのまま動き続けるので、出展申込フォームが止まることはない。ただし
> 以後どんな変更もデプロイされなくなる。）

#### 1-1. 手元にリポジトリを用意する

```bash
git clone https://github.com/bayashichan/buchiiyashi.git
cd buchiiyashi
git checkout claude/modest-bell-wd8gl6
cd worker
```

#### 1-2. Cloudflareにログインする

```bash
npx wrangler login          # ブラウザが開くので許可する
npx wrangler whoami         # 目的のアカウントか確認する
```

#### 1-3. データベースを作る

```bash
npx wrangler d1 create buchiiyashi-tickets
```

次のような出力が返る。

```
✅ Successfully created DB 'buchiiyashi-tickets'

[[d1_databases]]
binding = "DB"
database_name = "buchiiyashi-tickets"
database_id = "12345678-90ab-cdef-1234-567890abcdef"
```

#### 1-4. database_id を書き込む

`worker/wrangler.toml` の `PLACEHOLDER_RUN_WRANGLER_D1_CREATE` を、出力された
`database_id` と差し替える。

```toml
[[d1_databases]]
binding = "TICKETS_DB"                                    # ← 変えない
database_name = "buchiiyashi-tickets"
database_id = "12345678-90ab-cdef-1234-567890abcdef"      # ← ここだけ差し替える
```

`binding` は `TICKETS_DB` のままにすること。出力例の `DB` に合わせると
コードから見つけられなくなる。`database_id` は秘密の値ではないので、
公開リポジトリにそのままコミットしてよい（操作にはAPIトークンが必要）。

#### 1-5. テーブルを作る

```bash
npx wrangler d1 execute buchiiyashi-tickets --remote --file=./schema/tickets.sql
```

**`--remote` を必ず付けること。** 付けないと手元のシミュレータにテーブルが
作られるだけで、本番のデータベースには何も起きない。実行の前に確認を求められたら
`y` で進める。

#### 1-6. 第6回の券種を入れる

```bash
npx wrangler d1 execute buchiiyashi-tickets --remote --file=./schema/seed-6th.sql
```

日時・番号・人数・文面はあとから管理画面で変更できる。このファイルは
`INSERT OR IGNORE` なので、二度実行しても既存の設定を上書きしない。

#### 1-7. 入ったことを確認する

```bash
npx wrangler d1 execute buchiiyashi-tickets --remote \
  --command="SELECT id, name, apply_start, apply_end, number_start, number_end, capacity_mode FROM ticket_types"
```

`入場整理券` と `講演会整理券` の2行が返れば成功。

### 2. LIFFアプリを作る

LINE Developers コンソールで、整理券専用のLIFFアプリを新規作成する。

| 項目 | 値 |
| --- | --- |
| エンドポイントURL | `https://buchiiyashifestatokyo.com/ticket/` |
| サイズ | Full |
| スコープ | `profile` |

発行されたLIFF IDを `ticket/config.json` の `liffId` に設定する。

出展申込のLIFFアプリとは**別に作ること**。LIFFのログイン後のリダイレクト先は
エンドポイントURL配下に限られるため、既存のIDを流用すると `/ticket/` で
ログインできない。`/ticket/my/` は `/ticket/` の配下なので同じIDで動く。

### 3. Workerをデプロイする

`database_id` を書き込んだ `wrangler.toml` をコミットして push し、main に
マージする。`worker/` 配下が変わると GitHub Actions が自動でデプロイする。

```bash
git add wrangler.toml
git commit -m "D1のdatabase_idを設定する"
git push
```

`LINE_CHANNEL_ACCESS_TOKEN` は設定済みのものをそのまま使う（整理券の配信にも
このトークンを使う）。新しく登録が必要なシークレットはない。

デプロイ後、APIが繋がったことを確認する。

```bash
curl https://buchiiyashi-festa-form.wakaossan2001.workers.dev/api/tickets/types
```

券種2件がJSONで返れば、WorkerとD1が繋がっている。
`TICKETS_DB が未設定です` が返る場合は、`database_id` か `binding` を見直す。

### 4. 動作を確認する

1. `/admin/tickets/` を開き、券種の設定を確認する
2. スマートフォンの公式LINEから `/ticket/` を開き、自分で1件申し込む
3. LINEに受付の通知が届くことを確認する
4. 管理画面の「抽選と配信」で抽選を実行し、整理券が届くことを確認する
5. 「やり直す（番号を破棄）」で元に戻す

本番の申込を受け付ける前に、テストで入れた申込は削除しておくこと。管理画面には
申込を消す機能を置いていない（運用中に誤って押すと取り返しがつかないため）。
テストデータの削除は手元から実行する。

```bash
npx wrangler d1 execute buchiiyashi-tickets --remote --command="
  DELETE FROM tickets;
  DELETE FROM applications;
  DELETE FROM lottery_runs;
  UPDATE ticket_types SET lottery_status='pending', lottery_seed=NULL, lottery_done_at=NULL;
"
```

申込がすべて消え、券種は抽選前の状態に戻る。券種の設定と文面は残る。

## 運用の流れ

| 場面 | 誰が | 何をするか |
| --- | --- | --- |
| 申込期間 | 来場者 | 公式LINEから `/ticket/` で申し込む。受付の通知が自動で届く |
| 抽選日時 | 自動 | 設定した時刻を過ぎると、5分以内にcronが抽選して結果を配信する |
| 抽選後 | 主催者 | 管理画面で未達の件数を確認し、必要なら「未達の人に再送する」 |
| 前日 | 自動 | リマインド送信日時を過ぎると、当選者に整理券を再送する |
| 当日 | 受付 | 画面を見せてもらい、番号と姓を確認して通す |
| 当日 | 窓口 | 券が見つからない方は「当日受付」タブで姓・電話下4桁などから探す |

### 当日の受付で決めておくこと

- **呼び出しは番号順ではなく時間帯順。** 集合時刻の枠ごとに呼ぶ
- **時刻を過ぎた方の扱い。** その枠の最後に通す、を既定の運用にしておく
- **当日枠。** 落選者と未申込の方向けに、講演会は開演10分前に空席分だけ案内する。
  それ以外の時間は並ばせない（当日枠の列ができては本末転倒になる）
- **「お困りの方」窓口を受付列とは別に置く。** ここを分けないと、券が見つからない
  1人のために受付列全体が止まる

## 抽選の公平性について

抽選にはシード値を使っている。同じシード値なら何度実行しても同じ結果になるため、
実行後にシード値と申込の一覧を公開すれば、第三者が結果を再現して検証できる。

シード値は管理画面の「抽選と配信」タブに記録されている。抽選のやり直しを求められた
ときに、ゼロコストで説明できる材料になる。

## 気をつける点

**番号範囲は定員より多めに。** 事前申込型の来場率は7〜8割。入場定員400名に対して
番号を400までしか出さないと、当日は300名台の入りになる。

**全員当選の券種は番号範囲を超えて発行する。** 「全員当選」の約束を番号設定の都合で
破らないため。超えた場合は管理画面に警告が出るので、番号範囲を広げること。

**LINEの配信は従量課金。** 当選通知・リマインドで申込者数×2通ほど必要になる。
プランの上限を先に確認しておくこと。券面をLIFFページで見せているのは、通数を
増やさずに何度でも確認してもらうため。

**抽選のやり直しは番号を破棄する。** すでに当選をお知らせした方の番号が変わるため、
配信後のやり直しは原則行わない。

## 開発

抽選の番号割り当てにはテストがある。デプロイ前に GitHub Actions でも実行される。

```bash
node --test "worker/test/**/*.test.mjs"
```

番号の重複・欠番・グループの分割は、当日そのまま受付の事故になる。
`planAssignment` を変更したときは必ずテストを通すこと。
