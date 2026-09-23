/**
 * LINE連携での前回内容呼び出し（/api/repeater/line）。
 *
 * 実行: node --test worker/test/repeater-line.test.mjs
 *
 * GASのURLは公開されているため、userIdを渡すだけの作りにすると他人の申込内容を
 * 引けてしまう。Workerはブラウザから受け取ったアクセストークンをそのままGASへ渡し、
 * 本人確認はGAS側（LINEのAPIでトークンを検証）に任せる。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = { GAS_URL: 'https://script.google.com/macros/s/TEST/exec' };
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function lineRequest(body) {
    return new Request('https://worker.example/api/repeater/line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

test('アクセストークンをGASへ渡し、GASの結果をそのまま返す', async () => {
    let calledUrl = null;
    globalThis.fetch = async (url) => {
        calledUrl = new URL(url);
        return new Response(JSON.stringify({ success: true, found: true, count: 1, list: [{ exhibitorName: 'テスト' }] }));
    };

    const res = await worker.fetch(lineRequest({ accessToken: 'tok-123' }), env, {});
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(calledUrl.searchParams.get('action'), 'search_by_line');
    assert.equal(calledUrl.searchParams.get('accessToken'), 'tok-123');
    // userIdはブラウザから受け取らないし、GASへも渡さない
    assert.equal(calledUrl.searchParams.has('lineUserId'), false);
    assert.equal(body.found, true);
    assert.equal(body.list[0].exhibitorName, 'テスト');
});

test('トークンが無ければGASを呼ばずに400を返す', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('{}'); };

    const res = await worker.fetch(lineRequest({ lineUserId: 'U123' }), env, {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).success, false);
    assert.equal(called, false);
});

test('本文がJSONでなければ400を返す', async () => {
    const res = await worker.fetch(lineRequest('not json'), env, {});
    assert.equal(res.status, 400);
});

test('GASがHTMLを返したら502で失敗を返す（申込フォームはメール認証へ案内する）', async () => {
    globalThis.fetch = async () => new Response('<!DOCTYPE html><html><body>エラー</body></html>', { status: 500 });

    const res = await worker.fetch(lineRequest({ accessToken: 'tok-123' }), env, {});
    assert.equal(res.status, 502);
    assert.equal((await res.json()).success, false);
});
