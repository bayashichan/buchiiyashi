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

import { runLottery, deliverMessages } from '../src/tickets.js';

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
