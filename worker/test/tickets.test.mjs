/**
 * 抽選の番号割り当ての検証。
 *
 * 実行: node --test worker/test/
 *
 * 番号の重複・欠番・グループの分割は、当日そのまま受付の事故になる。
 * データベースに触らない planAssignment を単体で検証しておく。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAssignment } from '../src/tickets.js';

/** 券種設定の雛形 */
function makeType(overrides = {}) {
    return {
        number_start: 1,
        number_end: 100,
        capacity_mode: 'all_win',
        slot_enabled: 1,
        slot_start_time: '10:45',
        slot_interval_min: 30,
        slot_capacity: 50,
        ...overrides
    };
}

/** 人数の配列から申込を作る */
function makeApplications(partySizes) {
    return partySizes.map((size, i) => ({
        id: `app_${String(i).padStart(3, '0')}`,
        party_size: size
    }));
}

test('グループは分割されず、人数分の連番がまとめて割り当てられる', () => {
    const apps = makeApplications([3, 1, 2, 4, 1]);
    const { winners } = planAssignment(makeType(), apps, 'seed-a');

    for (const w of winners) {
        const party = w.app.party_size;
        assert.equal(
            w.numberEnd - w.numberStart + 1, party,
            `${w.app.id} の番号ブロックが人数と一致していません`
        );
    }
});

test('割り当てた番号に重複も欠番もない', () => {
    const apps = makeApplications([3, 1, 2, 4, 1, 2, 5, 1, 1, 3]);
    const { winners, lastNumber } = planAssignment(makeType(), apps, 'seed-b');

    const seen = new Set();
    for (const w of winners) {
        for (let n = w.numberStart; n <= w.numberEnd; n++) {
            assert.ok(!seen.has(n), `番号 ${n} が重複しています`);
            seen.add(n);
        }
    }

    const total = apps.reduce((sum, a) => sum + a.party_size, 0);
    assert.equal(seen.size, total, '発行した番号の数が申込人数と一致していません');

    // 1 から lastNumber まで隙間なく埋まっていること
    for (let n = 1; n <= lastNumber; n++) {
        assert.ok(seen.has(n), `番号 ${n} が欠番になっています`);
    }
});

test('同じシードなら何度実行しても同じ結果になる', () => {
    const apps = makeApplications([2, 1, 3, 1, 4, 2, 1, 1]);
    const type = makeType();

    const first = planAssignment(type, apps, 'buchi-6th-entry');
    const second = planAssignment(type, apps, 'buchi-6th-entry');

    assert.deepEqual(
        first.winners.map(w => [w.app.id, w.numberStart, w.slotTime]),
        second.winners.map(w => [w.app.id, w.numberStart, w.slotTime])
    );
});

test('シードが違えば並びが変わる', () => {
    const apps = makeApplications(Array(30).fill(1));
    const type = makeType();

    const a = planAssignment(type, apps, 'seed-1').winners.map(w => w.app.id);
    const b = planAssignment(type, apps, 'seed-2').winners.map(w => w.app.id);

    assert.notDeepEqual(a, b, 'シードを変えても並びが同じです');
});

test('定員制では番号範囲を超えた申込が落選になる', () => {
    // 番号は1〜10。1名の申込を15件出すので、5件が落選するはず。
    const apps = makeApplications(Array(15).fill(1));
    const type = makeType({ number_end: 10, capacity_mode: 'limited' });

    const { winners, losers, extendedBeyondRange } = planAssignment(type, apps, 'seed-c');

    assert.equal(winners.length, 10);
    assert.equal(losers.length, 5);
    assert.equal(extendedBeyondRange, false);
    assert.ok(
        winners.every(w => w.numberEnd <= 10),
        '定員制なのに番号範囲を超えて発行されています'
    );
});

test('定員制で枠に入りきらないグループは落選になり、番号は範囲内に収まる', () => {
    // 番号は1〜5。3名・3名・1名の順に処理されると、2件目は入りきらない。
    const apps = makeApplications([3, 3, 1]);
    const type = makeType({ number_end: 5, capacity_mode: 'limited' });

    const { winners, losers } = planAssignment(type, apps, 'seed-d');

    const issued = winners.reduce((sum, w) => sum + (w.numberEnd - w.numberStart + 1), 0);
    assert.ok(issued <= 5, '番号範囲を超えて発行されています');
    assert.equal(winners.length + losers.length, 3);
    assert.ok(
        winners.every(w => w.numberEnd <= 5),
        'グループが番号範囲をはみ出しています'
    );
});

test('全員当選の券種では番号範囲を超えても落選が出ない', () => {
    const apps = makeApplications(Array(15).fill(1));
    const type = makeType({ number_end: 10, capacity_mode: 'all_win' });

    const { winners, losers, extendedBeyondRange } = planAssignment(type, apps, 'seed-e');

    assert.equal(losers.length, 0, '全員当選の券種で落選が出ています');
    assert.equal(winners.length, 15);
    assert.equal(extendedBeyondRange, true, '番号範囲超過の警告が立っていません');
});

test('集合時刻は枠の人数ごとに繰り上がる', () => {
    // 1枠2名・30分間隔。1名の申込を6件なら 10:45 / 11:15 / 11:45 が2件ずつ。
    const apps = makeApplications(Array(6).fill(1));
    const type = makeType({ slot_capacity: 2, slot_interval_min: 30, slot_start_time: '10:45' });

    const { winners } = planAssignment(type, apps, 'seed-f');
    const times = winners
        .slice()
        .sort((a, b) => a.numberStart - b.numberStart)
        .map(w => w.slotTime);

    assert.deepEqual(times, ['10:45', '10:45', '11:15', '11:15', '11:45', '11:45']);
});

test('グループ全員が同じ集合時刻になる（枠をまたいでも分割しない）', () => {
    // 1枠3名。2名・2名の順なら、2件目は枠を1名はみ出すが同じ時刻に入る。
    const apps = makeApplications([2, 2]);
    const type = makeType({ slot_capacity: 3, slot_interval_min: 30, slot_start_time: '10:00' });

    const { winners } = planAssignment(type, apps, 'seed-g');
    const sorted = winners.slice().sort((a, b) => a.numberStart - b.numberStart);

    assert.equal(sorted[0].slotTime, '10:00');
    assert.equal(sorted[1].slotTime, '10:00', '枠の残りが足りないグループが分割されています');
    assert.equal(sorted[1].numberStart, 3, '番号が飛んでいます');
});

test('時間枠を使わない券種では集合時刻を割り当てない', () => {
    const apps = makeApplications([1, 2]);
    const type = makeType({ slot_enabled: 0 });

    const { winners } = planAssignment(type, apps, 'seed-h');
    assert.ok(winners.every(w => w.slotTime === null));
});

test('開始番号を1以外にしてもそこから連番になる', () => {
    const apps = makeApplications([2, 1]);
    const type = makeType({ number_start: 501, number_end: 600 });

    const { winners, lastNumber } = planAssignment(type, apps, 'seed-i');
    const sorted = winners.slice().sort((a, b) => a.numberStart - b.numberStart);

    // どちらのグループが先に来るかは抽選次第なので、開始位置と連続性だけを見る
    assert.equal(sorted[0].numberStart, 501, '開始番号から始まっていません');
    assert.equal(sorted[1].numberStart, sorted[0].numberEnd + 1, '番号が飛んでいます');
    assert.equal(lastNumber, 503, '3名分で503番まで発行されるはずです');
});

test('申込が0件でも落ちない', () => {
    const { winners, losers, lastNumber } = planAssignment(makeType(), [], 'seed-j');
    assert.equal(winners.length, 0);
    assert.equal(losers.length, 0);
    assert.equal(lastNumber, 0);
});
