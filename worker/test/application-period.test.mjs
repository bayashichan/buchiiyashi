/**
 * 申込の受付期間（管理画面の「申込受付期間」）。
 *
 * 実行: node --test worker/test/application-period.test.mjs
 *
 * 申込フォームは開始前に予告画面、終了後に受付終了の画面を出すが、
 * フォームを開いたまま締切を過ぎた人や、端末の時計がずれている人からは申込が届きうる。
 * Workerが最新の設定で期間を確かめ、期間外ならGASへ送らない（保存も確認メールもしない）ことを確かめる。
 * 日時は日本時間として読む（WorkerはUTCで動くため、ずれると9時間早く・遅く締まる）。
 */

import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
    parseJstDateTime,
    formatJstDateTime,
    resolveApplicationPeriod,
    applicationPeriodMessage,
} from '../src/index.js';

const env = {
    GAS_URL: 'https://script.google.com/macros/s/TEST/exec',
    GITHUB_TOKEN: 'gh-token',
    GITHUB_REPO: 'owner/repo',
};
const CONFIG_URL = 'https://api.github.com/repos/owner/repo/contents/apply/config.json';
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    mock.timers.reset();
});

// ----------------------------------------
// 期間の判定
// ----------------------------------------
test('日時は日本時間として読む', () => {
    assert.equal(parseJstDateTime('2026-10-01 00:00:00').toISOString(), '2026-09-30T15:00:00.000Z');
    assert.equal(parseJstDateTime('2026-10-01T10:00').toISOString(), '2026-10-01T01:00:00.000Z');
});

test('空欄・読めない値は未設定として扱う', () => {
    assert.equal(parseJstDateTime(''), null);
    assert.equal(parseJstDateTime(undefined), null);
    assert.equal(parseJstDateTime('10月1日'), null);
    assert.equal(parseJstDateTime('2026-13-45 99:99:00'), null);
});

test('表示用の日時は日本時間・曜日つき', () => {
    assert.equal(formatJstDateTime(parseJstDateTime('2026-10-01 10:00:00')), '2026年10月1日（木）10:00');
    // UTCでは前日になる時刻でも、日本時間の日付・曜日で出す
    assert.equal(formatJstDateTime(parseJstDateTime('2026-11-30 23:59:59')), '2026年11月30日（月）23:59');
});

const period = { applicationStart: '2026-10-01 10:00:00', applicationEnd: '2026-11-30 23:59:59' };
const at = jst => parseJstDateTime(jst);

test('開始日時より前は受付前', () => {
    assert.equal(resolveApplicationPeriod(period, at('2026-10-01 09:59:59')).status, 'before');
});

test('開始日時ちょうどから受け付ける', () => {
    assert.equal(resolveApplicationPeriod(period, at('2026-10-01 10:00:00')).status, 'open');
});

test('終了日時の分の終わりまで受け付け、過ぎたら受付終了', () => {
    assert.equal(resolveApplicationPeriod(period, at('2026-11-30 23:59:59')).status, 'open');
    assert.equal(resolveApplicationPeriod(period, new Date(at('2026-11-30 23:59:59').getTime() + 1)).status, 'closed');
});

test('未設定の側は制限なし（これまでの設定のままなら、いつでも受け付ける）', () => {
    assert.equal(resolveApplicationPeriod({}, at('2020-01-01 00:00:00')).status, 'open');
    assert.equal(resolveApplicationPeriod({ applicationStart: '', applicationEnd: '' }, at('2030-01-01 00:00:00')).status, 'open');
    assert.equal(resolveApplicationPeriod({ applicationEnd: '2026-11-30 23:59:59' }, at('2020-01-01 00:00:00')).status, 'open');
    assert.equal(resolveApplicationPeriod({ applicationStart: '2026-10-01 10:00:00' }, at('2030-01-01 00:00:00')).status, 'open');
});

test('設定が読めないときは受け付ける（申込ごと落とさない）', () => {
    assert.equal(resolveApplicationPeriod(null, at('2020-01-01 00:00:00')).status, 'open');
});

test('申込者へ出す文言に、開始・終了の日時が入る', () => {
    assert.match(
        applicationPeriodMessage(resolveApplicationPeriod(period, at('2026-09-30 12:00:00'))),
        /2026年10月1日（木）10:00 から/
    );
    assert.match(
        applicationPeriodMessage(resolveApplicationPeriod(period, at('2026-12-01 00:00:00'))),
        /2026年11月30日（月）23:59 で終了/
    );
});

// ----------------------------------------
// 申込の受付（Worker）
// ----------------------------------------
function submitRequest() {
    const form = new FormData();
    form.append('name', '山田 花子');
    form.append('email', 'hanako@example.com');
    form.append('exhibitorName', 'ヒーリングサロン花');
    form.append('boothId', 'wall_1');
    form.append('boothName', '壁側1テーブル（標準2名）');
    form.append('menuName', 'ヒーリング 20分 2,000円');
    return new Request('https://worker.example/', { method: 'POST', body: form });
}

/**
 * GAS・GitHubのAPIを差し替え、GASへ送った中身を記録する。
 * config は最新の設定（GitHub上のconfig.json）。null なら設定の取得に失敗させる。
 */
function stubFetch(config) {
    const sentToGas = [];
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(env.GAS_URL)) {
            sentToGas.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ success: true }));
        }
        if (target === CONFIG_URL) {
            if (config === null) return new Response('boom', { status: 500 });
            return new Response(JSON.stringify({ booths: [{ id: 'wall_1' }], ...config }));
        }
        throw new Error(`想定外の通信: ${target}`);
    };
    return { sentToGas };
}

// Workerが見る「いま」を日本時間で指定する（new Date() も差し替わる）
function setNow(jst) {
    mock.timers.enable({ apis: ['Date'], now: at(jst).getTime() });
}

test('受付開始前に届いた申込は、GASへ送らず開始日時を伝える', async () => {
    const { sentToGas } = stubFetch(period);
    setNow('2026-09-30 23:00:00');

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(res.status, 200); // フォームが文言をそのまま出せるよう、通信エラーにはしない
    assert.equal(sentToGas.length, 0);
    assert.equal(body.success, false);
    assert.equal(body.applicationPeriod, 'before');
    assert.match(body.error, /2026年10月1日（木）10:00 から/);
});

test('受付終了後に届いた申込は、GASへ送らず終了を伝える', async () => {
    const { sentToGas } = stubFetch(period);
    setNow('2026-12-01 00:00:30');

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(sentToGas.length, 0);
    assert.equal(body.success, false);
    assert.equal(body.applicationPeriod, 'closed');
    assert.match(body.error, /2026年11月30日（月）23:59 で終了/);
});

test('受付期間中の申込は、これまでどおりGASへ送る', async () => {
    const { sentToGas } = stubFetch(period);
    setNow('2026-10-15 12:00:00');

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(sentToGas.length, 1);
    assert.equal(body.success, true);
});

test('受付期間が未設定なら、これまでどおりGASへ送る', async () => {
    const { sentToGas } = stubFetch({});
    setNow('2026-09-30 23:00:00');

    const res = await worker.fetch(submitRequest(), env, {});

    assert.equal(sentToGas.length, 1);
    assert.equal((await res.json()).success, true);
});

test('設定が読めないときは、申込ごと落とさずGASへ送る', async () => {
    const { sentToGas } = stubFetch(null);
    setNow('2026-09-30 23:00:00');

    const res = await worker.fetch(submitRequest(), env, {});

    assert.equal(sentToGas.length, 1);
    assert.equal((await res.json()).success, true);
});
