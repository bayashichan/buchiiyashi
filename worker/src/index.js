/**
 * ぶち癒しフェスタ東京 Cloudflare Worker
 * フォームデータ中継・画像Base64変換・GAS連携（Drive保存）
 * + 管理API（config更新・GASデプロイ）
 * + SNS一括投稿API（Facebook / Instagram、即時・予約）
 */

import { handleSocialAPI, runDueJobs } from './social.js';

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

        if (url.pathname.startsWith('/api/admin')) {
            return handleAdminAPI(request, env, corsHeaders, url, ctx);
        }

        // 公開用確認データ取得API
        if (url.pathname === '/api/public/exhibitor-data' && request.method === 'GET') {
            return handlePublicExhibitorData(request, env, corsHeaders, url);
        }

        // 既存のフォーム送信処理
        return handleFormSubmission(request, env, corsHeaders);
    },

    // Cron Trigger: 予約時刻を過ぎたSNS投稿を実行する
    async scheduled(event, env, ctx) {
        ctx.waitUntil(
            runDueJobs(env)
                .then(count => {
                    if (count > 0) console.log(`Social scheduler: processed ${count} job(s)`);
                })
                .catch(err => console.error('Social scheduler error:', err))
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

        // GET /api/admin/image-folders - 確認サイト参照先の候補フォルダ一覧取得
        if (url.pathname === '/api/admin/image-folders' && request.method === 'GET') {
            return await getImageFolders(env, corsHeaders);
        }

        // POST /api/admin/resend-confirmation - 申込時自動返信メールの再送
        if (url.pathname === '/api/admin/resend-confirmation' && request.method === 'POST') {
            const body = await request.json();
            return await resendConfirmation(env, body, corsHeaders);
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

// 設定取得（GitHubからconfig.json読み込み）
async function getConfig(env, corsHeaders) {
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

    const configJson = await response.text();
    const config = JSON.parse(configJson);

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

// GASデプロイ
/**
 * Apps Script プロジェクトへ反映するファイル。リポジトリ側を正とする。
 *
 * appsscript.json は意図的に含めない。マニフェストはWebアプリの公開設定
 * （誰がアクセスできるか）を持っており、リポジトリのコピーにはそれが無い。
 * 上書きすると公開URLが機能しなくなるため、Apps Script側のものをそのまま残す。
 */
const GAS_DEPLOY_FILES = [
    { path: 'gas/code.gs', name: 'code', type: 'SERVER_JS' },
    { path: 'gas/mail_template.html', name: 'mail_template', type: 'HTML' },
    { path: 'gas/admin_mail_template.html', name: 'admin_mail_template', type: 'HTML' }
];

/**
 * リポジトリの gas/ 配下を Apps Script プロジェクトへ反映し、Webアプリを更新する。
 *
 * 以前はバージョンを切るだけでコードを送っておらず、Apps Scriptエディタへ
 * 手作業で貼り付ける必要があった。その手作業が、エディタで直接直した内容を
 * 消してしまう事故につながっていた。
 *
 * 上書きの前に必ず現在のコードをバージョンとして退避するので、
 * エディタ側の変更が入っていた場合もそのバージョンから復元できる。
 */
async function deployGas(env, corsHeaders) {
    const scriptId = env.GAS_SCRIPT_ID;
    const accessToken = await getGoogleAccessToken(env, GAS_DEPLOY_SCOPES);

    // 1. リポジトリの最新を取得
    const repoFiles = [];
    for (const file of GAS_DEPLOY_FILES) {
        repoFiles.push({
            name: file.name,
            type: file.type,
            source: await fetchRepoFile(env, file.path)
        });
    }

    // 2. Apps Script 側の現在の内容
    const current = await gasApi(accessToken, `projects/${scriptId}/content`);
    const currentFiles = current.files || [];
    const currentByName = new Map(currentFiles.map(f => [f.name, f]));

    // 3. 差分を出す。何が上書きされるのかを管理画面に返すため
    const changedFiles = repoFiles
        .filter(f => normalizeSource((currentByName.get(f.name) || {}).source) !== normalizeSource(f.source))
        .map(f => f.name);

    // Apps Script 側にしか無いファイル（エディタで直接追加されたもの）は消さずに残す
    const keptFiles = currentFiles.filter(f => !repoFiles.some(r => r.name === f.name));

    let backupVersion = null;

    if (changedFiles.length > 0) {
        // 4. 上書きの前に、いまのコードをバージョンとして退避する
        backupVersion = await createGasVersion(accessToken, scriptId, '上書き前の自動バックアップ');

        // 5. 内容を差し替え
        await gasApi(accessToken, `projects/${scriptId}/content`, {
            method: 'PUT',
            body: { files: [...repoFiles, ...keptFiles] }
        });
    }

    // 6. 新しいバージョンを作成
    const versionNumber = await createGasVersion(accessToken, scriptId, '管理画面からデプロイ');

    // 7. Webアプリのデプロイを新しいバージョンへ向ける（/exec のURLは変わらない）
    const deployments = await updateGasDeployments(accessToken, scriptId, versionNumber);

    return new Response(JSON.stringify({
        success: true,
        changedFiles,
        versionNumber,
        backupVersion,
        deployments,
        // エディタ側で直接直した内容を上書きした可能性を管理画面で知らせるため
        message: changedFiles.length > 0
            ? `${changedFiles.join(', ')} を更新し、バージョン${versionNumber}として公開しました`
            : `コードに変更はありませんでした。バージョン${versionNumber}として公開し直しました`
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// リポジトリからファイルの中身を取得する（rawで受け取るのでBase64のデコードが不要）
async function fetchRepoFile(env, path) {
    const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
        {
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.raw',
                'User-Agent': 'BuchiiyashiFesta-Admin'
            }
        }
    );

    if (!response.ok) {
        throw new Error(`GitHubからの取得に失敗しました (${path}): ${response.status}`);
    }
    return await response.text();
}

// Apps Script API 呼び出しの共通処理
async function gasApi(accessToken, path, options = {}) {
    const method = options.method || 'GET';
    const response = await fetch(`https://script.googleapis.com/v1/${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Apps Script API ${method} ${path} が失敗しました: ${response.status} ${errorText}`);
    }
    return await response.json();
}

// 新しいバージョンを作成して、そのバージョン番号を返す
async function createGasVersion(accessToken, scriptId, description) {
    const version = await gasApi(accessToken, `projects/${scriptId}/versions`, {
        method: 'POST',
        body: { description: `${description}: ${new Date().toISOString()}` }
    });
    return version.versionNumber;
}

/**
 * 既存のデプロイを新しいバージョンへ向ける。
 *
 * 既存のデプロイを更新するので /exec のURLは変わらない。
 * バージョンを持たないHEAD（テスト用）デプロイは常に最新コードを返すため触らない。
 */
async function updateGasDeployments(accessToken, scriptId, versionNumber) {
    const list = await gasApi(accessToken, `projects/${scriptId}/deployments`);
    const results = [];

    for (const deployment of (list.deployments || [])) {
        const config = deployment.deploymentConfig || {};
        if (config.versionNumber === undefined || config.versionNumber === null) continue;

        try {
            await gasApi(accessToken, `projects/${scriptId}/deployments/${deployment.deploymentId}`, {
                method: 'PUT',
                body: {
                    deploymentConfig: {
                        scriptId,
                        versionNumber,
                        manifestFileName: config.manifestFileName || 'appsscript',
                        description: config.description || ''
                    }
                }
            });
            results.push({ deploymentId: deployment.deploymentId, updated: true });
        } catch (error) {
            // 1つ失敗しても他のデプロイの更新は続ける。結果は管理画面に出す
            console.error(`Failed to update deployment ${deployment.deploymentId}:`, error);
            results.push({ deploymentId: deployment.deploymentId, updated: false, error: error.message });
        }
    }

    return results;
}

// 改行コードと末尾の空白の違いは差分とみなさない（Apps Script側で正規化されるため）
function normalizeSource(source) {
    return String(source || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

// Googleアクセストークン取得（サービスアカウント）
// デプロイの更新には script.projects だけでは足りず、script.deployments が要る
const GAS_DEPLOY_SCOPES = 'https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/script.deployments';

async function getGoogleAccessToken(env, scopes) {
    const saKey = JSON.parse(atob(env.GOOGLE_SA_KEY));

    // JWT作成
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: saKey.client_email,
        scope: scopes || 'https://www.googleapis.com/auth/script.projects',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    };

    const jwt = await signJwt(header, payload, saKey.private_key);

    // トークン取得
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        })
    });

    if (!tokenResponse.ok) {
        throw new Error('Failed to get Google access token');
    }

    const tokenData = await tokenResponse.json();
    return tokenData.access_token;
}

// JWT署名
async function signJwt(header, payload, privateKeyPem) {
    const encoder = new TextEncoder();

    const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const unsignedToken = `${headerB64}.${payloadB64}`;

    // PEMからCryptoKey作成
    const pemContents = privateKeyPem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\n/g, '');

    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
        'pkcs8',
        binaryKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );

    // 署名
    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        cryptoKey,
        encoder.encode(unsignedToken)
    );

    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    return `${unsignedToken}.${signatureB64}`;
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

        const accessToken = await getGoogleAccessToken(env);

        console.log(`Sending create spreadsheet request to GAS for: ${name}`);
        const gasResponse = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'create_spreadsheet',
                name: name,
                accessToken: accessToken // GAS側での権限拡張が必要な場合に備えてトークンも渡すが、GAS単体で動くなら不要かも
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
        const gasUrl = new URL(env.GAS_URL);
        gasUrl.searchParams.append('action', 'get_exhibitors');
        if (spreadsheetId) {
            gasUrl.searchParams.append('spreadsheetId', spreadsheetId);
        }

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
        console.error('Get exhibitors error:', error);
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

        const response = await fetch(env.GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'resend_confirmation_email',
                spreadsheetId: spreadsheetId || '',
                rowIds,
                testEmail: testEmail || ''
            })
        });

        const result = await response.json();
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

        // LINE管理アプリへ申込者を連携する（申込受付とは独立。失敗しても申込は成功扱い）
        await registerApplicantToLineManager(data, env);

        // 申込内容をLINEでも本人へ通知する（メールと二本立て。失敗しても申込は成功扱い）
        await sendLineConfirmation(data, gasResult, env);

        return new Response(JSON.stringify({
            success: true,
            message: 'Application submitted successfully',
            ...gasResult
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

/**
 * LINE管理アプリ(line-manager)へ申込者を連携する。
 *
 * ブラウザからではなくWorkerから呼ぶ。シークレットをクライアントに晒さないため。
 * 管理アプリ側で Messaging API を使って友だち判定を行い、友だちなら友だち一覧に、
 * 友だちでなければ「未友だち申込者」として記録される。
 *
 * ここでの失敗は申込受付を巻き添えにしない（ログのみ）。申込自体は既にGASへ保存済み。
 */
async function registerApplicantToLineManager(data, env) {
    if (!env.LINE_MANAGER_URL || !env.LINE_MANAGER_SECRET || !env.LINE_MANAGER_CHANNEL_ID) {
        console.log('line-manager連携: 未設定のためスキップ');
        return;
    }

    // LINE情報が取れていない申込は連携できない（誰の申込か特定できないため）
    if (!data.lineUserId) {
        console.warn(`line-manager連携: lineUserIdが空のためスキップ (lineLinkStatus: ${data.lineLinkStatus || '不明'})`);
        return;
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
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`line-manager連携に失敗: ${response.status} ${errorText}`);
            return;
        }

        const result = await response.json();
        console.log(`line-manager連携成功: isFriend=${result.isFriend}`);
    } catch (error) {
        console.error('line-manager連携エラー:', error);
    }
}

/**
 * 申込内容をLINEでも申込者本人へ通知する（確認メールと二本立て）。
 *
 * Messaging APIのpushを直接叩く。GASでの保存・確認メール送信が成功した後にだけ呼ぶ。
 * ここでの失敗は申込受付を巻き添えにしない（ログのみ）。申込は既にGASへ保存済みで
 * 確認メールも送信済みのため、LINEが届かなくても申込者への案内は成立する。
 *
 * 送れない条件（トークン未設定・LINE未連携・友だち未追加）は例外にせずスキップする。
 */
async function sendLineConfirmation(data, gasResult, env) {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
        console.log('LINE通知: LINE_CHANNEL_ACCESS_TOKEN未設定のためスキップ');
        return;
    }

    // LIFFログインが取れていない申込は送り先が分からない（メールのみで案内する）
    if (!data.lineUserId) {
        console.warn(`LINE通知: lineUserIdが空のためスキップ (lineLinkStatus: ${data.lineLinkStatus || '不明'})`);
        return;
    }

    const body = JSON.stringify({
        to: data.lineUserId,
        messages: [{ type: 'text', text: buildLineConfirmationMessage(data, gasResult) }]
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
                return;
            }

            const errorText = await response.text();

            // 友だち未追加・ブロック中。再送しても結果は変わらない（案内はメールで届いている）
            if (response.status === 403) {
                console.warn(`LINE通知: 友だち未追加またはブロック中のため送信できません: ${errorText}`);
                return;
            }

            // 認証エラーやリクエスト不備は再送しても直らない
            if (response.status !== 429 && response.status < 500) {
                console.error(`LINE通知に失敗: ${response.status} ${errorText}`);
                return;
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
}

/**
 * LINEで送る申込完了メッセージを組み立てる。
 *
 * 金額の内訳や振込先の詳細は確認メールが正なので、ここは受付内容の要約に絞る。
 * 同じ内容を二箇所で管理すると、片方だけ更新されて食い違うため。
 */
function buildLineConfirmationMessage(data, gasResult) {
    const eventName = data.eventName || 'ぶち癒やしフェスタin東京';
    const result = gasResult || {};

    const lines = [
        `${data.name || ''} 様`.trim(),
        '',
        `この度は「${eventName}」へのお申し込み、誠にありがとうございます。`,
        '以下の内容でお申し込みを受け付けました。'
    ];

    // 値が取れなかった項目は行ごと出さない（「出展名: 」のような空行を送らないため）
    const detailLines = [
        data.exhibitorName ? `出展名: ${data.exhibitorName}` : '',
        data.boothName ? `出展ブース: ${data.boothName}` : '',
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
    if (Number.isFinite(totalFee)) {
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
    lines.push(`お申し込み内容の詳細とお振込先は、ご登録のメールアドレス${data.email ? `（${data.email}）` : ''}宛にお送りしています。`);
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
 * 公開用確認データ取得（個人情報を除外）
 */
async function handlePublicExhibitorData(request, env, corsHeaders, url) {
    try {
        const spreadsheetId = url.searchParams.get('sid');
        
        // 1. 設定を取得 (GitHubから)
        const configResponse = await getConfig(env, corsHeaders);
        const config = await configResponse.json();
        
        // 2. 出展者一覧を取得 (GASから)
        const gasUrl = new URL(env.GAS_URL);
        gasUrl.searchParams.append('action', 'get_exhibitors');
        if (spreadsheetId) {
            gasUrl.searchParams.append('spreadsheetId', spreadsheetId);
        } else if (config.currentSpreadsheetId) {
            gasUrl.searchParams.append('spreadsheetId', config.currentSpreadsheetId);
        }

        const exhibitorsRes = await fetch(gasUrl.toString(), { redirect: 'follow' });
        const exhibitorsData = await exhibitorsRes.json();

        if (!exhibitorsData.success) {
            throw new Error(exhibitorsData.error || 'Failed to fetch exhibitors');
        }

        // 3. 画像フォルダのスキャン (GASから)
        const folderId = url.searchParams.get('folderId') || config.introImagesFolderId;
        let imagesData = { success: true, images: {} };
        
        if (folderId) {
            const imagesGasUrl = new URL(env.GAS_URL);
            imagesGasUrl.searchParams.append('action', 'get_folder_images');
            imagesGasUrl.searchParams.append('folderId', folderId);
            
            const imagesRes = await fetch(imagesGasUrl.toString(), { redirect: 'follow' });
            imagesData = await imagesRes.json();
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

        return new Response(JSON.stringify({
            success: true,
            exhibitors: safeExhibitors,
            captionTemplates: config.captionTemplates,
            eventName: config.eventName
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Public data error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}
