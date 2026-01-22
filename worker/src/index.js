/**
 * ぶち癒しフェスタ東京 Cloudflare Worker
 * フォームデータ中継・画像Base64変換・GAS連携（Drive保存）
 * + 管理API（config更新・GASデプロイ）
 */

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
        if (url.pathname.startsWith('/api/admin')) {
            return handleAdminAPI(request, env, corsHeaders, url);
        }

        // 既存のフォーム送信処理
        return handleFormSubmission(request, env, corsHeaders);
    }
};

// ========================================
// 管理API
// ========================================
async function handleAdminAPI(request, env, corsHeaders, url) {
    // 認証チェック
    const authResult = verifyAuth(request, env);
    if (!authResult.success) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
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

// 設定取得（GitHubからconfig.js読み込み）
async function getConfig(env, corsHeaders) {
    const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/apply/config.js`,
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

    const configJs = await response.text();

    // config.jsからCONFIGオブジェクトを抽出してJSONに変換
    const config = parseConfigJs(configJs);

    return new Response(JSON.stringify(config), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// config.jsをパース
function parseConfigJs(jsContent) {
    // const CONFIG = { ... }; を抽出
    const match = jsContent.match(/const CONFIG\s*=\s*(\{[\s\S]*?\n\};)/);
    if (!match) {
        throw new Error('Could not parse config.js');
    }

    // JavaScriptオブジェクトをJSONに変換（コメントを除去）
    let objStr = match[1];
    objStr = objStr.replace(/\/\/.*$/gm, ''); // 行コメント除去
    objStr = objStr.replace(/\/\*[\s\S]*?\*\//g, ''); // ブロックコメント除去
    objStr = objStr.replace(/,(\s*[}\]])/g, '$1'); // trailing comma除去

    // キーをダブルクォートで囲む
    objStr = objStr.replace(/(\s)(\w+)(\s*:)/g, '$1"$2"$3');

    // シングルクォートをダブルクォートに
    objStr = objStr.replace(/'/g, '"');

    // 末尾のセミコロン除去
    objStr = objStr.replace(/;\s*$/, '');

    try {
        return JSON.parse(objStr);
    } catch (e) {
        console.error('JSON parse error:', e, objStr.slice(0, 500));
        throw new Error('Failed to parse config as JSON');
    }
}

// 設定更新（GitHubにconfig.jsを保存）
async function updateConfig(env, newConfig, corsHeaders) {
    // まず現在のファイル情報を取得（sha必要）
    const fileInfoResponse = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/apply/config.js`,
        {
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'BuchiiyashiFesta-Admin'
            }
        }
    );

    if (!fileInfoResponse.ok) {
        throw new Error(`GitHub API error: ${fileInfoResponse.status}`);
    }

    const fileInfo = await fileInfoResponse.json();

    // config.jsを生成
    const newConfigJs = generateConfigJs(newConfig);
    const encodedContent = btoa(unescape(encodeURIComponent(newConfigJs)));

    // GitHubに保存
    const updateResponse = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/contents/apply/config.js`,
        {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'BuchiiyashiFesta-Admin'
            },
            body: JSON.stringify({
                message: '管理画面から設定更新',
                content: encodedContent,
                sha: fileInfo.sha
            })
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
async function deployGas(env, corsHeaders) {
    // Apps Script APIを使用してデプロイ
    // サービスアカウント認証でアクセストークンを取得
    const accessToken = await getGoogleAccessToken(env);

    // スクリプトの内容を取得
    const scriptResponse = await fetch(
        `https://script.googleapis.com/v1/projects/${env.GAS_SCRIPT_ID}/content`,
        {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            }
        }
    );

    if (!scriptResponse.ok) {
        const errorText = await scriptResponse.text();
        throw new Error(`Apps Script API error: ${scriptResponse.status} ${errorText}`);
    }

    // 新しいバージョンを作成（デプロイ）
    const versionResponse = await fetch(
        `https://script.googleapis.com/v1/projects/${env.GAS_SCRIPT_ID}/versions`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                description: '管理画面からデプロイ: ' + new Date().toISOString()
            })
        }
    );

    if (!versionResponse.ok) {
        const errorText = await versionResponse.text();
        throw new Error(`Version create failed: ${versionResponse.status} ${errorText}`);
    }

    return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Googleアクセストークン取得（サービスアカウント）
async function getGoogleAccessToken(env) {
    const saKey = JSON.parse(atob(env.GOOGLE_SA_KEY));

    // JWT作成
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: saKey.client_email,
        scope: 'https://www.googleapis.com/auth/script.projects',
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

        // フォームデータを抽出
        for (const [key, value] of formData.entries()) {
            if (key === 'profileImage' && value instanceof File && value.size > 0) {
                // 画像をBase64に変換してGASに送信
                const imageData = await convertImageToBase64(value);
                data['profileImageBase64'] = imageData.base64;
                data['profileImageMimeType'] = imageData.mimeType;
                data['profileImageName'] = imageData.fileName;
            } else {
                data[key] = value;
            }
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
 * 画像をBase64に変換
 */
async function convertImageToBase64(file) {
    // ファイルサイズチェック (8MB以下)
    if (file.size > 8 * 1024 * 1024) {
        throw new Error('Image file too large (max 8MB)');
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
