-- ぶち癒しフェスタ 抽選式オンライン整理券システム
--
-- Cloudflare D1 (SQLite) のスキーマ。
-- 適用方法:
--   npx wrangler d1 execute buchiiyashi-tickets --remote --file=./schema/tickets.sql
--
-- 番号の割り当ては「一度だけ確実に実行する」必要がある。
-- スプレッドシートやR2のJSONでは同時書き込みで番号が重複しうるため、
-- UNIQUE制約を張れるD1を使う。

-- ============================================================
-- 券種（入場整理券・講演会整理券 など）
--
-- 運用中に管理画面から変更できることを前提にしている。
-- 抽選を実行したあとでも設定は編集できるが、番号や時刻の割り当てには
-- 影響しない（割り当て済みの結果は tickets 側で確定している）。
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_types (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    enabled           INTEGER NOT NULL DEFAULT 1,   -- 0なら申込ページに出さない

    -- 期間設定（すべてISO8601。例 "2026-09-12T10:00:00+09:00"）
    apply_start       TEXT,
    apply_end         TEXT,
    lottery_at        TEXT,    -- この時刻を過ぎるとcronが抽選を実行する
    remind_at         TEXT,    -- この時刻を過ぎるとcronが前日リマインドを送る
    issue_end         TEXT,    -- この時刻を過ぎたら整理券を表示しない
                               -- （発行は抽選と同時。開始時刻の設定は持たない）

    -- 番号設定
    number_start      INTEGER NOT NULL DEFAULT 1,
    number_end        INTEGER NOT NULL DEFAULT 100,

    -- 定員の扱い: 'all_win'（全員当選・番号のみ抽選） / 'limited'（定員制・落選あり）
    capacity_mode     TEXT NOT NULL DEFAULT 'all_win',

    -- 1申込あたりの上限人数（グループ申込）
    max_party_size    INTEGER NOT NULL DEFAULT 5,

    -- 会場の時刻。案内文に {{open}} {{free}} として差し込む。
    -- 文面に時刻を直接書くと、時間が変わったとき全部の文面を直すことになる。
    open_time         TEXT,    -- 開場時刻 'HH:MM'
    free_entry_time   TEXT,    -- 整理券なしで入場できるようになる時刻 'HH:MM'

    -- 時間枠設定
    slot_enabled      INTEGER NOT NULL DEFAULT 1,
    slot_start_time   TEXT DEFAULT '10:45',  -- 最初の枠の集合時刻 'HH:MM'
    slot_interval_min INTEGER DEFAULT 30,    -- 枠の間隔（分）
    slot_capacity     INTEGER DEFAULT 50,    -- 1枠あたりの人数
    fixed_time_label  TEXT,                  -- 枠なしのときに券面へ出す文字（例 "14:00 開演"）

    -- 券面の色（LINEのFlex Messageと整理券ページで使う）
    color             TEXT NOT NULL DEFAULT '#B01B54',

    -- 申込ページで券種名の下に出す説明文
    note              TEXT,

    -- 案内文（管理画面から編集。差込タグ {{name}} {{number}} {{time}} {{party}} が使える）
    msg_receipt       TEXT,   -- 申込を受け付けた直後
    msg_win           TEXT,   -- 当選
    msg_lose          TEXT,   -- 落選
    msg_remind        TEXT,   -- 前日リマインド

    -- 抽選の実行状態。二重実行で番号が壊れるのを防ぐための本体。
    lottery_status    TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done
    lottery_seed      TEXT,
    lottery_done_at   TEXT,

    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

-- ============================================================
-- 申込（1件 = 1グループ）
--
-- 抽選はこの表の行単位で行う。人単位でシャッフルするとグループの番号が
-- バラバラになるため、グループを分割しないことがこの設計の要。
-- ============================================================
CREATE TABLE IF NOT EXISTS applications (
    id                TEXT PRIMARY KEY,
    ticket_type_id    TEXT NOT NULL,
    receipt_no        TEXT NOT NULL,          -- 受付番号（整理番号ではない）

    line_user_id      TEXT NOT NULL,
    line_display_name TEXT,

    name              TEXT NOT NULL,
    name_kana         TEXT,
    phone             TEXT NOT NULL,          -- 当日の照合に使う
    email             TEXT,                   -- 任意。LINEが届かなかったときの保険

    party_size        INTEGER NOT NULL,       -- 代表者を含む人数
    companions        TEXT,                   -- 同行者名のJSON配列（任意入力）
    note              TEXT,

    status            TEXT NOT NULL DEFAULT 'applied',  -- applied | won | lost | cancelled

    -- LINE配信の状態。当選も落選もここで一元管理する。
    -- 未達（友だち未追加・ブロック）を管理画面で一覧にするために使う。
    receipt_notified_at TEXT,
    result_notified_at  TEXT,
    remind_notified_at  TEXT,
    notify_error        TEXT,

    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,

    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id),

    -- 1人1申込。LINEログイン必須にしているので、これが重複申込の防波堤になる。
    UNIQUE (ticket_type_id, line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_type   ON applications(ticket_type_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_line   ON applications(line_user_id);
CREATE INDEX IF NOT EXISTS idx_applications_phone  ON applications(phone);

-- ============================================================
-- 発行済み整理券
--
-- 1申込に1行。人数分の番号は number_start 〜 number_end の連番で確保する。
-- ============================================================
CREATE TABLE IF NOT EXISTS tickets (
    id                TEXT PRIMARY KEY,
    application_id    TEXT NOT NULL,
    ticket_type_id    TEXT NOT NULL,

    number_start      INTEGER NOT NULL,
    number_end        INTEGER NOT NULL,
    slot_time         TEXT,                   -- 集合時刻 'HH:MM'（枠なしなら NULL）

    issued_at         TEXT NOT NULL,
    checked_in_at     TEXT,                   -- 当日受付で通した時刻

    FOREIGN KEY (application_id) REFERENCES applications(id),
    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id),

    -- 同じ券種で同じ開始番号は二度と出せない。番号重複に対する最後の砦。
    UNIQUE (ticket_type_id, number_start),
    UNIQUE (application_id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(ticket_type_id, number_start);

-- ============================================================
-- 抽選の実行記録
--
-- 「いつ・どのシードで・何件を処理したか」を残す。
-- シードを公開すれば第三者が同じ結果を再現でき、抽選の公平性を説明できる。
-- ============================================================
CREATE TABLE IF NOT EXISTS lottery_runs (
    id                   TEXT PRIMARY KEY,
    ticket_type_id       TEXT NOT NULL,
    seed                 TEXT NOT NULL,
    trigger              TEXT NOT NULL,       -- 'cron' | 'manual'
    status               TEXT NOT NULL,       -- running | done | failed
    total_applications   INTEGER DEFAULT 0,
    won_applications     INTEGER DEFAULT 0,
    lost_applications    INTEGER DEFAULT 0,
    issued_numbers       INTEGER DEFAULT 0,
    error                TEXT,
    started_at           TEXT NOT NULL,
    finished_at          TEXT,

    FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(id)
);

CREATE INDEX IF NOT EXISTS idx_lottery_runs_type ON lottery_runs(ticket_type_id, started_at);
