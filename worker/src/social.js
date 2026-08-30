/**
 * ぶち癒しフェスタ SNS一括投稿モジュール
 *
 * 管理画面（/admin/sns/）から、出展者の画像＋キャプションを
 * Facebookページ／Instagram(ビジネスアカウント)へ投稿する。
 *
 * - 即時投稿と日時指定（予約投稿）の両方に対応
 * - 予約はR2に保存し、Cron Trigger（scheduledハンドラ）が実行する
 * - 投稿画像はGoogle Driveから取得してR2へミラーし、公開URLをGraph APIへ渡す
 *   （Instagramは公開URLのJPEGしか受け付けないため）
 *
 * 必要なシークレット（Cloudflareダッシュボード or wrangler secret put）:
 *   - FB_PAGE_ID              : 投稿先Facebookページのページ ID
 *   - FB_PAGE_ACCESS_TOKEN    : 上記ページの長期ページアクセストークン
 *   - IG_USER_ID              : Instagramビジネスアカウントの ID
 *   - IG_ACCESS_TOKEN         : 省略時は FB_PAGE_ACCESS_TOKEN を使う
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const PENDING_PREFIX = 'social/jobs/pending/';
const INDEX_KEY = 'social/jobs/index.json';
const IMAGE_PREFIX = 'social/images/';

// 1回のCron実行で処理する最大件数。
// Workerは1リクエストあたりのサブリクエスト数に上限（無料プランは50）があり、
// 1件の投稿で10〜20回の外部呼び出しを行うため、既定は少なめにしている。
const DEFAULT_MAX_JOBS_PER_TICK = 3;
// 予約時刻の許容誤差（この秒数だけ先の予約も実行対象にする）
const DUE_TOLERANCE_MS = 30 * 1000;
// 履歴（index.json）に残す件数
const HISTORY_LIMIT = 300;

// ========================================
// ルーティング
// ========================================

/**
 * /api/admin/social/* のルーティング。
 * 認証は呼び出し元（handleAdminAPI）で済んでいる前提。
 * 該当ルートが無ければ null を返す。
 */
export async function handleSocialAPI(request, env, corsHeaders, url, ctx) {
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/api/admin/social/config' && request.method === 'GET') {
        return json(getSocialConfig(env), 200, corsHeaders);
    }

    if (path === '/api/admin/social/test' && request.method === 'POST') {
        return json(await testConnection(env), 200, corsHeaders);
    }

    if (path === '/api/admin/social/post' && request.method === 'POST') {
        const body = await request.json();
        return json(await postNow(env, body), 200, corsHeaders);
    }

    if (path === '/api/admin/social/schedule' && request.method === 'POST') {
        const body = await request.json();
        return json(await scheduleJobs(env, body), 200, corsHeaders);
    }

    if (path === '/api/admin/social/jobs' && request.method === 'GET') {
        return json(await listJobs(env), 200, corsHeaders);
    }

    if (path === '/api/admin/social/jobs/cancel' && request.method === 'POST') {
        const body = await request.json();
        return json(await cancelJob(env, body.id), 200, corsHeaders);
    }

    if (path === '/api/admin/social/jobs/clear-history' && request.method === 'POST') {
        return json(await clearHistory(env), 200, corsHeaders);
    }

    // 予約分を手動で実行（動作確認・Cronが止まっている場合の救済用）
    if (path === '/api/admin/social/run-due' && request.method === 'POST') {
        const processed = await runDueJobs(env);
        return json({ success: true, processed }, 200, corsHeaders);
    }

    return null;
}

function json(data, status, corsHeaders) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// ========================================
// 設定・接続確認
// ========================================

function fbToken(env) {
    return env.FB_PAGE_ACCESS_TOKEN || env.META_ACCESS_TOKEN || '';
}

function igToken(env) {
    return env.IG_ACCESS_TOKEN || fbToken(env);
}

export function getSocialConfig(env) {
    return {
        success: true,
        graphVersion: GRAPH_VERSION,
        facebook: {
            configured: Boolean(env.FB_PAGE_ID && fbToken(env)),
            pageId: env.FB_PAGE_ID || '',
            missing: [
                env.FB_PAGE_ID ? null : 'FB_PAGE_ID',
                fbToken(env) ? null : 'FB_PAGE_ACCESS_TOKEN'
            ].filter(Boolean)
        },
        instagram: {
            configured: Boolean(env.IG_USER_ID && igToken(env)),
            igUserId: env.IG_USER_ID || '',
            missing: [
                env.IG_USER_ID ? null : 'IG_USER_ID',
                igToken(env) ? null : 'FB_PAGE_ACCESS_TOKEN（またはIG_ACCESS_TOKEN）'
            ].filter(Boolean)
        },
        // 予約投稿と画像ミラーにR2が必要
        storage: {
            bucket: Boolean(env.R2_BUCKET),
            publicUrl: env.R2_PUBLIC_URL || ''
        }
    };
}

async function testConnection(env) {
    const result = { success: true, facebook: null, instagram: null };

    if (env.FB_PAGE_ID && fbToken(env)) {
        try {
            const data = await graphGet(`${GRAPH_BASE}/${env.FB_PAGE_ID}`, {
                fields: 'id,name,link',
                access_token: fbToken(env)
            });
            result.facebook = { ok: true, name: data.name, id: data.id };
        } catch (err) {
            result.facebook = { ok: false, error: err.message };
        }
    } else {
        result.facebook = { ok: false, error: 'FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN が未設定です' };
    }

    if (env.IG_USER_ID && igToken(env)) {
        try {
            const data = await graphGet(`${GRAPH_BASE}/${env.IG_USER_ID}`, {
                fields: 'id,username',
                access_token: igToken(env)
            });
            result.instagram = { ok: true, username: data.username, id: data.id };
        } catch (err) {
            result.instagram = { ok: false, error: err.message };
        }
    } else {
        result.instagram = { ok: false, error: 'IG_USER_ID / アクセストークンが未設定です' };
    }

    return result;
}

// ========================================
// 即時投稿
// ========================================

/**
 * body: { items: [ { id, exhibitorName, imageFileId, imageUrl, captions:{facebook,instagram} } ],
 *         platforms: ['facebook','instagram'] }
 */
async function postNow(env, body) {
    const items = Array.isArray(body.items) ? body.items : [];
    const platforms = normalizePlatforms(body.platforms);

    if (items.length === 0) return { success: false, error: '投稿対象が選択されていません' };
    if (platforms.length === 0) return { success: false, error: '投稿先（Instagram / Facebook）を選択してください' };

    const invalid = validateItems(items, platforms);
    if (invalid) return { success: false, error: invalid };

    const results = [];
    for (const item of items) {
        const job = buildJob(item, platforms, Date.now());
        await executeJob(env, job);
        results.push(job);
    }

    // 即時投稿もあとから結果を確認できるように履歴へ残す
    await updateIndex(env, results);

    return { success: true, results };
}

// ========================================
// 予約投稿
// ========================================

/**
 * body: { items: [ { ...item, scheduledAt: epochMs } ], platforms: [...] }
 */
async function scheduleJobs(env, body) {
    if (!env.R2_BUCKET) {
        return { success: false, error: '予約投稿にはR2バケットの設定が必要です（wrangler.tomlのR2_BUCKET）' };
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const platforms = normalizePlatforms(body.platforms);

    if (items.length === 0) return { success: false, error: '投稿対象が選択されていません' };
    if (platforms.length === 0) return { success: false, error: '投稿先（Instagram / Facebook）を選択してください' };

    const invalid = validateItems(items, platforms);
    if (invalid) return { success: false, error: invalid };

    const created = [];
    for (const item of items) {
        const scheduledAt = Number(item.scheduledAt);
        if (!scheduledAt || Number.isNaN(scheduledAt)) {
            return { success: false, error: `${item.exhibitorName || '出展者'} の予約日時が不正です` };
        }
        const job = buildJob(item, platforms, scheduledAt);
        job.status = 'pending';
        await savePending(env, job);
        created.push(job);
    }

    await updateIndex(env, created);
    return { success: true, created };
}

async function listJobs(env) {
    if (!env.R2_BUCKET) return { success: true, pending: [], history: [], now: Date.now() };

    const index = await readIndex(env);
    const pending = index.filter(job => job.status === 'pending' || job.status === 'processing');
    const history = index.filter(job => job.status !== 'pending' && job.status !== 'processing');

    pending.sort((a, b) => a.scheduledAt - b.scheduledAt);
    history.sort((a, b) => (b.executedAt || b.scheduledAt) - (a.executedAt || a.scheduledAt));

    return { success: true, pending, history: history.slice(0, 100), now: Date.now() };
}

async function cancelJob(env, id) {
    if (!id) return { success: false, error: 'idが指定されていません' };
    if (!env.R2_BUCKET) return { success: false, error: 'R2バケットが未設定です' };

    const key = await findPendingKey(env, id);
    if (!key) return { success: false, error: '該当する予約が見つかりません（すでに実行済みの可能性があります）' };

    await env.R2_BUCKET.delete(key);

    const index = await readIndex(env);
    const entry = index.find(job => job.id === id);
    if (entry) {
        entry.status = 'canceled';
        entry.executedAt = Date.now();
    }
    await writeIndex(env, index);

    return { success: true };
}

async function clearHistory(env) {
    if (!env.R2_BUCKET) return { success: false, error: 'R2バケットが未設定です' };

    const index = await readIndex(env);
    const kept = index.filter(job => job.status === 'pending' || job.status === 'processing');
    await writeIndex(env, kept);

    return { success: true, deleted: index.length - kept.length };
}

// ========================================
// Cronからの実行
// ========================================

/**
 * 予約時刻を過ぎたジョブを実行する。scheduledハンドラと手動実行の両方から呼ばれる。
 */
export async function runDueJobs(env) {
    if (!env.R2_BUCKET) return 0;

    const maxPerTick = Number(env.SOCIAL_MAX_JOBS_PER_TICK) || DEFAULT_MAX_JOBS_PER_TICK;
    const now = Date.now() + DUE_TOLERANCE_MS;
    const listed = await env.R2_BUCKET.list({ prefix: PENDING_PREFIX, limit: 1000 });

    // キー先頭のゼロ埋めエポックで昇順に並ぶので、そのまま古い順になる
    const due = listed.objects
        .filter(obj => dueEpochFromKey(obj.key) <= now)
        .slice(0, maxPerTick);

    if (due.length === 0) return 0;

    const finished = [];
    for (const obj of due) {
        const stored = await env.R2_BUCKET.get(obj.key);
        if (!stored) continue;

        let job;
        try {
            job = JSON.parse(await stored.text());
        } catch (err) {
            console.error('Broken job json:', obj.key);
            await env.R2_BUCKET.delete(obj.key);
            continue;
        }

        // 二重実行を防ぐため、実行前にpendingのオブジェクトを消す
        await env.R2_BUCKET.delete(obj.key);

        try {
            await executeJob(env, job);
        } catch (err) {
            job.status = 'failed';
            job.error = err.message;
            job.executedAt = Date.now();
        }
        finished.push(job);
    }

    await updateIndex(env, finished);
    return finished.length;
}

// ========================================
// ジョブの組み立てと実行
// ========================================

/** 投稿前に弾けるものは弾く。問題なければ null を返す */
function validateItems(items, platforms) {
    const toInstagram = platforms.includes('instagram');
    if (!toInstagram) return null;

    for (const item of items) {
        const count = normalizeImages(item).length;
        if (count > IG_CAROUSEL_MAX) {
            return `Instagramの複数画像投稿は${IG_CAROUSEL_MAX}枚までです（${count}枚が指定されています）。`
                + '出展者の数を減らすか、Facebookのみに投稿してください';
        }
    }
    return null;
}

function normalizePlatforms(platforms) {
    const allowed = ['instagram', 'facebook'];
    if (!Array.isArray(platforms)) return [];
    return allowed.filter(p => platforms.includes(p));
}

/**
 * 投稿対象の画像を配列に正規化する。
 * 1人分の投稿は1枚、まとめて1投稿する場合は複数枚になる。
 */
function normalizeImages(item) {
    const images = [];

    if (Array.isArray(item.images)) {
        for (const image of item.images) {
            if (!image) continue;
            const fileId = image.fileId || image.imageFileId || '';
            const url = image.url || image.imageUrl || '';
            if (fileId || url) images.push({ fileId, url, name: image.name || '' });
        }
    }

    if (images.length === 0 && (item.imageFileId || item.imageUrl)) {
        images.push({
            fileId: item.imageFileId || '',
            url: item.imageUrl || '',
            name: item.exhibitorName || ''
        });
    }

    // 同じ画像を重複して投稿しないようにする
    const seen = new Set();
    return images.filter(image => {
        const key = image.fileId || image.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildJob(item, platforms, scheduledAt) {
    const images = normalizeImages(item);

    return {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        scheduledAt,
        platforms: normalizePlatforms(item.platforms).length ? normalizePlatforms(item.platforms) : platforms,
        // combined = 複数人を1投稿にまとめる（Instagramはカルーセル、Facebookは複数写真）
        mode: item.mode === 'combined' ? 'combined' : 'single',
        exhibitorId: item.exhibitorId ?? item.id ?? null,
        exhibitorName: item.exhibitorName || '(名称未設定)',
        images,
        captions: {
            instagram: (item.captions && item.captions.instagram) || '',
            facebook: (item.captions && item.captions.facebook) || ''
        },
        status: 'pending',
        results: {},
        executedAt: null,
        error: null
    };
}

/**
 * ジョブを実際に投稿する。結果は job.results / job.status に書き込む。
 */
async function executeJob(env, job) {
    job.results = job.results || {};
    const needsJpeg = job.platforms.includes('instagram');
    const images = job.images && job.images.length ? job.images : normalizeImages(job);

    const imageUrls = [];
    const imageErrors = [];

    // 公開URLの確認は1回で足りるので、ジョブ単位で結果を使い回す
    const context = { publicUrlVerified: null };

    for (const image of images) {
        try {
            imageUrls.push(await prepareImageUrl(env, image, needsJpeg, job.id, context));
        } catch (err) {
            imageErrors.push(`${image.name || '画像'}: ${err.message}`);
        }
    }

    job.preparedImageUrls = imageUrls;
    const imageError = imageErrors.length
        ? `画像の準備に失敗しました（${imageErrors.join(' / ')}）`
        : (images.length === 0 ? '投稿する画像が見つかりません' : null);

    for (const platform of job.platforms) {
        const caption = job.captions[platform] || '';
        try {
            if (platform === 'facebook') {
                // 画像が無い場合でもFacebookはテキスト投稿ができる
                job.results.facebook = await postToFacebook(env, imageUrls, caption);
            } else {
                if (imageUrls.length === 0) throw new Error(imageError || '投稿する画像が見つかりません');
                job.results.instagram = await postToInstagram(env, imageUrls, caption);
            }
        } catch (err) {
            job.results[platform] = { ok: false, error: err.message };
        }
    }

    if (imageError) job.error = imageError;

    const outcomes = job.platforms.map(p => job.results[p] && job.results[p].ok);
    if (outcomes.every(Boolean)) job.status = 'done';
    else if (outcomes.some(Boolean)) job.status = 'partial';
    else job.status = 'failed';

    job.executedAt = Date.now();
    return job;
}

// ========================================
// 画像の準備（Drive → R2ミラー）
// ========================================

/**
 * Graph APIが取得できる公開URLを1枚分用意する。
 * InstagramはJPEGのみ対応なので、必要なら lh3 のJPEG変換／GAS変換を経由する。
 *
 * image   : { fileId, url, name }
 * context : ジョブ内で使い回す情報（R2公開URLの確認結果など）
 */
async function prepareImageUrl(env, image, needsJpeg, jobId, context = {}) {
    const candidates = [];

    if (image.fileId) {
        // lh3 の "-rj" はJPEGでの配信を要求するパラメータ
        if (needsJpeg) candidates.push(`https://lh3.googleusercontent.com/d/${image.fileId}=w1440-rj`);
        candidates.push(`https://lh3.googleusercontent.com/d/${image.fileId}=w1440`);
        candidates.push(`https://lh3.googleusercontent.com/d/${image.fileId}`);
        candidates.push(`https://drive.google.com/uc?export=download&id=${image.fileId}`);
    }
    if (image.url) candidates.push(image.url);

    if (candidates.length === 0) throw new Error('投稿する画像が指定されていません');

    let fetched = null;
    let lastError = '';
    for (const candidate of candidates) {
        try {
            const res = await fetch(candidate, {
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BuchiiyashiBot/1.0)' }
            });
            if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }

            const contentType = (res.headers.get('Content-Type') || '').split(';')[0].trim();
            if (!contentType.startsWith('image/')) { lastError = `画像ではありません (${contentType})`; continue; }

            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.byteLength === 0) { lastError = '画像が空です'; continue; }

            fetched = { bytes, contentType };
            if (!needsJpeg || contentType === 'image/jpeg') break;
            // JPEGが必要なのにJPEGで返ってこなかった場合は次の候補を試す
            lastError = `Instagramで使えない形式です (${contentType})`;
        } catch (err) {
            lastError = err.message;
        }
    }

    // どの候補でもJPEGにならなかった場合はGAS側で変換してもらう
    if (needsJpeg && (!fetched || fetched.contentType !== 'image/jpeg') && image.fileId && env.GAS_URL) {
        const converted = await convertToJpegViaGas(env, image.fileId);
        if (converted) fetched = converted;
    }

    if (!fetched) throw new Error(`画像を取得できませんでした（${lastError}）`);
    if (needsJpeg && fetched.contentType !== 'image/jpeg') {
        throw new Error('InstagramはJPEG画像のみ投稿できます。画像をJPEGに変換してください');
    }

    // R2が使えるならミラーして公開URLを返す（Drive URLはGraph側からの取得が不安定なため）
    if (env.R2_BUCKET && env.R2_PUBLIC_URL) {
        const ext = fetched.contentType === 'image/png' ? 'png' : 'jpg';
        const key = `${IMAGE_PREFIX}${image.fileId || jobId}-${await shortHash(fetched.bytes)}.${ext}`;
        await env.R2_BUCKET.put(key, fetched.bytes, {
            httpMetadata: {
                contentType: fetched.contentType,
                cacheControl: 'public, max-age=86400'
            }
        });

        const publicUrl = `${env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
        // バケットの公開設定が無効だとMeta側から取得できないので、1枚目で確かめておく
        if (context.publicUrlVerified === null || context.publicUrlVerified === undefined) {
            context.publicUrlVerified = await isPubliclyReadable(publicUrl);
            if (!context.publicUrlVerified) console.warn('R2 public URL is not readable, falling back to Drive URL');
        }
        if (context.publicUrlVerified) return publicUrl;
    }

    // R2が使えない場合はDriveの公開URLをそのまま使う
    const fallback = driveFallbackUrl(image, needsJpeg);
    if (!fallback) throw new Error('投稿できる公開URLを用意できませんでした');
    return fallback;
}

function driveFallbackUrl(image, needsJpeg) {
    if (image.fileId) {
        return needsJpeg
            ? `https://lh3.googleusercontent.com/d/${image.fileId}=w1440-rj`
            : `https://lh3.googleusercontent.com/d/${image.fileId}=w1440`;
    }
    return image.url || null;
}

async function isPubliclyReadable(url) {
    try {
        const res = await fetch(url, { method: 'HEAD' });
        return res.ok;
    } catch (err) {
        return false;
    }
}

async function convertToJpegViaGas(env, fileId) {
    try {
        const gasUrl = new URL(env.GAS_URL);
        gasUrl.searchParams.append('action', 'get_image_jpeg');
        gasUrl.searchParams.append('fileId', fileId);

        const res = await fetch(gasUrl.toString(), { redirect: 'follow' });
        const data = await res.json();
        if (!data.success || !data.base64) return null;

        return { bytes: base64ToBytes(data.base64), contentType: 'image/jpeg' };
    } catch (err) {
        console.error('GAS jpeg conversion failed:', err);
        return null;
    }
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function shortHash(bytes) {
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ========================================
// Facebook / Instagram 投稿
// ========================================

// Instagramのカルーセルは2〜10枚まで
const IG_CAROUSEL_MAX = 10;

/**
 * Facebookページへ投稿する。
 * 画像なし=テキスト投稿 / 1枚=写真投稿 / 2枚以上=複数写真をまとめた1投稿
 */
async function postToFacebook(env, imageUrls, caption) {
    if (!env.FB_PAGE_ID || !fbToken(env)) {
        throw new Error('Facebookの設定（FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN）が未設定です');
    }
    const token = fbToken(env);
    const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : (imageUrls ? [imageUrls] : []);

    let data;
    if (urls.length === 0) {
        data = await graphPost(`${GRAPH_BASE}/${env.FB_PAGE_ID}/feed`, {
            message: caption,
            access_token: token
        });
    } else if (urls.length === 1) {
        data = await graphPost(`${GRAPH_BASE}/${env.FB_PAGE_ID}/photos`, {
            url: urls[0],
            caption,
            published: 'true',
            access_token: token
        });
    } else {
        // 複数写真は「未公開の写真」を先に作り、まとめて1件の投稿に添付する
        const mediaIds = [];
        for (const url of urls) {
            const photo = await graphPost(`${GRAPH_BASE}/${env.FB_PAGE_ID}/photos`, {
                url,
                published: 'false',
                temporary: 'true',
                access_token: token
            });
            if (photo.id) mediaIds.push(photo.id);
        }
        if (mediaIds.length === 0) throw new Error('Facebookへの画像アップロードに失敗しました');

        const params = { message: caption, access_token: token };
        mediaIds.forEach((id, i) => {
            params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
        });
        data = await graphPost(`${GRAPH_BASE}/${env.FB_PAGE_ID}/feed`, params);
    }

    const postId = data.post_id || data.id;
    return {
        ok: true,
        postId,
        imageCount: urls.length,
        permalink: postId ? `https://www.facebook.com/${postId}` : null,
        postedAt: Date.now()
    };
}

/**
 * Instagramへ投稿する。1枚なら通常の投稿、2枚以上はカルーセル投稿。
 */
async function postToInstagram(env, imageUrls, caption) {
    if (!env.IG_USER_ID || !igToken(env)) {
        throw new Error('Instagramの設定（IG_USER_ID / アクセストークン）が未設定です');
    }
    const token = igToken(env);
    const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : (imageUrls ? [imageUrls] : []);

    if (urls.length === 0) throw new Error('投稿する画像がありません');
    if (urls.length > IG_CAROUSEL_MAX) {
        throw new Error(`Instagramの複数画像投稿は${IG_CAROUSEL_MAX}枚までです（${urls.length}枚が指定されています）`);
    }

    let creationId;
    if (urls.length === 1) {
        // 1. メディアコンテナ作成
        const container = await graphPost(`${GRAPH_BASE}/${env.IG_USER_ID}/media`, {
            image_url: urls[0],
            caption,
            access_token: token
        });
        creationId = container.id;
    } else {
        // 1-a. 各画像のカルーセル用コンテナを作る（キャプションは親側に付ける）
        const children = [];
        for (const url of urls) {
            const child = await graphPost(`${GRAPH_BASE}/${env.IG_USER_ID}/media`, {
                image_url: url,
                is_carousel_item: 'true',
                access_token: token
            });
            if (child.id) children.push(child.id);
        }
        if (children.length < 2) throw new Error('Instagramのカルーセル用画像を用意できませんでした');

        // 1-b. まとめ役のカルーセルコンテナを作る
        const carousel = await graphPost(`${GRAPH_BASE}/${env.IG_USER_ID}/media`, {
            media_type: 'CAROUSEL',
            children: children.join(','),
            caption,
            access_token: token
        });
        creationId = carousel.id;
    }

    if (!creationId) throw new Error('Instagramのメディア作成に失敗しました');

    // 2. コンテナの処理完了を待つ
    await waitForContainer(creationId, token);

    // 3. 公開
    const published = await graphPost(`${GRAPH_BASE}/${env.IG_USER_ID}/media_publish`, {
        creation_id: creationId,
        access_token: token
    });

    let permalink = null;
    try {
        const info = await graphGet(`${GRAPH_BASE}/${published.id}`, { fields: 'permalink', access_token: token });
        permalink = info.permalink || null;
    } catch (err) {
        // パーマリンクが取れなくても投稿自体は成功しているので握りつぶす
    }

    return { ok: true, postId: published.id, imageCount: urls.length, permalink, postedAt: Date.now() };
}

async function waitForContainer(creationId, token, maxAttempts = 12) {
    for (let i = 0; i < maxAttempts; i++) {
        const status = await graphGet(`${GRAPH_BASE}/${creationId}`, {
            fields: 'status_code,status',
            access_token: token
        });

        if (status.status_code === 'FINISHED') return;
        if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
            throw new Error(`Instagramの画像処理に失敗しました（${status.status || status.status_code}）`);
        }
        await sleep(2500);
    }
    throw new Error('Instagramの画像処理がタイムアウトしました');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================================
// Graph APIヘルパー
// ========================================

async function graphGet(endpoint, params) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
    const res = await fetch(url.toString());
    return parseGraphResponse(res);
}

async function graphPost(endpoint, params) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) form.set(key, value);
    }
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
    });
    return parseGraphResponse(res);
}

async function parseGraphResponse(res) {
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new Error(`Graph APIの応答を解釈できませんでした: ${text.slice(0, 200)}`);
    }

    if (!res.ok || data.error) {
        const e = data.error || {};
        const detail = e.error_user_msg || e.message || `HTTP ${res.status}`;
        const code = e.code ? `[code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}] ` : '';
        throw new Error(`${code}${detail}`);
    }
    return data;
}

// ========================================
// R2上のジョブ保存
// ========================================
//
// - 予約待ちのジョブ本体（キャプション込み）は social/jobs/pending/ に1件ずつ置く
// - 一覧表示用の要約は social/jobs/index.json にまとめて置く
//   （R2の呼び出しもWorkerのサブリクエスト数に数えられるため、
//     一覧のたびに全ジョブを読みに行かない作りにしている）

function pendingKey(job) {
    return `${PENDING_PREFIX}${String(job.scheduledAt).padStart(15, '0')}_${job.id}.json`;
}

function dueEpochFromKey(key) {
    const name = key.split('/').pop() || '';
    const epoch = parseInt(name.split('_')[0], 10);
    return Number.isNaN(epoch) ? 0 : epoch;
}

async function savePending(env, job) {
    await env.R2_BUCKET.put(pendingKey(job), JSON.stringify(job), {
        httpMetadata: { contentType: 'application/json' }
    });
}

async function findPendingKey(env, id) {
    const listed = await env.R2_BUCKET.list({ prefix: PENDING_PREFIX, limit: 1000 });
    const hit = listed.objects.find(obj => obj.key.endsWith(`_${id}.json`));
    return hit ? hit.key : null;
}

/** 一覧に出す分だけの要約（キャプション本文は持たせない） */
function toSummary(job) {
    return {
        id: job.id,
        createdAt: job.createdAt,
        scheduledAt: job.scheduledAt,
        executedAt: job.executedAt || null,
        exhibitorId: job.exhibitorId,
        exhibitorName: job.exhibitorName,
        platforms: job.platforms,
        status: job.status,
        error: job.error || null,
        mode: job.mode || 'single',
        imageCount: (job.images || []).length,
        results: Object.fromEntries(
            Object.entries(job.results || {}).map(([platform, r]) => [platform, {
                ok: Boolean(r && r.ok),
                postId: (r && r.postId) || null,
                permalink: (r && r.permalink) || null,
                error: (r && r.error) || null
            }])
        )
    };
}

async function readIndex(env) {
    try {
        const stored = await env.R2_BUCKET.get(INDEX_KEY);
        if (!stored) return [];
        const parsed = JSON.parse(await stored.text());
        return Array.isArray(parsed) ? parsed : (parsed.jobs || []);
    } catch (err) {
        console.error('Failed to read social job index:', err);
        return [];
    }
}

async function writeIndex(env, jobs) {
    // 新しいものから HISTORY_LIMIT 件だけ残す（予約中は必ず残す）
    const pending = jobs.filter(job => job.status === 'pending' || job.status === 'processing');
    const rest = jobs
        .filter(job => job.status !== 'pending' && job.status !== 'processing')
        .sort((a, b) => (b.executedAt || b.scheduledAt || 0) - (a.executedAt || a.scheduledAt || 0))
        .slice(0, HISTORY_LIMIT);

    await env.R2_BUCKET.put(INDEX_KEY, JSON.stringify([...pending, ...rest]), {
        httpMetadata: { contentType: 'application/json' }
    });
}

/** 与えられたジョブの要約でindexを更新する（同じidがあれば置き換える） */
async function updateIndex(env, jobs) {
    if (!env.R2_BUCKET || !jobs || jobs.length === 0) return;

    const index = await readIndex(env);
    for (const job of jobs) {
        const summary = toSummary(job);
        const at = index.findIndex(entry => entry.id === summary.id);
        if (at >= 0) index[at] = summary;
        else index.push(summary);
    }
    await writeIndex(env, index);
}
