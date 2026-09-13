/**
 * GASからの応答の読み取り。
 *
 * 実行: node --test worker/test/gas-response.test.mjs
 *
 * 内容確認ページに「Unexpected token '<', "<!DOCTYPE "... is not valid JSON」と
 * 出た。GASが承認要求などのHTMLを返しているのに、それをそのままJSONとして
 * 読んでいたため、Googleが何を言っているのかページからも追えなかった。
 * HTMLが来たときにGoogleの文言が残ることを、ここで確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGasResponseText } from '../src/index.js';

test('JSONはそのまま読める', () => {
    const result = parseGasResponseText('{"success":true,"exhibitors":[]}', 200);
    assert.equal(result.success, true);
});

test('HTMLならGoogleの文言とHTTPステータスを添えて投げる', () => {
    const html = `<!DOCTYPE html><html><head><title>エラー</title>
        <style>body{color:red}</style><script>var a = 1 < 2;</script></head>
        <body><div>承認が必要です</div><p>スクリプト機能へのアクセスが承認されていません。</p></body></html>`;

    assert.throws(() => parseGasResponseText(html, 401), (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.match(err.message, /承認が必要です/);
        assert.match(err.message, /スクリプト機能へのアクセスが承認されていません。/);
        // タグやscript・styleの中身が混ざらないこと
        assert.doesNotMatch(err.message, /<|var a|color:red/);
        return true;
    });
});

test('本文が空でもステータスは分かる', () => {
    assert.throws(() => parseGasResponseText('', 500), /HTTP 500[\s\S]*\(本文なし\)/);
});
