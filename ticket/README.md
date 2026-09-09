# 抽選式オンライン整理券システム

当日の会場前に行列をつくらないための、事前申込・抽選・整理券配信のしくみ。

- 整理券ページ … `/ticket/`（申込と表示を兼ねる。リンクはこれ1つだけ）
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

**リンクは1つだけ。** `/ticket/` を開いた人の状況で中身が変わる。まだ申し込んで
いなければ申込フォーム、申込済みで抽選前なら受付内容といつ抽選するか、当選後なら
整理券そのもの。「申込用」と「表示用」を分けると、当日「どっちを押すのか」で
必ず詰まる。券種ごとに状態が違えば同時に出る（入場は当選済み、講演会は受付中、など）。

画面がどう出ようと二重申込は起きない。同じ人が同じ券種に申し込めないことは
データベースのUNIQUE制約で担保していて、画面はその状態を映しているだけ。

## 初期セットアップ

### 1. データベースを作る

> **順番が大事。** `wrangler.toml` の `database_id` がプレースホルダのままだと
> Worker のデプロイが失敗する。**D1を作って database_id を書き込むまで、この
> ブランチを main にマージしないこと。**（デプロイが失敗しても現在動いている
> Worker はそのまま動き続けるので、出展申込フォームが止まることはない。ただし
> 以後どんな変更もデプロイされなくなる。）
>
> **すでにマージしてしまった場合も、壊れたものは何もない。** 下の手順をそのまま
> 実行し、`database_id` を書いた `wrangler.toml` を main に push すれば、
> デプロイがやり直されて復旧する。失敗したデプロイを個別に消す必要はない。

#### 1-1. 手元にリポジトリを用意する

```bash
git clone https://github.com/bayashichan/buchiiyashi.git
cd buchiiyashi/worker
```

すでにクローン済みなら、最新を取り込んでおく。

```bash
git checkout main && git pull
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

「友だち追加オプション」は **aggressive** にする。友だちでない人には整理券を
配信できない（LINEが403を返す）ため、申込の前に友だちになってもらう必要がある。
すでに友だちの人には表示されないので、既存の友だちの体験は変わらない。
これが効くのは、LINEログインチャネルの「リンクされたLINE公式アカウント」に
配信用の公式アカウントが設定されている場合だけなので、あわせて確認すること。

発行されたLIFF IDを2か所に設定する。

- `ticket/config.json` の `liffId`
- `worker/wrangler.toml` の `TICKET_LIFF_ID`

出展申込のLIFFアプリとは**別に作ること**。LIFFのログイン後のリダイレクト先は
エンドポイントURL配下に限られるため、既存のIDを流用すると `/ticket/` で
ログインできない。`/ticket/my/` は `/ticket/` の配下なので同じIDで動く。

#### リッチメニューからの導線

LIFFアプリには `https://liff.line.me/{LIFF_ID}` というURLが発行される。
リッチメニューのリンク先にこれを指定すれば、タップした人がログイン済みのまま入れる。

| ボタン | リンク先 |
| --- | --- |
| 整理券 | `https://liff.line.me/{LIFF_ID}` |

**ボタンは1つでよい。** 申込前・抽選待ち・当選後で中身が変わるので、
「申し込む」と「見る」を分ける必要がない。

**素のURL（`https://buchiiyashifestatokyo.com/ticket/`）を直接指定しないこと。**
開いた先でログインし直す画面が挟まり、そこで諦める人が出る。

`/ticket/my/` は以前の整理券ページのURL。すでに配信した案内に含まれているため、
`/ticket/` へ転送するページとして残してある。

### 3. Workerをデプロイする

`database_id` を書き込んだ `wrangler.toml` を main に push する。
`worker/` 配下が変わると GitHub Actions が自動でデプロイする。

```bash
git add wrangler.toml
git commit -m "D1のdatabase_idを設定する"
git push origin main
```

GitHub の Actions タブで「Deploy Worker」が緑になれば成功。

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
3. LINEに受付の通知が届き、同じページが「抽選待ち」の表示に変わることを確認する
4. 管理画面の「抽選と配信」で抽選を実行し、整理券が届くことを確認する
5. もう一度 `/ticket/` を開き、整理券が表示されることを確認する
6. 「やり直す（番号を破棄）」で元に戻す

自分で何度も試すときは、管理画面の「申込一覧」で行ごとに削除できる。
1人1申込なので、消さないと2回目が申し込めない。

当選番号をすでに配信した相手を消すと、本人の手元には番号が残ったまま無効になる。
その場合だけ確認の文言が変わるので、本番運用中は読んでから押すこと。

本番の申込を受け付ける前に、テストで入れた申込はまとめて消しておくとよい。
券種の状態ごと戻すなら手元から実行する。

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

## データベースの変更

列を足したり変えたりしたときは、`worker/schema/tickets.sql` を直すだけでは
すでに動いているデータベースに反映されない。`worker/schema/migrations/` に
ALTER 文を1ファイル置いて、本番にも流すこと。

```bash
npx wrangler d1 execute buchiiyashi-tickets --remote \
  --file=./schema/migrations/<ファイル名>.sql
```

## 開発

テストは2種類ある。どちらもデプロイ前に GitHub Actions で実行される。

```bash
node --test "worker/test/**/*.test.mjs"
```

**`tickets.test.mjs`** — 抽選の番号割り当て。番号の重複・欠番・グループの分割は、
当日そのまま受付の事故になる。`planAssignment` を変更したら必ず通すこと。

**`lottery-run.test.mjs`** — 抽選の実行そのもの。D1と同じ形のシムを
`node:sqlite` の上に作り、`runLottery` と `deliverMessages` を本番と同じ経路で
呼ぶ。番号の割り当てだけをテストしていたときに、それを呼ぶ側の変数の消し忘れを
素通しして本番で抽選が動かなくなったため、呼び出し口ごと通すようにした。
LINEのトークンは渡さないので外部への通信は起きない。

**`schema.test.mjs`** — スキーマと、Workerが実際に発行するSQLの突き合わせ。
実物のSQLite（`node:sqlite`）にスキーマとシードを流し、管理画面の INSERT/UPDATE、
申込ページの SELECT、抽選の INSERT を同じ形で実行する。
列名の食い違いは管理画面を開くまで誰も気づけないので、ここで落とす。
`tickets.js` のSQLを変えたときは、このテストも合わせて直すこと。
