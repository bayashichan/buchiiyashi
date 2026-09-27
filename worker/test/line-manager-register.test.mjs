/**
 * LINE管理アプリ(line-manager)への申込者連携。
 *
 * 実行: node --test worker/test/line-manager-register.test.mjs
 *
 * 申込者の出展名を管理用ネームとして、開催回のタグ（第7回出展者）とあわせて送る。
 * キャンセル待ちは出展が決まっていないため「第7回キャンセル待ち」にする。
 * GASが受け付けなかった申込には、出展名もタグも送らない。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildLineManagerProfile } from '../src/index.js';

const env = {
    GAS_URL: 'https://script.google.com/macros/s/TEST/exec',
    LINE_MANAGER_URL: 'https://line-manager.example',
    LINE_MANAGER_SECRET: 'secret',
    LINE_MANAGER_CHANNEL_ID: 'channel-uuid',
};
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function submitRequest(fields = {}) {
    const form = new FormData();
    form.append('name', '山田 花子');
    form.append('email', 'hanako@example.com');
    form.append('exhibitorName', 'ヒーリングサロン\n花');
    form.append('eventName', '第7回');
    form.append('lineUserId', 'U123');
    form.append('lineDisplayName', 'はなこ');
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return new Request('https://worker.example/', { method: 'POST', body: form });
}

// GASとline-managerを差し替え、line-managerへ送った本文を記録する
function stubFetch(gasResult) {
    const sent = [];
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(env.GAS_URL)) {
            return new Response(JSON.stringify(gasResult));
        }
        if (target === `${env.LINE_MANAGER_URL}/api/applicants/register`) {
            assert.equal(init.headers.Authorization, 'Bearer secret');
            sent.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ success: true, isFriend: true, profileApplied: true }));
        }
        throw new Error(`想定外の通信: ${target}`);
    };
    return sent;
}

test('出展名を管理用ネームに、開催回の出展者タグとあわせて送る', async () => {
    const sent = stubFetch({ success: true });

    const res = await worker.fetch(submitRequest(), env, {});

    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channelId, 'channel-uuid');
    assert.equal(sent[0].lineUserId, 'U123');
    assert.equal(sent[0].displayName, 'はなこ');
    assert.equal(sent[0].internalName, 'ヒーリングサロン 花');
    assert.deepEqual(sent[0].tagNames, ['第7回出展者']);
});

test('キャンセル待ちは出展者タグではなく、キャンセル待ちのタグにする', async () => {
    const sent = stubFetch({ success: true });

    await worker.fetch(submitRequest({ waitlist: '1' }), env, {});

    assert.equal(sent.length, 1);
    assert.equal(sent[0].internalName, 'ヒーリングサロン 花');
    assert.deepEqual(sent[0].tagNames, ['第7回キャンセル待ち']);
});

test('GASが受け付けなかった申込には、出展名もタグも送らない', async () => {
    const sent = stubFetch({ success: false, error: '入力エラー' });

    await worker.fetch(submitRequest(), env, {});

    assert.equal(sent.length, 1);
    assert.equal(sent[0].lineUserId, 'U123');
    assert.equal('internalName' in sent[0], false);
    assert.equal('tagNames' in sent[0], false);
});

test('開催回が「第◯回」の形でなければそのまま使い、無ければタグを付けない', () => {
    assert.deepEqual(
        buildLineManagerProfile({ exhibitorName: '花', eventName: '第12回 ぶち癒しフェスタ' }).tagNames,
        ['第12回出展者']
    );
    assert.deepEqual(
        buildLineManagerProfile({ exhibitorName: '花', eventName: '2027春' }).tagNames,
        ['2027春出展者']
    );
    assert.deepEqual(buildLineManagerProfile({ exhibitorName: '花' }).tagNames, []);
    assert.equal(buildLineManagerProfile({ exhibitorName: '  ' }).internalName, null);
});
