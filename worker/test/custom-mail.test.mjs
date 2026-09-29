/**
 * 過去出展者への一斉メール（管理画面 → Worker → GAS）。
 *
 * 実行: node --test worker/test/custom-mail.test.mjs
 *
 * GASのWebアプリURLは公開されているため、GASは所有アカウント本人のGoogleトークンが
 * 添えられているときだけ送信・一覧の取得に応じる。Workerが管理画面の認証を通った
 * リクエストにだけトークンを付けて中継することを確かめる。
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';
const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function makeEnv({ connected = true } = {}) {
    return {
        ADMIN_PASSWORD: 'pw',
        GAS_URL,
        GOOGLE_OAUTH_CLIENT_ID: 'client-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
        R2_BUCKET: {
            async get(key) {
                if (!connected || key !== 'config/google-oauth.json') return null;
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

// GoogleのトークンAPIとGASを差し替え、GASへ送った中身を記録する
function stubFetch(gasResult) {
    const sentToGas = [];
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target === 'https://oauth2.googleapis.com/token') {
            return new Response(JSON.stringify({ access_token: 'owner-token' }));
        }
        if (target.startsWith(GAS_URL)) {
            sentToGas.push(JSON.parse(init.body));
            return new Response(JSON.stringify(gasResult));
        }
        throw new Error(`unexpected fetch: ${target}`);
    };
    return sentToGas;
}

test('管理画面の認証がなければ、GASへは何も送らない', async () => {
    const sentToGas = stubFetch({ success: true });

    const res = await worker.fetch(adminRequest('/api/admin/send-custom-email', {
        method: 'POST',
        password: 'wrong',
        body: { emails: ['a@example.com'], subject: '件名', body: '本文' }
    }), makeEnv(), {});

    assert.equal(res.status, 401);
    assert.equal(sentToGas.length, 0);
});

test('送信先一覧は、所有アカウントのトークンを添えてGASから取る', async () => {
    const recipients = [{ email: 'hanako@example.com', name: '山田 花子', exhibitorName: '花', events: ['第6回'] }];
    const sentToGas = stubFetch({ success: true, recipients, skipped: 1, remainingQuota: 100 });

    const res = await worker.fetch(
        adminRequest('/api/admin/mail-recipients?spreadsheetId=MASTER'), makeEnv(), {});
    const result = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(result.recipients, recipients);
    assert.deepEqual(sentToGas, [{
        action: 'get_mail_recipients', accessToken: 'owner-token', spreadsheetId: 'MASTER', applicationStart: ''
    }]);
});

test('送信は、宛先・件名・本文・テスト送信先をそのままGASへ渡す', async () => {
    const sentToGas = stubFetch({ success: true, results: [{ email: 'hanako@example.com', success: true }] });

    const res = await worker.fetch(adminRequest('/api/admin/send-custom-email', {
        method: 'POST',
        body: {
            spreadsheetId: 'MASTER',
            emails: ['hanako@example.com'],
            subject: '{{氏名}}様へ次回のご案内',
            body: '{{氏名}} 様\n\n次回もよろしくお願いします。',
            testEmail: 'staff@example.com'
        }
    }), makeEnv(), {});

    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
    assert.deepEqual(sentToGas, [{
        action: 'send_custom_email',
        accessToken: 'owner-token',
        spreadsheetId: 'MASTER',
        emails: ['hanako@example.com'],
        subject: '{{氏名}}様へ次回のご案内',
        body: '{{氏名}} 様\n\n次回もよろしくお願いします。',
        testEmail: 'staff@example.com',
        applicationStart: ''
    }]);
});

// 受付開始日より前の日は、GASが申込の確認メール用の枠を残さない（全部を一斉メールに使う）。
// その判定に使う受付開始日時を、Workerが最新の設定（GitHub上のconfig.json）から付けて渡す
const CONFIG_URL = 'https://api.github.com/repos/owner/repo/contents/apply/config.json';

function stubFetchWithConfig(gasResult, config) {
    const sentToGas = stubFetch(gasResult);
    const gasFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url) === CONFIG_URL) {
            return config === null
                ? new Response('boom', { status: 500 })
                : new Response(JSON.stringify(config));
        }
        return gasFetch(url, init);
    };
    return sentToGas;
}

const githubEnv = () => ({ ...makeEnv(), GITHUB_TOKEN: 'gh-token', GITHUB_REPO: 'owner/repo' });

test('送信先一覧・送信とも、管理画面で設定した受付開始日時をGASへ渡す', async () => {
    const sentToGas = stubFetchWithConfig({ success: true, recipients: [] }, { applicationStart: '2026-10-05 10:00:00' });

    await worker.fetch(adminRequest('/api/admin/mail-recipients?spreadsheetId=MASTER'), githubEnv(), {});
    await worker.fetch(adminRequest('/api/admin/send-custom-email', {
        method: 'POST',
        body: { spreadsheetId: 'MASTER', emails: ['hanako@example.com'], subject: '件名', body: '本文' }
    }), githubEnv(), {});

    assert.deepEqual(sentToGas.map(p => [p.action, p.applicationStart]), [
        ['get_mail_recipients', '2026-10-05 10:00:00'],
        ['send_custom_email', '2026-10-05 10:00:00']
    ]);
});

test('受付開始日時が未設定・設定が読めないときは空で渡す（GASは確認メール用の枠を残す）', async () => {
    for (const config of [{}, null]) {
        const sentToGas = stubFetchWithConfig({ success: true, recipients: [] }, config);

        const res = await worker.fetch(adminRequest('/api/admin/mail-recipients'), githubEnv(), {});

        assert.equal(res.status, 200);
        assert.equal(sentToGas[0].applicationStart, '');
    }
});

test('宛先・件名・本文が欠けていれば、GASへ送らずに断る', async () => {
    const sentToGas = stubFetch({ success: true });
    const cases = [
        [{ emails: [], subject: '件名', body: '本文' }, '送信先が選択されていません'],
        [{ emails: ['a@example.com'], subject: '  ', body: '本文' }, '件名を入力してください'],
        [{ emails: ['a@example.com'], subject: '件名', body: '\n' }, '本文を入力してください']
    ];

    for (const [body, message] of cases) {
        const res = await worker.fetch(adminRequest('/api/admin/send-custom-email', { method: 'POST', body }), makeEnv(), {});
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, message);
    }
    assert.equal(sentToGas.length, 0);
});

test('Googleアカウントが未連携なら、連携を案内してGASへは送らない', async () => {
    const sentToGas = stubFetch({ success: true });

    const res = await worker.fetch(adminRequest('/api/admin/send-custom-email', {
        method: 'POST',
        body: { emails: ['a@example.com'], subject: '件名', body: '本文' }
    }), makeEnv({ connected: false }), {});

    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /Googleアカウントが未連携です/);
    assert.equal(sentToGas.length, 0);
});
