/**
 * 申込完了のLINE通知。
 *
 * 実行: node --test worker/test/line-confirmation.test.mjs
 *
 * 確認メールと同じ内容の本文はGASが組み立てて lineMessage で返す。
 * Workerはそれを1通のテキストメッセージとしてそのまま送り、ブラウザへは返さない。
 * GASが古いデプロイのままで lineMessage が無いときは、要約版を送る。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { selectLineConfirmationText } from '../src/index.js';

const env = {
    GAS_URL: 'https://script.google.com/macros/s/TEST/exec',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
};
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function submitRequest() {
    const form = new FormData();
    form.append('name', '山田 花子');
    form.append('email', 'hanako@example.com');
    form.append('exhibitorName', 'ヒーリングサロン花');
    form.append('boothName', '壁側1テーブル（標準2名）');
    form.append('menuName', 'ヒーリング 20分 2,000円');
    form.append('lineUserId', 'U123');
    return new Request('https://worker.example/', { method: 'POST', body: form });
}

// GASとLINEのAPIを差し替え、LINEへ送った本文を記録する
function stubFetch(gasResult) {
    const pushed = [];
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(env.GAS_URL)) {
            return new Response(JSON.stringify(gasResult));
        }
        if (target === 'https://api.line.me/v2/bot/message/push') {
            pushed.push(JSON.parse(init.body));
            return new Response('{}');
        }
        throw new Error(`想定外の通信: ${target}`);
    };
    return pushed;
}

test('GASが組み立てた全文を、1通のテキストメッセージとして本人へ送る', async () => {
    const lineMessage = '山田 花子 様\n\n━━━━━━━━━━\n■ お申し込み内容\n━━━━━━━━━━\n出展名：ヒーリングサロン花';
    const pushed = stubFetch({ success: true, totalFee: 16000, imageStatus: 'ok', lineMessage });

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].to, 'U123');
    assert.equal(pushed[0].messages.length, 1);
    assert.deepEqual(pushed[0].messages[0], { type: 'text', text: lineMessage });

    // LINE用の本文はブラウザへ返さない
    assert.equal(body.success, true);
    assert.equal('lineMessage' in body, false);
    assert.equal(body.imageStatus, 'ok');
});

test('GASが全文を返さないとき（古いデプロイ）は要約版を送る', async () => {
    const pushed = stubFetch({ success: true, totalFee: 16000, imageStatus: 'ok' });

    await worker.fetch(submitRequest(), env, {});

    assert.equal(pushed.length, 1);
    const text = pushed[0].messages[0].text;
    assert.match(text, /山田 花子 様/);
    assert.match(text, /出展名: ヒーリングサロン花/);
    assert.match(text, /¥16,000/);
});

test('上限の5000文字を超える本文は切り詰める', () => {
    const text = selectLineConfirmationText({}, { lineMessage: 'あ'.repeat(6000) });
    assert.equal(text.length, 5000);
    assert.ok(text.endsWith('…'));
});
