/**
 * キャンセル待ちの繰り上げ（管理画面 → Worker → GAS）。
 *
 * 実行: node --test worker/test/waitlist-promote.test.mjs
 *
 * 繰り上げは、申込データを動かして振込先入りの案内を送る操作なので、
 * 一斉メールと同じく管理画面の認証を通ったときだけ、所有アカウントのトークンを添えてGASへ渡す。
 * LINE連携済みの方には、GASが組み立てた本文をWorkerがLINEでも送る（メールと二本立て）。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_MANAGER_URL = 'https://line-manager.example';
const CONFIG_URL = 'https://api.github.com/repos/owner/repo/contents/apply/config.json';
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function makeEnv() {
    return {
        ADMIN_PASSWORD: 'pw',
        GAS_URL,
        GOOGLE_OAUTH_CLIENT_ID: 'client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
        LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
        LINE_MANAGER_URL,
        LINE_MANAGER_SECRET: 'lm-secret',
        LINE_MANAGER_CHANNEL_ID: 'channel-1',
        GITHUB_TOKEN: 'gh-token',
        GITHUB_REPO: 'owner/repo',
        R2_BUCKET: {
            async get(key) {
                if (key !== 'config/google-oauth.json') return null;
                return { text: async () => JSON.stringify({ refresh_token: 'refresh' }) };
            }
        }
    };
}

function adminRequest(path, { method = 'GET', body, password = 'pw' } = {}) {
    return new Request(`https://worker.example${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${btoa(password)}`,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
}

// GoogleのトークンAPI・GAS・LINEを差し替え、送った中身を記録する
function stubFetch(gasResult, { lineStatus = 200, lineManagerStatus = 200 } = {}) {
    const sent = { gas: [], line: [], lineManager: [] };
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target === 'https://oauth2.googleapis.com/token') {
            return new Response(JSON.stringify({ access_token: 'owner-token' }));
        }
        if (target.startsWith(GAS_URL)) {
            sent.gas.push(JSON.parse(init.body));
            return new Response(JSON.stringify(gasResult));
        }
        if (target === CONFIG_URL) {
            return new Response(JSON.stringify({ eventName: '第7回ぶち癒やしフェスタin東京' }));
        }
        if (target === `${LINE_MANAGER_URL}/api/applicants/register`) {
            sent.lineManager.push(JSON.parse(init.body));
            return lineManagerStatus === 200
                ? new Response(JSON.stringify({ success: true, isFriend: true, profileApplied: true, tagsRemoved: true }))
                : new Response('error', { status: lineManagerStatus });
        }
        if (target === LINE_PUSH_URL) {
            sent.line.push(JSON.parse(init.body));
            return new Response(lineStatus === 200 ? '{}' : 'forbidden', { status: lineStatus });
        }
        throw new Error(`unexpected fetch: ${target}`);
    };
    return sent;
}

const KEY = '2026/10/01 12:00:00\thanako@example.com\t花';

test('管理画面の認証がなければ、GASへは何も送らない', async () => {
    const sent = stubFetch({ success: true, results: [] });

    const res = await worker.fetch(adminRequest('/api/admin/promote-waitlist', {
        method: 'POST',
        password: 'wrong',
        body: { keys: [KEY] }
    }), makeEnv(), {});

    assert.equal(res.status, 401);
    assert.equal(sent.gas.length, 0);
});

test('一覧は、所有アカウントのトークンを添えてGASから取る', async () => {
    const entries = [{ key: KEY, exhibitorName: '花', boothName: '内側1テーブル（標準2名）', totalFee: 14000 }];
    const sent = stubFetch({ success: true, entries, boothCounts: { '内側1テーブル（標準2名）': 3 } });

    const res = await worker.fetch(adminRequest('/api/admin/waitlist?spreadsheetId=EVENT'), makeEnv(), {});
    const result = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(result.entries, entries);
    assert.deepEqual(sent.gas, [{ action: 'get_waitlist', accessToken: 'owner-token', spreadsheetId: 'EVENT' }]);
});

test('選んだ方が無ければ、GASへは送らない', async () => {
    const sent = stubFetch({ success: true, results: [] });

    const res = await worker.fetch(adminRequest('/api/admin/promote-waitlist', {
        method: 'POST',
        body: { keys: [] }
    }), makeEnv(), {});

    assert.equal(res.status, 400);
    assert.equal(sent.gas.length, 0);
});

test('繰り上げたLINE連携済みの方には、GASの本文をLINEでも送る。本文と送り先はブラウザへ返さない', async () => {
    const sent = stubFetch({
        success: true,
        results: [
            {
                key: KEY, exhibitorName: '花', sentTo: 'hanako@example.com', isTest: false, moved: true, success: true,
                totalFee: 14000, lineUserId: 'U123', lineMessage: '山田 花子 様\n\n出展が確定いたしました。\n振込先…'
            },
            { key: 'k2', exhibitorName: '月', sentTo: 'tsuki@example.com', isTest: false, moved: true, success: true, lineUserId: '', lineMessage: '' },
            { key: 'k3', exhibitorName: '星', moved: false, success: false, error: 'キャンセル待ちシートに見つかりません' }
        ]
    });

    const res = await worker.fetch(adminRequest('/api/admin/promote-waitlist', {
        method: 'POST',
        body: { spreadsheetId: 'EVENT', databaseSpreadsheetId: 'MASTER', keys: [KEY, 'k2', 'k3'] }
    }), makeEnv(), {});
    const result = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(sent.gas, [{
        action: 'promote_waitlist',
        accessToken: 'owner-token',
        spreadsheetId: 'EVENT',
        databaseSpreadsheetId: 'MASTER',
        keys: [KEY, 'k2', 'k3'],
        testEmail: ''
    }]);

    assert.equal(sent.line.length, 1);
    assert.equal(sent.line[0].to, 'U123');
    assert.match(sent.line[0].messages[0].text, /出展が確定いたしました/);

    assert.equal(result.results[0].lineSent, true);
    assert.equal(result.results[1].lineSent, undefined);
    assert.equal(result.results[2].success, false);
    result.results.forEach(r => {
        assert.equal('lineMessage' in r, false);
        assert.equal('lineUserId' in r, false);
    });
});

test('LINEが届かなくても繰り上げは成功のまま、届かなかったことだけ返す', async () => {
    stubFetch({
        success: true,
        results: [{ key: KEY, success: true, moved: true, isTest: false, lineUserId: 'U123', lineMessage: '本文' }]
    }, { lineStatus: 403 });

    const res = await worker.fetch(adminRequest('/api/admin/promote-waitlist', {
        method: 'POST',
        body: { keys: [KEY] }
    }), makeEnv(), {});
    const result = await res.json();

    assert.equal(result.success, true);
    assert.equal(result.results[0].success, true);
    assert.equal(result.results[0].lineSent, false);
});

test('テスト送信では、LINEは送らない', async () => {
    const sent = stubFetch({
        success: true,
        results: [{ key: KEY, success: true, moved: false, isTest: true, sentTo: 'staff@example.com', lineUserId: 'U123', lineMessage: '本文' }]
    });

    const res = await worker.fetch(adminRequest('/api/admin/promote-waitlist', {
        method: 'POST',
        body: { keys: [KEY], testEmail: 'staff@example.com' }
    }), makeEnv(), {});

    assert.equal(res.status, 200);
    assert.equal(sent.gas[0].testEmail, 'staff@example.com');
    assert.equal(sent.line.length, 0);
    assert.equal(sent.lineManager.length, 0);
});

test('繰り上げたLINE連携済みの方は、LINE管理アプリのタグをキャンセル待ちから出展者へ付け替える', async () => {
    const sent = stubFetch({
        success: true,
        results: [
            {
                key: KEY, exhibitorName: '花\nの部屋', success: true, moved: true, isTest: false,
                lineUserId: 'U123', lineDisplayName: 'はな', submittedAt: '2026/10/1 12:00:00', lineMessage: '本文'
            },
            // 行は移したがメールだけ失敗した方も、タグは付け替える
            {
                key: 'k2', exhibitorName: '月', success: false, moved: true, error: 'メールを送れませんでした',
                lineUserId: 'U456', lineDisplayName: 'つき', submittedAt: '2026/10/01 12:05:00', lineMessage: ''
            },
            // 行を移せなかった方は付け替えない
            { key: 'k3', exhibitorName: '星', success: false, moved: false, error: '見つかりません', lineUserId: '' }
        ]
    });

    const res = await worker.fetch(adminRequest('/api/admin/promote-waitlist', {
        method: 'POST',
        body: { keys: [KEY, 'k2', 'k3'] }
    }), makeEnv(), {});
    const result = await res.json();

    assert.deepEqual(sent.lineManager, [
        {
            channelId: 'channel-1',
            lineUserId: 'U123',
            displayName: 'はな',
            source: 'buchiiyashi-apply',
            appliedAt: '2026-10-01T03:00:00.000Z',
            internalName: '花 の部屋',
            tagNames: ['第7回出展者'],
            removeTagNames: ['第7回キャンセル待ち']
        },
        {
            channelId: 'channel-1',
            lineUserId: 'U456',
            displayName: 'つき',
            source: 'buchiiyashi-apply',
            appliedAt: '2026-10-01T03:05:00.000Z',
            internalName: '月',
            tagNames: ['第7回出展者'],
            removeTagNames: ['第7回キャンセル待ち']
        }
    ]);
    assert.equal(result.results[0].lineTagUpdated, true);
    assert.equal(result.results[1].lineTagUpdated, true);
    assert.equal(result.results[2].lineTagUpdated, undefined);
    result.results.forEach(r => {
        assert.equal('lineDisplayName' in r, false);
        assert.equal('submittedAt' in r, false);
    });
});

test('LINE管理アプリへの連携に失敗しても繰り上げは成功のまま、失敗したことだけ返す', async () => {
    stubFetch({
        success: true,
        results: [{ key: KEY, success: true, moved: true, isTest: false, lineUserId: 'U123', lineMessage: '本文' }]
    }, { lineManagerStatus: 500 });

    const res = await worker.fetch(adminRequest('/api/admin/promote-waitlist', {
        method: 'POST',
        body: { keys: [KEY] }
    }), makeEnv(), {});
    const result = await res.json();

    assert.equal(result.results[0].success, true);
    assert.equal(result.results[0].lineSent, true);
    assert.equal(result.results[0].lineTagUpdated, false);
});
