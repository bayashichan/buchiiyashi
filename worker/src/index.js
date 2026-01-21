/**
 * ぶち癒しフェスタ東京 Cloudflare Worker
 * フォームデータ中継・画像R2保存・GAS連携
 */

export default {
    async fetch(request, env, ctx) {
        // CORS対応
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // プリフライトリクエスト
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

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
                    // 画像をR2に保存
                    const imageUrl = await saveImageToR2(env, value);
                    data['profileImageUrl'] = imageUrl;
                } else {
                    data[key] = value;
                }
            }

            // タイムスタンプ追加
            data['submittedAt'] = new Date().toISOString();

            // GASへデータ送信
            const gasResponse = await fetch(env.GAS_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data)
            });

            if (!gasResponse.ok) {
                throw new Error('GAS request failed');
            }

            const gasResult = await gasResponse.json();

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
};

/**
 * 画像をR2に保存し、公開URLを返す
 */
async function saveImageToR2(env, file) {
    // ファイル名生成 (タイムスタンプ + ランダム文字列)
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const extension = file.name.split('.').pop().toLowerCase();
    const fileName = `profile_${timestamp}_${randomStr}.${extension}`;

    // ファイルサイズチェック (5MB以下)
    if (file.size > 5 * 1024 * 1024) {
        throw new Error('Image file too large (max 5MB)');
    }

    // 許可された拡張子チェック
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    if (!allowedExtensions.includes(extension)) {
        throw new Error('Invalid image format');
    }

    // R2に保存
    const arrayBuffer = await file.arrayBuffer();
    await env.R2_BUCKET.put(fileName, arrayBuffer, {
        httpMetadata: {
            contentType: file.type,
        },
    });

    // 公開URL生成 (R2のカスタムドメインまたはパブリックバケット設定が必要)
    return `${env.R2_PUBLIC_URL}/${fileName}`;
}
