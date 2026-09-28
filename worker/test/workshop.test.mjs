/**
 * ワークショップブース（オプション）の申込と空き状況。
 *
 * 実行: node --test worker/test/workshop.test.mjs
 *
 * 時間帯ごとに1名だけ、申込者が選んだ時間帯を先着順で押さえる。
 * 時間帯・料金は最新の設定（config.json の workshop）から付け、フォームから届いた値は使わない。
 * 空いているかは、GASが保存の直前に（ほかの申込とぶつからないようロックの中で）数えて決める。
 * キャンセル待ちの申込は時間帯を押さえず、希望として記録する。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { workshopSettings, buildPublicWorkshopAvailability, WORKSHOP_UNAVAILABLE_MESSAGE } from '../src/index.js';

globalThis.caches = { default: { match: async () => null, put: async () => {} } };

const env = {
    GAS_URL: 'https://script.google.com/macros/s/TEST/exec',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    GITHUB_TOKEN: 'gh-token',
    GITHUB_REPO: 'owner/repo',
};
const CONFIG_URL = 'https://api.github.com/repos/owner/repo/contents/apply/config.json';
const WALL_1 = '壁側1テーブル（標準2名）';
const WORKSHOP = { enabled: true, price: 3000, startTime: '11:00', slotMinutes: 90, slotCount: 3, tables: 3, chairs: 6 };
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
    form.append('boothName', WALL_1);
    form.append('menuName', 'ヒーリング 20分 2,000円');
    form.append('lineUserId', 'U123');
    Object.entries(fields).forEach(([key, value]) => form.set(key, value));
    return new Request('https://worker.example/', { method: 'POST', body: form });
}

function stubFetch({ config, gasResult = { success: true, lineMessage: '本文' }, gasGet }) {
    const sentToGas = [];
    const pushed = [];
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(env.GAS_URL)) {
            if ((init.method || 'GET') === 'GET') return gasGet();
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
    return { sentToGas, pushed };
}

const configWith = (workshop, booth = {}) => ({
    workshop,
    booths: [{ id: 'wall_1', name: WALL_1, ...booth }, { id: 'body_small', name: 'ボディケアブース小（標準1名）' }],
});

// ----------------------------------------
// 設定の読み取り
// ----------------------------------------

test('時間帯は開始時刻・1枠の長さ・枠数から作る（11:00から90分×3枠）', () => {
    const settings = workshopSettings({ workshop: WORKSHOP });
    assert.equal(settings.price, 3000);
    assert.deepEqual(settings.slots, [
        { start: '11:00', label: '11:00〜12:30' },
        { start: '12:30', label: '12:30〜14:00' },
        { start: '14:00', label: '14:00〜15:30' },
    ]);
});

test('受付オフ・未設定・読めない設定は「ワークショップなし」', () => {
    assert.equal(workshopSettings({}), null);
    assert.equal(workshopSettings({ workshop: { ...WORKSHOP, enabled: false } }), null);
    assert.equal(workshopSettings({ workshop: { ...WORKSHOP, startTime: '25:00' } }), null);
    assert.equal(workshopSettings({ workshop: { ...WORKSHOP, slotCount: 0 } }), null);
    assert.equal(workshopSettings({ workshop: { ...WORKSHOP, price: -1 } }), null);
});

// ----------------------------------------
// 申込の受付
// ----------------------------------------

test('選んだ時間帯は apply_workshop で、設定上の表記・料金を付けてGASへ送る（フォームの料金は使わない）', async () => {
    const { sentToGas } = stubFetch({ config: configWith(WORKSHOP) });

    const res = await worker.fetch(submitRequest({ workshopSlot: '12:30', workshopFee: '0', workshopLabel: '偽' }), env, {});
    const body = await res.json();

    assert.equal(body.success, true);
    assert.equal(sentToGas[0].action, 'apply_workshop');
    assert.equal(sentToGas[0].workshopSlot, '12:30');
    assert.equal(sentToGas[0].workshopLabel, '12:30〜14:00');
    assert.equal(sentToGas[0].workshopFee, '3000');
    assert.equal('boothCapacity' in sentToGas[0], false);
});

test('定員のあるブースでも、定員を添えて apply_workshop で送る', async () => {
    const { sentToGas } = stubFetch({ config: configWith(WORKSHOP, { capacity: 5 }) });

    await worker.fetch(submitRequest({ workshopSlot: '11:00' }), env, {});

    assert.equal(sentToGas[0].action, 'apply_workshop');
    assert.equal(sentToGas[0].boothCapacity, '5');
    assert.equal(sentToGas[0].workshopSlot, '11:00');
});

test('ワークショップを選ばない申込は、従来どおり（action なし・ワークショップの項目なし）', async () => {
    const { sentToGas } = stubFetch({ config: configWith(WORKSHOP) });

    await worker.fetch(submitRequest({ workshopFee: '3000' }), env, {});

    assert.equal('action' in sentToGas[0], false);
    assert.equal('workshopSlot' in sentToGas[0], false);
    assert.equal('workshopFee' in sentToGas[0], false);
});

test('受付オフ・対象外のブース・無い時間帯は受け付けない（GASへ送らない）', async () => {
    const cases = [
        [configWith({ ...WORKSHOP, enabled: false }), '11:00', 'wall_1'],
        [configWith({ ...WORKSHOP, boothIds: ['body_small'] }), '11:00', 'wall_1'],
        [configWith(WORKSHOP), '15:30', 'wall_1'],
    ];
    for (const [config, slot, boothId] of cases) {
        const { sentToGas, pushed } = stubFetch({ config });
        const res = await worker.fetch(submitRequest({ workshopSlot: slot, boothId }), env, {});
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.success, false);
        assert.equal(body.error, WORKSHOP_UNAVAILABLE_MESSAGE);
        assert.equal(sentToGas.length, 0);
        assert.equal(pushed.length, 0);
    }
});

test('設定が読めないときは、ワークショップ付きの申込を受け付けない（料金を確かめられないため）', async () => {
    const { sentToGas } = stubFetch({ config: null });

    const res = await worker.fetch(submitRequest({ workshopSlot: '11:00' }), env, {});
    const body = await res.json();

    assert.equal(body.success, false);
    assert.match(body.error, /時間をおいて/);
    assert.equal(sentToGas.length, 0);
});

test('時間帯が先に埋まっていたら、別の時間帯を選ぶよう案内し、LINEで受付を知らせない', async () => {
    const { pushed } = stubFetch({
        config: configWith(WORKSHOP),
        gasResult: { success: false, code: 'workshop_slot_taken', error: '埋まっています' },
    });

    const res = await worker.fetch(submitRequest({ workshopSlot: '12:30' }), env, {});
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, false);
    assert.match(body.error, /12:30〜14:00/);
    assert.match(body.error, /別の時間帯/);
    assert.equal(body.workshopSlotTaken, '12:30');
    assert.equal(pushed.length, 0);
});

test('キャンセル待ちの申込は、時間帯を押さえずに希望としてGASへ送る', async () => {
    const { sentToGas, pushed } = stubFetch({
        config: configWith(WORKSHOP, { soldOut: true }),
        gasResult: { success: true, waitlist: true },
    });

    const res = await worker.fetch(submitRequest({ workshopSlot: '11:00', waitlist: '1' }), env, {});
    const body = await res.json();

    assert.equal(body.waitlist, true);
    assert.equal(sentToGas[0].action, 'apply_waitlist');
    assert.equal(sentToGas[0].workshopSlot, '11:00');
    // LINEの要約版（GASから全文が届かないとき）でも、未確保であることが分かる
    const text = pushed[0].messages[0].text;
    assert.match(text, /ワークショップブース（ご希望）: 11:00〜12:30 ※時間帯は未確保です/);
});

test('定員に達してGASがキャンセル待ちにしたら、LINEの要約版も希望として案内する', async () => {
    const { pushed } = stubFetch({
        config: configWith(WORKSHOP, { capacity: 1 }),
        gasResult: { success: true, waitlist: true },
    });

    const res = await worker.fetch(submitRequest({ workshopSlot: '14:00' }), env, {});
    const body = await res.json();

    assert.equal(body.waitlist, true);
    assert.match(pushed[0].messages[0].text, /（ご希望）: 14:00〜15:30/);
});

test('押さえた時間帯は、LINEの要約版に時間帯を載せる', async () => {
    const { pushed } = stubFetch({
        config: configWith(WORKSHOP),
        gasResult: { success: true, waitlist: false, totalFee: 20000 },
    });

    await worker.fetch(submitRequest({ workshopSlot: '11:00' }), env, {});

    const text = pushed[0].messages[0].text;
    assert.match(text, /ワークショップブース: 11:00〜12:30/);
    assert.match(text, /20,000/);
});

// ----------------------------------------
// 空き状況（公開API）
// ----------------------------------------

test('空き状況：埋まった時間帯を満枠として返し、出展名は載せない', async () => {
    stubFetch({
        config: configWith(WORKSHOP),
        gasGet: () => new Response(JSON.stringify({ success: true, counts: {}, workshopReservations: { '12:30': ['ヒーリングサロン花'] } })),
    });

    const res = await worker.fetch(new Request('https://worker.example/api/public/booth-availability'), env, {});
    const text = await res.text();
    const body = JSON.parse(text);

    assert.deepEqual(body.workshop, {
        slots: { '11:00': { full: false }, '12:30': { full: true }, '14:00': { full: false } },
    });
    assert.doesNotMatch(text, /ヒーリングサロン花/);
});

test('空き状況：ワークショップが受付オフなら workshop は null（定員もなければGASに問い合わせない）', async () => {
    stubFetch({ config: configWith({ ...WORKSHOP, enabled: false }) });

    const res = await worker.fetch(new Request('https://worker.example/api/public/booth-availability'), env, {});
    const body = await res.json();

    assert.equal(body.workshop, null);
});

test('空き状況：時間帯の予約を返さない古いGASでも、全枠を空きとして返す', () => {
    assert.deepEqual(buildPublicWorkshopAvailability({ workshop: WORKSHOP }, null).slots['11:00'], { full: false });
});
