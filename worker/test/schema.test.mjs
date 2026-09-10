/**
 * スキーマと、Workerが実際に発行するSQLの突き合わせ。
 *
 * 実行: node --test worker/test/schema.test.mjs
 *
 * `note` 列を CREATE TABLE に書き忘れたまま、シードとWorkerのINSERT/SELECTだけが
 * その列を使っている状態を本番に出してしまった。列名の食い違いは、管理画面を
 * 開くまで誰も気づけない。ここで実物のSQLiteに流して落とす。
 *
 * Cloudflare D1 はSQLiteなので、node:sqlite で同じ結果が得られる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tickets.js');

const schemaSql = readFileSync(join(SCHEMA_DIR, 'tickets.sql'), 'utf8');
const seedSql = readFileSync(join(SCHEMA_DIR, 'seed-6th.sql'), 'utf8');
const workerSource = readFileSync(SRC, 'utf8');

/**
 * 列を足す前の、古いスキーマのデータベースを作る。
 *
 * 過去のコミットを git から読む書き方にしていたが、CIはリポジトリを
 * 浅く取得するのでそのコミットが無く、手元では通るのにCIで落ちた。
 * テストが外の状態に依存しないよう、ここに直接書いておく。
 */
const LEGACY_SCHEMA = `
CREATE TABLE ticket_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    apply_start TEXT,
    apply_end TEXT,
    lottery_at TEXT,
    number_start INTEGER NOT NULL DEFAULT 1,
    number_end INTEGER NOT NULL DEFAULT 100,
    capacity_mode TEXT NOT NULL DEFAULT 'all_win',
    max_party_size INTEGER NOT NULL DEFAULT 5,
    slot_enabled INTEGER NOT NULL DEFAULT 1,
    slot_start_time TEXT,
    slot_interval_min INTEGER,
    slot_capacity INTEGER,
    fixed_time_label TEXT,
    color TEXT NOT NULL DEFAULT '#B01B54',
    msg_receipt TEXT, msg_win TEXT, msg_lose TEXT, msg_remind TEXT,
    lottery_status TEXT NOT NULL DEFAULT 'pending',
    lottery_seed TEXT,
    lottery_done_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    ticket_type_id TEXT NOT NULL,
    receipt_no TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    party_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

function legacyDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(LEGACY_SCHEMA);
    return db;
}

/** スキーマを流したまっさらなデータベースを作る */
function freshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    return db;
}

/** CREATE TABLE で定義されている列名 */
function columnsOf(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
}

test('スキーマがそのまま流せる', () => {
    const db = freshDb();
    const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    assert.deepEqual(tables, ['applications', 'lottery_runs', 'ticket_types', 'tickets']);
    db.close();
});

test('初期データがそのまま入る', () => {
    const db = freshDb();
    db.exec(seedSql);

    const rows = db.prepare('SELECT id, name, capacity_mode, note FROM ticket_types ORDER BY sort_order').all();
    assert.equal(rows.length, 2, '券種が2件入っていません');
    assert.equal(rows[0].name, '入場整理券');
    assert.equal(rows[1].name, '講演会整理券');
    assert.ok(rows[0].note, '説明文が入っていません');
    db.close();
});

test('初期データは二度流しても既存の設定を壊さない', () => {
    const db = freshDb();
    db.exec(seedSql);
    db.prepare("UPDATE ticket_types SET name = ? WHERE id = 'type_entry_6th'").run('変更後の名前');
    db.exec(seedSql);

    const row = db.prepare("SELECT name FROM ticket_types WHERE id = 'type_entry_6th'").get();
    assert.equal(row.name, '変更後の名前', 'INSERT OR IGNORE のはずが上書きされています');
    db.close();
});

/**
 * 管理画面から券種を保存したときのINSERT。
 * upsertType が組み立てる列の並びをそのまま写している。
 */
const TYPE_FIELDS = [
    'name', 'sort_order', 'enabled', 'apply_start', 'apply_end', 'lottery_at', 'remind_at',
    'issue_end', 'number_start', 'number_end', 'capacity_mode', 'max_party_size',
    'slot_enabled', 'slot_start_time', 'slot_interval_min', 'slot_capacity',
    'fixed_time_label', 'color', 'note', 'open_time', 'free_entry_time',
    'msg_receipt', 'msg_win', 'msg_lose', 'msg_remind'
];

test('管理画面が書き込む列がすべて存在する', () => {
    const db = freshDb();
    const columns = columnsOf(db, 'ticket_types');

    const missing = TYPE_FIELDS.filter(field => !columns.includes(field));
    assert.deepEqual(missing, [], `ticket_types に無い列: ${missing.join(', ')}`);

    // 実際にINSERTとUPDATEを流して確かめる
    const values = TYPE_FIELDS.map(() => 'x');
    db.prepare(
        `INSERT INTO ticket_types (id, ${TYPE_FIELDS.join(', ')}, created_at, updated_at)
         VALUES (?, ${TYPE_FIELDS.map(() => '?').join(', ')}, ?, ?)`
    ).run('type_test', ...values, 'now', 'now');

    db.prepare(
        `UPDATE ticket_types SET ${TYPE_FIELDS.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
    ).run(...values, 'now', 'type_test');

    db.close();
});

test('申込ページに返す列がすべて存在する', () => {
    const db = freshDb();
    db.exec(seedSql);

    // listPublicTypes と同じSELECT
    const rows = db.prepare(
        `SELECT id, name, apply_start, apply_end, lottery_at, number_start, number_end,
                capacity_mode, max_party_size, slot_enabled, slot_start_time,
                slot_interval_min, slot_capacity, fixed_time_label, color, note,
                lottery_status
         FROM ticket_types WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC`
    ).all();

    assert.equal(rows.length, 2);
    db.close();
});

test('申込の登録と、整理券の発行が流せる', () => {
    const db = freshDb();
    db.exec(seedSql);

    // submitApplication と同じINSERT
    db.prepare(
        `INSERT INTO applications
         (id, ticket_type_id, receipt_no, line_user_id, line_display_name, name, name_kana,
          phone, email, party_size, companions, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`
    ).run('app_1', 'type_entry_6th', '123456', 'U1', '山田', '山田 花子', 'ヤマダ ハナコ',
        '09012345678', '', 3, null, '', 'now', 'now');

    // runLottery と同じINSERT / UPDATE
    db.prepare(
        `INSERT INTO tickets
         (id, application_id, ticket_type_id, number_start, number_end, slot_time, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('tkt_1', 'app_1', 'type_entry_6th', 1, 3, '10:45', 'now');

    db.prepare(
        `UPDATE applications SET status = 'won', notify_error = NULL, updated_at = ? WHERE id = ?`
    ).run('now', 'app_1');

    // getMyTickets と同じSELECT
    const row = db.prepare(
        `SELECT a.id, a.receipt_no, a.name, a.party_size, a.status, a.created_at,
                t.number_start, t.number_end, t.slot_time, t.checked_in_at,
                ty.id AS type_id, ty.name AS type_name, ty.color, ty.slot_enabled,
                ty.fixed_time_label, ty.lottery_status, ty.lottery_at, ty.issue_end
         FROM applications a
         JOIN ticket_types ty ON ty.id = a.ticket_type_id
         LEFT JOIN tickets t ON t.application_id = a.id
         WHERE a.line_user_id = ?`
    ).get('U1');

    assert.equal(row.number_start, 1);
    assert.equal(row.type_id, 'type_entry_6th');
    db.close();
});

test('同じ人が同じ券種に二重申込できない', () => {
    const db = freshDb();
    db.exec(seedSql);

    const insert = () => db.prepare(
        `INSERT INTO applications
         (id, ticket_type_id, receipt_no, line_user_id, name, phone, party_size, status, created_at, updated_at)
         VALUES (?, 'type_entry_6th', '000001', 'U1', '山田 花子', '09012345678', 1, 'applied', 'now', 'now')`
    ).run(`app_${Math.random()}`);

    insert();
    assert.throws(insert, /UNIQUE/, '二重申込がデータベースで弾かれていません');
    db.close();
});

test('同じ券種で同じ整理番号を二度発行できない', () => {
    const db = freshDb();
    db.exec(seedSql);

    db.prepare(
        `INSERT INTO applications
         (id, ticket_type_id, receipt_no, line_user_id, name, phone, party_size, status, created_at, updated_at)
         VALUES ('app_1', 'type_entry_6th', '000001', 'U1', 'A', '09000000001', 1, 'applied', 'now', 'now'),
                ('app_2', 'type_entry_6th', '000002', 'U2', 'B', '09000000002', 1, 'applied', 'now', 'now')`
    ).run();

    const issue = (id, appId) => db.prepare(
        `INSERT INTO tickets (id, application_id, ticket_type_id, number_start, number_end, slot_time, issued_at)
         VALUES (?, ?, 'type_entry_6th', 1, 1, '10:45', 'now')`
    ).run(id, appId);

    issue('tkt_1', 'app_1');
    assert.throws(() => issue('tkt_2', 'app_2'), /UNIQUE/, '整理番号の重複が弾かれていません');
    db.close();
});

/**
 * ソースに書かれた ticket_types の列名を拾って、スキーマと突き合わせる。
 * 上の個別テストを通り抜けた列名の打ち間違いを、まとめて捕まえるための保険。
 */
test('Workerのソースが参照する ticket_types の列がスキーマに存在する', () => {
    const db = freshDb();
    const columns = new Set(columnsOf(db, 'ticket_types'));
    db.close();

    // "ty.xxx" と書かれている参照を集める（getMyTickets などのJOIN）
    const referenced = new Set();
    for (const match of workerSource.matchAll(/\bty\.([a-z_]+)\b/g)) {
        referenced.add(match[1]);
    }

    const missing = [...referenced].filter(name => !columns.has(name));
    assert.deepEqual(missing, [], `ticket_types に無い列を参照しています: ${missing.join(', ')}`);
});

test('申込を消すと整理券も消え、同じ人がもう一度申し込める', () => {
    const db = freshDb();
    db.exec(seedSql);

    const apply = () => db.prepare(
        `INSERT INTO applications
         (id, ticket_type_id, receipt_no, line_user_id, name, phone, party_size,
          status, created_at, updated_at)
         VALUES (?, 'type_entry_6th', '000001', 'U_owner', '主催者', '09000000000', 1,
                 'applied', 'now', 'now')`
    ).run(`app_${Math.random()}`);

    apply();
    const appId = db.prepare("SELECT id FROM applications WHERE line_user_id='U_owner'").get().id;
    db.prepare(
        `INSERT INTO tickets (id, application_id, ticket_type_id, number_start, number_end, slot_time, issued_at)
         VALUES ('tkt_1', ?, 'type_entry_6th', 1, 1, '10:45', 'now')`
    ).run(appId);

    // 同じ人はもう申し込めない
    assert.throws(apply, /UNIQUE/);

    // deleteApplication と同じ削除
    db.prepare('DELETE FROM tickets WHERE application_id = ?').run(appId);
    db.prepare('DELETE FROM applications WHERE id = ?').run(appId);

    assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 0, '整理券が残っています');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM applications').get().c, 0);

    // 消したので、また申し込める（テストを繰り返すための本題）
    assert.doesNotThrow(apply, '削除したのに再申込できません');
    db.close();
});

test('申込を消しても券種の設定は残る', () => {
    const db = freshDb();
    db.exec(seedSql);
    db.prepare(
        `INSERT INTO applications
         (id, ticket_type_id, receipt_no, line_user_id, name, phone, party_size,
          status, created_at, updated_at)
         VALUES ('app_1', 'type_entry_6th', '000001', 'U1', 'A', '09000000001', 1,
                 'applied', 'now', 'now')`
    ).run();

    db.prepare('DELETE FROM applications WHERE id = ?').run('app_1');

    const types = db.prepare('SELECT COUNT(*) c FROM ticket_types').get();
    assert.equal(types.c, 2, '券種まで消えています');
    db.close();
});

test('初期データに会場の時刻が入っている', () => {
    const db = freshDb();
    db.exec(seedSql);

    const entry = db.prepare("SELECT open_time, free_entry_time, note FROM ticket_types WHERE id='type_entry_6th'").get();
    assert.equal(entry.open_time, '10:30');
    assert.equal(entry.free_entry_time, '13:00');
    assert.ok(entry.note.includes('{{open}}'), '説明文が時刻を直接書いています');
    assert.ok(entry.note.includes('{{free}}'), '説明文が時刻を直接書いています');
    db.close();
});

test('講演会の文面は時刻を直接書かず fixed_time_label を差し込む', () => {
    const db = freshDb();
    db.exec(seedSql);

    const talk = db.prepare("SELECT fixed_time_label, msg_win, msg_remind FROM ticket_types WHERE id='type_talk_6th'").get();
    assert.ok(talk.fixed_time_label.includes('14:00'), '時刻の置き場所が fixed_time_label ではありません');
    for (const [label, text] of [['当選', talk.msg_win], ['リマインド', talk.msg_remind]]) {
        assert.ok(text.includes('{{time}}'), `${label}の文面が {{time}} を使っていません`);
        assert.ok(!/\d{1,2}:\d{2}/.test(text), `${label}の文面に時刻が直接書かれています`);
    }
    db.close();
});

// ============================================================
// 古いデータベースに新しいコードを載せたときの挙動
//
// 列を足すたびに手作業でALTERを流す前提にしていたため、コードが先に出て
// 申込ページが券種を1件も取れなくなる事故を2度起こした。
// ensureSchema が自力で追いつくことを確かめる。
// ============================================================

/** Workerが使うのと同じ形の、最小限のD1シム */
function d1(db) {
    return {
        prepare(sql) {
            return {
                bind: (...p) => ({
                    all: async () => ({ results: db.prepare(sql).all(...p) }),
                    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...p).changes) } }),
                    first: async () => db.prepare(sql).get(...p) ?? null
                }),
                all: async () => ({ results: db.prepare(sql).all() }),
                run: async () => ({ meta: { changes: Number(db.prepare(sql).run().changes) } }),
                first: async () => db.prepare(sql).get() ?? null
            };
        }
    };
}

test('古いスキーマのままだと、新しいコードの検索は落ちる（事故の再現）', () => {
    const db = legacyDb();
    assert.throws(
        () => db.prepare('SELECT open_time FROM ticket_types LIMIT 0').all(),
        /no such column/
    );
    db.close();
});

test('ensureSchema が足りない列を自分で追加する', async () => {
    const { ensureSchema } = await import(`../src/tickets.js?fresh=${Math.random()}`);
    const db = legacyDb();

    await ensureSchema({ TICKETS_DB: d1(db) });

    const columns = columnsOf(db, 'ticket_types');
    for (const column of ['note', 'remind_at', 'issue_end', 'open_time', 'free_entry_time']) {
        assert.ok(columns.includes(column), `${column} が追加されていません`);
    }
    for (const column of ['receipt_notified_at', 'result_notified_at', 'remind_notified_at', 'notify_error']) {
        assert.ok(columnsOf(db, 'applications').includes(column), `applications.${column} が追加されていません`);
    }
    db.close();
});

test('列を追加したあと、申込ページのSELECTが通る', async () => {
    const { ensureSchema } = await import(`../src/tickets.js?fresh=${Math.random()}`);
    const db = legacyDb();
    await ensureSchema({ TICKETS_DB: d1(db) });

    // listPublicTypes と同じSELECT
    assert.doesNotThrow(() => db.prepare(
        `SELECT id, name, apply_start, apply_end, lottery_at, number_start, number_end,
                capacity_mode, max_party_size, slot_enabled, slot_start_time,
                slot_interval_min, slot_capacity, fixed_time_label, color, note,
                open_time, free_entry_time, lottery_status
         FROM ticket_types WHERE enabled = 1`
    ).all());
    db.close();
});

test('すでに列がそろっていれば何も変えない', async () => {
    const { ensureSchema } = await import(`../src/tickets.js?fresh=${Math.random()}`);
    const db = freshDb();
    const before = columnsOf(db, 'ticket_types').join(',');

    await ensureSchema({ TICKETS_DB: d1(db) });

    assert.equal(columnsOf(db, 'ticket_types').join(','), before);
    db.close();
});

test('自動追加の対象になっている列が、スキーマ本体にも書かれている', async () => {
    const { ADDITIVE_COLUMNS } = await import('../src/tickets.js');
    // 過去に2回、コードだけ先に列を使い始めて本番が落ちている。
    // ALTER で後から足せるようにはしたが、新しく作るデータベースに
    // その列が無いままだと、作り直したときに同じ事故が再発する。
    const db = freshDb();
    const missing = [];
    for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
        const actual = new Set(columnsOf(db, table));
        for (const name of Object.keys(columns)) {
            if (!actual.has(name)) missing.push(`${table}.${name}`);
        }
    }
    db.close();

    assert.deepEqual(missing, [], `スキーマに書かれていない列: ${missing.join(', ')}`);
});
