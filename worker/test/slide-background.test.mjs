/**
 * 申込フォームのスライドプレビュー用の背景画像（/api/public/slide-background）。
 *
 * 実行: node --test worker/test/slide-background.test.mjs
 *
 * 背景は開催ごとに差し替えるため、テンプレートからGAS経由で取り出す。
 * 公開の口なので、管理画面で設定済みのテンプレート（config.json の slideTemplates）以外は断る。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleSlideBackground } from '../src/index.js';

const env = {
    GAS_URL: 'https://script.google.com/macros/s/TEST/exec',
    GITHUB_REPO: 'owner/repo',
    GITHUB_TOKEN: 'gh-token',
};
const TEMPLATE_ID = '1Emruj-C4Io2LNP6gdp3pxzaFb73nLfrJEXP6Xx0Rub8';
const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;

afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
});

// Workersのキャッシュの代わり（テストごとに空にする）
function stubCache() {
    const store = new Map();
    globalThis.caches = {
        default: {
            match: async (req) => store.get(req.url)?.clone(),
            put: async (req, res) => { store.set(req.url, res); },
        },
    };
    return store;
}

function stubFetch(gasResult) {
    const calls = { gas: 0 };
    globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.startsWith('https://api.github.com/')) {
            return new Response(JSON.stringify({ slideTemplates: { earlySns: TEMPLATE_ID, lateSns: '' } }));
        }
        if (target.startsWith(env.GAS_URL)) {
            calls.gas++;
            calls.gasUrl = new URL(target);
            return new Response(JSON.stringify(gasResult));
        }
        throw new Error(`想定外の通信: ${target}`);
    };
    return calls;
}

const request = (t) => {
    const url = new URL(`https://worker.example/api/public/slide-background?t=${encodeURIComponent(t)}`);
    return [new Request(url), env, {}, url, null];
};

test('設定済みテンプレートの背景画像を返し、2回目はキャッシュから返す', async () => {
    stubCache();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const calls = stubFetch({ success: true, mimeType: 'image/png', base64: png.toString('base64') });

    const res = await handleSlideBackground(...request(TEMPLATE_ID));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    assert.equal(calls.gasUrl.searchParams.get('action'), 'get_slide_background');
    assert.equal(calls.gasUrl.searchParams.get('presentationId'), TEMPLATE_ID);

    const again = await handleSlideBackground(...request(TEMPLATE_ID));
    assert.equal(again.status, 200);
    assert.equal(calls.gas, 1);
});

test('設定に無いテンプレートIDは断る（GASを呼ばない）', async () => {
    stubCache();
    const calls = stubFetch({ success: true, base64: 'AA==' });

    const res = await handleSlideBackground(...request('1OtherPresentationIdXXXXXXXXXXXXXXXX'));
    assert.equal(res.status, 404);
    assert.equal(calls.gas, 0);
});

test('IDの形をしていなければ400', async () => {
    stubCache();
    stubFetch({});
    const res = await handleSlideBackground(...request('../etc'));
    assert.equal(res.status, 400);
});

test('背景が取り出せなければ404を返し、キャッシュしない', async () => {
    const store = stubCache();
    stubFetch({ success: false, error: '背景画像が見つかりません' });

    const res = await handleSlideBackground(...request(TEMPLATE_ID));
    assert.equal(res.status, 404);
    assert.equal(store.size, 0);
});
