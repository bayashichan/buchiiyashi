/**
 * ブースごとの定員（残枠）と、申込フォームへの残枠の見せ方。
 *
 * 実行: node --test worker/test/booth-capacity.test.mjs
 *
 * 定員のあるブースは、申込が定員に達した時点で満枠になり、以降はキャンセル待ち（または受付終了）になる。
 * 最後の1枠に同時に申し込まれても定員を超えないよう、空きの判定はGASが保存の直前に数えて行う。
 * Workerは最新の設定から定員を添えてGASへ送り、GASの判定を完了画面・LINEの案内に反映する。
 *
 * 残枠の表示は管理画面で「表示しない / 最初から表示 / 残りわずかで表示」を選べる。
 * 表示しない設定のときは、公開APIの応答にも数字を載せない。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { boothCapacity, buildPublicBoothAvailability, BOOTH_CLOSED_MESSAGE } from '../src/index.js';

// Workers のグローバル（エッジキャッシュ）。常に取り直させる
const cachePuts = [];
globalThis.caches = {
    default: {
        match: async () => null,
        put: async (key, response) => { cachePuts.push({ key, response }); }
    }
};

const env = {
    GAS_URL: 'https://script.google.com/macros/s/TEST/exec',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    GITHUB_TOKEN: 'gh-token',
    GITHUB_REPO: 'owner/repo',
};
const CONFIG_URL = 'https://api.github.com/repos/owner/repo/contents/apply/config.json';
const WALL_1 = '壁側1テーブル（標準2名）';
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    cachePuts.length = 0;
});

function submitRequest(fields = {}) {
    const form = new FormData();
    form.append('name', '山田 花子');
    form.append('email', 'hanako@example.com');
    form.append('exhibitorName', 'ヒーリングサロン花');
    form.append('boothId', 'wall_1');
    form.append('boothName', WALL_1);
    form.append('menuName', 'ヒーリング 20分 2,000円');
    form.append('lineUserId', 'U123');
    Object.entries(fields).forEach(([key, value]) => form.set(key, value));
    return new Request('https://worker.example/', { method: 'POST', body: form });
}

function availabilityRequest() {
    return new Request('https://worker.example/api/public/booth-availability', { method: 'GET' });
}

/**
 * GAS・GitHub・LINEのAPIを差し替え、GASへ送った中身・GASへの問い合わせ・LINEへ送った本文を記録する。
 * config は最新の設定（GitHub上のconfig.json）。null なら取得に失敗させる。
 * gasGet はGASへのGET（申込数の問い合わせ）への応答。
 */
function stubFetch({ config, gasResult = { success: true }, gasGet }) {
    const sentToGas = [];
    const gasQueries = [];
    const pushed = [];
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(env.GAS_URL)) {
            if ((init.method || 'GET') === 'GET') {
                gasQueries.push(Object.fromEntries(new URL(target).searchParams));
                if (!gasGet) throw new Error('GASへの問い合わせは想定していない');
                return gasGet();
            }
            sentToGas.push(JSON.parse(init.body));
            return new Response(JSON.stringify(gasResult));
        }
        if (target === CONFIG_URL) {
            if (config === null) return new Response('boom', { status: 500 });
            return new Response(JSON.stringify(config));
        }
        if (target === 'https://api.line.me/v2/bot/message/push') {
            pushed.push(JSON.parse(init.body));
            return new Response('{}');
        }
        throw new Error(`想定外の通信: ${target}`);
    };
    return { sentToGas, gasQueries, pushed };
}

// ----------------------------------------
// 定員の読み取り
// ----------------------------------------

test('定員は0以上の整数だけを有効とし、空欄や読めない値は「定員なし」にする', () => {
    assert.equal(boothCapacity({ capacity: 5 }), 5);
    assert.equal(boothCapacity({ capacity: '3' }), 3);
    assert.equal(boothCapacity({ capacity: 0 }), 0);
    assert.equal(boothCapacity({ capacity: '' }), null);
    assert.equal(boothCapacity({ capacity: null }), null);
    assert.equal(boothCapacity({}), null);
    assert.equal(boothCapacity({ capacity: -1 }), null);
    assert.equal(boothCapacity({ capacity: 2.5 }), null);
    assert.equal(boothCapacity(undefined), null);
});

// ----------------------------------------
// 申込の受付（定員のあるブース）
// ----------------------------------------

test('定員のあるブースは、定員・キャンセル待ちの受付設定・設定上のブース名を添えてGASへ送る', async () => {
    const { sentToGas } = stubFetch({
        config: { booths: [{ id: 'wall_1', name: WALL_1, capacity: 3 }] },
        gasResult: { success: true, waitlist: false, lineMessage: '通常' },
    });

    // フォームから届いたブース名は使わない（GASはシートのブース名で数えるため）
    const res = await worker.fetch(submitRequest({ boothName: '書き換えられた名前' }), env, {});
    const body = await res.json();

    assert.equal(sentToGas.length, 1);
    assert.equal(sentToGas[0].action, 'apply_limited');
    assert.equal(sentToGas[0].boothCapacity, '3');
    assert.equal(sentToGas[0].waitlistEnabled, '1'); // 未設定はオン扱い
    assert.equal(sentToGas[0].boothName, WALL_1);
    assert.equal(body.success, true);
    assert.equal(body.waitlist, false);
});

test('GASが定員に達したと判定したら、キャンセル待ちとして完了画面に伝え、LINEにも金額・振込の案内を載せない', async () => {
    const { pushed } = stubFetch({
        config: { booths: [{ id: 'wall_1', name: WALL_1, capacity: 3 }] },
        // lineMessage が無いので、Workerの要約版がLINEに送られる
        gasResult: { success: true, waitlist: true, totalFee: 16000, imageStatus: 'ok' },
    });

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(body.success, true);
    assert.equal(body.waitlist, true);
    assert.equal(pushed.length, 1);
    const text = pushed[0].messages[0].text;
    assert.match(text, /キャンセル待ち/);
    assert.doesNotMatch(text, /16,000/);
    assert.doesNotMatch(text, /お振込金額/);
});

test('定員に達していてキャンセル待ちも受け付けない設定なら、受付終了の文言を返し、LINEで受付を知らせない', async () => {
    const { sentToGas, pushed } = stubFetch({
        config: { waitlistEnabled: false, booths: [{ id: 'wall_1', name: WALL_1, capacity: 3 }] },
        gasResult: { success: false, code: 'booth_full', error: 'お選びのブースは満枠のため、受付を終了しました。' },
    });

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(sentToGas[0].waitlistEnabled, '0');
    assert.equal(res.status, 200); // フォームが文言をそのまま出せるよう、通信エラーにはしない
    assert.equal(body.success, false);
    assert.equal(body.error, BOOTH_CLOSED_MESSAGE);
    assert.equal(pushed.length, 0);
});

test('定員を知らない古いGASは申込ごと止まり、LINEで受付を知らせない（定員を超えて振込先を案内しないため）', async () => {
    const { pushed } = stubFetch({
        config: { booths: [{ id: 'wall_1', name: WALL_1, capacity: 3 }] },
        gasResult: { success: false, error: '未対応のアクションです: apply_limited。' },
    });

    const res = await worker.fetch(submitRequest(), env, {});
    const body = await res.json();

    assert.equal(body.success, false);
    assert.match(body.error, /未対応のアクション/);
    assert.equal(pushed.length, 0);
});

test('キャンセル待ちの画面を見て申し込んだ人は、定員のあるブースでもキャンセル待ちのまま送る', async () => {
    const { sentToGas } = stubFetch({
        config: { booths: [{ id: 'wall_1', name: WALL_1, capacity: 3 }] },
        gasResult: { success: true, waitlist: true, lineMessage: 'キャンセル待ち' },
    });

    const res = await worker.fetch(submitRequest({ waitlist: '1' }), env, {});
    const body = await res.json();

    assert.equal(sentToGas[0].action, 'apply_waitlist');
    assert.equal('boothCapacity' in sentToGas[0], false);
    assert.equal(body.waitlist, true);
});

test('手動の満枠チェックは定員より優先する', async () => {
    const { sentToGas } = stubFetch({
        config: { booths: [{ id: 'wall_1', name: WALL_1, capacity: 10, soldOut: true }] },
        gasResult: { success: true, waitlist: true, lineMessage: 'キャンセル待ち' },
    });

    await worker.fetch(submitRequest(), env, {});

    assert.equal(sentToGas[0].action, 'apply_waitlist');
});

test('フォームから届いた定員・受付設定はGASへ渡さない（定員のないブースでも）', async () => {
    const { sentToGas } = stubFetch({
        config: { booths: [{ id: 'wall_1', name: WALL_1 }] },
        gasResult: { success: true, lineMessage: '通常' },
    });

    await worker.fetch(submitRequest({ boothCapacity: '999', waitlistEnabled: '1' }), env, {});

    assert.equal('action' in sentToGas[0], false);
    assert.equal('boothCapacity' in sentToGas[0], false);
    assert.equal('waitlistEnabled' in sentToGas[0], false);
});

// ----------------------------------------
// 申込フォームの空き状況（公開API）
// ----------------------------------------

test('定員のあるブースが無ければ、GASに問い合わせず満枠チェックだけを返す', async () => {
    const { gasQueries } = stubFetch({
        config: {
            remainingDisplay: 'always',
            booths: [{ id: 'wall_1', name: WALL_1, soldOut: true }, { id: 'wall_2', name: '壁側2' }],
        },
    });

    const res = await worker.fetch(availabilityRequest(), env, {});
    const body = await res.json();

    assert.equal(gasQueries.length, 0);
    assert.deepEqual(body.booths, { wall_1: { full: true }, wall_2: { full: false } });
});

test('申込数はイベント用スプレッドシートで数え、定員に達したブースを満枠として返す', async () => {
    const { gasQueries } = stubFetch({
        config: {
            currentSpreadsheetId: 'sheet-7th',
            booths: [{ id: 'wall_1', name: WALL_1, capacity: 2 }, { id: 'wall_2', name: '壁側2', capacity: 5 }],
        },
        gasGet: () => new Response(JSON.stringify({ success: true, counts: { [WALL_1]: 2, '壁側2': 1 } })),
    });

    const res = await worker.fetch(availabilityRequest(), env, {});
    const body = await res.json();

    assert.equal(gasQueries[0].action, 'get_booth_counts');
    assert.equal(gasQueries[0].spreadsheetId, 'sheet-7th');
    assert.equal(body.booths.wall_1.full, true);
    assert.equal(body.booths.wall_2.full, false);
    assert.equal(cachePuts.length, 1);
});

test('残枠を「表示しない」設定（未設定も同じ）では、応答に残りの枠数を載せない', () => {
    const booths = [{ id: 'wall_1', name: WALL_1, capacity: 5 }];
    const counts = { [WALL_1]: 4 };

    assert.deepEqual(buildPublicBoothAvailability({ booths }, counts), { wall_1: { full: false } });
    assert.deepEqual(
        buildPublicBoothAvailability({ remainingDisplay: 'hidden', booths }, counts),
        { wall_1: { full: false } }
    );
});

test('「最初から表示」では定員のあるブースに残りの枠数を載せ、しきい値以下は残りわずかとする', () => {
    const config = {
        remainingDisplay: 'always',
        remainingDisplayThreshold: 2,
        booths: [
            { id: 'a', name: 'A', capacity: 10 },
            { id: 'b', name: 'B', capacity: 3 },
            { id: 'c', name: 'C', capacity: 1 },
            { id: 'd', name: 'D' },
        ],
    };

    const result = buildPublicBoothAvailability(config, { A: 3, B: 1, C: 1 });

    assert.deepEqual(result.a, { full: false, remaining: 7, few: false });
    assert.deepEqual(result.b, { full: false, remaining: 2, few: true });
    assert.deepEqual(result.c, { full: true }); // 満枠には数字を出さない（満枠の表示になる）
    assert.deepEqual(result.d, { full: false }); // 定員のないブース
});

test('「残りわずかで表示」では、しきい値以下になるまで残りの枠数を載せない', () => {
    const config = {
        remainingDisplay: 'few',
        remainingDisplayThreshold: 3,
        booths: [{ id: 'a', name: 'A', capacity: 10 }, { id: 'b', name: 'B', capacity: 10 }],
    };

    const result = buildPublicBoothAvailability(config, { A: 6, B: 7 });

    assert.deepEqual(result.a, { full: false });
    assert.deepEqual(result.b, { full: false, remaining: 3, few: true });
});

test('申込数はブース名の前後の空白を無視して照合し、定員を超えていても残りは0とする', () => {
    const config = { remainingDisplay: 'always', booths: [{ id: 'a', name: ' A ', capacity: 2 }] };

    assert.deepEqual(buildPublicBoothAvailability(config, { A: 3 }).a, { full: true });
});

test('申込数が取れないとき（GASの不調・古いデプロイ）は 502 を返し、キャッシュに残さない', async () => {
    stubFetch({
        config: { booths: [{ id: 'wall_1', name: WALL_1, capacity: 2 }] },
        gasGet: () => new Response(JSON.stringify({ error: 'Invalid action (GAS): get_booth_counts' })),
    });

    const res = await worker.fetch(availabilityRequest(), env, {});

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(cachePuts.length, 0);
});
