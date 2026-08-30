/**
 * ぶち癒しフェスタ SNS一括投稿ページ（管理者専用）
 *
 * 内容確認ページ（/confirm/）と同じ内容を管理者だけが見られる形で表示し、
 * 選択した出展者の画像＋キャプションをInstagram / Facebookへ投稿する。
 * 即時投稿と日時指定（予約）に対応し、複数人をまとめて処理できる。
 */

const API_BASE = 'https://buchiiyashi-festa-form.wakaossan2001.workers.dev';
const OVERRIDE_KEY = 'buchiiyashi_sns_caption_overrides';

// 状態
let authToken = null;
let exhibitors = [];
let templates = {};
let overrides = {};          // 出展名 => { instagram, facebook }
let selected = new Set();    // 選択中の出展者ID
let rowTimes = {};           // 出展者ID => datetime-local文字列（個別指定）
let currentId = null;        // 詳細表示中の出展者ID
let socialConfig = null;

// DOM
const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const overlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');

// ========================================
// 初期化
// ========================================
document.addEventListener('DOMContentLoaded', () => {
    overrides = loadOverrides();

    authToken = sessionStorage.getItem('adminToken');
    if (authToken) {
        startApp();
    }

    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    document.getElementById('passwordInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('logoutBtn').addEventListener('click', () => {
        sessionStorage.removeItem('adminToken');
        location.reload();
    });

    document.getElementById('reloadBtn').addEventListener('click', () => loadExhibitors());
    document.getElementById('searchInput').addEventListener('input', renderList);
    document.getElementById('selectAllBtn').addEventListener('click', selectAllVisible);
    document.getElementById('clearSelectionBtn').addEventListener('click', () => {
        selected.clear();
        renderList();
        renderPreview();
    });

    document.getElementById('testConnectionBtn').addEventListener('click', testConnection);
    document.getElementById('postBtn').addEventListener('click', handlePost);
    document.getElementById('runDueBtn').addEventListener('click', runDueNow);
    document.getElementById('refreshJobsBtn').addEventListener('click', loadJobs);
    document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);

    document.querySelectorAll('input[name="timing"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const scheduled = getTiming() === 'schedule';
            document.getElementById('scheduleOptions').classList.toggle('hidden', !scheduled);
            renderPreview();
        });
    });
    document.getElementById('scheduleStart').addEventListener('change', renderPreview);
    document.getElementById('scheduleInterval').addEventListener('input', renderPreview);
    document.getElementById('platformInsta').addEventListener('change', renderPreview);
    document.getElementById('platformFb').addEventListener('change', renderPreview);

    document.getElementById('captionInsta').addEventListener('input', () => saveOverride('instagram'));
    document.getElementById('captionFb').addEventListener('input', () => saveOverride('facebook'));
    document.getElementById('resetCaptionBtn').addEventListener('click', resetOverride);
    document.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', () => copyText(btn.dataset.copy, btn));
    });

    // 既定の開始日時は「1時間後の0分」
    const start = new Date(Date.now() + 60 * 60 * 1000);
    start.setMinutes(0, 0, 0);
    document.getElementById('scheduleStart').value = toLocalInput(start.getTime());
});

// ========================================
// 認証
// ========================================
async function handleLogin() {
    const password = document.getElementById('passwordInput').value;
    if (!password) return;

    showLoading('ログイン中…');
    try {
        const token = btoa(password);
        const res = await fetch(`${API_BASE}/api/admin/social/config`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.status === 401) {
            document.getElementById('loginError').classList.remove('hidden');
            return;
        }
        if (!res.ok) throw new Error('API Error');

        authToken = token;
        sessionStorage.setItem('adminToken', token);
        startApp();
    } catch (err) {
        console.error('Login error:', err);
        document.getElementById('loginError').classList.remove('hidden');
    } finally {
        hideLoading();
    }
}

function startApp() {
    loginScreen.classList.add('hidden');
    mainScreen.classList.remove('hidden');
    loadSocialConfig();
    loadExhibitors();
    loadJobs();
}

function authHeaders(json) {
    const headers = { 'Authorization': `Bearer ${authToken}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders(false) });
    if (res.status === 401) { sessionStorage.removeItem('adminToken'); location.reload(); return null; }
    return res.json();
}

async function apiPost(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body || {})
    });
    if (res.status === 401) { sessionStorage.removeItem('adminToken'); location.reload(); return null; }
    return res.json();
}

// ========================================
// SNS連携の状況
// ========================================
async function loadSocialConfig() {
    try {
        socialConfig = await apiGet('/api/admin/social/config');
        if (!socialConfig) return;
        renderBadge('igStatus', 'Instagram', socialConfig.instagram);
        renderBadge('fbStatus', 'Facebook', socialConfig.facebook);

        const missing = [
            ...(socialConfig.instagram.missing || []),
            ...(socialConfig.facebook.missing || [])
        ];
        document.getElementById('connectionDetail').textContent = missing.length
            ? `未設定の項目: ${[...new Set(missing)].join(' / ')}`
            : '';
    } catch (err) {
        console.error('Social config error:', err);
    }
}

function renderBadge(elementId, label, info) {
    const el = document.getElementById(elementId);
    el.className = `badge ${info.configured ? 'badge-ok' : 'badge-ng'}`;
    el.textContent = `${label}: ${info.configured ? '設定済み' : '未設定'}`;
}

async function testConnection() {
    showLoading('接続を確認しています…');
    try {
        const result = await apiPost('/api/admin/social/test');
        if (!result) return;

        const lines = [];
        if (result.instagram) {
            lines.push(result.instagram.ok
                ? `✅ Instagram: @${result.instagram.username} に接続できました`
                : `❌ Instagram: ${result.instagram.error}`);
        }
        if (result.facebook) {
            lines.push(result.facebook.ok
                ? `✅ Facebook: 「${result.facebook.name}」に接続できました`
                : `❌ Facebook: ${result.facebook.error}`);
        }
        document.getElementById('connectionDetail').textContent = lines.join('\n');
    } catch (err) {
        document.getElementById('connectionDetail').textContent = `接続テストに失敗しました: ${err.message}`;
    } finally {
        hideLoading();
    }
}

// ========================================
// 出展者データ
// ========================================
async function loadExhibitors() {
    showLoading('出展者データを読み込んでいます…');
    try {
        const res = await fetch(`${API_BASE}/api/public/exhibitor-data`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'データの取得に失敗しました');

        exhibitors = data.exhibitors || [];
        templates = data.captionTemplates || {};
        if (data.eventName) document.getElementById('eventName').textContent = data.eventName;

        renderList();
        renderPreview();
    } catch (err) {
        document.getElementById('exhibitorList').innerHTML =
            `<p class="empty">読み込みに失敗しました：${escapeHtml(err.message)}</p>`;
    } finally {
        hideLoading();
    }
}

function visibleExhibitors() {
    const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
    if (!keyword) return exhibitors;
    return exhibitors.filter(ex => (ex.exhibitorName || '').toLowerCase().includes(keyword));
}

function renderList() {
    const list = document.getElementById('exhibitorList');
    const rows = visibleExhibitors();

    if (rows.length === 0) {
        list.innerHTML = '<p class="empty">該当する出展者がいません</p>';
        updateSelectionCount();
        return;
    }

    list.innerHTML = rows.map(ex => {
        const checked = selected.has(ex.id) ? 'checked' : '';
        const active = currentId === ex.id ? 'active' : '';
        const thumb = ex.introImageId
            ? `<img class="row-thumb" src="https://lh3.googleusercontent.com/d/${ex.introImageId}=w88" alt="" loading="lazy">`
            : '<div class="row-thumb"></div>';
        const tags = [];
        if (!ex.introImageId) tags.push('<span class="tag tag-warn">画像なし</span>');
        if (overrides[ex.exhibitorName]) tags.push('<span class="tag tag-edit">編集済み</span>');
        if (ex.seatNumber) tags.push(`<span class="tag">席 ${escapeHtml(ex.seatNumber)}</span>`);

        return `
            <div class="exhibitor-row ${active}" data-id="${ex.id}">
                <input type="checkbox" data-check="${ex.id}" ${checked}>
                ${thumb}
                <div class="row-main" data-open="${ex.id}">
                    <div class="row-name">${escapeHtml(ex.exhibitorName || '(名称未設定)')}</div>
                    <div class="row-sub">${tags.join('')}</div>
                </div>
                <input type="datetime-local" class="row-time" data-time="${ex.id}"
                    value="${rowTimes[ex.id] || ''}" title="この出展者だけの投稿日時">
            </div>`;
    }).join('');

    list.querySelectorAll('[data-check]').forEach(box => {
        box.addEventListener('change', (e) => {
            const id = Number(e.target.dataset.check);
            if (e.target.checked) selected.add(id); else selected.delete(id);
            updateSelectionCount();
            renderPreview();
        });
    });

    list.querySelectorAll('[data-open]').forEach(el => {
        el.addEventListener('click', () => showDetail(Number(el.dataset.open)));
    });

    list.querySelectorAll('[data-time]').forEach(input => {
        input.addEventListener('change', (e) => {
            const id = Number(e.target.dataset.time);
            if (e.target.value) rowTimes[id] = e.target.value; else delete rowTimes[id];
            renderPreview();
        });
    });

    updateSelectionCount();
}

function selectAllVisible() {
    visibleExhibitors().forEach(ex => selected.add(ex.id));
    renderList();
    renderPreview();
}

function updateSelectionCount() {
    document.getElementById('selectionCount').textContent = `${selected.size}件選択`;
}

// ========================================
// 詳細（内容確認）
// ========================================
function showDetail(id) {
    const ex = exhibitors.find(e => e.id === id);
    if (!ex) return;

    currentId = id;
    document.getElementById('detailEmpty').classList.add('hidden');
    document.getElementById('detailBody').classList.remove('hidden');
    document.getElementById('detailName').textContent = ex.exhibitorName || '';

    const img = document.getElementById('detailImage');
    const noImage = document.getElementById('detailNoImage');
    const link = document.getElementById('detailImageLink');
    if (ex.introImageId) {
        const url = `https://lh3.googleusercontent.com/d/${ex.introImageId}`;
        img.src = url;
        img.classList.remove('hidden');
        noImage.classList.add('hidden');
        link.href = url;
        link.classList.remove('hidden');
        document.getElementById('detailImageNote').textContent = 'この画像がそのまま投稿されます';
    } else {
        img.classList.add('hidden');
        noImage.classList.remove('hidden');
        link.classList.add('hidden');
        document.getElementById('detailImageNote').textContent =
            '画像がありません（Instagramは投稿できません／Facebookは本文のみ投稿されます）';
    }

    document.getElementById('captionInsta').value = getCaption(ex, 'instagram');
    document.getElementById('captionFb').value = getCaption(ex, 'facebook');
    updateCaptionCounts();

    document.getElementById('metaMenu').textContent = ex.menuName || '-';
    document.getElementById('metaGenre').textContent = ex.specialtyGenres || '-';
    document.getElementById('metaPr').textContent = ex.shortPR || '-';
    document.getElementById('metaIntro').textContent = ex.selfIntro || '-';
    document.getElementById('metaSeat').textContent = ex.seatNumber || '未定';

    document.getElementById('captionSaveStatus').textContent =
        overrides[ex.exhibitorName] ? '※このページで編集した内容が保存されています' : '';

    renderList();
}

function saveOverride(platform) {
    const ex = exhibitors.find(e => e.id === currentId);
    if (!ex) return;

    const value = platform === 'instagram'
        ? document.getElementById('captionInsta').value
        : document.getElementById('captionFb').value;

    const current = overrides[ex.exhibitorName] || {};
    current[platform] = value;
    overrides[ex.exhibitorName] = current;
    persistOverrides();

    document.getElementById('captionSaveStatus').textContent = '※このページで編集した内容が保存されています';
    updateCaptionCounts();
}

function resetOverride() {
    const ex = exhibitors.find(e => e.id === currentId);
    if (!ex) return;

    delete overrides[ex.exhibitorName];
    persistOverrides();

    document.getElementById('captionInsta').value = buildCaption(ex, 'instagram');
    document.getElementById('captionFb').value = buildCaption(ex, 'facebook');
    document.getElementById('captionSaveStatus').textContent = 'テンプレートの内容に戻しました';
    updateCaptionCounts();
    renderList();
}

function updateCaptionCounts() {
    const insta = document.getElementById('captionInsta').value.length;
    const fb = document.getElementById('captionFb').value.length;
    const instaEl = document.getElementById('instaCount');
    instaEl.textContent = `${insta}文字${insta > 2200 ? '（上限2,200文字を超えています）' : ''}`;
    instaEl.style.color = insta > 2200 ? 'var(--error)' : '';
    document.getElementById('fbCount').textContent = `${fb}文字`;
}

function loadOverrides() {
    try {
        return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}');
    } catch (err) {
        return {};
    }
}

function persistOverrides() {
    try {
        localStorage.setItem(OVERRIDE_KEY, JSON.stringify(overrides));
    } catch (err) {
        console.error('Failed to save overrides', err);
    }
}

// ========================================
// キャプション生成（内容確認ページと同じ変換）
// ========================================
function getCaption(ex, platform) {
    const override = overrides[ex.exhibitorName];
    if (override && typeof override[platform] === 'string') return override[platform];
    return buildCaption(ex, platform);
}

function buildCaption(ex, platform) {
    let caption = templates[platform] || defaultTemplate(platform);

    caption = caption.replace(/\{\{出展名\}\}/g, ex.exhibitorName || '');
    caption = caption.replace(/\{\{メニュー\}\}/g, ex.menuName || '');
    caption = caption.replace(/\{\{一言PR\}\}/g, ex.shortPR || '');
    caption = caption.replace(/\{\{自己紹介\}\}/g, ex.selfIntro || '');
    caption = caption.replace(/\{\{事前予約\}\}/g, formatReservation(ex.advanceReservation));

    if (platform === 'instagram') {
        caption = caption.replace(/\{\{SNSアカウント\}\}/g, extractAllInstagramHandles(ex.snsLinks));
    } else {
        caption = caption.replace(/\{\{SNSリンク一覧\}\}/g, formatSnsLinks(ex.snsLinks));
    }

    return caption.trim();
}

function formatReservation(value) {
    const v = String(value || '').trim();
    if (v === '可') return '○可\n（ご予約の際は直接，出展者様にお問い合わせください。）';
    if (v === '不可') return '×不可（当日受付のみ）';
    return v;
}

function extractInstagramHandle(url) {
    if (!url) return '';
    const match = url.match(/instagram\.com\/([^\/\?]+)/i);
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
        'Ameblo': '📝', 'note': '✍️', 'HP': '🌐', 'Linktree': '🌐', 'lit.link': '🌐'
    };
    return map[type] || '🔗';
}

function defaultTemplate(platform) {
    return platform === 'instagram'
        ? '【{{出展名}}】をご紹介✨\n\n{{メニュー}}\n\n{{一言PR}}\n\n{{SNSアカウント}}\n\n#ぶち癒しフェスタ'
        : '【{{出展名}}】をご紹介✨\n\n{{メニュー}}\n\n{{一言PR}}\n\n▼SNS・HP\n{{SNSリンク一覧}}';
}

// ========================================
// 投稿対象の組み立て
// ========================================
function getTiming() {
    return document.querySelector('input[name="timing"]:checked').value;
}

function getPlatforms() {
    const platforms = [];
    if (document.getElementById('platformInsta').checked) platforms.push('instagram');
    if (document.getElementById('platformFb').checked) platforms.push('facebook');
    return platforms;
}

/**
 * 選択中の出展者から投稿アイテムを作る。
 * 日時指定の場合は「個別指定 > 開始日時＋間隔」の優先順で予約時刻を決める。
 */
function buildItems() {
    const platforms = getPlatforms();
    const scheduled = getTiming() === 'schedule';
    const startValue = document.getElementById('scheduleStart').value;
    const interval = Number(document.getElementById('scheduleInterval').value || 0);
    const startEpoch = startValue ? new Date(startValue).getTime() : null;

    // 選択順ではなくリストの並び順で番号を振る
    const targets = exhibitors.filter(ex => selected.has(ex.id));

    let index = 0;
    return targets.map(ex => {
        let scheduledAt = null;
        if (scheduled) {
            if (rowTimes[ex.id]) {
                scheduledAt = new Date(rowTimes[ex.id]).getTime();
            } else if (startEpoch) {
                scheduledAt = startEpoch + index * interval * 60 * 1000;
                index++;
            }
        }

        return {
            exhibitorId: ex.id,
            exhibitorName: ex.exhibitorName,
            imageFileId: ex.introImageId || '',
            captions: {
                instagram: getCaption(ex, 'instagram'),
                facebook: getCaption(ex, 'facebook')
            },
            platforms,
            scheduledAt
        };
    });
}

function renderPreview() {
    const preview = document.getElementById('postPreview');
    const items = buildItems();
    const platforms = getPlatforms();

    if (items.length === 0) {
        preview.innerHTML = '<p class="empty">出展者が選択されていません</p>';
        document.getElementById('postBtn').textContent = '選択した出展者を投稿する';
        return;
    }

    const scheduled = getTiming() === 'schedule';
    preview.innerHTML = items.map(item => {
        const when = scheduled
            ? (item.scheduledAt ? formatDateTime(item.scheduledAt) : '⚠️ 日時未設定')
            : 'すぐに投稿';
        const warn = (!item.imageFileId && platforms.includes('instagram'))
            ? ' <span class="log-ng">画像なし（Instagram不可）</span>'
            : '';
        return `<div class="row"><span>${escapeHtml(item.exhibitorName)}</span><span>${when}${warn}</span></div>`;
    }).join('');

    document.getElementById('postBtn').textContent = scheduled
        ? `選択した${items.length}件を予約する`
        : `選択した${items.length}件を今すぐ投稿する`;
}

// ========================================
// 投稿の実行
// ========================================
async function handlePost() {
    const platforms = getPlatforms();
    const items = buildItems();
    const scheduled = getTiming() === 'schedule';
    const log = document.getElementById('postLog');

    if (items.length === 0) return alert('出展者を選択してください');
    if (platforms.length === 0) return alert('投稿先（Instagram / Facebook）を選択してください');

    if (scheduled) {
        const missing = items.filter(item => !item.scheduledAt);
        if (missing.length > 0) {
            return alert('開始日時を入力するか、出展者ごとの日時を指定してください');
        }
        const past = items.filter(item => item.scheduledAt < Date.now() - 60 * 1000);
        if (past.length > 0 && !confirm(`${past.length}件の予約日時が過去になっています。すぐに投稿されますがよろしいですか？`)) {
            return;
        }
    }

    const label = scheduled ? '予約' : '投稿';
    if (!confirm(`${items.length}件を${platforms.map(p => p === 'instagram' ? 'Instagram' : 'Facebook').join('・')}へ${label}します。よろしいですか？`)) {
        return;
    }

    document.getElementById('postBtn').disabled = true;
    log.innerHTML = '';

    try {
        if (scheduled) {
            showLoading('予約を登録しています…');
            const result = await apiPost('/api/admin/social/schedule', { items, platforms });
            if (!result) return;

            if (result.success) {
                appendLog(`✅ ${result.created.length}件を予約しました`, 'ok');
                selected.clear();
                renderList();
                renderPreview();
                await loadJobs();
            } else {
                appendLog(`❌ ${result.error}`, 'ng');
            }
        } else {
            // 1件ずつ送って進捗を出す（Workerのサブリクエスト上限にも配慮）
            let done = 0;
            for (const item of items) {
                showLoading(`投稿中… (${done + 1}/${items.length}) ${item.exhibitorName}`);
                appendLog(`▶ ${item.exhibitorName} を投稿しています…`, 'info');

                try {
                    const result = await apiPost('/api/admin/social/post', { items: [item], platforms });
                    if (!result) return;

                    if (!result.success) {
                        appendLog(`　❌ ${item.exhibitorName}: ${result.error}`, 'ng');
                    } else {
                        renderJobResult(item.exhibitorName, result.results[0]);
                    }
                } catch (err) {
                    appendLog(`　❌ ${item.exhibitorName}: ${err.message}`, 'ng');
                }
                done++;
            }
            appendLog(`— ${done}件の処理が終わりました —`, 'info');
            await loadJobs();
        }
    } finally {
        hideLoading();
        document.getElementById('postBtn').disabled = false;
    }
}

function renderJobResult(name, job) {
    if (!job) return;
    for (const platform of job.platforms) {
        const r = job.results[platform] || {};
        const label = platform === 'instagram' ? 'Instagram' : 'Facebook';
        if (r.ok) {
            const link = r.permalink ? ` <a href="${r.permalink}" target="_blank" rel="noopener">投稿を見る</a>` : '';
            appendLog(`　✅ ${name} / ${label} に投稿しました${link}`, 'ok');
        } else {
            appendLog(`　❌ ${name} / ${label}: ${r.error || '不明なエラー'}`, 'ng');
        }
    }
}

function appendLog(html, type) {
    const log = document.getElementById('postLog');
    const div = document.createElement('div');
    div.className = `log-${type === 'ok' ? 'ok' : type === 'ng' ? 'ng' : 'info'}`;
    div.innerHTML = html;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

async function runDueNow() {
    showLoading('予約分を実行しています…');
    try {
        const result = await apiPost('/api/admin/social/run-due');
        if (!result) return;
        appendLog(`⏱ 予約分を${result.processed}件処理しました`, 'info');
        await loadJobs();
    } finally {
        hideLoading();
    }
}

// ========================================
// 予約一覧・履歴
// ========================================
async function loadJobs() {
    try {
        const data = await apiGet('/api/admin/social/jobs');
        if (!data || !data.success) return;

        renderJobs('pendingJobs', data.pending, true);
        renderJobs('historyJobs', data.history, false);
    } catch (err) {
        console.error('Load jobs error:', err);
    }
}

function renderJobs(elementId, jobs, cancelable) {
    const el = document.getElementById(elementId);
    if (!jobs || jobs.length === 0) {
        el.innerHTML = `<p class="empty">${cancelable ? '予約はありません' : '履歴はありません'}</p>`;
        return;
    }

    el.innerHTML = jobs.map(job => {
        const platforms = job.platforms.map(p => p === 'instagram'
            ? '<span class="tag pf-insta">Instagram</span>'
            : '<span class="tag pf-fb">Facebook</span>').join('');

        const links = Object.entries(job.results || {})
            .filter(([, r]) => r && r.ok && r.permalink)
            .map(([platform, r]) => `<a href="${r.permalink}" target="_blank" rel="noopener">${platform === 'instagram' ? 'IG' : 'FB'}投稿</a>`)
            .join('');

        const errors = Object.entries(job.results || {})
            .filter(([, r]) => r && !r.ok)
            .map(([platform, r]) => `${platform === 'instagram' ? 'Instagram' : 'Facebook'}: ${r.error}`)
            .join('\n');

        return `
            <div class="job-row">
                <span class="job-time">${formatDateTime(job.scheduledAt)}</span>
                <span class="job-name">${escapeHtml(job.exhibitorName)}</span>
                <span class="job-platforms">${platforms}</span>
                <span class="job-status st-${job.status}">${statusLabel(job.status)}</span>
                <span class="job-links">${links}</span>
                ${cancelable ? `<button class="btn-ghost small" data-cancel="${job.id}">取消</button>` : ''}
                ${errors ? `<span class="job-error">${escapeHtml(errors)}</span>` : ''}
            </div>`;
    }).join('');

    el.querySelectorAll('[data-cancel]').forEach(btn => {
        btn.addEventListener('click', () => cancelJob(btn.dataset.cancel));
    });
}

function statusLabel(status) {
    const map = {
        pending: '予約中',
        processing: '処理中',
        done: '投稿済み',
        partial: '一部成功',
        failed: '失敗',
        canceled: '取消済み'
    };
    return map[status] || status;
}

async function cancelJob(id) {
    if (!confirm('この予約を取り消しますか？')) return;
    showLoading('予約を取り消しています…');
    try {
        const result = await apiPost('/api/admin/social/jobs/cancel', { id });
        if (result && !result.success) alert(result.error);
        await loadJobs();
    } finally {
        hideLoading();
    }
}

async function clearHistory() {
    if (!confirm('投稿履歴をすべて削除しますか？（実際の投稿は消えません）')) return;
    showLoading('履歴を削除しています…');
    try {
        await apiPost('/api/admin/social/jobs/clear-history');
        await loadJobs();
    } finally {
        hideLoading();
    }
}

// ========================================
// ユーティリティ
// ========================================
async function copyText(elementId, btn) {
    const text = document.getElementById(elementId).value;
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = 'コピーしました';
        setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (err) {
        alert('コピーに失敗しました');
    }
}

function formatDateTime(epoch) {
    if (!epoch) return '-';
    return new Date(epoch).toLocaleString('ja-JP', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'short'
    });
}

function toLocalInput(epoch) {
    const d = new Date(epoch);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showLoading(text) {
    loadingText.textContent = text || '処理中…';
    overlay.classList.remove('hidden');
}

function hideLoading() {
    overlay.classList.add('hidden');
}
