/**
 * ぶち癒しフェスタ 出展者確認ページ
 */

const API_BASE = 'https://buchiiyashi-festa-form.wakaossan2001.workers.dev';

// 状態管理
let exhibitors = [];
let templates = {};
let currentExhibitor = null;
let currentPlatform = 'instagram';

// DOM要素
const selectEl = document.getElementById('exhibitor-select');
const contentArea = document.getElementById('content-area');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const errorMsgEl = document.getElementById('error-message');

const introImageEl = document.getElementById('intro-image');
const noImageEl = document.getElementById('no-image');
const captionTextEl = document.getElementById('caption-text');
const eventNameEl = document.getElementById('event-name');

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    await loadData();

    // イベントリスナー
    selectEl.addEventListener('change', (e) => {
        const id = parseInt(e.target.value);
        if (id) {
            showExhibitor(id);
        } else {
            contentArea.classList.add('hidden');
        }
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPlatform = btn.dataset.platform;
            renderCaption();
        });
    });

    document.getElementById('copy-btn').addEventListener('click', copyCaption);
});

// データ読み込み
async function loadData() {
    showLoading(true);
    try {
        const url = new URL(`${API_BASE}/api/public/exhibitor-data`);
        
        // クエリパラメータがあれば引き継ぐ（デバッグ等用）
        const params = new URLSearchParams(window.location.search);
        if (params.has('sid')) url.searchParams.append('sid', params.get('sid'));
        if (params.has('folderId')) url.searchParams.append('folderId', params.get('folderId'));

        const response = await fetch(url);
        const result = await response.json();

        if (result.success) {
            exhibitors = result.exhibitors;
            templates = result.captionTemplates;
            if (result.eventName) eventNameEl.textContent = result.eventName;
            
            renderSelect();
            showLoading(false);
        } else {
            throw new Error(result.error || 'データの取得に失敗しました');
        }
    } catch (err) {
        console.error('Load data error:', err);
        showError(err.message);
    }
}

// セレクトボックス描画
function renderSelect() {
    selectEl.innerHTML = '<option value="">出展名を選択してください...</option>' +
        exhibitors.map(ex => `<option value="${ex.id}">${ex.exhibitorName}</option>`).join('');
}

// 出展者情報表示
function showExhibitor(id) {
    currentExhibitor = exhibitors.find(ex => ex.id === id);
    if (!currentExhibitor) return;

    contentArea.classList.remove('hidden');

    // 画像表示
    if (currentExhibitor.introImageId) {
        introImageEl.src = `https://lh3.googleusercontent.com/d/${currentExhibitor.introImageId}`;
        introImageEl.classList.remove('hidden');
        noImageEl.classList.add('hidden');
    } else {
        introImageEl.classList.add('hidden');
        noImageEl.classList.remove('hidden');
    }

    // 詳細情報
    document.getElementById('detail-menu').textContent = currentExhibitor.menuName || '-';
    document.getElementById('detail-pr').textContent = currentExhibitor.shortPR || '-';
    document.getElementById('detail-intro').textContent = currentExhibitor.selfIntro || '-';
    document.getElementById('detail-seat').textContent = currentExhibitor.seatNumber || '未定';

    // キャプション
    renderCaption();

    // スムーズにスクロール
    contentArea.scrollIntoView({ behavior: 'smooth' });
}

// キャプション描画
function renderCaption() {
    if (!currentExhibitor) return;

    let template = templates[currentPlatform] || getDefaultTemplate(currentPlatform);
    let caption = template;

    // プレースホルダー置換
    caption = caption.replace(/\{\{出展名\}\}/g, currentExhibitor.exhibitorName || '');
    caption = caption.replace(/\{\{メニュー\}\}/g, currentExhibitor.menuName || '');
    caption = caption.replace(/\{\{一言PR\}\}/g, currentExhibitor.shortPR || '');
    caption = caption.replace(/\{\{自己紹介\}\}/g, currentExhibitor.selfIntro || '');

    // SNS処理
    if (currentPlatform === 'instagram') {
        const handles = extractAllInstagramHandles(currentExhibitor.snsLinks);
        caption = caption.replace(/\{\{SNSアカウント\}\}/g, handles);
    } else {
        const snsLinks = formatSnsLinks(currentExhibitor.snsLinks);
        caption = caption.replace(/\{\{SNSリンク一覧\}\}/g, snsLinks);
    }

    captionTextEl.value = caption.trim();
}

// クリップボードコピー
async function copyCaption() {
    const text = captionTextEl.value;
    if (!text) return;

    try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('copy-btn');
        const originalText = btn.textContent;
        btn.textContent = '✅ コピーしました！';
        setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (err) {
        alert('コピーに失敗しました');
    }
}

// ユーティリティ
function extractInstagramHandle(url) {
    if (!url) return '';
    const match = url.match(/instagram\.com\/([^\/\?]+)/);
    return match ? match[1] : '';
}

function extractAllInstagramHandles(snsLinks) {
    if (Array.isArray(snsLinks)) {
        return snsLinks
            .filter(l => l.type === 'Instagram')
            .map(l => { const h = extractInstagramHandle(l.url); return h ? `@${h}` : ''; })
            .filter(Boolean)
            .join(' ');
    }
    if (snsLinks && typeof snsLinks === 'object') {
        const handles = [];
        ['insta', 'insta2'].forEach(key => {
            if (snsLinks[key]) {
                const h = extractInstagramHandle(snsLinks[key]);
                if (h) handles.push(`@${h}`);
            }
        });
        return handles.join(' ');
    }
    return '';
}

function formatSnsLinks(snsLinks) {
    if (Array.isArray(snsLinks) && snsLinks.length > 0) {
        return snsLinks.map(l => `${getSnsEmoji(l.type)} ${l.type}: ${l.url}`).join('\n');
    }
    if (snsLinks && typeof snsLinks === 'object') {
        const links = [];
        if (snsLinks.hp) links.push(`🌐 HP: ${snsLinks.hp}`);
        if (snsLinks.blog) links.push(`📝 ブログ: ${snsLinks.blog}`);
        if (snsLinks.insta) links.push(`📸 Instagram: ${snsLinks.insta}`);
        if (snsLinks.insta2) links.push(`📸 Instagram: ${snsLinks.insta2}`);
        if (snsLinks.fb) links.push(`👤 Facebook: ${snsLinks.fb}`);
        if (snsLinks.line) links.push(`💬 LINE: ${snsLinks.line}`);
        if (snsLinks.other) links.push(`🔗 その他: ${snsLinks.other}`);
        return links.join('\n');
    }
    return '';
}

function getSnsEmoji(type) {
    const map = {
        'Instagram': '📸', 'Facebook': '👤', '公式LINE': '💬',
        'YouTube': '▶️', 'TikTok': '🎵', 'X(Twitter)': '🐦',
        'Ameblo': '📝', 'HP': '🌐', 'Linktree': '🌐', 'lit.link': '🌐'
    };
    return map[type] || '🔗';
}

function getDefaultTemplate(platform) {
    return platform === 'instagram' 
        ? '【{{出展名}}】をご紹介✨\n\n{{メニュー}}\n\n{{一言PR}}\n\n{{SNSアカウント}}\n\n#ぶち癒しフェスタ'
        : '【{{出展名}}】をご紹介✨\n\n{{メニュー}}\n\n{{一言PR}}\n\n▼SNS・HP\n{{SNSリンク一覧}}';
}

function showLoading(show) {
    loadingEl.classList.toggle('hidden', !show);
    if (show) {
        errorEl.classList.add('hidden');
        contentArea.classList.add('hidden');
    }
}

function showError(msg) {
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
    errorMsgEl.textContent = msg;
}
