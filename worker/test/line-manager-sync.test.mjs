/**
 * LINE管理アプリへの再連携（管理画面 → Worker → line-manager）。
 *
 * 実行: node --test worker/test/line-manager-sync.test.mjs
 *
 * 申込時の連携は失敗しても申込を止めないため、設定の食い違いが続くと誰にもタグが付かないまま気づけない。
 * 管理画面から送り直したとき、出展者・キャンセル待ちのタグを正しく付け、断られた理由を見せることを確かめる。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { describeLineManagerError } from '../src/index.js';

const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';
const LINE_MANAGER_URL = 'https://line-manager.example';
const CONFIG_URL = 'https://api.github.com/repos/owner/repo/contents/apply/config.json';
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function makeEnv(overrides = {}) {
    return {
        ADMIN_PASSWORD: 'pw',
        GAS_URL,
        GOOGLE_OAUTH_CLIENT_ID: 'client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
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
        },
        ...overrides
    };
}

function adminRequest(path, { method = 'GET', body } = {}) {
    return new Request(`https://worker.example${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${btoa('pw')}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
}

function stubFetch({ gasResult = {}, lineManager = () => new Response(JSON.stringify({ success: true, isFriend: true, profileApplied: true })) } = {}) {
    const sent = { gas: [], lineManager: [] };
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
            return new Response(JSON.stringify({ eventName: '第7回' }));
        }
        if (target === `${LINE_MANAGER_URL}/api/applicants/register`) {
            const body = JSON.parse(init.body);
            sent.lineManager.push({ body, auth: init.headers.Authorization });
            return lineManager(body);
        }
        throw new Error(`unexpected fetch: ${target}`);
    };
    return sent;
}

test('申込者の一覧は、所有アカウントのトークンを添えてGASから取り、足りない設定も返す', async () => {
    const targets = [{ lineUserId: 'U1', exhibitorName: '花', submittedAt: '2026/10/1 12:00:00', waitlist: false }];
    const sent = stubFetch({ gasResult: { success: true, targets } });

    const res = await worker.fetch(adminRequest('/api/admin/line-manager-targets?spreadsheetId=EVENT'),
        makeEnv({ LINE_MANAGER_SECRET: undefined }), {});
    const result = await res.json();

    assert.deepEqual(sent.gas, [{ action: 'get_line_manager_targets', accessToken: 'owner-token', spreadsheetId: 'EVENT' }]);
    assert.deepEqual(result.targets, targets);
    assert.deepEqual(result.missingSettings, ['LINE_MANAGER_SECRET']);
});

test('出展者には出展者タグを付けてキャンセル待ちタグを外し、キャンセル待ちの方にはキャンセル待ちタグを付ける', async () => {
    const sent = stubFetch({
        lineManager: (body) => new Response(JSON.stringify({ success: true, isFriend: body.lineUserId === 'U1', profileApplied: true }))
    });

    const res = await worker.fetch(adminRequest('/api/admin/line-manager-sync', {
        method: 'POST',
        body: {
            targets: [
                { lineUserId: 'U1', lineDisplayName: 'はな', exhibitorName: '花', submittedAt: '2026/10/1 12:00:00', waitlist: false },
                { lineUserId: 'U2', lineDisplayName: 'つき', exhibitorName: '月', submittedAt: '2026/10/1 13:00:00', waitlist: true }
            ]
        }
    }), makeEnv(), {});
    const result = await res.json();

    assert.equal(sent.lineManager[0].auth, 'Bearer lm-secret');
    assert.deepEqual(sent.lineManager.map(s => s.body), [
        {
            channelId: 'channel-1', lineUserId: 'U1', displayName: 'はな', source: 'buchiiyashi-apply',
            appliedAt: '2026-10-01T03:00:00.000Z', internalName: '花',
            tagNames: ['第7回出展者'], removeTagNames: ['第7回キャンセル待ち']
        },
        {
            channelId: 'channel-1', lineUserId: 'U2', displayName: 'つき', source: 'buchiiyashi-apply',
            appliedAt: '2026-10-01T04:00:00.000Z', internalName: '月',
            tagNames: ['第7回キャンセル待ち']
        }
    ]);
    assert.equal(result.success, true);
    assert.deepEqual(result.results.map(r => [r.ok, r.isFriend]), [[true, true], [true, false]]);
});

test('line-managerに断られたら、直し方の分かる理由を返す', async () => {
    stubFetch({ lineManager: () => new Response(JSON.stringify({ error: '認証エラー' }), { status: 401 }) });

    const res = await worker.fetch(adminRequest('/api/admin/line-manager-sync', {
        method: 'POST',
        body: { targets: [{ lineUserId: 'U1', exhibitorName: '花' }] }
    }), makeEnv(), {});
    const result = await res.json();

    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].status, 401);
    assert.match(result.results[0].error, /HTTP 401 認証エラー：.*LINE_MANAGER_SECRET.*APPLICANT_INGEST_SECRET/);
});

test('Workerの設定が足りなければ、line-managerへは送らずに足りない設定を返す', async () => {
    const sent = stubFetch();

    const res = await worker.fetch(adminRequest('/api/admin/line-manager-sync', {
        method: 'POST',
        body: { targets: [{ lineUserId: 'U1' }] }
    }), makeEnv({ LINE_MANAGER_SECRET: '' }), {});
    const result = await res.json();

    assert.equal(result.success, false);
    assert.match(result.error, /LINE_MANAGER_SECRET/);
    assert.equal(sent.lineManager.length, 0);
});

test('一度に送れる件数を超えたら断る', async () => {
    stubFetch();
    const targets = Array.from({ length: 21 }, (_, i) => ({ lineUserId: `U${i}` }));

    const res = await worker.fetch(adminRequest('/api/admin/line-manager-sync', {
        method: 'POST',
        body: { targets }
    }), makeEnv(), {});

    assert.equal(res.status, 400);
});

test('理由の文言：JSONでない本文もそのまま残す', () => {
    assert.match(describeLineManagerError(404, '{"error":"チャネルが見つかりません"}'), /^HTTP 404 チャネルが見つかりません：.*LINE_MANAGER_CHANNEL_ID/);
    assert.equal(describeLineManagerError(418, 'teapot'), 'HTTP 418 teapot');
});
