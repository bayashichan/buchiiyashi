/**
 * 満枠のブースへの申込を、キャンセル待ちとして受け付ける。
 *
 * 実行: node --test worker/test/waitlist.test.mjs
 *
 * キャンセル待ちの人に振込先入りの案内が届くと、誤って入金されてしまう。
 * - フォームが満枠のブースを選んで送ってきたとき
 * - フォームを開いたあとに管理画面で満枠にされたとき（最新の設定で確かめる）
 * のどちらでも、GASへキャンセル待ちとして送り、LINEにも金額・振込の案内を載せないことを確かめる。
 * キャンセル待ちを知らない古いGASが受け取ったときは、申込ごと止まる（action で送るため）。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = {
    GAS_URL: 'https://script.google.com/macros/s/TEST/exec',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    GITHUB_TOKEN: 'gh-token',
    GITHUB_REPO: 'owner/repo',
};
const CONFIG_URL = 'https://api.github.com/repos/owner/repo/contents/apply/config.json';
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function submitRequest(fields = {}) {
    const form = new FormData();
    form.append('name', '山田 花子');
    form.append('email', 'hanako@example.com');
    form.append('exhibitorName', 'ヒーリングサロン花');
    form.append('boothId', 'wall_1');
    form.append('boothName', '壁側1テーブル（標準2名）');
    form.append('menuName', 'ヒーリング 20分 2,000円');
    form.append('lineUserId', 'U123');
    Object.entries(fields).forEach(([key, value]) => form.set(key, value));
    return new Request('https://worker.example/', { method: 'POST', body: form });
}

/**
 * GAS・GitHub・LINEのAPIを差し替え、GASへ送った中身とLINEへ送った本文を記録する。
 * soldOut は最新の設定（GitHub上のconfig.json）での wall_1 の満枠状態。null なら設定の取得に失敗させる。
 * waitlistEnabled は管理画面の「キャンセル待ちとして受付を続ける」。undefined なら未設定。
 */
function stubFetch({ gasResult, soldOut = false, waitlistEnabled }) {
    const sentToGas = [];
    const pushed = [];
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(env.GAS_URL)) {
            sentToGas.push(JSON.parse(init.body));
            return new Response(JSON.stringify(gasResult));
        }
        if (target === CONFIG_URL) {
            if (soldOut === null) return new Response('boom', { status: 500 });
            return new Response(JSON.stringify({ waitlistEnabled, booths: [{ id: 'wall_1', soldOut }] }));
        }
        if (target === 'https://api.line.me/v2/bot/message/push') {
            pushed.push(JSON.parse(init.body));
            return new Response('{}');
        }
        throw new Error(`想定外の通信: ${target}`);
    };
    return { sentToGas, pushed };
}

test('満枠のブースを選んだ申込は、キャンセル待ちとしてGASへ送る', async () => {
    const { sentToGas } = stubFetch({ gasResult: { success: true, waitlist: true, lineMessage: 'キャンセル待ち' } });

    const res = await worker.fetch(submitRequest({ waitlist: '1' }), env, {});
    const body = await res.json();

    assert.equal(sentToGas.length, 1);
    assert.equal(sentToGas[0].action, 'apply_waitlist');
    assert.equal(sentToGas[0].waitlist, '1');
    assert.equal(body.success, true);
    assert.equal(body.waitlist, true);
});

test('フォームを開いたあとに満枠になったブースも、最新の設定を見てキャンセル待ちにする', async () => {
    const { sentToGas } = stubFetch({ gasResult: { success: true, waitlist: true, lineMessage: 'キャンセル待ち' }, soldOut: true });

    const res = await worker.fetch(submitRequest({ waitlist: '0' }), env, {});
    const body = await res.json();

    assert.equal(sentToGas[0].action, 'apply_waitlist');
    assert.equal(sentToGas[0].waitlist, '1');
    assert.equal(body.waitlist, true);
});

test('「キャンセル待ちとして受付を続ける」がオフなら、満枠のブースへの申込は受け付けない', async () => {
    const { sentToGas, pushed } = stubFetch({ gasResult: { success: true }, soldOut: true, waitlistEnabled: false });

    const res = await worker.fetch(submitRequest({ waitlist: '1' }), env, {});
    const body = await res.json();

    assert.equal(res.status, 200); // フォームが文言をそのまま出せるよう、通信エラーにはしない
    assert.equal(body.success, false);
    assert.match(body.error, /受付を終了しました/);
    assert.equal(sentToGas.length, 0);
    assert.equal(pushed.length, 0);
});

test('「キャンセル待ちとして受付を続ける」がオンなら、満枠のブースはキャンセル待ちで受け付ける', async () => {
    const { sentToGas } = stubFetch({ gasResult: { success: true, waitlist: true, lineMessage: 'キャンセル待ち' }, soldOut: true, waitlistEnabled: true });

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(sentToGas[0].action, 'apply_waitlist');
    assert.equal(body.waitlist, true);
});

test('オフでも、満枠でないブースは通常どおり受け付ける', async () => {
    const { sentToGas } = stubFetch({ gasResult: { success: true, lineMessage: '通常' }, soldOut: false, waitlistEnabled: false });

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(body.success, true);
    assert.equal('action' in sentToGas[0], false);
});

test('空きのあるブースは通常の申込として送る', async () => {
    const { sentToGas } = stubFetch({ gasResult: { success: true, lineMessage: '通常' }, soldOut: false });

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal('action' in sentToGas[0], false);
    assert.equal(sentToGas[0].waitlist, '0');
    assert.equal(body.waitlist, false);
});

test('設定が読めないときは、フォームの判定のまま受け付ける', async () => {
    const { sentToGas } = stubFetch({ gasResult: { success: true, lineMessage: '通常' }, soldOut: null });

    const res = await worker.fetch(submitRequest(), env, {});

    assert.equal(res.status, 200);
    assert.equal('action' in sentToGas[0], false);
});

test('申込フォームから送られた action はGASへ渡さない（管理用の処理を呼ばせない）', async () => {
    const { sentToGas } = stubFetch({ gasResult: { success: true, lineMessage: '通常' } });

    await worker.fetch(submitRequest({ action: 'resend_confirmation_email' }), env, {});

    assert.equal('action' in sentToGas[0], false);
});

test('GASが受け付けなかったとき（キャンセル待ちを知らない古いデプロイ）は、LINEで受付を知らせない', async () => {
    const { pushed } = stubFetch({
        gasResult: { success: false, error: '未対応のアクションです: apply_waitlist。' },
    });

    const res = await worker.fetch(submitRequest({ waitlist: '1' }), env, {});
    const body = await res.json();

    assert.equal(body.success, false);
    assert.match(body.error, /未対応のアクション/);
    assert.equal(pushed.length, 0);
});

test('GASから全文が届かないときの要約版にも、キャンセル待ちでは金額・振込の案内を載せない', async () => {
    const { pushed } = stubFetch({ gasResult: { success: true, waitlist: true, totalFee: 16000, imageStatus: 'ok' } });

    await worker.fetch(submitRequest({ waitlist: '1' }), env, {});

    assert.equal(pushed.length, 1);
    const text = pushed[0].messages[0].text;
    assert.match(text, /キャンセル待ち/);
    assert.match(text, /お振り込みは不要です/);
    assert.doesNotMatch(text, /16,000/);
    assert.doesNotMatch(text, /お振込先へ/);
    assert.doesNotMatch(text, /お振込金額/);
});
