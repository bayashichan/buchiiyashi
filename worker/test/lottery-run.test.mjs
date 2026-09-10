/**
 * 抽選の実行そのものを、データベースごと動かして確かめる。
 *
 * 実行: node --test worker/test/lottery-run.test.mjs
 *
 * planAssignment（番号の割り当て）だけをテストしていたため、それを呼ぶ側の
 * runLottery に残っていた変数の消し忘れ（shuffled is not defined）を素通しし、
 * 本番で抽選が実行できない状態を出してしまった。
 *
 * ここでは D1 と同じ形のシムを node:sqlite の上に作り、runLottery と
 * deliverMessages を本番と同じ経路で呼ぶ。LINEのトークンは渡さないので
 * 外部への通信は起きない（pushLine が送信前に諦める）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runLottery, deliverMessages, runTicketSchedule, handleTicketAdminAPI } from '../src/tickets.js';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const schemaSql = readFileSync(join(SCHEMA_DIR, 'tickets.sql'), 'utf8');
const seedSql = readFileSync(join(SCHEMA_DIR, 'seed-6th.sql'), 'utf8');

// ============================================================
// D1のシム（prepare().bind().run()/first()/all() と batch()）
// ============================================================

class Stmt {
    constructor(db, sql, params) {
        this.db = db;
        this.sql = sql;
        this.params = params;
    }
    bind(...params) {
        return new Stmt(this.db, this.sql, params);
    }
    async run() {
        const result = this.db.prepare(this.sql).run(...this.params);
        return { success: true, meta: { changes: Number(result.changes) } };
    }
    async first() {
        return this.db.prepare(this.sql).get(...this.params) ?? null;
    }
    async all() {
        return { results: this.db.prepare(this.sql).all(...this.params) };
    }
}

class D1Shim {
    constructor(db) {
        this.db = db;
        this.batchCount = 0;
        // n回目のbatchで例外を投げる（途中で落ちた実行を再現するため）
        this.failOnBatch = null;
    }
    prepare(sql) { return new Stmt(this.db, sql, []); }
    async batch(statements) {
        this.batchCount += 1;
        if (this.failOnBatch === this.batchCount) {
            throw new Error('意図的な失敗（テスト）');
        }
        // D1のbatchはトランザクション。途中で失敗したら全部戻す
        this.db.exec('BEGIN');
        try {
            const out = [];
            for (const statement of statements) out.push(await statement.run());
            this.db.exec('COMMIT');
            return out;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}

/** 券種と申込が入った状態のenvを作る */
function makeEnv(partySizes, ticketTypeId = 'type_entry_6th') {
    const db = new DatabaseSync(':memory:');
    db.exec(schemaSql);
    db.exec(seedSql);

    // 申込期間や抽選日時に左右されないよう、抽選は直接呼ぶ
    partySizes.forEach((size, i) => {
        db.prepare(
            `INSERT INTO applications
             (id, ticket_type_id, receipt_no, line_user_id, name, phone, party_size,
              status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`
        ).run(
            `app_${i}`, ticketTypeId, `10000${i}`, `U${i}`,
            `申込者${i}`, `0900000000${i}`, size,
            `2026-09-11T10:0${i}:00+09:00`, `2026-09-11T10:0${i}:00+09:00`
        );
    });

    return { env: { TICKETS_DB: new D1Shim(db) }, db };
}

// ============================================================

test('抽選を実行すると整理券が発行され、券種が抽選済みになる', async () => {
    const { env, db } = makeEnv([3, 1, 2]);

    const result = await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'test-seed' });

    assert.equal(result.ok, true, `抽選に失敗: ${result.error}`);
    assert.equal(result.total, 3, '申込件数が記録されていません');
    assert.equal(result.won, 3);
    assert.equal(result.lost, 0);
    assert.equal(result.issuedNumbers, 6, '3+1+2 で6番分のはずです');
    assert.equal(result.lastNumber, 6);

    const type = db.prepare("SELECT lottery_status, lottery_seed FROM ticket_types WHERE id='type_entry_6th'").get();
    assert.equal(type.lottery_status, 'done');
    assert.equal(type.lottery_seed, 'test-seed');

    const tickets = db.prepare('SELECT number_start, number_end, slot_time FROM tickets ORDER BY number_start').all();
    assert.equal(tickets.length, 3);
    assert.equal(tickets[0].number_start, 1);
    assert.equal(tickets[2].number_end, 6);
    assert.ok(tickets[0].slot_time, '集合時刻が入っていません');

    const won = db.prepare("SELECT COUNT(*) c FROM applications WHERE status='won'").get();
    assert.equal(won.c, 3);
});

test('抽選の記録が残り、件数とシード値が読める', async () => {
    const { env, db } = makeEnv([2, 2]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'seed-for-run' });

    const run = db.prepare('SELECT * FROM lottery_runs ORDER BY started_at DESC').get();
    assert.equal(run.status, 'done');
    assert.equal(run.trigger, 'manual');
    assert.equal(run.seed, 'seed-for-run');
    assert.equal(run.total_applications, 2);
    assert.equal(run.won_applications, 2);
    assert.equal(run.issued_numbers, 4);
    assert.ok(run.finished_at, '終了時刻が入っていません');
});

test('同じ券種の抽選は二度実行できない', async () => {
    const { env } = makeEnv([1]);
    const first = await runLottery(env, 'type_entry_6th', { trigger: 'manual' });
    assert.equal(first.ok, true);

    const second = await runLottery(env, 'type_entry_6th', { trigger: 'manual' });
    assert.equal(second.ok, false);
    assert.equal(second.alreadyDone, true);
});

test('やり直すと番号が破棄され、もう一度発行される', async () => {
    const { env, db } = makeEnv([1, 1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'a' });

    const redo = await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'b', force: true });
    assert.equal(redo.ok, true, `やり直しに失敗: ${redo.error}`);
    assert.equal(redo.won, 2);

    const tickets = db.prepare('SELECT COUNT(*) c FROM tickets').get();
    assert.equal(tickets.c, 2, '古い整理券が残っています');

    const type = db.prepare("SELECT lottery_seed FROM ticket_types WHERE id='type_entry_6th'").get();
    assert.equal(type.lottery_seed, 'b');
});

test('定員制の券種では、あふれた申込が落選になる', async () => {
    // 講演会整理券は 1〜120番。1名の申込を大量に作ると121件目から落選する
    const { env, db } = makeEnv(Array(125).fill(1), 'type_talk_6th');

    const result = await runLottery(env, 'type_talk_6th', { trigger: 'manual', seed: 'talk' });
    assert.equal(result.ok, true, `抽選に失敗: ${result.error}`);
    assert.equal(result.won, 120);
    assert.equal(result.lost, 5);

    const max = db.prepare('SELECT MAX(number_end) m FROM tickets').get();
    assert.equal(max.m, 120, '番号範囲を超えて発行されています');
});

test('申込が0件でも抽選は完了する', async () => {
    const { env, db } = makeEnv([]);
    const result = await runLottery(env, 'type_entry_6th', { trigger: 'cron' });

    assert.equal(result.ok, true, `抽選に失敗: ${result.error}`);
    assert.equal(result.total, 0);
    assert.equal(result.won, 0);

    const type = db.prepare("SELECT lottery_status FROM ticket_types WHERE id='type_entry_6th'").get();
    assert.equal(type.lottery_status, 'done');
});

test('抽選が終わっていない券種には配信できない', async () => {
    const { env } = makeEnv([1]);
    const result = await deliverMessages(env, 'type_entry_6th', { kind: 'result' });

    assert.equal(result.ok, false);
    assert.match(result.error, /抽選が完了していない/);
});

test('配信できなかった相手は未達として記録され、残り件数が減らない', async () => {
    // LINEのトークンを渡していないので、pushLine は送信せずに失敗を返す
    const { env, db } = makeEnv([1, 1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual' });

    const result = await deliverMessages(env, 'type_entry_6th', { kind: 'result' });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.remaining, 2, '送れていないのに残り件数が減っています');

    const rows = db.prepare('SELECT notify_error FROM applications').all();
    assert.ok(rows.every(r => r.notify_error), '未達の理由が記録されていません');
});

test('整理券を書いたあとで落ちても、痕跡を残さずやり直せる', async () => {
    const { env, db } = makeEnv([2, 1, 3]);

    // 整理券のINSERTは通り、そのあとの記録更新で落ちる状況を作る。
    // 実際に「shuffled is not defined」で起きたのがこの形で、
    // 番号だけが残って次の実行が application_id の重複で弾かれていた。
    env.TICKETS_DB.failOnBatch = 2;

    const failed = await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'boom' });
    assert.equal(failed.ok, false, '失敗するはずの実行が成功しています');

    // 券種は抽選前に戻り、書きかけの整理券は消えている
    const type = db.prepare("SELECT lottery_status FROM ticket_types WHERE id='type_entry_6th'").get();
    assert.equal(type.lottery_status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 0, '書きかけの整理券が残っています');
    assert.equal(
        db.prepare("SELECT COUNT(*) c FROM applications WHERE status='applied'").get().c, 3,
        '申込が抽選前に戻っていません'
    );

    const run = db.prepare("SELECT status FROM lottery_runs WHERE seed='boom'").get();
    assert.equal(run.status, 'failed');

    // そのまま同じ手順でやり直せる
    env.TICKETS_DB.failOnBatch = null;
    const retry = await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'retry' });
    assert.equal(retry.ok, true, `やり直しに失敗: ${retry.error}`);
    assert.equal(retry.won, 3);
    assert.equal(retry.issuedNumbers, 6);
});

test('整理券が残ったまま抽選前になっていても、実行すれば直る', async () => {
    // 古い版で落ちたあとのデータベースを再現する（番号が残り、状態はpending）
    const { env, db } = makeEnv([1, 1]);
    db.prepare(
        `INSERT INTO tickets (id, application_id, ticket_type_id, number_start, number_end, slot_time, issued_at)
         VALUES ('tkt_old', 'app_0', 'type_entry_6th', 1, 1, '10:45', 'past')`
    ).run();
    db.prepare("UPDATE applications SET status='won' WHERE id='app_0'").run();

    const result = await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'heal' });
    assert.equal(result.ok, true, `残骸があると実行できません: ${result.error}`);
    assert.equal(result.won, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 2, '古い整理券が残っています');
});

test('LINEに送る本文で、会場の時刻の差込タグが埋まる', async () => {
    const { env, db } = makeEnv([1]);

    db.prepare(
        `UPDATE ticket_types
         SET msg_win = '{{name}} 様{{number}}番／集合 {{time}}／開場 {{open}}／{{free}} 以降は不要',
             open_time = '10:30', free_entry_time = '13:00'
         WHERE id = 'type_entry_6th'`
    ).run();

    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'vars' });

    // 送信内容を捕まえる。実際に外へは出さない。
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        sent.push(JSON.parse(options.body));
        return { ok: true, status: 200, text: async () => '' };
    };

    try {
        const result = await deliverMessages(
            { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' },
            'type_entry_6th',
            { kind: 'result' }
        );
        assert.equal(result.sent, 1, `配信できていません（失敗 ${result.failed}件）`);
    } finally {
        globalThis.fetch = originalFetch;
    }

    const text = sent[0].messages[0].text;
    assert.match(text, /開場 10:30/, `開場時刻が埋まっていません: ${text}`);
    assert.match(text, /13:00 以降は不要/, `解放時刻が埋まっていません: ${text}`);
    assert.match(text, /集合 10:45/, `集合時刻が埋まっていません: ${text}`);
    assert.ok(!text.includes('{{'), `埋まっていないタグが残っています: ${text}`);
});

/** 管理APIを直接叩く（本番と同じ経路） */
async function adminPost(env, path, body) {
    const request = new Request(`https://example.test${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const response = await handleTicketAdminAPI(request, env, {}, new URL(request.url));
    return { status: response.status, data: await response.json() };
}

test('抽選前に戻すと、番号が消えて受付が再開する', async () => {
    const { env, db } = makeEnv([2, 1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'testrun' });

    // テストで抽選してしまった状態
    assert.equal(
        db.prepare("SELECT lottery_status FROM ticket_types WHERE id='type_entry_6th'").get().lottery_status,
        'done'
    );

    const { status, data } = await adminPost(env, '/api/admin/tickets/lottery/reset', {
        ticketTypeId: 'type_entry_6th'
    });

    assert.equal(status, 200, `失敗: ${data.error}`);
    assert.equal(data.discarded, 2, '破棄した整理券の件数が合いません');

    const type = db.prepare("SELECT lottery_status, lottery_seed, lottery_done_at FROM ticket_types WHERE id='type_entry_6th'").get();
    assert.equal(type.lottery_status, 'pending', '抽選前に戻っていません');
    assert.equal(type.lottery_seed, null, 'シード値が残っています');
    assert.equal(type.lottery_done_at, null);

    assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 0, '整理券が残っています');
    assert.equal(
        db.prepare("SELECT COUNT(*) c FROM applications WHERE status='applied'").get().c, 2,
        '申込が抽選前に戻っていません'
    );
});

test('抽選前に戻したあと、もう一度抽選できる', async () => {
    const { env, db } = makeEnv([1, 1, 1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'first' });
    await adminPost(env, '/api/admin/tickets/lottery/reset', { ticketTypeId: 'type_entry_6th' });

    const again = await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'second' });
    assert.equal(again.ok, true, `再抽選に失敗: ${again.error}`);
    assert.equal(again.won, 3);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 3);
});

test('申込を消してから抽選前に戻すと、まっさらな状態になる', async () => {
    // テストの申込を消し、抽選もなかったことにする流れ
    const { env, db } = makeEnv([1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'x' });

    const appId = db.prepare('SELECT id FROM applications').get().id;
    await adminPost(env, '/api/admin/tickets/applications/delete', { applicationId: appId });
    await adminPost(env, '/api/admin/tickets/lottery/reset', { ticketTypeId: 'type_entry_6th' });

    assert.equal(db.prepare('SELECT COUNT(*) c FROM applications').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 0);
    assert.equal(
        db.prepare("SELECT lottery_status FROM ticket_types WHERE id='type_entry_6th'").get().lottery_status,
        'pending'
    );
});

// ============================================================
// 配信の自動再送
//
// Workersの無料プランは1回の実行で外部通信が50回までしかできない。
// まとめて送ろうとすると途中で落ちるため、少しずつ送って残りを次に回す。
// そのとき「一度失敗したら二度と送らない」動きだと、主催者が手で押し直すまで
// 止まってしまう。ここではその自動再送が本当に効くかを確かめる。
// ============================================================

/** fetch を差し替えて、呼び出しごとの応答を決められるようにする */
function stubLine(responder) {
    const sent = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        sent.push(body);
        const result = responder(body, sent.length);
        return {
            ok: result.status < 300,
            status: result.status,
            text: async () => result.text || ''
        };
    };
    return { sent, restore: () => { globalThis.fetch = original; } };
}

test('一時的に送れなかった人は、次の実行で自動的に送り直される', async () => {
    const { env, db } = makeEnv([1, 1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'retry-ok' });
    const withToken = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };

    // 1回目：LINE側が混んでいて全員失敗する
    let line = stubLine(() => ({ status: 429, text: 'rate limited' }));
    let first;
    try {
        first = await deliverMessages(withToken, 'type_entry_6th', { kind: 'result' });
    } finally { line.restore(); }

    assert.equal(first.sent, 0);
    assert.equal(first.failed, 2);
    assert.equal(first.retryLater, 2, '再送の対象として数えられていません');
    assert.equal(first.remaining, 2, '自動で送り直す分に入っていません');
    assert.equal(first.stuck, 0, '一時的な失敗を「未達」にしてはいけません');

    // 2回目：復旧した。主催者が何もしなくても対象に戻っている
    line = stubLine(() => ({ status: 200 }));
    let second;
    try {
        second = await deliverMessages(withToken, 'type_entry_6th', { kind: 'result' });
    } finally { line.restore(); }

    assert.equal(second.sent, 2, '自動で送り直されていません');
    assert.equal(second.remaining, 0);
    assert.equal(second.stuck, 0);

    const rows = db.prepare('SELECT result_notified_at, notify_error FROM applications').all();
    assert.ok(rows.every(r => r.result_notified_at), '配信済みの印が付いていません');
    assert.ok(rows.every(r => !r.notify_error), '成功したのに失敗の記録が残っています');
});

test('ブロック中の人は自動で送り直さず、未達として残す', async () => {
    const { env, db } = makeEnv([1, 1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'blocked' });
    const withToken = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };

    // 1人目はブロック中（403）、2人目は届く
    let line = stubLine(body => (body.to === 'U0' ? { status: 403, text: 'blocked' } : { status: 200 }));
    let first;
    try {
        first = await deliverMessages(withToken, 'type_entry_6th', { kind: 'result' });
    } finally { line.restore(); }

    assert.equal(first.sent, 1);
    assert.equal(first.failed, 1);
    assert.equal(first.retryLater, 0, 'ブロック中を再送の対象にしてはいけません');
    assert.equal(first.stuck, 1, '未達として数えられていません');
    assert.equal(first.remaining, 0, '自動で送り直す分に入れてはいけません');

    // 次の実行では誰も対象にならない（同じ相手を叩き続けない）
    line = stubLine(() => ({ status: 200 }));
    let second;
    try {
        second = await deliverMessages(withToken, 'type_entry_6th', { kind: 'result' });
    } finally { line.restore(); }
    assert.equal(second.sent, 0, 'ブロック中の人に送り直しています');
    assert.equal(line.sent.length, 0, 'LINEを呼んでしまっています');

    // 主催者が明示的に押したときだけ、もう一度試す
    line = stubLine(() => ({ status: 200 }));
    let manual;
    try {
        manual = await deliverMessages(withToken, 'type_entry_6th',
            { kind: 'result', retryFailed: true });
    } finally { line.restore(); }
    assert.equal(manual.sent, 1, '「未達の人に再送」で送れていません');

    const row = db.prepare("SELECT result_notified_at FROM applications WHERE id='app_0'").get();
    assert.ok(row.result_notified_at, '再送後に配信済みになっていません');
});

test('何度やっても届かない人は、いつか自動再送をやめる', async () => {
    const { env, db } = makeEnv([1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'giveup' });
    const withToken = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };

    let last = null;
    for (let i = 0; i < 10; i++) {
        const line = stubLine(() => ({ status: 500, text: 'server error' }));
        try {
            last = await deliverMessages(withToken, 'type_entry_6th', { kind: 'result' });
        } finally { line.restore(); }
        if (last.remaining === 0) break;
    }

    assert.equal(last.remaining, 0, '延々と再送し続けています');
    assert.equal(last.stuck, 1, '諦めた分が未達として残っていません');

    const row = db.prepare("SELECT notify_attempts FROM applications WHERE id='app_0'").get();
    assert.ok(row.notify_attempts >= 5, `再送回数が数えられていません: ${row.notify_attempts}`);
    assert.ok(row.notify_attempts <= 6, `上限を超えて再送しています: ${row.notify_attempts}`);
});

test('1回の配信でLINEを呼ぶ回数には上限があり、残りは次に回る', async () => {
    // 無料プランの通信上限に当たらないことが目的。件数を指定しても超えない。
    const { env } = makeEnv(Array(60).fill(1));
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'cap' });
    const withToken = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };

    // 既定のまま呼んだとき
    let line = stubLine(() => ({ status: 200 }));
    let result;
    try {
        result = await deliverMessages(withToken, 'type_entry_6th', { kind: 'result' });
    } finally { line.restore(); }

    assert.ok(line.sent.length <= 20, `1回で ${line.sent.length}件も送っています`);
    assert.ok(result.remaining > 0, '残りが次に回されていません');
    assert.equal(result.sent + result.remaining, 60, '合計が申込件数と合いません');

    // 大きな件数を指定されても、上限までしか送らない
    line = stubLine(() => ({ status: 200 }));
    try {
        await deliverMessages(withToken, 'type_entry_6th', { kind: 'result', limit: 500 });
    } finally { line.restore(); }

    assert.ok(line.sent.length <= 40, `指定に従って ${line.sent.length}件も送っています`);
});

test('一度も試していない人を、失敗が続いている人より先に送る', async () => {
    const { env, db } = makeEnv([1, 1, 1]);
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'order' });
    const withToken = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };

    // 1番の人だけ、すでに何度か失敗している状態にする
    db.prepare(
        `UPDATE applications SET notify_error = '一時的な失敗', notify_permanent = 0,
         notify_attempts = 3 WHERE id = 'app_0'`
    ).run();

    const line = stubLine(() => ({ status: 200 }));
    try {
        await deliverMessages(withToken, 'type_entry_6th', { kind: 'result' });
    } finally { line.restore(); }

    const order = line.sent.map(b => b.to);
    assert.equal(order.length, 3);
    assert.equal(order[order.length - 1], 'U0', `失敗続きの人が先に来ています: ${order.join(',')}`);
});

// ============================================================
// 5分ごとの自動処理
//
// 主催者が管理画面を開いていなくても、放っておけば全員に届くこと。
// これが成り立たないと、無料プランの通信上限に当たった時点で配信が止まる。
// ============================================================

test('自動処理は、抽選した回には配信まで進めず、次の回で送り始める', async () => {
    const { env, db } = makeEnv(Array(5).fill(1));
    db.prepare(
        "UPDATE ticket_types SET lottery_at = '2020-01-01T00:00:00+09:00' WHERE id = 'type_entry_6th'"
    ).run();
    // もう片方の券種は対象外にしておく
    db.prepare("UPDATE ticket_types SET enabled = 0 WHERE id <> 'type_entry_6th'").run();

    const withToken = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };

    // 1回目：抽選だけ。同じ実行で配信まで進むと通信の上限に当たる。
    let line = stubLine(() => ({ status: 200 }));
    let first;
    try {
        first = await runTicketSchedule(withToken);
    } finally { line.restore(); }

    assert.equal(first.lotteries, 1, '抽選が実行されていません');
    assert.equal(line.sent.length, 0, '抽選と同じ回で配信まで進んでいます');

    // 2回目：配信が始まる
    line = stubLine(() => ({ status: 200 }));
    let second;
    try {
        second = await runTicketSchedule(withToken);
    } finally { line.restore(); }

    assert.equal(second.delivered, 5, `配信されていません（${line.sent.length}件送信）`);

    const done = db.prepare(
        "SELECT COUNT(*) c FROM applications WHERE result_notified_at IS NOT NULL"
    ).get();
    assert.equal(done.c, 5, '配信済みの印が付いていません');
});

test('自動処理をくり返せば、上限を超える人数でも最後まで届く', async () => {
    const { env, db } = makeEnv(Array(45).fill(1));
    db.prepare("UPDATE ticket_types SET enabled = 0 WHERE id <> 'type_entry_6th'").run();
    await runLottery(env, 'type_entry_6th', { trigger: 'manual', seed: 'cron-all' });

    const withToken = { ...env, LINE_CHANNEL_ACCESS_TOKEN: 'dummy' };

    // 3回目までは混雑して失敗する。主催者は何もしない。
    let calls = 0;
    let total = 0;
    for (let round = 1; round <= 12; round++) {
        const line = stubLine(() => (round <= 3 ? { status: 429, text: 'busy' } : { status: 200 }));
        try {
            const summary = await runTicketSchedule(withToken);
            total += summary.delivered;
            calls += line.sent.length;
        } finally { line.restore(); }
    }

    const remaining = db.prepare(
        "SELECT COUNT(*) c FROM applications WHERE result_notified_at IS NULL"
    ).get();
    assert.equal(remaining.c, 0, `${remaining.c}件が届かないまま残っています`);
    assert.equal(total, 45, `配信件数が合いません: ${total}`);
    assert.ok(calls > 45, '失敗した分が送り直されていません');
});
