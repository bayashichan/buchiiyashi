/**
 * ぶち癒しフェスタ 管理画面スクリプト
 */

// API Base URL (Worker)
const API_BASE = 'https://buchiiyashi-festa-form.wakaossan2001.workers.dev';

// 状態管理
let config = null;
let authToken = null;
let exhibitors = []; // 出展者一覧

// DOM要素
const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const loadingOverlay = document.getElementById('loadingOverlay');

// ========================================
// 初期化
// ========================================
document.addEventListener('DOMContentLoaded', () => {
    // ログイン状態チェック
    authToken = sessionStorage.getItem('adminToken');
    if (authToken) {
        showMainScreen();
    }

    // イベントリスナー設定
    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    document.getElementById('passwordInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);

    // タブ切り替え
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // デプロイボタン
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
    document.getElementById('deployGasBtn').addEventListener('click', deployGas);
    document.getElementById('saveAllBtn').addEventListener('click', saveConfig);

    // スプレッドシート作成
    document.getElementById('createSpreadsheetBtn').addEventListener('click', createSpreadsheet);

    // 画像生成関連
    document.getElementById('loadExhibitorsBtn')?.addEventListener('click', loadExhibitors);
    document.getElementById('loadCaptionExhibitorsBtn')?.addEventListener('click', loadExhibitors);
    document.getElementById('generateSelectedBtn')?.addEventListener('click', generateSelectedImages);
    document.getElementById('generateAllBtn')?.addEventListener('click', generateAllImages);

    // キャプション生成関連
    document.getElementById('generateCaptionInstaBtn')?.addEventListener('click', () => generateCaption('instagram'));
    document.getElementById('generateCaptionFbBtn')?.addEventListener('click', () => generateCaption('facebook'));
    document.getElementById('copyCaptionBtn')?.addEventListener('click', copyCaption);

    // プレースホルダーボタン
    document.querySelectorAll('.placeholder-btn').forEach(btn => {
        btn.addEventListener('click', () => insertPlaceholder(btn.dataset.tag));
    });

    // テキストエリアのフォーカス追跡
    document.getElementById('captionTemplateInsta')?.addEventListener('focus', () => lastFocusedTextarea = 'captionTemplateInsta');
    document.getElementById('captionTemplateFb')?.addEventListener('focus', () => lastFocusedTextarea = 'captionTemplateFb');
});

let lastFocusedTextarea = 'captionTemplateInsta'; // デフォルト

// プレースホルダー挿入
function insertPlaceholder(tag) {
    const textarea = document.getElementById(lastFocusedTextarea);
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const before = text.substring(0, start);
    const after = text.substring(end, text.length);

    textarea.value = before + tag + after;
    textarea.selectionStart = textarea.selectionEnd = start + tag.length;
    textarea.focus();
}

// ========================================
// スプレッドシート作成
// ========================================
async function createSpreadsheet() {
    const eventName = document.getElementById('eventName').value;
    if (!eventName) {
        alert('イベント名を入力してください');
        return;
    }

    if (!confirm(`「${eventName}」の名前で新しいスプレッドシートを作成しますか？\n\n※管理者としてGASを実行します。`)) {
        return;
    }

    const statusEl = document.getElementById('createSpreadsheetStatus');
    statusEl.className = 'status loading';
    statusEl.textContent = '作成中... (約10-20秒かかります)';
    document.getElementById('createSpreadsheetBtn').disabled = true;

    try {
        const response = await fetch(`${API_BASE}/api/admin/create-spreadsheet`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: eventName })
        });

        if (response.status === 401) {
            handleLogout();
            return;
        }

        const result = await response.json();

        if (result.success) {
            statusEl.className = 'status success';
            statusEl.textContent = `✅ 作成完了！\nID: ${result.spreadsheetId}\nURL: ${result.spreadsheetUrl}`;

            // 自動入力
            document.getElementById('currentSpreadsheetId').value = result.spreadsheetId;
            const openBtn = document.getElementById('openSpreadsheetBtn');
            openBtn.href = result.spreadsheetUrl;
            openBtn.style.display = 'inline-flex';

            // 設定も保存するか確認
            if (confirm('作成されたスプレッドシートIDを設定に反映して保存しますか？')) {
                saveConfig();
            }
        } else {
            throw new Error(result.error || 'Unknown error');
        }
    } catch (error) {
        console.error('Create spreadsheet error:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ エラー: ${error.message}`;
    } finally {
        document.getElementById('createSpreadsheetBtn').disabled = false;
    }
}

// ========================================
// 認証
// ========================================
async function handleLogin() {
    const password = document.getElementById('passwordInput').value;
    if (!password) return;

    showLoading();
    try {
        // パスワードをBase64エンコードしてトークンとして使用
        const token = btoa(password);

        // 認証テスト（config取得）
        const response = await fetch(`${API_BASE}/api/admin/config`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401) {
            document.getElementById('loginError').classList.remove('hidden');
            return;
        }

        if (!response.ok) throw new Error('API Error');

        authToken = token;
        sessionStorage.setItem('adminToken', token);
        config = await response.json();

        showMainScreen();
        renderConfig();
    } catch (error) {
        console.error('Login error:', error);
        document.getElementById('loginError').classList.remove('hidden');
    } finally {
        hideLoading();
    }
}

function handleLogout() {
    authToken = null;
    sessionStorage.removeItem('adminToken');
    location.reload();
}

function showMainScreen() {
    loginScreen.classList.add('hidden');
    mainScreen.classList.remove('hidden');
    if (!config) loadConfig();
}

// ========================================
// 設定読み込み
// ========================================
async function loadConfig() {
    showLoading();
    try {
        const response = await fetch(`${API_BASE}/api/admin/config`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (response.status === 401) {
            handleLogout();
            return;
        }

        config = await response.json();
        renderConfig();
    } catch (error) {
        console.error('Load config error:', error);
        alert('設定の読み込みに失敗しました');
    } finally {
        hideLoading();
    }
}

// ========================================
// UI描画
// ========================================
function renderConfig() {
    if (!config) return;

    // 早割締切
    if (config.earlyBirdDeadline) {
        const date = config.earlyBirdDeadline.replace(' ', 'T').slice(0, 16);
        document.getElementById('earlyBirdDeadline').value = date;
    }

    // 会員割引
    document.getElementById('memberDiscount').value = config.memberDiscount || 0;

    // オプション単価
    if (config.unitPrices) {
        document.getElementById('unitPrice_chair').value = config.unitPrices.chair || 0;
        document.getElementById('unitPrice_power').value = config.unitPrices.power || 0;
        document.getElementById('unitPrice_staff').value = config.unitPrices.staff || 0;
        document.getElementById('unitPrice_party').value = config.unitPrices.party || 0;
    }

    // ブース設定
    renderBooths();

    // 満枠設定
    renderAvailability();

    // 基本設定
    renderBasicSettings();

    // 生成ツール設定（追加）
    renderGeneratorSettings();
}

function renderGeneratorSettings() {
    if (!config) return;

    // スライドテンプレート
    if (config.slideTemplates) {
        document.getElementById('templateEarlySns').value = config.slideTemplates.earlySns || '';
        document.getElementById('templateLateSns').value = config.slideTemplates.lateSns || '';
        document.getElementById('templateVenue').value = config.slideTemplates.venue || '';

        // リンク表示更新
        if (config.slideTemplates.earlySns) {
            const link = document.getElementById('openEarlySns');
            link.href = `https://docs.google.com/presentation/d/${config.slideTemplates.earlySns}/edit`;
            link.style.display = 'inline-block';
        }
        if (config.slideTemplates.lateSns) {
            const link = document.getElementById('openLateSns');
            link.href = `https://docs.google.com/presentation/d/${config.slideTemplates.lateSns}/edit`;
            link.style.display = 'inline-block';
        }
        if (config.slideTemplates.venue) {
            const link = document.getElementById('openVenue');
            link.href = `https://docs.google.com/presentation/d/${config.slideTemplates.venue}/edit`;
            link.style.display = 'inline-block';
        }
    }

    // キャプションテンプレート
    if (config.captionTemplates) {
        document.getElementById('captionTemplateInsta').value = config.captionTemplates.instagram || '';
        document.getElementById('captionTemplateFb').value = config.captionTemplates.facebook || '';
    }
}

function renderBasicSettings() {
    if (!config) return;

    document.getElementById('eventName').value = config.eventName || '';
    document.getElementById('eventDate').value = config.eventDate || '';
    document.getElementById('eventLocation').value = config.eventLocation || '';
    document.getElementById('currentSpreadsheetId').value = config.currentSpreadsheetId || '';
    document.getElementById('databaseSpreadsheetId').value = config.databaseSpreadsheetId || '';

    const openBtn = document.getElementById('openSpreadsheetBtn');
    if (config.currentSpreadsheetId) {
        openBtn.href = `https://docs.google.com/spreadsheets/d/${config.currentSpreadsheetId}/edit`;
        openBtn.style.display = 'inline-flex';
    } else {
        openBtn.style.display = 'none';
    }
}

function renderBooths() {
    const container = document.getElementById('boothList');
    container.innerHTML = '';

    if (!config.booths) return;

    config.booths.forEach((booth, index) => {
        const card = document.createElement('div');
        card.className = 'booth-card';
        card.innerHTML = `
            <h4>${booth.name}</h4>
            <div class="form-row">
                <div class="form-group">
                    <label>通常料金（円）</label>
                    <input type="number" id="booth_${index}_regular" value="${booth.prices.regular}" min="0" step="100">
                </div>
                <div class="form-group">
                    <label>早割料金（円）</label>
                    <input type="number" id="booth_${index}_earlyBird" value="${booth.prices.earlyBird}" min="0" step="100">
                </div>
                <div class="form-group">
                    <label>追加人数上限</label>
                    <input type="number" id="booth_${index}_maxStaff" value="${booth.limits.maxStaff}" min="0">
                </div>
                <div class="form-group">
                    <label>追加椅子上限</label>
                    <input type="number" id="booth_${index}_maxChairs" value="${booth.limits.maxChairs}" min="0">
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function renderAvailability() {
    const container = document.getElementById('availabilityList');
    container.innerHTML = '';

    if (!config.booths) return;

    config.booths.forEach((booth, index) => {
        const item = document.createElement('div');
        item.className = 'availability-item';
        const isSoldOut = booth.soldOut || false;
        item.innerHTML = `
            <input type="checkbox" id="soldout_${index}" ${isSoldOut ? 'checked' : ''}>
            <label for="soldout_${index}">${booth.name}</label>
        `;
        container.appendChild(item);
    });
}

// ========================================
// タブ切り替え
// ========================================
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));

    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.remove('hidden');
}

// ========================================
// 設定保存
// ========================================
async function saveConfig() {
    // UIから設定を収集
    collectConfigFromUI();

    showLoading();
    const statusEl = document.getElementById('configStatus');
    statusEl.className = 'status loading';
    statusEl.textContent = '保存中...';

    try {
        const response = await fetch(`${API_BASE}/api/admin/config`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });

        if (response.status === 401) {
            handleLogout();
            return;
        }

        const result = await response.json();

        if (result.success) {
            statusEl.className = 'status success';
            statusEl.textContent = '✅ 保存完了！サイトに反映されました。';
            // 再描画して状態を同期
            renderBasicSettings();
        } else {
            throw new Error(result.error || 'Unknown error');
        }
    } catch (error) {
        console.error('Save config error:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ エラー: ${error.message}`;
    } finally {
        hideLoading();
    }
}

function collectConfigFromUI() {
    // 基本設定
    config.eventName = document.getElementById('eventName').value;
    config.eventDate = document.getElementById('eventDate').value;
    config.eventLocation = document.getElementById('eventLocation').value;
    config.currentSpreadsheetId = document.getElementById('currentSpreadsheetId').value;
    // databaseSpreadsheetId は readonly なのでそのまま（もしくは hidden があればそこから）
    // 現状 config オブジェクトはメモリ上にあるので変更なければそのまま維持される

    // スライドテンプレート
    config.slideTemplates = {
        earlySns: document.getElementById('templateEarlySns').value,
        lateSns: document.getElementById('templateLateSns').value,
        venue: document.getElementById('templateVenue').value
    };

    // キャプションテンプレート
    config.captionTemplates = {
        instagram: document.getElementById('captionTemplateInsta').value,
        facebook: document.getElementById('captionTemplateFb').value
    };

    // 早割締切
    const deadline = document.getElementById('earlyBirdDeadline').value;
    if (deadline) {
        config.earlyBirdDeadline = deadline.replace('T', ' ') + ':00';
    }

    // 会員割引
    config.memberDiscount = parseInt(document.getElementById('memberDiscount').value) || 0;

    // オプション単価
    config.unitPrices = {
        chair: parseInt(document.getElementById('unitPrice_chair').value) || 0,
        power: parseInt(document.getElementById('unitPrice_power').value) || 0,
        staff: parseInt(document.getElementById('unitPrice_staff').value) || 0,
        party: parseInt(document.getElementById('unitPrice_party').value) || 0,
        secondaryParty: config.unitPrices?.secondaryParty || 3000
    };

    // ブース設定
    config.booths.forEach((booth, index) => {
        booth.prices.regular = parseInt(document.getElementById(`booth_${index}_regular`).value) || 0;
        booth.prices.earlyBird = parseInt(document.getElementById(`booth_${index}_earlyBird`).value) || 0;
        booth.limits.maxStaff = parseInt(document.getElementById(`booth_${index}_maxStaff`).value) || 0;
        booth.limits.maxChairs = parseInt(document.getElementById(`booth_${index}_maxChairs`).value) || 0;
    });

    // 満枠設定
    config.booths.forEach((booth, index) => {
        booth.soldOut = document.getElementById(`soldout_${index}`).checked;
    });
}

// ========================================
// GASデプロイ
// ========================================
async function deployGas() {
    showLoading();
    const statusEl = document.getElementById('gasStatus');
    statusEl.className = 'status loading';
    statusEl.textContent = 'デプロイ中...';

    try {
        const response = await fetch(`${API_BASE}/api/admin/deploy-gas`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        if (response.status === 401) {
            handleLogout();
            return;
        }

        const result = await response.json();

        if (result.success) {
            statusEl.className = 'status success';
            statusEl.textContent = '✅ GASデプロイ完了！';
        } else {
            throw new Error(result.error || 'Unknown error');
        }
    } catch (error) {
        console.error('Deploy GAS error:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ エラー: ${error.message}`;
    } finally {
        hideLoading();
    }
}

// ========================================
// ユーティリティ
// ========================================
function showLoading() {
    loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    loadingOverlay.classList.add('hidden');
}

// ========================================
// 画像生成機能
// ========================================

// 出展者一覧を読み込む
async function loadExhibitors() {
    showLoading();
    try {
        const spreadsheetId = document.getElementById('currentSpreadsheetId')?.value;
        let url = `${API_BASE}/api/admin/exhibitors`;
        if (spreadsheetId) {
            url += `?spreadsheetId=${encodeURIComponent(spreadsheetId)}`;
        }

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const result = await response.json();

        if (result.success && result.exhibitors) {
            exhibitors = result.exhibitors;
            renderExhibitorList();
            updateExhibitorSelect();
        } else {
            alert('出展者一覧の取得に失敗しました: ' + (result.error || '不明なエラー'));
        }
    } catch (error) {
        console.error('Load exhibitors error:', error);
        alert('出展者一覧の取得に失敗しました: ' + error.message);
    } finally {
        hideLoading();
    }
}

// 出展者一覧を表示（チェックボックス付き）
function renderExhibitorList() {
    const container = document.getElementById('exhibitorList');
    if (!container) return;

    if (exhibitors.length === 0) {
        container.innerHTML = '<p class="hint">出展者データがありません</p>';
        return;
    }

    container.innerHTML = exhibitors.map(ex => `
        <label class="exhibitor-item">
            <input type="checkbox" name="exhibitor" value="${ex.id}" checked>
            <span class="exhibitor-name">${ex.exhibitorName}</span>
            <span class="exhibitor-seat">${ex.seatNumber || '未定'}</span>
        </label>
    `).join('');
}

// キャプション用セレクトを更新
function updateExhibitorSelect() {
    const select = document.getElementById('captionExhibitorSelect');
    if (!select) return;

    select.innerHTML = '<option value="">出展者を選択...</option>' +
        exhibitors.map(ex => `<option value="${ex.id}">${ex.exhibitorName}</option>`).join('');
}

// 選択した出展者の画像を生成
async function generateSelectedImages() {
    const checkedBoxes = document.querySelectorAll('#exhibitorList input[name="exhibitor"]:checked');
    const selectedIds = Array.from(checkedBoxes).map(cb => parseInt(cb.value));

    if (selectedIds.length === 0) {
        alert('出展者を選択してください');
        return;
    }

    await generateImages(selectedIds);
}

// 全員の画像を生成
async function generateAllImages() {
    await generateImages([]);
}

// 画像生成実行
async function generateImages(exhibitorIds) {
    const imageType = document.getElementById('imageType').value;
    const templateId = getTemplateId(imageType);

    if (!templateId) {
        alert('テンプレートIDを設定してください');
        return;
    }

    showLoading();
    const statusDiv = document.getElementById('imageGenerationStatus');
    statusDiv.innerHTML = '画像を生成中...';

    try {
        const response = await fetch(`${API_BASE}/api/admin/generate-batch-images`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                templateId,
                exhibitorIds,
                imageType,
                spreadsheetId: document.getElementById('currentSpreadsheetId')?.value
            })
        });

        const result = await response.json();

        if (result.success) {
            statusDiv.innerHTML = `✅ 完了: ${result.succeeded}件成功, ${result.failed}件失敗`;
            renderGeneratedImages(result.results);
        } else {
            statusDiv.innerHTML = `❌ エラー: ${result.error}`;
        }
    } catch (error) {
        console.error('Generate images error:', error);
        statusDiv.innerHTML = `❌ エラー: ${error.message}`;
    } finally {
        hideLoading();
    }
}

// テンプレートIDを取得
function getTemplateId(imageType) {
    switch (imageType) {
        case 'earlySns': return document.getElementById('templateEarlySns')?.value;
        case 'lateSns': return document.getElementById('templateLateSns')?.value;
        case 'venue': return document.getElementById('templateVenue')?.value;
        default: return null;
    }
}

// テンプレートスライド新規作成
async function createSlideTemplate(templateType) {
    const typeNames = {
        'earlySns': '早期SNS用',
        'lateSns': '後期SNS用',
        'venue': '会場掲示用'
    };

    const confirmed = confirm(`「${typeNames[templateType]}」のテンプレートスライドを新規作成しますか？`);
    if (!confirmed) return;

    showLoading();
    const statusDiv = document.getElementById('slideCreationStatus');
    statusDiv.innerHTML = 'スライドを作成中...';

    try {
        const response = await fetch(`${API_BASE}/api/admin/create-slide-template`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ templateType })
        });

        const result = await response.json();

        if (result.success) {
            // IDを入力欄に設定
            const inputId = templateType === 'earlySns' ? 'templateEarlySns'
                : templateType === 'lateSns' ? 'templateLateSns'
                    : 'templateVenue';
            document.getElementById(inputId).value = result.presentationId;

            // 開くリンクを表示
            const linkId = templateType === 'earlySns' ? 'openEarlySns'
                : templateType === 'lateSns' ? 'openLateSns'
                    : 'openVenue';
            const link = document.getElementById(linkId);
            link.href = result.presentationUrl;
            link.style.display = 'inline-block';

            statusDiv.innerHTML = `✅ 作成完了！Googleスライドを開いて背景やレイアウトを調整してください。`;

            // スライドを開く
            window.open(result.presentationUrl, '_blank');
        } else {
            statusDiv.innerHTML = `❌ エラー: ${result.error}`;
        }
    } catch (error) {
        console.error('Create slide template error:', error);
        statusDiv.innerHTML = `❌ エラー: ${error.message}`;
    } finally {
        hideLoading();
    }
}

// 生成された画像を表示
function renderGeneratedImages(results) {
    const container = document.getElementById('generatedImages');
    if (!container) return;

    container.innerHTML = results.map(r => `
        <div class="generated-image-item ${r.success ? '' : 'error'}">
            <span class="name">${r.exhibitorName}</span>
            ${r.success
            ? `<a href="${r.downloadUrl}" target="_blank" class="btn-secondary small">📥 ダウンロード</a>`
            : `<span class="error-msg">${r.error}</span>`
        }
        </div>
    `).join('');
}

// ========================================
// キャプション生成機能
// ========================================

// キャプション生成
function generateCaption(platform) {
    const selectEl = document.getElementById('captionExhibitorSelect');
    const exhibitorId = parseInt(selectEl?.value);

    if (!exhibitorId) {
        alert('出展者を選択してください');
        return;
    }

    const exhibitor = exhibitors.find(e => e.id === exhibitorId);
    if (!exhibitor) {
        alert('出展者が見つかりません');
        return;
    }

    const templateEl = platform === 'instagram'
        ? document.getElementById('captionTemplateInsta')
        : document.getElementById('captionTemplateFb');

    let template = templateEl?.value || getDefaultTemplate(platform);
    let caption = template;

    // プレースホルダー置換
    caption = caption.replace(/\{\{出展名\}\}/g, exhibitor.exhibitorName || '');
    caption = caption.replace(/\{\{メニュー\}\}/g, exhibitor.menuName || '');
    caption = caption.replace(/\{\{一言PR\}\}/g, exhibitor.shortPR || '');
    caption = caption.replace(/\{\{自己紹介\}\}/g, exhibitor.selfIntro || '');

    // SNS処理
    if (platform === 'instagram') {
        // Instagram: @アカウント名のみ
        const instaHandle = extractInstagramHandle(exhibitor.snsLinks?.insta || '');
        caption = caption.replace(/\{\{SNSアカウント\}\}/g, instaHandle ? `@${instaHandle}` : '');
    } else {
        // Facebook: すべてのリンクをプラットフォーム名付きで
        const snsLinks = formatSnsLinks(exhibitor.snsLinks);
        caption = caption.replace(/\{\{SNSリンク一覧\}\}/g, snsLinks);
    }

    // ボタンのスタイル切り替え
    const instaBtn = document.getElementById('generateCaptionInstaBtn');
    const fbBtn = document.getElementById('generateCaptionFbBtn');

    if (platform === 'instagram') {
        instaBtn.classList.remove('btn-secondary');
        instaBtn.classList.add('btn-primary');
        fbBtn.classList.remove('btn-primary');
        fbBtn.classList.add('btn-secondary');
    } else {
        fbBtn.classList.remove('btn-secondary');
        fbBtn.classList.add('btn-primary');
        instaBtn.classList.remove('btn-primary');
        instaBtn.classList.add('btn-secondary');
    }

    document.getElementById('generatedCaption').value = caption.trim();
}

// Instagram URLからハンドル名を抽出
function extractInstagramHandle(url) {
    if (!url) return '';
    const match = url.match(/instagram\.com\/([^\/\?]+)/);
    return match ? match[1] : '';
}

// SNSリンクをフォーマット
function formatSnsLinks(snsLinks) {
    if (!snsLinks) return '';

    const links = [];
    if (snsLinks.hp) links.push(`🌐 HP: ${snsLinks.hp}`);
    if (snsLinks.blog) links.push(`📝 ブログ: ${snsLinks.blog}`);
    if (snsLinks.insta) links.push(`📸 Instagram: ${snsLinks.insta}`);
    if (snsLinks.fb) links.push(`👤 Facebook: ${snsLinks.fb}`);
    if (snsLinks.line) links.push(`💬 LINE: ${snsLinks.line}`);
    if (snsLinks.other) links.push(`🔗 その他: ${snsLinks.other}`);

    return links.join('\n');
}

// デフォルトテンプレート
function getDefaultTemplate(platform) {
    if (platform === 'instagram') {
        return `【{{出展名}}】をご紹介✨

{{メニュー}}

{{一言PR}}

{{SNSアカウント}}

#ぶち癒しフェスタ東京 #癒しイベント`;
    } else {
        return `【{{出展名}}】をご紹介✨

{{メニュー}}

{{一言PR}}

▼SNS・HP
{{SNSリンク一覧}}`;
    }
}

// クリップボードにコピー
async function copyCaption() {
    const caption = document.getElementById('generatedCaption')?.value;
    if (!caption) {
        alert('コピーするキャプションがありません');
        return;
    }

    try {
        await navigator.clipboard.writeText(caption);
        const statusEl = document.getElementById('copyStatus');
        if (statusEl) {
            statusEl.textContent = '✅ コピーしました';
            setTimeout(() => { statusEl.textContent = ''; }, 2000);
        }
    } catch (error) {
        alert('コピーに失敗しました: ' + error.message);
    }
}
