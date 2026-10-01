/**
 * ぶち癒しフェスタ東京 Cloudflare Worker
 * フォームデータ中継・画像Base64変換・GAS連携（Drive保存）
 * + 管理API（config更新・GASデプロイ）
 * + SNS一括投稿API（Facebook / Instagram、即時・予約）
 */

import { handleSocialAPI, runDueJobs } from './social.js';
import { handleTicketAPI, handleTicketAdminAPI, runTicketSchedule } from './tickets.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS対応
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        // プリフライトリクエスト
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // ルーティング
        if (url.pathname === '/api/repeater') {
            return handleRepeaterSearch(request, env, corsHeaders);
        }

        if (url.pathname === '/api/repeater/line' && request.method === 'POST') {
            return handleRepeaterLineSearch(request, env, corsHeaders);
        }

        // Googleからのリダイレクト。ブラウザが直接開くため管理画面の認証ヘッダーが付かない。
        // 代わりにstateで照合する（handleGoogleOAuthCallback内）
        if (url.pathname === '/oauth/google/callback') {
            return handleGoogleOAuthCallback(env, request);
        }

        if (url.pathname.startsWith('/api/admin')) {
            return handleAdminAPI(request, env, corsHeaders, url, ctx);
        }

        // 申込フォームのスライドプレビュー用の背景画像
        if (url.pathname === '/api/public/slide-background' && request.method === 'GET') {
            return handleSlideBackground(request, env, corsHeaders, url, ctx);
        }

        // 公開用確認データ取得API
        if (url.pathname === '/api/public/exhibitor-data' && request.method === 'GET') {
            return handlePublicExhibitorData(request, env, corsHeaders, url, ctx);
        }

        // 申込フォームの空き状況（満枠・残枠）
        if (url.pathname === '/api/public/booth-availability' && request.method === 'GET') {
            return handleBoothAvailability(request, env, corsHeaders, url, ctx);
        }

        // 整理券システム（来場者向け）
        if (url.pathname.startsWith('/api/tickets/')) {
            const ticketResponse = await handleTicketAPI(request, env, corsHeaders, url);
            if (ticketResponse) return ticketResponse;
        }

        // 既存のフォーム送信処理
        return handleFormSubmission(request, env, corsHeaders);
    },

    // Cron Trigger: 予約時刻を過ぎたSNS投稿の実行と、整理券の抽選・配信
    async scheduled(event, env, ctx) {
        ctx.waitUntil(
            runDueJobs(env)
                .then(count => {
                    if (count > 0) console.log(`Social scheduler: processed ${count} job(s)`);
                })
                .catch(err => console.error('Social scheduler error:', err))
        );

        // 抽選日時が来た券種の抽選と、送りきれていない配信の続き。
        // SNS投稿とは独立させ、片方が落ちてももう片方は動くようにする。
        ctx.waitUntil(
            runTicketSchedule(env)
                .then(result => {
                    if (result.lotteries || result.delivered || result.reminded || result.recovered) {
                        console.log(
                            `整理券スケジューラ: 抽選${result.lotteries}件 / ` +
                            `結果配信${result.delivered}件 / リマインド${result.reminded}件 / ` +
                            `復旧${result.recovered}件`
                        );
                    }
                })
                .catch(err => console.error('整理券スケジューラ エラー:', err))
        );
    }
};

// ========================================
// 管理API
// ========================================
async function handleAdminAPI(request, env, corsHeaders, url, ctx) {
    // 認証チェック
    const authResult = verifyAuth(request, env);
    if (!authResult.success) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        // /api/admin/social/* - SNS投稿（Facebook / Instagram）
        if (url.pathname.startsWith('/api/admin/social')) {
            const socialResponse = await handleSocialAPI(request, env, corsHeaders, url, ctx);
            if (socialResponse) return socialResponse;
        }

        // /api/admin/tickets/* - 整理券（券種設定・抽選・配信・当日受付）
        if (url.pathname.startsWith('/api/admin/tickets')) {
            const ticketResponse = await handleTicketAdminAPI(request, env, corsHeaders, url);
            if (ticketResponse) return ticketResponse;
        }

        // GET /api/admin/config - 設定取得
        if (url.pathname === '/api/admin/config' && request.method === 'GET') {
            return await getConfig(env, corsHeaders);
        }

        // POST /api/admin/config - 設定更新
        if (url.pathname === '/api/admin/config' && request.method === 'POST') {
            const newConfig = await request.json();
            return await updateConfig(env, newConfig, corsHeaders);
        }

        // POST /api/admin/deploy-gas - GASデプロイ
        if (url.pathname === '/api/admin/deploy-gas' && request.method === 'POST') {
            return await deployGas(env, corsHeaders);
        }

        // GET /api/admin/google-oauth/status - Google連携の状態
        if (url.pathname === '/api/admin/google-oauth/status' && request.method === 'GET') {
            return await getGoogleOAuthStatus(env, corsHeaders);
        }

        // GET /api/admin/google-oauth/start - 連携を開始するURLを返す
        if (url.pathname === '/api/admin/google-oauth/start' && request.method === 'GET') {
            return await startGoogleOAuth(env, request, corsHeaders);
        }

        // POST /api/admin/google-oauth/disconnect - 連携を解除
        if (url.pathname === '/api/admin/google-oauth/disconnect' && request.method === 'POST') {
            return await disconnectGoogleOAuth(env, corsHeaders);
        }

        // POST /api/admin/create-spreadsheet - 新規スプレッドシート作成
        if (url.pathname === '/api/admin/create-spreadsheet' && request.method === 'POST') {
            const body = await request.json();
            return await createSpreadsheet(env, body, corsHeaders);
        }

        // GET /api/admin/exhibitors - 出展者一覧取得
        if (url.pathname === '/api/admin/exhibitors' && request.method === 'GET') {
            const spreadsheetId = url.searchParams.get('spreadsheetId');
            return await getExhibitors(env, spreadsheetId, corsHeaders);
        }

        // GET /api/admin/booth-counts - ブースごとの申込数（満枠設定タブで残枠を確かめるため）
        if (url.pathname === '/api/admin/booth-counts' && request.method === 'GET') {
            return await getBoothCounts(env, url.searchParams.get('spreadsheetId'), corsHeaders);
        }

        // GET /api/admin/image-folders - 確認サイト参照先の候補フォルダ一覧取得
        if (url.pathname === '/api/admin/image-folders' && request.method === 'GET') {
            return await getImageFolders(env, corsHeaders);
        }

        // POST /api/admin/resend-confirmation - 申込時自動返信メールの再送
        if (url.pathname === '/api/admin/resend-confirmation' && request.method === 'POST') {
            const body = await request.json();
            return await resendConfirmation(env, body, corsHeaders);
        }

        // GET /api/admin/waitlist - キャンセル待ちの一覧（繰り上げる人を選ぶため）
        if (url.pathname === '/api/admin/waitlist' && request.method === 'GET') {
            return await getWaitlist(env, url.searchParams.get('spreadsheetId'), corsHeaders);
        }

        // POST /api/admin/promote-waitlist - キャンセル待ちを繰り上げ、料金・振込先入りの案内を送る
        if (url.pathname === '/api/admin/promote-waitlist' && request.method === 'POST') {
            const body = await request.json();
            return await promoteWaitlist(env, body, corsHeaders);
        }

        // GET /api/admin/line-manager-targets - LINE管理アプリへ送り直す申込者（LINE連携済みの方）
        if (url.pathname === '/api/admin/line-manager-targets' && request.method === 'GET') {
            return await getLineManagerTargets(env, url.searchParams.get('spreadsheetId'), corsHeaders);
        }

        // POST /api/admin/line-manager-sync - 選んだ申込者をLINE管理アプリへ送り直す（出展名・開催回タグ）
        if (url.pathname === '/api/admin/line-manager-sync' && request.method === 'POST') {
            const body = await request.json();
            return await syncLineManagerApplicants(env, body, corsHeaders);
        }

        // GET /api/admin/mail-recipients - 一斉メールの送信先（マスターDBの過去出展者）
        if (url.pathname === '/api/admin/mail-recipients' && request.method === 'GET') {
            const spreadsheetId = url.searchParams.get('spreadsheetId');
            return await getMailRecipients(env, spreadsheetId, corsHeaders);
        }

        // POST /api/admin/send-custom-email - 過去出展者へ任意の件名・本文でメール送信
        if (url.pathname === '/api/admin/send-custom-email' && request.method === 'POST') {
            const body = await request.json();
            return await sendCustomEmail(env, body, corsHeaders);
        }

        // POST /api/admin/generate-image - 画像生成
        if (url.pathname === '/api/admin/generate-image' && request.method === 'POST') {
            const body = await request.json();
            return await generateImage(env, body, corsHeaders);
        }

        // POST /api/admin/generate-batch-images - 一括画像生成
        if (url.pathname === '/api/admin/generate-batch-images' && request.method === 'POST') {
            const body = await request.json();
            return await generateBatchImages(env, body, corsHeaders);
        }

        // POST /api/admin/create-slide-template - スライドテンプレート作成
        if (url.pathname === '/api/admin/create-slide-template' && request.method === 'POST') {
            const body = await request.json();
            return await createSlideTemplate(env, body, corsHeaders);
        }

        // POST /api/admin/combine-presentations - スライド結合
        if (url.pathname === '/api/admin/combine-presentations' && request.method === 'POST') {
            const body = await request.json();
            return await combinePresentationsWorker(env, body, corsHeaders);
        }

        // GET /api/admin/fetch-image - 画像取得プロキシ
        if (url.pathname === '/api/admin/fetch-image' && request.method === 'GET') {
            const imageUrl = url.searchParams.get('url');
            if (!imageUrl) {
                return new Response(JSON.stringify({ error: 'url property is required' }), {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
            
            try {
                // Google DriveのDLリダイレクトを手動で追跡
                let fetchUrl = imageUrl;
                
                // drive.google.comのUCUrlをlh3に変換するためただちにリクエスト
                const imgRes = await fetch(fetchUrl, {
                    redirect: 'follow',
                    headers: {
                        'User-Agent': 'Mozilla/5.0'
                    }
                });
                
                if (!imgRes.ok) {
                    return new Response(JSON.stringify({ error: `Upstream error: ${imgRes.status}` }), {
                        status: imgRes.status,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
                
                const contentType = imgRes.headers.get('Content-Type') || 'image/png';
                const imageData = await imgRes.arrayBuffer();
                
                return new Response(imageData, {
                    status: 200,
                    headers: {
                        ...corsHeaders,
                        'Content-Type': contentType,
                        'Cache-Control': 'public, max-age=3600'
                    }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: err.message }), {
                    status: 500,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Admin API error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// 認証検証
function verifyAuth(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { success: false };
    }

    const token = authHeader.slice(7);
    try {
        const password = atob(token);
        if (password === env.ADMIN_PASSWORD) {
            return { success: true };
        }
    } catch (e) {
        // Base64デコードエラー
    }
    return { success: false };
}

// 設定取得（GitHubからconfig.jsonを読み、オブジェクトで返す）
async function fetchConfigObject(env) {
    const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/apply/config.json`,
        {
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3.raw',
                'User-Agent': 'BuchiiyashiFesta-Admin'
            }
        }
    );

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
    }

    return JSON.parse(await response.text());
}

// 設定取得（管理APIのレスポンス用）
async function getConfig(env, corsHeaders) {
    const config = await fetchConfigObject(env);

    return new Response(JSON.stringify(config), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// config.jsをパース
function parseConfigJs(jsContent) {
    // 最初に全てのコメントを削除
    let cleaned = jsContent
        .replace(/\/\*[\s\S]*?\*\//g, '')  // ブロックコメント削除
        .replace(/\/\/.*$/gm, '');          // 行コメント削除

    // const/let CONFIG = { から最後の }; までを抽出
    const startMatch = cleaned.match(/(const|let)\s+CONFIG\s*=\s*\{/);
    if (!startMatch) {
        throw new Error('Could not find CONFIG declaration');
    }

    const startIndex = startMatch.index + startMatch[0].length - 1; // '{' の位置

    // 括弧のバランスを追跡して終端を見つける
    let depth = 0;
    let endIndex = -1;
    for (let i = startIndex; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') {
            depth--;
            if (depth === 0) {
                endIndex = i;
                break;
            }
        }
    }

    if (endIndex === -1) {
        throw new Error('Could not find end of CONFIG object');
    }

    let objStr = cleaned.substring(startIndex, endIndex + 1);

    // シングルクォートをダブルクォートに（キー処理より先に）
    objStr = objStr.replace(/'/g, '"');

    // trailing comma除去（複数回）
    objStr = objStr.replace(/,(\s*[}\]])/g, '$1');
    objStr = objStr.replace(/,(\s*[}\]])/g, '$1');

    // キーをダブルクォートで囲む（改行があるうちに処理）
    // パターン: {の後、,の後、改行の後にあるキー
    objStr = objStr.replace(/([\{\[,\n]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

    // 改行をスペースに変換
    objStr = objStr.replace(/[\r\n]+/g, ' ');

    // 複数のスペースを1つに
    objStr = objStr.replace(/\s+/g, ' ');

    try {
        return JSON.parse(objStr);
    } catch (e) {
        console.error('JSON parse error:', e.message);
        console.error('Object string (first 1000 chars):', objStr.slice(0, 1000));
        throw new Error('Failed to parse config as JSON: ' + e.message);
    }
}

// 設定更新（GitHubにconfig.jsonを保存）
async function updateConfig(env, newConfig, corsHeaders) {
    // まず現在のファイル情報を取得（sha必要）
    const fileInfoResponse = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/apply/config.json`,
        {
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'BuchiiyashiFesta-Admin'
            }
        }
    );

    let sha = null;
    if (fileInfoResponse.ok) {
        const fileInfo = await fileInfoResponse.json();
        sha = fileInfo.sha;
    } else if (fileInfoResponse.status !== 404) {
        // 404以外はエラー
        throw new Error(`GitHub API error: ${fileInfoResponse.status}`);
    }

    // config.jsonを生成（整形して保存）
    const newConfigJson = JSON.stringify(newConfig, null, 2);
    const encodedContent = btoa(unescape(encodeURIComponent(newConfigJson)));

    // APIリクエストボディ
    const requestBody = {
        message: '管理画面から設定更新',
        content: encodedContent
    };
    if (sha) {
        requestBody.sha = sha;
    }

    // GitHubに保存
    const updateResponse = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/apply/config.json`,
        {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'BuchiiyashiFesta-Admin'
            },
            body: JSON.stringify(requestBody)
        }
    );

    if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        throw new Error(`GitHub update failed: ${updateResponse.status} ${errorText}`);
    }

    return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// JSONからconfig.jsを生成
function generateConfigJs(config) {
    const lines = [
        '/**',
        ' * ぶち癒しフェスタ東京 設定ファイル',
        ' * ブース定義・料金・オプション制限を管理',
        ' */',
        'const CONFIG = {'
    ];

    // スケジュール設定
    lines.push(`  // ■ スケジュール設定`);
    lines.push(`  earlyBirdDeadline: "${config.earlyBirdDeadline}",`);
    lines.push('');

    // 会員特典
    lines.push(`  // ■ 会員特典（ステルス適用：メール通知時に減額）`);
    lines.push(`  memberDiscount: ${config.memberDiscount},`);
    lines.push('');

    // オプション単価
    lines.push(`  // ■ オプション・参加費単価`);
    lines.push(`  unitPrices: {`);
    lines.push(`    chair: ${config.unitPrices.chair},`);
    lines.push(`    power: ${config.unitPrices.power},`);
    lines.push(`    staff: ${config.unitPrices.staff},`);
    lines.push(`    party: ${config.unitPrices.party},`);
    lines.push(`    secondaryParty: ${config.unitPrices.secondaryParty || 3000}`);
    lines.push(`  },`);
    lines.push('');

    // カテゴリ
    lines.push(`  // ■ カテゴリ定義`);
    lines.push(`  categories: [`);
    if (config.categories) {
        config.categories.forEach(cat => {
            lines.push(`    "${cat}",`);
        });
    }
    lines.push(`  ],`);
    lines.push('');

    // システム設定
    lines.push(`  // ■ システム設定`);
    lines.push(`  workerUrl: "${config.workerUrl || 'https://buchiiyashi-festa-form.buchiiyashi-festa.workers.dev'}",`);
    lines.push(`  liffId: "${config.liffId || ''}",`);
    lines.push('');

    // ブース定義
    lines.push(`  // ■ ブース定義`);
    lines.push(`  booths: [`);
    if (config.booths) {
        config.booths.forEach(booth => {
            lines.push(`    {`);
            lines.push(`      id: "${booth.id}",`);
            lines.push(`      name: "${booth.name}",`);
            lines.push(`      location: "${booth.location}",`);
            if (booth.prohibitSession) {
                lines.push(`      prohibitSession: true,`);
            }
            if (booth.soldOut) {
                lines.push(`      soldOut: true,`);
            }
            lines.push(`      prices: { regular: ${booth.prices.regular}, earlyBird: ${booth.prices.earlyBird} },`);
            lines.push(`      limits: { maxStaff: ${booth.limits.maxStaff}, maxChairs: ${booth.limits.maxChairs}, allowPower: ${booth.limits.allowPower} }`);
            lines.push(`    },`);
        });
    }
    lines.push(`  ]`);
    lines.push(`};`);
    lines.push('');

    return lines.join('\n');
}

// ========================================
// GAS連携（応答の読み取り）
// ========================================
/**
 * GASからの応答をJSONとして読む。
 *
 * GASが例外を投げたり承認が必要な状態だと、JSONではなくHTMLのエラーページが返る。
 * それをそのままJSONとして読むと「Unexpected token '<'」としか分からず、
 * Googleが何を言っているのか追えない。中身を添えて投げ直す。
 */
export function parseGasResponseText(text, status) {
    try {
        return JSON.parse(text);
    } catch (e) {
        const snippet = text
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 400);
        throw new Error(
            `GASがJSONではない応答を返しました (HTTP ${status})。\n`
            + `Googleからの表示: ${snippet || '(本文なし)'}`
        );
    }
}

// GASのWebアプリへPOSTしてJSONを受け取る
async function postToGas(env, payload) {
    const response = await fetch(env.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow'
    });

    return parseGasResponseText(await response.text(), response.status);
}

/**
 * GASのWebアプリをGETで叩いてJSONを受け取る。
 *
 * paramsはクエリパラメータ。値がnull/undefinedのものは付けない。
 * POST側と同じく、HTMLが返ったらGoogleの文言を添えて投げ直す。
 */
async function getGasJson(env, params) {
    const gasUrl = new URL(env.GAS_URL);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') {
            gasUrl.searchParams.append(key, value);
        }
    });

    const response = await fetch(gasUrl.toString(), {
        method: 'GET',
        headers: { 'User-Agent': 'Cloudflare-Worker' },
        redirect: 'follow'
    });

    return parseGasResponseText(await response.text(), response.status);
}

/**
 * GASのデプロイ。実際の反映はGAS側（selfUpdateFromRepo）が行う。
 *
 * サービスアカウントではApps Script APIの書き込みができない。アカウントごとの
 * 有効化設定を持てないためで、読み取りは通るのに書き込みだけが403になる。
 * スクリプト自身のトークンなら所有アカウントの権限で動くので、Workerは
 * 引き金を引くだけにして、GitHubからの取得と反映はGAS側にやらせる。
 */
async function deployGas(env, corsHeaders) {
    // Apps Script APIの呼び出しに使うトークン。スクリプト自身のトークンでは
    // 操作できない既定のCloudプロジェクトに紐づいてしまうため、所有アカウント
    // 本人のトークンを渡す
    const accessToken = await getGoogleUserAccessToken(env);

    const result = await postToGas(env, { action: 'self_update', accessToken });

    if (!result.success) {
        throw new Error(result.error || 'GASでの更新に失敗しました');
    }

    return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Googleスプレッドシート作成
async function createSpreadsheet(env, body, corsHeaders) {
    try {
        const { name } = body;
        if (!name) {
            return new Response(JSON.stringify({ error: 'Spreadsheet name is required' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // 作成はGASを動かしているアカウントの権限で行われるため、トークンは渡さない
        console.log(`Sending create spreadsheet request to GAS for: ${name}`);
        const gasResponse = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'create_spreadsheet',
                name: name
            })
        });

        if (!gasResponse.ok) {
            const errorText = await gasResponse.text();
            throw new Error(`GAS request failed: ${gasResponse.status} ${errorText}`);
        }

        const result = await gasResponse.json();
        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Create spreadsheet error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// ========================================
// 出展者一覧・画像生成API
// ========================================

// 出展者一覧取得
async function getExhibitors(env, spreadsheetId, corsHeaders) {
    try {
        // GASがHTMLを返したときは、そのまま素通しせずGoogleの文言をエラーにして返す
        const data = await getGasJson(env, { action: 'get_exhibitors', spreadsheetId });

        return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Get exhibitors error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// ブースごとの申込数（「申込データ」シートの出展ブース名ごとの件数）
async function getBoothCounts(env, spreadsheetId, corsHeaders) {
    try {
        const data = await getGasJson(env, { action: 'get_booth_counts', spreadsheetId });

        return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Get booth counts error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// 確認サイト参照先の候補フォルダ一覧取得（GASへ中継）
async function getImageFolders(env, corsHeaders) {
    try {
        const gasUrl = new URL(env.GAS_URL);
        gasUrl.searchParams.append('action', 'list_image_folders');

        const response = await fetch(gasUrl.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'Cloudflare-Worker' },
            redirect: 'follow'
        });

        const data = await response.text();
        return new Response(data, {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Get image folders error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// 個別画像生成
async function generateImage(env, body, corsHeaders) {
    try {
        const { templateId, exhibitorData, imageType } = body;

        if (!templateId || !exhibitorData || !imageType) {
            return new Response(JSON.stringify({ error: 'templateId, exhibitorData, imageType are required' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const response = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'generate_image',
                templateId,
                exhibitorData,
                imageType
            })
        });

        const result = await response.json();
        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Generate image error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// 一括画像生成
async function generateBatchImages(env, body, corsHeaders) {
    try {
        const { templateId, exhibitorIds, imageType, spreadsheetId } = body;

        if (!templateId || !imageType) {
            return new Response(JSON.stringify({ error: 'templateId, imageType are required' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const response = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'generate_batch_images',
                templateId,
                exhibitorIds: exhibitorIds || [],
                imageType,
                spreadsheetId
            })
        });

        const result = await response.json();
        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Generate batch images error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// 申込時自動返信メールの再送（GASへ中継）
async function resendConfirmation(env, body, corsHeaders) {
    try {
        const { spreadsheetId, rowIds, testEmail } = body;

        if (!Array.isArray(rowIds) || rowIds.length === 0) {
            return new Response(JSON.stringify({ error: 'rowIds is required' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const result = await postToGas(env, {
            action: 'resend_confirmation_email',
            spreadsheetId: spreadsheetId || '',
            rowIds,
            testEmail: testEmail || ''
        });

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Resend confirmation error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// ========================================
// キャンセル待ちの繰り上げ（GASへ中継）
// ========================================
//
// 連絡先を返す・申込データを動かす・振込先入りのメールを送る操作なので、一斉メールと同じく
// 管理画面の認証を通ったリクエストにだけ、連携済みのGoogleトークンを付けてGASへ渡す。

// ========================================
// LINE管理アプリへの再連携（管理画面用）
// ========================================
//
// 申込時の連携は失敗しても申込を止めない（ログのみ）ため、設定の食い違いなどで失敗が続くと
// 誰にもタグが付かないまま気づけない。管理画面からシートの申込者を送り直し、
// line-managerが断った理由をその場で見せる。

// 1リクエストで送り直す上限（Workerの外部リクエスト数の上限に収めるため）
export const LINE_MANAGER_SYNC_MAX = 20;

async function getLineManagerTargets(env, spreadsheetId, corsHeaders) {
    try {
        const accessToken = await getGoogleUserAccessToken(env);
        const result = await postToGas(env, {
            action: 'get_line_manager_targets',
            accessToken,
            spreadsheetId: spreadsheetId || ''
        });

        return new Response(JSON.stringify({ ...result, missingSettings: missingLineManagerSettings(env) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Get line-manager targets error:', error);
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 申込者をLINE管理アプリへ送り直す。申込時と同じ連携で、出展名を管理用ネームに、開催回タグを付ける。
 * 出展者（申込データ）は「第◯回出展者」を付けて「第◯回キャンセル待ち」を外す（繰り上げた方を含むため）。
 * キャンセル待ちの方は「第◯回キャンセル待ち」を付ける。
 */
async function syncLineManagerApplicants(env, body, corsHeaders) {
    const targets = Array.isArray(body && body.targets) ? body.targets : [];
    if (targets.length === 0 || targets.length > LINE_MANAGER_SYNC_MAX) {
        return new Response(JSON.stringify({
            success: false,
            error: targets.length === 0 ? '送り直す方がいません' : `一度に送れるのは${LINE_MANAGER_SYNC_MAX}件までです`
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const missing = missingLineManagerSettings(env);
    if (missing.length > 0) {
        return new Response(JSON.stringify({
            success: false,
            error: `Workerの設定が足りません（${missing.join('・')}）。Cloudflareのシークレットをご確認ください`
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const eventName = await loadLatestEventName(env);
    const results = [];
    for (const target of targets) {
        const data = {
            lineUserId: String(target.lineUserId || ''),
            lineDisplayName: target.lineDisplayName || '',
            exhibitorName: target.exhibitorName || '',
            eventName,
            submittedAt: sheetDateTimeToIso(target.submittedAt),
            waitlist: target.waitlist ? '1' : '0'
        };
        const profile = target.waitlist ? buildLineManagerProfile(data) : buildPromotedLineManagerProfile(data);
        const synced = await registerApplicantToLineManager(data, env, true, profile);
        results.push({ lineUserId: data.lineUserId, exhibitorName: data.exhibitorName, waitlist: !!target.waitlist, ...synced });
    }

    return new Response(JSON.stringify({ success: true, eventName, results }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// 最新の設定のイベント名（読めなければ ''。タグは付け替えず、管理用ネームだけ連携する）
async function loadLatestEventName(env) {
    const config = await loadLatestConfig(env);
    return String((config && config.eventName) || '');
}

// キャンセル待ちの一覧
async function getWaitlist(env, spreadsheetId, corsHeaders) {
    try {
        const accessToken = await getGoogleUserAccessToken(env);
        const result = await postToGas(env, {
            action: 'get_waitlist',
            accessToken,
            spreadsheetId: spreadsheetId || ''
        });

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Get waitlist error:', error);
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 選んだキャンセル待ちの方を繰り上げる。
 *
 * GASが行を「申込データ」へ移して、料金・振込先入りの確認メールを送る。
 * LINE連携済みの方には、GASが組み立てた同じ内容の本文をここからLINEでも送る（申込時と同じ二本立て）。
 * テスト送信（testEmail あり）のときは、GASは行を動かさずテスト先へメールだけ送り、LINEは送らない。
 */
async function promoteWaitlist(env, body, corsHeaders) {
    const { spreadsheetId, databaseSpreadsheetId, keys, testEmail } = body || {};

    if (!Array.isArray(keys) || keys.length === 0) {
        return new Response(JSON.stringify({ success: false, error: '繰り上げる方が選択されていません' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        const accessToken = await getGoogleUserAccessToken(env);
        const result = await postToGas(env, {
            action: 'promote_waitlist',
            accessToken,
            spreadsheetId: spreadsheetId || '',
            databaseSpreadsheetId: databaseSpreadsheetId || '',
            keys,
            testEmail: testEmail || ''
        });

        const rows = (result && result.results) || [];
        // LINE管理アプリのタグに開催回を使う（申込時と同じく、最新の設定のイベント名から）
        const promotedWithLine = rows.filter(row => row.moved && !row.isTest && row.lineUserId);
        const eventName = promotedWithLine.length > 0 ? await loadLatestEventName(env) : '';

        // LINEの本文と送り先はWorkerで使うためのもの。ブラウザへは「送れたか」だけ返す
        const results = [];
        for (const row of rows) {
            const { lineMessage, lineUserId, lineDisplayName, submittedAt, ...rest } = row;
            if (row.success && !row.isTest && lineUserId && lineMessage) {
                rest.lineSent = await sendLineConfirmation({ lineUserId }, { lineMessage }, env);
            }
            // メールが送れなかった方も、繰り上げ（行の移動）は済んでいるのでタグは付け替える
            if (row.moved && !row.isTest && lineUserId) {
                const data = {
                    lineUserId,
                    lineDisplayName,
                    exhibitorName: row.exhibitorName,
                    eventName,
                    submittedAt: sheetDateTimeToIso(submittedAt)
                };
                const synced = await registerApplicantToLineManager(
                    data, env, true, buildPromotedLineManagerProfile(data));
                rest.lineTagUpdated = synced.ok;
                if (!synced.ok) rest.lineTagError = synced.error;
            }
            results.push(rest);
        }

        return new Response(JSON.stringify({ ...result, results }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Promote waitlist error:', error);
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// ========================================
// 過去出展者への一斉メール（GASへ中継）
// ========================================
//
// GASのWebアプリURLは公開されているため、GASは所有アカウント本人のGoogleトークンが
// 添えられているときだけ応じる（verifyAdminAccessToken）。ここで管理画面の認証を
// 通ったリクエストにだけ、GASデプロイ用に連携済みのトークンを付けて渡す。

// 送信先一覧（マスターDBの氏名・メールアドレス）
async function getMailRecipients(env, spreadsheetId, corsHeaders) {
    try {
        const accessToken = await getGoogleUserAccessToken(env);
        const result = await postToGas(env, {
            action: 'get_mail_recipients',
            accessToken,
            spreadsheetId: spreadsheetId || '',
            applicationStart: await loadApplicationStart(env)
        });

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Get mail recipients error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 申込の受付開始日時（管理画面「申込受付期間」の開始。config.json の applicationStart）。
 * GASは一斉メールの送信枠を決めるときに使い、受付開始日より前の日は申込の確認メール用の枠を残さない。
 * 設定が読めなければ ''（GASは常に枠を残す安全側で動く）。
 */
async function loadApplicationStart(env) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return '';
    try {
        const config = await fetchConfigObject(env);
        return String(config.applicationStart || '');
    } catch (error) {
        console.error('受付開始日時の取得に失敗（一斉メールは確認メール用の枠を残します）:', error);
        return '';
    }
}

// 任意の件名・本文で送信
async function sendCustomEmail(env, body, corsHeaders) {
    const { spreadsheetId, emails, subject, body: mailBody, testEmail } = body || {};

    let invalid = '';
    if (!Array.isArray(emails) || emails.length === 0) invalid = '送信先が選択されていません';
    else if (!String(subject || '').trim()) invalid = '件名を入力してください';
    else if (!String(mailBody || '').trim()) invalid = '本文を入力してください';
    if (invalid) {
        return new Response(JSON.stringify({ success: false, error: invalid }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        const accessToken = await getGoogleUserAccessToken(env);
        const result = await postToGas(env, {
            action: 'send_custom_email',
            accessToken,
            spreadsheetId: spreadsheetId || '',
            emails,
            subject,
            body: mailBody,
            testEmail: testEmail || '',
            applicationStart: await loadApplicationStart(env)
        });

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Send custom email error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// スライドテンプレート作成
async function createSlideTemplate(env, body, corsHeaders) {
    try {
        const { templateType } = body;

        if (!templateType) {
            return new Response(JSON.stringify({ error: 'templateType is required' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const response = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'create_slide_template',
                templateType
            })
        });

        const result = await response.json();
        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Create slide template error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// スライド結合
async function combinePresentationsWorker(env, body, corsHeaders) {
    try {
        const { action, presentationIds, title, targetId, sourceId } = body;

        const response = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: action || 'combine_presentations',
                presentationIds,
                title,
                targetId,
                sourceId
            })
        });

        const result = await response.json();
        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Combine presentations error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// ========================================
// フォーム送信処理（既存）
// ========================================
async function handleFormSubmission(request, env, corsHeaders) {
    // POSTのみ受付
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        const formData = await request.formData();
        const data = {};

        // 設定ファイルからSpreadsheet IDを取得
        let currentSpreadsheetId = null;
        let databaseSpreadsheetId = null;

        try {
            // GitHubからconfig.jsonを取得するのは高負荷なので避ける
            // クライアント(Front)から送られてくるconfig値を信用するか、
            // もしくは運用でカバー（Envに入れるなど）
            // 今回は、あえてGithubへの問い合わせはせず、FormDataに含まれていることを期待するか、
            // Admin APIと同じロジックで取得するか。
            // 妥協案: フロントエンドの config.js に含まれているであろう値を送ってもらうように
            // 呼び出し元の apply/script.js を修正する。
            // ここでは FormData に `currentSpreadsheetId` と `databaseSpreadsheetId` が含まれていると仮定して処理する。
            if (formData.has('currentSpreadsheetId')) {
                currentSpreadsheetId = formData.get('currentSpreadsheetId');
            }
            if (formData.has('databaseSpreadsheetId')) {
                databaseSpreadsheetId = formData.get('databaseSpreadsheetId');
            }
        } catch (e) {
            console.error('Failed to parse spreadsheet IDs', e);
        }

        // ブラウザ側で圧縮＆Base64化に成功していれば、そちらを使う。
        // 原本をWorkerで再変換すると容量・CPUを二重に消費し、大きい写真では
        // CPU時間上限に当たって申込ごと失敗するため。
        const hasClientBase64 = !!formData.get('profileImageBase64');

        // 画像の取り込みに失敗した理由（ブラウザ側で失敗していれば引き継ぐ）
        let imageUploadError = formData.get('imageUploadError') || '';

        // フォームデータを抽出
        for (const [key, value] of formData.entries()) {
            if (key === 'profileImage' && value instanceof File && value.size > 0) {
                // ブラウザ側の変換が失敗したときのフォールバック。
                // ここで失敗しても申込は通す（画像は後から公式LINEで回収する運用）。
                if (hasClientBase64) continue;

                try {
                    const imageData = await convertImageToBase64(value);
                    data['profileImageBase64'] = imageData.base64;
                    data['profileImageMimeType'] = imageData.mimeType;
                    data['profileImageName'] = imageData.fileName;
                    imageUploadError = '';
                } catch (imageError) {
                    console.error('Image conversion failed (continuing without image):', imageError);
                    imageUploadError = imageUploadError
                        ? `${imageUploadError} / サーバー側の変換も失敗: ${imageError.message}`
                        : `サーバー側の画像変換に失敗: ${imageError.message}`;
                }
            } else {
                data[key] = value;
            }
        }

        data['imageUploadError'] = imageUploadError;

        // action はGASの管理用の処理（再送・自己更新など）を呼び分けるキー。
        // 公開の申込フォームから届いた値は使わず、キャンセル待ちのときだけこちらで付ける。
        delete data.action;
        // 定員まわりも、最新の設定からこちらで付ける（フォームから届いた値は使わない）
        delete data.boothCapacity;
        delete data.waitlistEnabled;
        // ワークショップは、フォームから届いた時間帯（開始時刻）だけを使う。表記・料金は最新の設定から付ける
        const requestedWorkshopSlot = String(data.workshopSlot || '').trim();
        delete data.workshopSlot;
        delete data.workshopLabel;
        delete data.workshopFee;

        // 受付期間・満枠・定員・ワークショップの判定に使う最新の設定（読めなければ null）
        const config = await loadLatestConfig(env);

        // 受付期間の外なら受け付けない。フォームを開いたまま締切を過ぎた場合や、
        // 端末の時計がずれていて開始前にフォームが出てしまった場合も、ここで止める
        const period = resolveApplicationPeriod(config, new Date());
        if (period.status !== 'open') {
            return applicationErrorResponse(applicationPeriodMessage(period), corsHeaders, {
                applicationPeriod: period.status
            });
        }

        // 満枠のブースへの申込は、キャンセル待ちとして受け付ける（管理画面でオフなら受付終了）
        const availability = resolveBoothAvailability(data, config);
        if (availability.status === 'closed') {
            // GASへは送らない（保存も確認メールもしない）。フォームは入力を残したままこの文言を出す
            return boothClosedResponse(corsHeaders);
        }

        // ワークショップの時間帯が、いまの設定で選べるものか（空いているかは、GASが保存の直前に数えて決める）
        const workshop = resolveWorkshopRequest(requestedWorkshopSlot, data.boothId, config);
        if (workshop.error) {
            return applicationErrorResponse(workshop.error, corsHeaders);
        }

        let waitlist = availability.status === 'waitlist';
        data['waitlist'] = waitlist ? '1' : '0';
        if (workshop.slot) {
            data['workshopSlot'] = workshop.slot.start;
            data['workshopLabel'] = workshop.slot.label;
            data['workshopFee'] = String(workshop.fee);
        }
        if (waitlist) {
            // action にしておくと、キャンセル待ちを知らない古いGASは「未対応のアクション」で止まる。
            // 通常の申込として受けてしまうと、振込先入りの確認メールが届いてしまうため。
            // ワークショップの時間帯は押さえず、GASが希望として残す
            data['action'] = GAS_ACTION_APPLY_WAITLIST;
        } else if (availability.status === 'limited' || workshop.slot) {
            // 定員のあるブース・ワークショップの時間帯は、GASが保存の直前に（ほかの申込とぶつからないようロックの中で）数えて決める。
            // 知らない古いGASは「未対応のアクション」で止まる（定員を超えた受付や、時間帯・料金の記録漏れを防ぐため）。
            data['action'] = workshop.slot ? GAS_ACTION_APPLY_WORKSHOP : GAS_ACTION_APPLY_LIMITED;
        }
        if (availability.status === 'limited') {
            data['boothCapacity'] = String(availability.capacity);
            data['waitlistEnabled'] = availability.waitlistEnabled ? '1' : '0';
            // GASはシートの出展ブース名で数えるので、フォームから届いた名前ではなく設定の名前にそろえる
            data['boothName'] = availability.boothName;
        }

        // タイムスタンプ追加
        data['submittedAt'] = new Date().toISOString();

        // GASへデータ送信
        console.log('Sending data to GAS...');
        if (data.profileImageBase64) {
            console.log(`Image data present. Length: ${data.profileImageBase64.length}`);
        } else {
            console.log('No image data present.');
        }

        const gasResponse = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        console.log(`GAS response status: ${gasResponse.status}`);

        if (!gasResponse.ok) {
            const errorText = await gasResponse.text();
            console.error(`GAS request failed: ${gasResponse.status} ${errorText}`);
            throw new Error(`GAS request failed: ${gasResponse.status}`);
        }

        const gasResult = await gasResponse.json();
        console.log('GAS response JSON:', gasResult);

        if ((data.action === GAS_ACTION_APPLY_LIMITED || data.action === GAS_ACTION_APPLY_WORKSHOP) && gasResult) {
            // 定員に達していて、キャンセル待ちも受け付けない設定だった（GASは保存もメール送信もしていない）
            if (gasResult.code === GAS_ERROR_BOOTH_FULL) {
                return boothClosedResponse(corsHeaders);
            }
            // 選んだワークショップの時間帯が先に埋まっていた（GASは保存もメール送信もしていない）
            if (gasResult.code === GAS_ERROR_WORKSHOP_SLOT_TAKEN && workshop.slot) {
                return applicationErrorResponse(workshopSlotTakenMessage(workshop.slot.label), corsHeaders, {
                    workshopSlotTaken: workshop.slot.start
                });
            }
            // 定員に達していれば、GASがキャンセル待ちとして受け付けている（ワークショップは希望になる）。
            // LINEの案内・完了画面もそちらに合わせる
            if (gasResult.success && typeof gasResult.waitlist === 'boolean') {
                waitlist = gasResult.waitlist;
                data['waitlist'] = waitlist ? '1' : '0';
            }
        }

        // LINE管理アプリへ申込者を連携する（申込受付とは独立。失敗しても申込は成功扱い）。
        // 出展名・開催回タグは、GASが受け付けた申込のときだけ付ける。
        await registerApplicantToLineManager(data, env, !!(gasResult && gasResult.success));

        // 申込内容をLINEでも本人へ通知する（メールと二本立て。失敗しても申込は成功扱い）。
        // GASが受け付けなかった申込に「受け付けました」と送らないよう、成功したときだけ送る。
        if (gasResult && gasResult.success) {
            await sendLineConfirmation(data, gasResult, env);
        }

        // LINE用の本文はWorkerで送るためのもの。ブラウザへは返さない
        const { lineMessage, ...clientResult } = gasResult || {};

        return new Response(JSON.stringify({
            success: true,
            message: 'Application submitted successfully',
            ...clientResult,
            // 完了画面の出し分け用。フォームを開いたあとに満枠になった場合もここで伝わる
            waitlist
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Worker error:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// キャンセル待ちの申込としてGASへ送るときの action（gas/code.gs の ACTION_APPLY_WAITLIST と揃える）
export const GAS_ACTION_APPLY_WAITLIST = 'apply_waitlist';

// 定員（残枠）を設定したブースへの申込としてGASへ送るときの action（gas/code.gs の ACTION_APPLY_LIMITED と揃える）
export const GAS_ACTION_APPLY_LIMITED = 'apply_limited';

// ワークショップの時間帯を押さえる申込としてGASへ送るときの action（gas/code.gs の ACTION_APPLY_WORKSHOP と揃える）。
// 定員の判定も apply_limited と同じように行われる
export const GAS_ACTION_APPLY_WORKSHOP = 'apply_workshop';

// 定員に達していて、キャンセル待ちも受け付けないときにGASが返すエラーコード（gas/code.gs の ERROR_CODE_BOOTH_FULL と揃える）
const GAS_ERROR_BOOTH_FULL = 'booth_full';

// 選んだワークショップの時間帯が先に埋まっていたときにGASが返すエラーコード（gas/code.gs の ERROR_CODE_WORKSHOP_SLOT_TAKEN と揃える）
const GAS_ERROR_WORKSHOP_SLOT_TAKEN = 'workshop_slot_taken';

// 満枠のブースでキャンセル待ちを受け付けない設定のときに、申込者へ出す文言
export const BOOTH_CLOSED_MESSAGE =
    'お選びいただいたブースは満枠のため、受付を終了しました。お手数ですが、他のブースをお選びのうえ、もう一度お申し込みください。';

// 申込を受け付けなかったときの応答。フォームが文言をそのまま出せるよう、通信エラー（4xx/5xx）にはしない
function applicationErrorResponse(message, corsHeaders, extra = {}) {
    return new Response(JSON.stringify({ success: false, error: message, ...extra }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// 受付終了の応答
function boothClosedResponse(corsHeaders) {
    return applicationErrorResponse(BOOTH_CLOSED_MESSAGE, corsHeaders);
}

/**
 * 申込の判定に使う最新の設定（GitHub上のconfig.json）。読めなければ null。
 * フォームを開いたあとに管理画面で変えた満枠・定員・ワークショップの設定を、ここで反映する。
 */
async function loadLatestConfig(env) {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
    try {
        return await fetchConfigObject(env);
    } catch (error) {
        console.error('満枠の確認に失敗（フォームの判定のみで受け付けます）:', error);
        return null;
    }
}

// ========================================
// 申込の受付期間
// ========================================
// config.json の applicationStart / applicationEnd は日本時間の "2026-10-01 10:00:00" 形式（管理画面で設定）。
// Workerの時計はUTCなので、日本時間として読む（apply/script.js・admin/script.js と同じ解釈）。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// "2026-10-01 10:00:00" → Date。空欄・読めない値は null（その側は制限なし）
export function parseJstDateTime(text) {
    const m = String(text || '').trim()
        .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

// Date → "2026年10月1日（木）10:00"（日本時間）
export function formatJstDateTime(date) {
    const jst = new Date(date.getTime() + JST_OFFSET_MS);
    const weekday = '日月火水木金土'[jst.getUTCDay()];
    const hh = String(jst.getUTCHours()).padStart(2, '0');
    const mm = String(jst.getUTCMinutes()).padStart(2, '0');
    return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日（${weekday}）${hh}:${mm}`;
}

/**
 * いまが申込の受付期間かどうか。
 *   { status: 'before' | 'open' | 'closed', start, end }（start / end は Date か null）
 *
 * 開始日時ちょうどから受け付け、終了日時まで受け付ける（管理画面は終了を「23:59:59」のように分の終わりで保存する）。
 * 未設定・読めない値の側は制限なし。設定が読めないとき（config が null）は申込ごと落とさないよう受け付ける
 * （フォームは開始前・終了後には予告・終了の画面を出しているので、通常そこから送られてくることはない）。
 */
export function resolveApplicationPeriod(config, now) {
    const start = config ? parseJstDateTime(config.applicationStart) : null;
    const end = config ? parseJstDateTime(config.applicationEnd) : null;
    let status = 'open';
    if (start && now < start) status = 'before';
    else if (end && now > end) status = 'closed';
    return { status, start, end };
}

// 受付期間の外で申込が届いたときに、申込者へ出す文言
export function applicationPeriodMessage(period) {
    if (period.status === 'before') {
        return `出展申込の受付は ${formatJstDateTime(period.start)} からです。受付開始まで、もうしばらくお待ちください。`;
    }
    return `出展申込の受付は ${formatJstDateTime(period.end)} で終了しました。お問い合わせは公式LINEまでお願いいたします。`;
}

/**
 * ブースの定員（管理画面の満枠設定で入れる枠数）。未設定・読めない値なら null。
 * 定員がなければ、満枠かどうかは従来どおり手動のチェック（soldOut）だけで決まる。
 */
export function boothCapacity(booth) {
    const value = booth ? booth.capacity : null;
    if (value === null || value === undefined || value === '') return null;
    const capacity = Number(value);
    return Number.isInteger(capacity) && capacity >= 0 ? capacity : null;
}

/**
 * 申込をどう受け付けるか。
 *   { status: 'open' }      通常
 *   { status: 'waitlist' }  キャンセル待ち
 *   { status: 'closed' }    受付終了
 *   { status: 'limited', capacity, boothName, waitlistEnabled }
 *                           定員のあるブース。空きがあるかはGASが保存の直前に数えて決める
 *
 * フォームが送ってくる waitlist（満枠のブースを選んだ）に加え、最新の設定でもブースの状態を確かめる。
 * フォームを開いたあとに管理画面で満枠にされた場合でも、振込先入りの案内を送らないため。
 * 満枠で、管理画面の「キャンセル待ちとして受付を続ける」がオフなら受け付けない
 * （未設定はオン扱い。申込フォーム・管理画面と同じ判定）。
 * キャンセル待ちの画面を見て申し込んだ人は、その間に空きができていてもキャンセル待ちのままにする（画面の案内と揃える）。
 * 設定が読めないとき（config が null）は、フォームの判定だけで受け付ける（申込ごと落とさない）。
 */
export function resolveBoothAvailability(data, config) {
    const requestedWaitlist = data.waitlist === '1';
    const byForm = { status: requestedWaitlist ? 'waitlist' : 'open' };
    if (!data.boothId || !config) {
        return byForm;
    }

    const booth = (config.booths || []).find(b => b.id === data.boothId);
    if (booth && booth.soldOut) {
        return { status: config.waitlistEnabled === false ? 'closed' : 'waitlist' };
    }

    const capacity = boothCapacity(booth);
    if (!requestedWaitlist && capacity !== null) {
        return {
            status: 'limited',
            capacity,
            boothName: booth.name,
            waitlistEnabled: config.waitlistEnabled !== false
        };
    }
    return byForm;
}

// ========================================
// ワークショップブース（オプション）
// ========================================
// 1つの時間帯に入れる人数（gas/code.gs の WORKSHOP_SLOT_CAPACITY と揃える）
export const WORKSHOP_SLOT_CAPACITY = 1;

// 時間帯の既定値（管理画面で変えられる）。11:00 から 90分（準備・片付け込み）× 3枠
const WORKSHOP_DEFAULTS = { startTime: '11:00', slotMinutes: 90, slotCount: 3 };

// 設定が変わっていて、選んだ時間帯を受け付けられないときの文言
export const WORKSHOP_UNAVAILABLE_MESSAGE =
    'ワークショップブースの受付内容が変わったため、お申し込みを受け付けられませんでした。お手数ですが、ページを再読み込みして、もう一度お選びください。';

// 選んだ時間帯が先に埋まっていたときの文言
export function workshopSlotTakenMessage(label) {
    return `お選びのワークショップの時間帯（${label}）は、先にお申し込みがあり受付を終了しました。`
        + 'お手数ですが、別の時間帯をお選びのうえ、もう一度お申し込みください。';
}

// "11:00" → 660（分）。読めなければ null
function parseClock(text) {
    const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

// 660 → "11:00"
function formatClock(minutes) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * ワークショップの設定（config.json の workshop）を読む。受付がオフ・設定が読めないときは null。
 *   { price, boothIds, slots: [{ start: "11:00", label: "11:00〜12:30" }] }
 * 時間帯は開始時刻・1枠の長さ・枠数から作る（申込フォーム・管理画面も同じ規則で作る）。
 * boothIds が無ければ、すべてのブースで選べる。
 */
export function workshopSettings(config) {
    const workshop = config && config.workshop;
    if (!workshop || workshop.enabled !== true) return null;

    const start = parseClock(workshop.startTime ?? WORKSHOP_DEFAULTS.startTime);
    const slotMinutes = Number(workshop.slotMinutes ?? WORKSHOP_DEFAULTS.slotMinutes);
    const slotCount = Number(workshop.slotCount ?? WORKSHOP_DEFAULTS.slotCount);
    const price = Number(workshop.price);
    if (start === null
        || !(Number.isInteger(slotMinutes) && slotMinutes > 0)
        || !(Number.isInteger(slotCount) && slotCount > 0)
        || !(Number.isInteger(price) && price >= 0)) {
        return null;
    }

    const slots = [];
    for (let i = 0; i < slotCount; i++) {
        const from = start + slotMinutes * i;
        const to = from + slotMinutes;
        if (to > 24 * 60) break;
        slots.push({ start: formatClock(from), label: `${formatClock(from)}〜${formatClock(to)}` });
    }

    return { price, slots, boothIds: Array.isArray(workshop.boothIds) ? workshop.boothIds : null };
}

// そのブースでワークショップを付けられるか
export function workshopAvailableForBooth(settings, boothId) {
    return !!settings && (!settings.boothIds || settings.boothIds.includes(boothId));
}

/**
 * フォームから届いたワークショップの時間帯（開始時刻）を、最新の設定で確かめる。
 *   {}                              申し込んでいない
 *   { slot: { start, label }, fee } 選べる時間帯（空いているかは、GASが保存の直前に数えて決める）
 *   { error }                       受付がオフ・対象外のブース・無い時間帯（設定が変わった）、または設定が読めない
 */
export function resolveWorkshopRequest(requestedSlot, boothId, config) {
    if (!requestedSlot) return {};
    if (!config) {
        // 料金も時間帯も確かめられないまま受け付けない（時間をおけば読めることがほとんど）
        return { error: 'ただいまワークショップブースの受付状況を確認できません。お手数ですが、時間をおいてもう一度お申し込みください。' };
    }

    const settings = workshopSettings(config);
    const slot = workshopAvailableForBooth(settings, boothId)
        ? settings.slots.find(s => s.start === requestedSlot)
        : null;
    if (!slot) return { error: WORKSHOP_UNAVAILABLE_MESSAGE };

    return { slot, fee: settings.price };
}

/**
 * ワークショップの時間帯ごとの空き（申込フォーム用）。受付がオフなら null。{ slots: { "11:00": { full } } }
 * reservations はGASが返す「時間帯（開始時刻）→ 押さえた出展者」。出展名は公開の応答に載せない。
 * 1つの時間帯に1名なので、残枠の表示設定に関係なく、埋まった時間帯は常に満枠として返す。
 */
export function buildPublicWorkshopAvailability(config, reservations) {
    const settings = workshopSettings(config);
    if (!settings) return null;

    const slots = {};
    settings.slots.forEach(slot => {
        const taken = ((reservations || {})[slot.start] || []).length;
        slots[slot.start] = { full: taken >= WORKSHOP_SLOT_CAPACITY };
    });
    return { slots };
}

/**
 * LINE管理アプリ(line-manager)の友だちに付ける、管理用ネームとタグ。
 *
 * - 管理用ネーム: 出展名（スライド用の改行は1行にまとめる）
 * - タグ: 開催回ごとの「第7回出展者」。キャンセル待ちは出展が決まっていないため
 *   「第7回キャンセル待ち」にする（出展者向けの配信が届かないように）
 *
 * 開催回は申込フォームと同じく eventName の「第◯回」を使う。無ければタグは付けない。
 */
export function buildLineManagerProfile(data) {
    const internalName = String(data.exhibitorName || '').replace(/\s+/g, ' ').trim();
    const eventNumber = lineManagerEventNumber(data.eventName);
    const tagNames = eventNumber
        ? [`${eventNumber}${data.waitlist === '1' ? 'キャンセル待ち' : '出展者'}`]
        : [];

    return { internalName: internalName || null, tagNames };
}

/**
 * キャンセル待ちから繰り上げた方の、管理用ネームとタグ。
 * 「第7回出展者」を付け、申込時に付けた「第7回キャンセル待ち」を外す
 * （出展者向けの配信が届き、キャンセル待ち向けの配信は届かないように）。
 */
export function buildPromotedLineManagerProfile(data) {
    const profile = buildLineManagerProfile({ ...data, waitlist: '0' });
    const eventNumber = lineManagerEventNumber(data.eventName);
    return { ...profile, removeTagNames: eventNumber ? [`${eventNumber}キャンセル待ち`] : [] };
}

// タグに使う開催回（eventName の「第◯回」。無ければ eventName のまま。空なら ''）
function lineManagerEventNumber(eventName) {
    const name = String(eventName || '').trim();
    return name.match(/第.+回/)?.[0] || name;
}

/**
 * LINE管理アプリ(line-manager)へ申込者を連携する。
 *
 * ブラウザからではなくWorkerから呼ぶ。シークレットをクライアントに晒さないため。
 * 管理アプリ側で Messaging API を使って友だち判定を行い、友だちなら友だち一覧に、
 * 友だちでなければ「未友だち申込者」として記録される。
 * accepted（GASが申込を受け付けた）のときは、出展名を管理用ネームに登録し、開催回のタグも付ける。
 * 未友だちの人には、友だち追加したときに管理アプリ側で付けられる。
 *
 * ここでの失敗は申込受付を巻き添えにしない（ログのみ）。申込自体は既にGASへ保存済み。
 */
async function registerApplicantToLineManager(data, env, accepted, profile = buildLineManagerProfile(data)) {
    if (!env.LINE_MANAGER_URL || !env.LINE_MANAGER_SECRET || !env.LINE_MANAGER_CHANNEL_ID) {
        console.log('line-manager連携: 未設定のためスキップ');
        return { ok: false, error: `Workerの設定が足りません（${missingLineManagerSettings(env).join('・')}）` };
    }

    // LINE情報が取れていない申込は連携できない（誰の申込か特定できないため）
    if (!data.lineUserId) {
        console.warn(`line-manager連携: lineUserIdが空のためスキップ (lineLinkStatus: ${data.lineLinkStatus || '不明'})`);
        return { ok: false, error: 'LINEユーザーIDがありません' };
    }

    try {
        const response = await fetch(`${env.LINE_MANAGER_URL}/api/applicants/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.LINE_MANAGER_SECRET}`,
            },
            body: JSON.stringify({
                channelId: env.LINE_MANAGER_CHANNEL_ID,
                lineUserId: data.lineUserId,
                displayName: data.lineDisplayName || null,
                source: env.LINE_MANAGER_SOURCE || 'buchiiyashi-apply',
                appliedAt: data.submittedAt,
                ...(accepted ? profile : {}),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`line-manager連携に失敗: ${response.status} ${errorText}`);
            return { ok: false, status: response.status, error: describeLineManagerError(response.status, errorText) };
        }

        const result = await response.json();
        console.log(`line-manager連携成功: isFriend=${result.isFriend} profileApplied=${result.profileApplied}`);
        return { ok: true, isFriend: !!result.isFriend, profileApplied: !!result.profileApplied };
    } catch (error) {
        console.error('line-manager連携エラー:', error);
        return { ok: false, error: `line-managerへ接続できません: ${error.message}` };
    }
}

// Workerに足りないline-manager連携の設定（wrangler.toml の変数・Cloudflareのシークレット）
function missingLineManagerSettings(env) {
    return [
        ['LINE_MANAGER_URL', env.LINE_MANAGER_URL],
        ['LINE_MANAGER_SECRET', env.LINE_MANAGER_SECRET],
        ['LINE_MANAGER_CHANNEL_ID', env.LINE_MANAGER_CHANNEL_ID]
    ].filter(([, value]) => !value).map(([name]) => name);
}

/**
 * line-managerの申込者連携が断ったときの理由を、直し方が分かる言葉にする。
 * 断られた申込は line-manager に何も残らないため、ここで分からないと原因を追えない。
 */
export function describeLineManagerError(status, text) {
    let message = String(text || '').trim();
    try {
        message = JSON.parse(message).error || message;
    } catch (e) {
        // JSONでなければ本文のまま
    }
    message = message.slice(0, 200);

    const hint = {
        401: 'WorkerのLINE_MANAGER_SECRETと、line-manager（Vercel）のAPPLICANT_INGEST_SECRETが一致していません',
        404: 'WorkerのLINE_MANAGER_CHANNEL_IDに当たるチャネルが、line-managerにありません',
        500: 'line-manager側の設定・データベースのエラーです（APPLICANT_INGEST_SECRET未設定など。Vercelのログもご確認ください）',
        502: 'line-managerがLINEへの友だち確認に失敗しました（チャネルアクセストークンをご確認ください）'
    }[status];
    return `HTTP ${status} ${message}${hint ? `：${hint}` : ''}`;
}

/**
 * シートに残っている申込日時（日本時間の "2026/10/1 12:00:00"）を ISO 形式にする。
 * line-manager の申込日時を、繰り上げの連携で消してしまわないように使う。読めなければ今の時刻。
 */
export function sheetDateTimeToIso(text, now = new Date()) {
    const m = String(text || '').trim()
        .match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return now.toISOString();
    const pad = (v) => String(v).padStart(2, '0');
    const date = new Date(`${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] || '00'}+09:00`);
    return Number.isNaN(date.getTime()) ? now.toISOString() : date.toISOString();
}

/**
 * 申込内容をLINEでも申込者本人へ通知する（確認メールと二本立て）。
 *
 * Messaging APIのpushを直接叩く。GASでの保存・確認メール送信が成功した後にだけ呼ぶ。
 * ここでの失敗は申込受付を巻き添えにしない（ログのみ）。申込は既にGASへ保存済みで
 * 確認メールも送信済みのため、LINEが届かなくても申込者への案内は成立する。
 *
 * 送れない条件（トークン未設定・LINE未連携・友だち未追加）は例外にせずスキップする。
 * 届いたら true、送れなかったら false を返す（繰り上げの結果表示に使う）。
 */
async function sendLineConfirmation(data, gasResult, env) {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
        console.log('LINE通知: LINE_CHANNEL_ACCESS_TOKEN未設定のためスキップ');
        return false;
    }

    // LIFFログインが取れていない申込は送り先が分からない（メールのみで案内する）
    if (!data.lineUserId) {
        console.warn(`LINE通知: lineUserIdが空のためスキップ (lineLinkStatus: ${data.lineLinkStatus || '不明'})`);
        return false;
    }

    const body = JSON.stringify({
        to: data.lineUserId,
        messages: [{ type: 'text', text: selectLineConfirmationText(data, gasResult) }]
    });

    // 同じリトライキーで送る限り、LINE側が重複配信を防いでくれる
    const retryKey = crypto.randomUUID();

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await fetch('https://api.line.me/v2/bot/message/push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
                    'X-Line-Retry-Key': retryKey,
                },
                body
            });

            if (response.ok) {
                console.log('LINE通知: 送信成功');
                return true;
            }

            const errorText = await response.text();

            // 友だち未追加・ブロック中。再送しても結果は変わらない（案内はメールで届いている）
            if (response.status === 403) {
                console.warn(`LINE通知: 友だち未追加またはブロック中のため送信できません: ${errorText}`);
                return false;
            }

            // 認証エラーやリクエスト不備は再送しても直らない
            if (response.status !== 429 && response.status < 500) {
                console.error(`LINE通知に失敗: ${response.status} ${errorText}`);
                return false;
            }

            console.warn(`LINE通知が一時的に失敗 (${attempt}回目): ${response.status} ${errorText}`);
        } catch (error) {
            console.warn(`LINE通知でエラー (${attempt}回目):`, error);
        }

        // 一時的な失敗のときだけ、少し待って1回だけ再送する
        if (attempt === 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    console.error('LINE通知: リトライしても送信できませんでした');
    return false;
}

// LINEのテキストメッセージの上限は5000文字
const LINE_TEXT_MAX = 5000;

/**
 * LINEで送る申込完了メッセージの本文を選ぶ。
 *
 * 確認メールと同じ内容（申込内容・料金内訳・振込先・各種ご案内）の本文はGASが組み立てて
 * lineMessage として返す。メールと同じ計算結果から作るので、金額や振込先が食い違わない。
 * GASが古いデプロイのままで lineMessage が無いときだけ、ここで要約版を作る。
 */
export function selectLineConfirmationText(data, gasResult) {
    const full = gasResult && typeof gasResult.lineMessage === 'string' ? gasResult.lineMessage.trim() : '';
    if (full) {
        return full.length > LINE_TEXT_MAX ? `${full.slice(0, LINE_TEXT_MAX - 1)}…` : full;
    }
    return buildLineConfirmationMessage(data, gasResult);
}

/**
 * LINEで送る申込完了メッセージの要約版（GASから全文が届かなかったときの予備）。
 *
 * 金額の内訳や振込先の詳細は確認メールが正なので、ここは受付内容の要約に絞る。
 */
function buildLineConfirmationMessage(data, gasResult) {
    const eventName = data.eventName || 'ぶち癒やしフェスタin東京';
    const result = gasResult || {};
    // キャンセル待ちには金額・振込の案内を一切載せない（誤って入金されるのを防ぐため）
    const waitlist = data.waitlist === '1';

    const lines = [
        `${data.name || ''} 様`.trim(),
        '',
        `この度は「${eventName}」へのお申し込み、誠にありがとうございます。`,
        waitlist
            ? 'お選びいただいたブースは満枠のため、キャンセル待ちとしてお申し込みを受け付けました。'
            : '以下の内容でお申し込みを受け付けました。'
    ];

    if (waitlist) {
        lines.push('');
        lines.push('■ キャンセル待ちについて');
        lines.push('現時点では出展は確定しておりません。お振り込みは不要です。');
        lines.push('空きが出た場合は、事務局よりこのトークまたはメールでご連絡いたします。');
        lines.push('繰り上げで出展が決まりましたら、そのときに改めてお支払いについてご案内いたします。');
    }

    // 値が取れなかった項目は行ごと出さない（「出展名: 」のような空行を送らないため）
    const detailLines = [
        data.exhibitorName ? `出展名: ${data.exhibitorName}` : '',
        data.boothName ? `出展ブース: ${data.boothName}` : '',
        // キャンセル待ちのワークショップは時間帯を押さえていない（希望として記録）
        data.workshopLabel
            ? (waitlist
                ? `ワークショップブース（ご希望）: ${data.workshopLabel} ※時間帯は未確保です`
                : `ワークショップブース: ${data.workshopLabel}`)
            : '',
        data.menuName ? `出展メニュー: ${data.menuName}` : ''
    ].filter(Boolean);

    if (detailLines.length > 0) {
        lines.push('');
        lines.push('■ お申し込み内容');
        lines.push(...detailLines);
    }

    // GASが再計算した金額。取れなかったときは金額に触れない（誤った額を送らないため）
    const rawFee = result.totalFee;
    const totalFee = (rawFee === undefined || rawFee === null || rawFee === '') ? NaN : Number(rawFee);
    if (!waitlist && Number.isFinite(totalFee)) {
        lines.push('');
        lines.push('■ お振込金額合計');
        lines.push(`¥${formatYen(totalFee)}`);
        lines.push('');
        lines.push('お申し込みから1週間以内に、メールに記載のお振込先へお振り込みください。');
        lines.push('ご入金の確認をもって、正式な出展確定とさせていただきます。');
    }

    // 画像が登録できなかった申込は、後から公式LINEで写真を受け取る必要がある
    if (result.imageStatus === 'missing') {
        lines.push('');
        lines.push('※プロフィールのお写真のみ登録できておりません。お申し込み自体は正常に受け付けております。');
        lines.push('お手数ですが、お写真はこのトークへ直接お送りください。');
        if (data.exhibitorName) {
            lines.push(`その際、出展名（${data.exhibitorName}）をお書き添えください。`);
        }
    }

    lines.push('');
    lines.push(waitlist
        ? `お申し込み内容の詳細は、ご登録のメールアドレス${data.email ? `（${data.email}）` : ''}宛にお送りしています。`
        : `お申し込み内容の詳細とお振込先は、ご登録のメールアドレス${data.email ? `（${data.email}）` : ''}宛にお送りしています。`);
    lines.push('メールが見当たらない場合は、迷惑メールフォルダもご確認ください。');
    lines.push('');
    lines.push('ぶち癒やしフェスタin東京 事務局');

    const message = lines.join('\n');

    // LINEのテキストメッセージは5000文字まで。超える場合は末尾を落とす
    return message.length > 4900 ? `${message.slice(0, 4900)}…` : message;
}

// 3桁区切り（Intlのロケール差に左右されず同じ結果にする）
function formatYen(value) {
    return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 画像をBase64に変換
 */
async function convertImageToBase64(file) {
    // ここに来るのはブラウザ側の圧縮が失敗したときの原本のみ。
    // 大きすぎる原本の変換はWorkerのCPU時間を使い切り、申込全体を巻き添えにするため断念する
    // （申込自体は画像なしで成立し、写真は公式LINEで回収する）。
    if (file.size > 8 * 1024 * 1024) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
        throw new Error(`原本のサイズが大きく変換できませんでした (${sizeMB}MB / 上限8MB)`);
    }

    // 許可された拡張子チェック
    const extension = file.name.split('.').pop().toLowerCase();
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    if (!allowedExtensions.includes(extension)) {
        throw new Error('Invalid image format');
    }

    // ファイル名生成 (タイムスタンプ + ランダム文字列)
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const fileName = `profile_${timestamp}_${randomStr}.${extension}`;

    // Base64変換
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    return {
        base64: base64,
        mimeType: file.type,
        fileName: fileName
    };
}

// ========================================
// リピーター検索処理
// ========================================
async function handleRepeaterSearch(request, env, corsHeaders) {
    try {
        const url = new URL(request.url);
        const searchParams = url.searchParams;
        const action = searchParams.get('action');

        console.log(`[handleRepeaterSearch] Action received: ${action}`); // Debug log
        console.log(`[handleRepeaterSearch] Full URL: ${request.url}`); // Debug log

        // アクションのバリデーション
        const allowedActions = ['check_repeater', 'send_auth_code', 'verify_auth_code'];
        if (!allowedActions.includes(action)) {
            return new Response(JSON.stringify({ error: 'Invalid action' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // GASへ転送
        const gasUrl = new URL(env.GAS_URL);

        // 必要なパラメータを転送
        gasUrl.searchParams.append('action', action);
        if (searchParams.has('name')) gasUrl.searchParams.append('name', searchParams.get('name'));
        if (searchParams.has('email')) gasUrl.searchParams.append('email', searchParams.get('email'));
        if (searchParams.has('code')) gasUrl.searchParams.append('code', searchParams.get('code'));

        // GASへのリクエスト
        const response = await fetch(gasUrl.toString(), {
            method: 'GET',
            headers: {
                'User-Agent': 'Cloudflare-Worker'
            },
            redirect: 'follow'
        });

        // レスポンス取得
        const data = await response.text();

        // JSONとして返す
        return new Response(data, {
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.error('Repeater search error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

/**
 * LINE連携で前回の申込内容を探す。
 *
 * アクセストークンはURLに載せるとログに残るため、ブラウザからはPOSTの本文で受け取る。
 * 本人確認（トークンの検証とuserIdの取得）はGAS側で行う。GASのURLは公開されているため、
 * userIdだけを渡す作りにすると誰でも他人の申込内容を引けてしまう。
 */
async function handleRepeaterLineSearch(request, env, corsHeaders) {
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    try {
        let body = {};
        try {
            body = await request.json();
        } catch (e) {
            return json({ success: false, error: 'リクエストの形式が正しくありません' }, 400);
        }

        const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
        if (!accessToken) {
            return json({ success: false, error: 'LINEの認証情報がありません' }, 400);
        }

        const result = await getGasJson(env, { action: 'search_by_line', accessToken });
        return json(result);
    } catch (error) {
        console.error('Repeater LINE search error:', error.message);
        return json({ success: false, error: 'LINEでの呼び出しに失敗しました' }, 502);
    }
}

// 背景画像のキャッシュ時間。テンプレートの背景を差し替えてから、長くてもこの時間で反映される
const SLIDE_BACKGROUND_TTL_SEC = 30 * 60;

/**
 * 申込フォームのスライドプレビュー用に、テンプレートの背景画像を返す。
 *
 * 背景は開催ごとに差し替えるため、画像をサイトに置かずテンプレートから取り出す（GAS経由）。
 * 取り出せるのは管理画面で設定済みのテンプレート（config.json の slideTemplates）だけに限る。
 * 任意のIDを受け付けると、公開の口から他のスライドの画像まで取り出せてしまうため。
 */
export async function handleSlideBackground(request, env, corsHeaders, url, ctx) {
    const notFound = (status = 404) => new Response(null, {
        status,
        headers: { ...corsHeaders, 'Cache-Control': 'no-store' }
    });

    const templateId = url.searchParams.get('t') || '';
    if (!/^[\w-]{20,100}$/.test(templateId)) return notFound(400);

    const cacheKey = new Request(`${url.origin}${url.pathname}?t=${encodeURIComponent(templateId)}`, { method: 'GET' });
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;

    try {
        const config = await fetchConfigObject(env);
        const allowed = Object.values(config.slideTemplates || {}).filter(Boolean);
        if (!allowed.includes(templateId)) return notFound();

        const result = await getGasJson(env, { action: 'get_slide_background', presentationId: templateId });
        if (!result.success || !result.base64) {
            console.warn(`Slide background unavailable: ${result.error || 'no image'}`);
            return notFound();
        }

        const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
        const response = new Response(bytes, {
            headers: {
                ...corsHeaders,
                'Content-Type': result.mimeType || 'image/jpeg',
                'Cache-Control': `public, max-age=${SLIDE_BACKGROUND_TTL_SEC}`
            }
        });
        const put = caches.default.put(cacheKey, response.clone());
        if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
        return response;
    } catch (error) {
        console.error('Slide background error:', error.message);
        return notFound(502);
    }
}

// ========================================
// ブースの空き状況（申込フォームの満枠・残枠表示）
// ========================================
// 残枠の見せ方（管理画面の満枠設定）。
//   hidden: 表示しない（未設定もこれ。この項目ができる前と同じ見え方）
//   always: 最初から表示する
//   few:    残りわずか（しきい値以下）になってから表示する
export const REMAINING_DISPLAY_MODES = ['hidden', 'always', 'few'];
const DEFAULT_REMAINING_THRESHOLD = 3;
// 申込の判定は保存時にGASが数え直すので、表示は少し古くてもよい。GASへの集中を避ける
const BOOTH_AVAILABILITY_TTL_SEC = 30;

export function remainingDisplaySettings(config) {
    const mode = REMAINING_DISPLAY_MODES.includes(config.remainingDisplay) ? config.remainingDisplay : 'hidden';
    const threshold = Number(config.remainingDisplayThreshold);
    return {
        mode,
        threshold: Number.isInteger(threshold) && threshold >= 1 ? threshold : DEFAULT_REMAINING_THRESHOLD
    };
}

/**
 * ブースごとの空き状況を、申込フォームに見せてよい形にする。{ [boothId]: { full, remaining?, few? } }
 *
 * counts はGASが数えた「申込データ」の出展ブース名ごとの件数（定員のあるブースが無ければ null）。
 * - full:      満枠か（手動の満枠チェック、または申込数が定員に達した）
 * - remaining: 残りの枠数。表示の設定で見せるときだけ付ける
 *              （表示しない設定なのに、通信をのぞけば数字が分かってしまわないように）
 * - few:       残りわずか（しきい値以下）か。remaining と一緒に付ける
 */
export function buildPublicBoothAvailability(config, counts) {
    const { mode, threshold } = remainingDisplaySettings(config);
    const booths = {};

    (config.booths || []).forEach(booth => {
        const entry = { full: !!booth.soldOut };
        const capacity = boothCapacity(booth);

        if (capacity !== null && counts) {
            const applied = counts[String(booth.name || '').trim()] || 0;
            const remaining = Math.max(capacity - applied, 0);
            const few = remaining <= threshold;
            if (remaining === 0) entry.full = true;
            if (!entry.full && (mode === 'always' || (mode === 'few' && few))) {
                entry.remaining = remaining;
                entry.few = few;
            }
        }
        booths[booth.id] = entry;
    });

    return booths;
}

/**
 * 申込フォームのブース一覧に出す空き状況。
 *
 * 定員・表示の設定は最新の config.json（GitHub）から、申込数はGASから取る。
 * 取れなかったときは 502 を返し、フォームは config.json の満枠チェックだけで表示する
 * （その場合も、申込の受付可否は保存時にGASが数えて決めるので、定員は超えない）。
 */
export async function handleBoothAvailability(request, env, corsHeaders, url, ctx) {
    const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;

    try {
        const config = await fetchConfigObject(env);

        // 定員を設定したブースも、受付中のワークショップも無ければ、GASに数えさせるまでもない
        let counts = null;
        let workshopReservations = null;
        if ((config.booths || []).some(booth => boothCapacity(booth) !== null) || workshopSettings(config)) {
            const result = await getGasJson(env, {
                action: 'get_booth_counts',
                spreadsheetId: config.currentSpreadsheetId
            });
            if (!result.success) throw new Error(result.error || '申込数を取得できませんでした');
            counts = result.counts || {};
            workshopReservations = result.workshopReservations || {};
        }

        const response = new Response(JSON.stringify({
            success: true,
            booths: buildPublicBoothAvailability(config, counts),
            workshop: buildPublicWorkshopAvailability(config, workshopReservations)
        }), {
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': `public, max-age=${BOOTH_AVAILABILITY_TTL_SEC}`
            }
        });
        const put = caches.default.put(cacheKey, response.clone());
        if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
        return response;
    } catch (error) {
        console.error('Booth availability error:', error.message);
        return new Response(JSON.stringify({ success: false, error: '空き状況を取得できませんでした' }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
    }
}

/**
 * 内容確認ページのデータの持ち方。
 *
 * GASは一時的にJSONではなくHTMLのエラーページを返すことがある（同時実行の集中や
 * Google側の不調）。その一瞬のために出展者へ白紙とパースエラーを見せないよう、
 * 最後に取れたデータを二段構えで抱えておく。
 *   - エッジキャッシュ: 1時間持たせ、5分を過ぎたら裏で取り直しつつ古い方を返す。
 *     待たせないだけでなく、期限切れの瞬間にGASへアクセスが集中するのも防ぐ。
 *   - R2のバックアップ: エッジに無く、かつGASも落ちているときの最後の砦。
 *     こちらから返すときは stale を立て、古い可能性をページに出させる。
 */
const PUBLIC_DATA_SOFT_TTL_MS = 5 * 60 * 1000;
const PUBLIC_DATA_EDGE_TTL_SEC = 60 * 60;
const PUBLIC_DATA_BROWSER_TTL_SEC = 60;
const PUBLIC_DATA_BACKUP_PREFIX = 'cache/exhibitor-data/';

/**
 * 公開用確認データ取得（個人情報を除外）
 */
export async function handlePublicExhibitorData(request, env, corsHeaders, url, ctx) {
    // 修正直後に確認したい場合は ?nocache=1 を付ければ素通しできる
    const bypassCache = url.searchParams.get('nocache') === '1';

    if (!bypassCache) {
        const hit = await caches.default.match(publicExhibitorCacheKey(url));
        if (hit) {
            // 5分を過ぎていても待たせない。古い方を返して、取り直しは裏でやる。
            // ここでGASが詰まっても、詰まったことは画面に出ない。
            if (ctx && cachedAgeMs(hit) > PUBLIC_DATA_SOFT_TTL_MS) {
                ctx.waitUntil(
                    refreshPublicExhibitorData(env, url, corsHeaders, null)
                        .catch(err => console.error('Public data refresh failed:', err))
                );
            }
            return hit;
        }
    }

    try {
        return await refreshPublicExhibitorData(env, url, corsHeaders, ctx);
    } catch (error) {
        console.error('Public data error:', error);

        // GASが落ちていても、最後に取れた内容が残っていればそれを見せる
        const backup = await loadPublicExhibitorBackup(env, url, corsHeaders);
        if (backup) return backup;

        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                // 失敗はキャッシュに残さない
                'Cache-Control': 'no-store'
            }
        });
    }
}

// キャッシュに入っている応答が、取得からどれだけ経ったか
function cachedAgeMs(response) {
    const generatedAt = Date.parse(response.headers.get('X-Generated-At') || '');
    if (Number.isNaN(generatedAt)) return Infinity;
    return Date.now() - generatedAt;
}

/**
 * GASから取り直して、エッジキャッシュとR2のバックアップを更新する。
 *
 * ctxを渡すと保存を裏に回して応答を待たせない。裏で呼ぶとき（既に古い方を
 * 返した後）はnullを渡し、保存し終わるまでこの関数の中で待つ。
 */
async function refreshPublicExhibitorData(env, url, corsHeaders, ctx) {
    const payload = await buildPublicExhibitorPayload(env, url);
    const body = JSON.stringify(payload);

    const response = new Response(body, {
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'X-Generated-At': payload.generatedAt,
            // ブラウザは1分、エッジは1時間。エッジの分は5分で取り直すので
            // 誤字修正の反映は従来どおり数分で届く。長く持たせているのは
            // GASが落ちている間の予備として使うため
            'Cache-Control': `public, max-age=${PUBLIC_DATA_BROWSER_TTL_SEC}, s-maxage=${PUBLIC_DATA_EDGE_TTL_SEC}`
        }
    });

    // レスポンスは一度しか読めないので、複製をキャッシュへ回す
    const save = Promise.all([
        caches.default.put(publicExhibitorCacheKey(url), response.clone()),
        savePublicExhibitorBackup(env, url, body)
    ]).catch(err => console.error('Public data cache put failed:', err));

    if (ctx) {
        ctx.waitUntil(save);
    } else {
        await save;
    }

    return response;
}

// 出展者データの組み立て（GASと設定から作る、個人情報を除いた公開用の中身）
async function buildPublicExhibitorPayload(env, url) {
    const spreadsheetId = url.searchParams.get('sid');
    const folderIdParam = url.searchParams.get('folderId');
    const bypassCache = url.searchParams.get('nocache') === '1';

    // 1. 設定を取得 (GitHubから)
    const configPromise = fetchConfigObject(env);

    // 2/3. 出展者一覧と画像フォルダのスキャンは互いに独立しているので並列で叩く。
    //      直列にすると往復の遅いGASを2回続けて待つことになる。
    const exhibitorsPromise = (async () => {
        const config = await configPromise;
        return getGasJson(env, {
            action: 'get_exhibitors',
            spreadsheetId: spreadsheetId || config.currentSpreadsheetId
        });
    })();

    // 画像索引が取れなくても登録内容は見せたいので、ここだけは失敗を握って空で返す
    const imagesPromise = (async () => {
        try {
            const folderId = folderIdParam || (await configPromise).introImagesFolderId;
            if (!folderId) return { success: true, images: {} };

            return await getGasJson(env, {
                action: 'get_folder_images',
                folderId,
                // GAS側のキャッシュも一緒に素通しする
                nocache: bypassCache ? '1' : null
            });
        } catch (e) {
            console.error('Folder images fetch failed:', e);
            return { success: false, images: {} };
        }
    })();

    const [config, exhibitorsData, imagesData] = await Promise.all([
        configPromise, exhibitorsPromise, imagesPromise
    ]);

    if (!exhibitorsData.success) {
        throw new Error(exhibitorsData.error || 'Failed to fetch exhibitors');
    }

    // 4. 個人情報の除外と画像IDの紐付け
    const imageMap = imagesData.images || {};

    // 画像ファイル名が「番号_出展名.jpg」形式でも照合できるようにする別名索引。
    // GAS側でも同様の別名キーを生成しているが、GASが旧版のままでも動くよう
    // ここでも正規化キーの先頭に付いた連番を取り除いたキーを用意する。
    // （正規化済みキーは「_」等の区切り記号が除去済みのため、数字のみを剥がす）
    const strippedImageMap = {};
    Object.keys(imageMap).forEach(key => {
        const stripped = key.replace(/^[0-9０-９]+/, '');
        if (stripped && stripped !== key && !imageMap[stripped] && !strippedImageMap[stripped]) {
            strippedImageMap[stripped] = imageMap[key];
        }
    });

    const safeExhibitors = exhibitorsData.exhibitors.map(ex => {
        // 出展名から正規化キーを作成 (GAS側のnormalizeNameと必ず一致させること)
        // ファイル名に使えない記号（/ \ : * ? " < > |）は画像保存時に除去または
        // 「_」へ置換されるため、照合キーからも除去して一致させる
        const normalizedName = ex.exhibitorName
            .normalize('NFC')
            .replace(/[ 　\-_.\(\)（）!！?？｜|\/／\\＼:：*＊"＂”<＜>＞]/g, "")
            .toLowerCase();

        return {
            id: ex.id,
            exhibitorName: ex.exhibitorName,
            menuName: ex.menuName,
            shortPR: ex.shortPR,
            selfIntro: ex.selfIntro,
            snsLinks: ex.snsLinks,
            photoUrl: ex.photoUrl,
            // フォルダ内の画像ID（「番号_出展名.jpg」形式のファイル名にも対応）
            introImageId: imageMap[normalizedName] || strippedImageMap[normalizedName] || null,
            seatNumber: ex.seatNumber,
            advanceReservation: ex.advanceReservation, // 事前予約の有無（AK列）
            specialtyGenres: ex.specialtyGenres // 取扱いジャンル（AJ列＝得意ジャンル）
        };
    });

    return {
        success: true,
        exhibitors: safeExhibitors,
        captionTemplates: config.captionTemplates,
        eventName: config.eventName,
        // いつ時点の内容かの目印。鮮度の判定と、古い内容を出すときの表示に使う
        generatedAt: new Date().toISOString()
    };
}

// 最後に取れた内容をR2へ控える。エッジキャッシュは各拠点ごとで消えることもあるが、
// こちらはどの拠点からでも読めるので、GASが落ちている間の最後の砦になる
async function savePublicExhibitorBackup(env, url, body) {
    if (!env.R2_BUCKET) return;

    await env.R2_BUCKET.put(publicExhibitorBackupKey(url), body, {
        httpMetadata: { contentType: 'application/json' }
    });
}

// 控えてあった内容を返す。古い可能性があるので stale を立てる
async function loadPublicExhibitorBackup(env, url, corsHeaders) {
    if (!env.R2_BUCKET) return null;

    try {
        const object = await env.R2_BUCKET.get(publicExhibitorBackupKey(url));
        if (!object) return null;

        const payload = JSON.parse(await object.text());
        payload.stale = true;

        return new Response(JSON.stringify(payload), {
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'X-Data-Source': 'backup',
                // GASが復旧したらすぐ拾いたいので、この応答は溜めない
                'Cache-Control': 'no-store'
            }
        });
    } catch (e) {
        console.error('Public data backup read failed:', e);
        return null;
    }
}

// R2に控えるときのキー。参照先ごとに分ける
function publicExhibitorBackupKey(url) {
    const safe = (value) => (value || 'default').replace(/[^A-Za-z0-9_-]/g, '');
    const sid = safe(url.searchParams.get('sid'));
    const folderId = safe(url.searchParams.get('folderId'));
    return `${PUBLIC_DATA_BACKUP_PREFIX}${sid}__${folderId}.json`;
}

// エッジキャッシュのキー。参照先が変われば別物として扱いたいのでsid/folderIdだけを残し、
// nocache等の余計なパラメータは落として同じ内容が別キーに散らばらないようにする
function publicExhibitorCacheKey(url) {
    const keyUrl = new URL(url.origin + url.pathname);
    const sid = url.searchParams.get('sid');
    const folderId = url.searchParams.get('folderId');
    if (sid) keyUrl.searchParams.set('sid', sid);
    if (folderId) keyUrl.searchParams.set('folderId', folderId);
    return new Request(keyUrl.toString(), { method: 'GET' });
}

// ========================================
// Google連携（デプロイ用のユーザー認証）
// ========================================
//
// Apps Script API はサービスアカウントに対応していない。書き込み時に
// 「アカウントごとの有効化設定がない」として403になるが、サービスアカウントには
// その設定ページ自体が存在しないため回避できない。
// またスクリプト自身のトークンを使うと、Apps Scriptが自動作成した既定のCloud
// プロジェクトに紐づく。このプロジェクトはGoogle管理で利用者が操作できず、
// Apps Script APIを有効化できない。
//
// そこで、所有アカウント本人のOAuth認証を一度だけ通し、そのリフレッシュトークンで
// デプロイする。認証情報は操作可能なCloudプロジェクトのものになるため、どちらの
// 制約にも当たらない。

const OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/script.deployments'
].join(' ');

const OAUTH_TOKEN_KEY = 'config/google-oauth.json';
const OAUTH_STATE_PREFIX = 'oauth-state/';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// このWorker自身のコールバックURL。OAuthクライアントにこの値の登録が必要
function oauthRedirectUri(requestUrl) {
    return `${new URL(requestUrl).origin}/oauth/google/callback`;
}

// 連携を開始するURLを組み立てる
async function startGoogleOAuth(env, request, corsHeaders) {
    const missing = [];
    if (!env.GOOGLE_OAUTH_CLIENT_ID) missing.push('GOOGLE_OAUTH_CLIENT_ID');
    if (!env.GOOGLE_OAUTH_CLIENT_SECRET) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
    if (missing.length > 0) {
        return new Response(JSON.stringify({
            error: `Workerから次のシークレットが見えていません: ${missing.join(', ')}`
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 第三者にコールバックを踏ませても連携が成立しないよう、stateを控えて照合する
    const state = crypto.randomUUID();
    await env.R2_BUCKET.put(OAUTH_STATE_PREFIX + state, JSON.stringify({ createdAt: Date.now() }), {
        httpMetadata: { contentType: 'application/json' }
    });

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID);
    url.searchParams.set('redirect_uri', oauthRedirectUri(request.url));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', OAUTH_SCOPES);
    // リフレッシュトークンを受け取るために必要。promptを付けないと2回目以降返らない
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);

    return new Response(JSON.stringify({ url: url.toString() }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

/**
 * Googleからのリダイレクトを受ける。
 *
 * ブラウザから直接開かれるため管理画面の認証ヘッダーが付かない。
 * 代わりに、連携開始時に控えたstateと一致することを確認する。
 */
async function handleGoogleOAuthCallback(env, request) {
    const page = (title, body) => new Response(
        `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">`
        + `<meta name="viewport" content="width=device-width, initial-scale=1">`
        + `<title>${title}</title></head>`
        + `<body style="font-family:sans-serif; line-height:1.8; padding:40px; max-width:600px; margin:0 auto;">`
        + body + '</body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }
    );

    const url = new URL(request.url);
    const error = url.searchParams.get('error');
    if (error) {
        return page('連携できませんでした', `<h1>連携できませんでした</h1><p>${error}</p>`);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
        return page('連携できませんでした', '<h1>連携できませんでした</h1><p>パラメータが足りません。</p>');
    }

    const stateKey = OAUTH_STATE_PREFIX + state;
    const savedState = await env.R2_BUCKET.get(stateKey);
    if (!savedState) {
        return page('連携できませんでした',
            '<h1>連携できませんでした</h1><p>この連携リンクは無効か、期限切れです。管理画面からやり直してください。</p>');
    }
    await env.R2_BUCKET.delete(stateKey);

    const saved = JSON.parse(await savedState.text());
    if (Date.now() - saved.createdAt > OAUTH_STATE_TTL_MS) {
        return page('連携できませんでした',
            '<h1>連携できませんでした</h1><p>連携の有効期限（10分）が切れています。管理画面からやり直してください。</p>');
    }

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_OAUTH_CLIENT_ID,
            client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            redirect_uri: oauthRedirectUri(request.url),
            grant_type: 'authorization_code'
        })
    });

    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.refresh_token) {
        console.error('OAuth token exchange failed:', token);
        return page('連携できませんでした',
            `<h1>連携できませんでした</h1><p>${token.error_description || token.error || 'リフレッシュトークンが返りませんでした'}</p>`);
    }

    await env.R2_BUCKET.put(OAUTH_TOKEN_KEY, JSON.stringify({
        refresh_token: token.refresh_token,
        connected_at: new Date().toISOString()
    }), { httpMetadata: { contentType: 'application/json' } });

    return page('連携が完了しました',
        '<h1>✅ 連携が完了しました</h1><p>このタブを閉じて、管理画面に戻ってください。</p>'
        + '<p>「GASをデプロイ」が使えるようになります。</p>');
}

// 連携状態を返す（管理画面の表示用）
async function getGoogleOAuthStatus(env, corsHeaders) {
    const stored = env.R2_BUCKET ? await env.R2_BUCKET.get(OAUTH_TOKEN_KEY) : null;

    // 「未設定」だけでは、名前の打ち間違いなのか反映されていないのか切り分けられない。
    // どの名前が見えていないかを返す（値そのものは返さない）
    const missing = [];
    if (!env.GOOGLE_OAUTH_CLIENT_ID) missing.push('GOOGLE_OAUTH_CLIENT_ID');
    if (!env.GOOGLE_OAUTH_CLIENT_SECRET) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
    const configured = missing.length === 0;

    let connectedAt = null;
    if (stored) {
        try {
            connectedAt = JSON.parse(await stored.text()).connected_at || null;
        } catch (e) {
            connectedAt = null;
        }
    }

    return new Response(JSON.stringify({
        success: true,
        configured,
        missing,
        // R2が無いとリフレッシュトークンを保存できない
        hasStorage: !!env.R2_BUCKET,
        connected: !!stored,
        connectedAt
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// 連携を解除する
async function disconnectGoogleOAuth(env, corsHeaders) {
    await env.R2_BUCKET.delete(OAUTH_TOKEN_KEY);
    return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// 保存済みのリフレッシュトークンからアクセストークンを取得する
async function getGoogleUserAccessToken(env) {
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
        throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET が未設定です');
    }

    const stored = await env.R2_BUCKET.get(OAUTH_TOKEN_KEY);
    if (!stored) {
        throw new Error('Googleアカウントが未連携です。デプロイタブの「Googleアカウントを連携」から連携してください');
    }

    const { refresh_token } = JSON.parse(await stored.text());

    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            refresh_token,
            client_id: env.GOOGLE_OAUTH_CLIENT_ID,
            client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            grant_type: 'refresh_token'
        })
    });

    const token = await response.json();
    if (!response.ok || !token.access_token) {
        // 連携が取り消された・期限切れの場合はここに来る。やり直せることを伝える
        throw new Error(
            `Googleとの連携が無効になっています（${token.error_description || token.error || response.status}）。\n`
            + 'デプロイタブの「Googleアカウントを連携」からやり直してください。'
        );
    }
    return token.access_token;
}
