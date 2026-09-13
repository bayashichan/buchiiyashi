/**
 * 内容確認ページのデータ取得。
 *
 * 実行: node --test worker/test/public-exhibitor-data.test.mjs
 *
 * GASが一時的にHTMLのエラーページを返した日、出展者には白紙と
 * 「Unexpected token '<'」だけが見えていた。リロードで直ったので実害は
 * 短時間だったが、開催直前に同じことが起きると連絡が事務局に集中する。
 * 一瞬の不調をページまで通さないことを、ここで確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Workers のグローバル。importより先に用意しておく
const cacheCalls = { put: [] };
let cacheHit = null;
globalThis.caches = {
    default: {
        match: async () => cacheHit,
        put: async (key, response) => { cacheCalls.put.push({ key, response }); }
    }
};

const { handlePublicExhibitorData } = await import('../src/index.js');

const CORS = { 'Access-Control-Allow-Origin': '*' };
const GAS_URL = 'https://script.google.com/macros/s/dummy/exec';
const CONFIG = { currentSpreadsheetId: 'sheet1', eventName: '第6回', captionTemplates: {} };
const BACKUP = {
    success: true,
    exhibitors: [{ id: 1, exhibitorName: '控えの出展者' }],
    captionTemplates: {},
    eventName: '第6回',
    generatedAt: '2026-09-13T00:00:00.000Z'
};

// 承認が必要なときにGASが返すHTML
const GAS_HTML = '<!DOCTYPE html><html><body><div>承認が必要です</div></body></html>';

function fakeR2(initial) {
    const store = new Map(initial ? Object.entries(initial) : []);
    return {
        store,
        get: async (key) => {
            if (!store.has(key)) return null;
            return { text: async () => store.get(key) };
        },
        put: async (key, body) => { store.set(key, body); }
    };
}

// GASの応答だけを差し替える。設定(GitHub)は常に成功させる
function stubFetch(gasResponse) {
    globalThis.fetch = async (input) => {
        const target = typeof input === 'string' ? input : input.url;
        if (target.startsWith('https://api.github.com/')) {
            return new Response(JSON.stringify(CONFIG), { status: 200 });
        }
        if (target.startsWith(GAS_URL)) {
            return gasResponse();
        }
        throw new Error(`想定外のfetch: ${target}`);
    };
}

function makeEnv(r2) {
    return { GAS_URL, GITHUB_REPO: 'owner/repo', GITHUB_TOKEN: 'token', R2_BUCKET: r2 };
}

function requestUrl() {
    return new URL('https://worker.example.com/api/public/exhibitor-data');
}

test('GASがHTMLを返しても、控えがあれば内容を出す', async () => {
    cacheHit = null;
    const r2 = fakeR2({ 'cache/exhibitor-data/default__default.json': JSON.stringify(BACKUP) });
    stubFetch(() => new Response(GAS_HTML, { status: 200 }));

    const res = await handlePublicExhibitorData(null, makeEnv(r2), CORS, requestUrl(), null);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.exhibitors[0].exhibitorName, '控えの出展者');
    // 古い可能性をページに出させるための印
    assert.equal(body.stale, true);
    // 復旧をすぐ拾えるよう、この応答は溜めない
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('控えも無ければ、Googleの文言を添えて失敗を返す', async () => {
    cacheHit = null;
    stubFetch(() => new Response(GAS_HTML, { status: 200 }));

    const res = await handlePublicExhibitorData(null, makeEnv(fakeR2()), CORS, requestUrl(), null);
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.match(body.error, /承認が必要です/);
    // 「Unexpected token '<'」だけを見せていたのが元の問題
    assert.doesNotMatch(body.error, /Unexpected token/);
});

test('取得できたらR2へ控え、次の不調に備える', async () => {
    cacheHit = null;
    const r2 = fakeR2();
    stubFetch(() => new Response(JSON.stringify({
        success: true,
        exhibitors: [{ id: 1, exhibitorName: 'テスト出展', seatNumber: 'A-1' }]
    }), { status: 200 }));

    const res = await handlePublicExhibitorData(null, makeEnv(r2), CORS, requestUrl(), null);
    const body = await res.json();

    assert.equal(body.exhibitors[0].seatNumber, 'A-1');
    assert.ok(!body.stale);
    const saved = JSON.parse(r2.store.get('cache/exhibitor-data/default__default.json'));
    assert.equal(saved.exhibitors[0].exhibitorName, 'テスト出展');
});

test('5分を過ぎたキャッシュは、そのまま返して裏で取り直す', async () => {
    const stale = new Response(JSON.stringify({ success: true, exhibitors: [] }), {
        headers: { 'X-Generated-At': new Date(Date.now() - 10 * 60 * 1000).toISOString() }
    });
    cacheHit = stale;
    cacheCalls.put.length = 0;

    let gasCalls = 0;
    stubFetch(() => {
        gasCalls++;
        return new Response(JSON.stringify({ success: true, exhibitors: [] }), { status: 200 });
    });

    const background = [];
    const ctx = { waitUntil: (p) => background.push(p) };
    const res = await handlePublicExhibitorData(null, makeEnv(fakeR2()), CORS, requestUrl(), ctx);

    // 待たせずに古い方を返す
    assert.equal(res, stale);
    assert.equal(background.length, 1);

    await Promise.all(background);
    assert.equal(gasCalls, 1);
    assert.equal(cacheCalls.put.length, 1);
});

test('5分以内のキャッシュはGASを叩かない', async () => {
    cacheHit = new Response(JSON.stringify({ success: true, exhibitors: [] }), {
        headers: { 'X-Generated-At': new Date().toISOString() }
    });

    let gasCalls = 0;
    stubFetch(() => { gasCalls++; return new Response('{}', { status: 200 }); });

    const background = [];
    await handlePublicExhibitorData(null, makeEnv(fakeR2()), CORS, requestUrl(),
        { waitUntil: (p) => background.push(p) });

    await Promise.all(background);
    assert.equal(gasCalls, 0);
    assert.equal(background.length, 0);
});
