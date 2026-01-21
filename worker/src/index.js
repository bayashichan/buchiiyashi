/**
 * ぶち癒しフェスタ東京 Cloudflare Worker
 * フォームデータ中継・画像Base64変換・GAS連携（Drive保存）
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
};

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
