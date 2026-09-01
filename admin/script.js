/**
 * ぶち癒しフェスタ 管理画面スクリプト
 */

// API Base URL (Worker)
const API_BASE = 'https://buchiiyashi-festa-form.wakaossan2001.workers.dev';

// 状態管理
let config = null;
let authToken = null;
let exhibitors = []; // 出展者一覧
let currentGeneratedResults = []; // 現在の画像生成結果保持用

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
        restoreGeneratedResults();
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

    // Googleアカウント連携（GASデプロイ用）
    document.getElementById('connectGoogleBtn')?.addEventListener('click', connectGoogle);
    document.getElementById('disconnectGoogleBtn')?.addEventListener('click', disconnectGoogle);

    // デプロイボタン
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
    document.getElementById('deployGasBtn').addEventListener('click', deployGas);
    document.getElementById('saveAllBtn').addEventListener('click', saveConfig);

    // スプレッドシート作成
    document.getElementById('createSpreadsheetBtn').addEventListener('click', createSpreadsheet);

    // 確認ページ参照フォルダ
    document.getElementById('refreshFoldersBtn')?.addEventListener('click', () => loadImageFolders(true));
    document.getElementById('introImagesFolderSelect')?.addEventListener('change', (e) => {
        // プルダウンの選択をID入力欄（保存時のソース）へ反映
        document.getElementById('introImagesFolderId').value = e.target.value;
    });
    document.getElementById('introImagesFolderId')?.addEventListener('input', (e) => {
        // 手入力に合わせてプルダウンの選択状態も同期
        syncFolderSelect(e.target.value);
    });

    // 画像生成関連
    document.getElementById('loadExhibitorsBtn')?.addEventListener('click', loadExhibitors);
    document.getElementById('selectAllExhibitors')?.addEventListener('change', toggleAllExhibitors);
    document.getElementById('loadCaptionExhibitorsBtn')?.addEventListener('click', loadExhibitors);
    document.getElementById('generateSelectedBtn')?.addEventListener('click', generateSelectedImages);
    document.getElementById('generateAllBtn')?.addEventListener('click', generateAllImages);
    document.getElementById('downloadAllImagesBtn')?.addEventListener('click', downloadAllImagesZip);
    document.getElementById('downloadSlideUrlsBtn')?.addEventListener('click', downloadSlideUrlsCsv);
    document.getElementById('combineSlidesBtn')?.addEventListener('click', combineGeneratedSlides);

    // キャプション生成関連
    document.getElementById('generateCaptionInstaBtn')?.addEventListener('click', () => generateCaption('instagram'));
    document.getElementById('generateCaptionFbBtn')?.addEventListener('click', () => generateCaption('facebook'));
    document.getElementById('copyCaptionBtn')?.addEventListener('click', copyCaption);

    // 全員分キャプション一括ダウンロード
    document.getElementById('downloadAllCaptionsInstaBtn')?.addEventListener('click', () => downloadAllCaptions('instagram'));
    document.getElementById('downloadAllCaptionsFbBtn')?.addEventListener('click', () => downloadAllCaptions('facebook'));
    document.getElementById('downloadAllCaptionsBothBtn')?.addEventListener('click', () => downloadAllCaptions('both'));

    // 確認ページURLコピー
    document.getElementById('copyConfirmUrlBtn')?.addEventListener('click', copyConfirmUrl);

    // 申込時自動返信メールの再送
    document.getElementById('loadResendExhibitorsBtn')?.addEventListener('click', loadExhibitors);
    document.getElementById('resendFilter')?.addEventListener('input', renderResendExhibitorList);
    document.getElementById('selectAllResendExhibitors')?.addEventListener('change', toggleAllResendExhibitors);
    document.getElementById('resendConfirmationBtn')?.addEventListener('click', resendConfirmationEmails);

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
        restoreGeneratedResults();
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

// 保存されている生成結果の復元
function restoreGeneratedResults() {
    try {
        const saved = localStorage.getItem('buchiiyashi_generated_results');
        if (saved) {
            const results = JSON.parse(saved);
            if (Array.isArray(results) && results.length > 0) {
                currentGeneratedResults = results;
                
                // 表示の復元
                const container = document.getElementById('generatedImages');
                if (container) {
                    container.innerHTML = '';
                    appendGeneratedImages(results);
                }
                
                // ボタンの表示
                const downloadGroup = document.getElementById('downloadAllGroup');
                if (downloadGroup) downloadGroup.style.display = 'flex';
                
                // ステータスメッセージ
                const statusDiv = document.getElementById('imageGenerationStatus');
                if (statusDiv) {
                    statusDiv.innerHTML = `✅ 復元完了: 前回生成した ${results.length}件の画像データを読み込みました`;
                }
            }
        }
    } catch(e) {
        console.error('Failed to restore generated results', e);
        localStorage.removeItem('buchiiyashi_generated_results');
    }
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
    document.getElementById('introImagesFolderId').value = config.introImagesFolderId || '';

    // 確認ページ参照フォルダのプルダウンを読み込み（現在の設定を選択状態にする）
    loadImageFolders();

    // 確認ページURLの生成
    const confirmUrlInput = document.getElementById('confirmPageUrl');
    if (confirmUrlInput) {
        const baseUrl = window.location.href.split('/admin/')[0];
        confirmUrlInput.value = `${baseUrl}/confirm/`;
    }

    const openBtn = document.getElementById('openSpreadsheetBtn');
    if (config.currentSpreadsheetId) {
        openBtn.href = `https://docs.google.com/spreadsheets/d/${config.currentSpreadsheetId}/edit`;
        openBtn.style.display = 'inline-flex';
    } else {
        openBtn.style.display = 'none';
    }
}

// 確認ページ参照フォルダの候補一覧を取得してプルダウンを描画
async function loadImageFolders(forceReload = false) {
    const select = document.getElementById('introImagesFolderSelect');
    if (!select) return;

    // 二重読み込み防止（更新ボタン以外での再取得はスキップ）
    if (!forceReload && select.dataset.loaded === 'true') {
        syncFolderSelect(document.getElementById('introImagesFolderId').value);
        return;
    }

    const currentId = document.getElementById('introImagesFolderId').value || '';
    select.innerHTML = '<option value="">読み込み中...</option>';

    try {
        const response = await fetch(`${API_BASE}/api/admin/image-folders`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const result = await response.json();

        const folders = (result && result.success && Array.isArray(result.folders)) ? result.folders : [];

        // 選択肢を構築
        const options = ['<option value="">-- フォルダを選択 --</option>'];
        let matched = false;
        folders.forEach(f => {
            const selected = f.id === currentId ? ' selected' : '';
            if (selected) matched = true;
            const count = (typeof f.imageCount === 'number') ? `（${f.imageCount}枚）` : '';
            options.push(`<option value="${f.id}"${selected}>${escapeHtml(f.name)}${count}</option>`);
        });

        // 現在の設定が一覧にない場合は、その旨のオプションを追加して選択状態にする
        if (currentId && !matched) {
            options.push(`<option value="${currentId}" selected>現在の設定（一覧外のフォルダ）</option>`);
        }

        select.innerHTML = options.join('');
        select.dataset.loaded = 'true';
    } catch (error) {
        console.error('Load image folders error:', error);
        // 取得失敗時はプルダウンを使わず手入力にフォールバックできるようにする
        select.innerHTML = '<option value="">（フォルダ一覧の取得に失敗）</option>';
        if (currentId) {
            select.innerHTML += `<option value="${currentId}" selected>現在の設定: ${currentId}</option>`;
        }
    }
}

// ID入力欄の値に合わせてプルダウンの選択状態を同期する
function syncFolderSelect(id) {
    const select = document.getElementById('introImagesFolderSelect');
    if (!select) return;
    const hasOption = Array.from(select.options).some(o => o.value === id);
    if (hasOption) {
        select.value = id;
    } else {
        select.value = '';
    }
}

// HTMLエスケープ（フォルダ名の表示用）
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
    // 連携が切れていてもデプロイを押すまで気づけないため、タブを開いた時点で出す
    if (tabName === 'deploy') loadGoogleOAuthStatus();

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
    config.introImagesFolderId = document.getElementById('introImagesFolderId').value;
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
            const failed = (result.deployments || []).filter(d => !d.updated);
            statusEl.className = failed.length > 0 ? 'status error' : 'status success';

            // 何を上書きしたか・どのバージョンへ戻せるかが分からないと、
            // Apps Scriptエディタ側の変更を消しても気づけない
            const lines = [
                failed.length > 0 ? '⚠️ コードは更新しましたが、公開の切り替えに失敗しました' : '✅ GASデプロイ完了！',
                result.message || ''
            ];
            if (result.backupVersion) {
                lines.push(`上書き前のコードはバージョン${result.backupVersion}として保存しました（Apps Scriptの「デプロイを管理」から復元できます）`);
            }
            failed.forEach(d => lines.push(`失敗: ${d.deploymentId} — ${d.error || '不明なエラー'}`));

            statusEl.textContent = lines.filter(Boolean).join('\n');
            statusEl.style.whiteSpace = 'pre-line';
        } else {
            throw new Error(result.error || 'Unknown error');
        }
    } catch (error) {
        console.error('Deploy GAS error:', error);
        statusEl.className = 'status error';
        // 対処が複数行で返ってくるので、そのまま読める形で表示する
        statusEl.style.whiteSpace = 'pre-line';
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
            // 行番号をIDに使っているため、読み込み直したら選択はリセットする
            resendSelectedIds = new Set();
            renderExhibitorList();
            updateExhibitorSelect();
            renderResendExhibitorList();
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
    const selectAllContainer = document.getElementById('selectAllContainer');
    if (!container) return;

    if (exhibitors.length === 0) {
        container.innerHTML = '<p class="hint">出展者データがありません</p>';
        if (selectAllContainer) selectAllContainer.style.display = 'none';
        return;
    }
    
    if (selectAllContainer) selectAllContainer.style.display = 'flex';

    container.innerHTML = exhibitors.map(ex => `
        <label class="exhibitor-item">
            <input type="checkbox" name="exhibitor" value="${ex.id}" checked onchange="updateSelectAllState()">
            <span class="exhibitor-name">${ex.exhibitorName}</span>
            <span class="exhibitor-seat">${ex.seatNumber || '未定'}</span>
        </label>
    `).join('');
    
    // 初期状態は全てチェック済みにする
    const selectAllCb = document.getElementById('selectAllExhibitors');
    if (selectAllCb) selectAllCb.checked = true;
}

// 全選択/全解除の切り替え
function toggleAllExhibitors(e) {
    const isChecked = e.target.checked;
    const checkboxes = document.querySelectorAll('#exhibitorList input[name="exhibitor"]');
    checkboxes.forEach(cb => cb.checked = isChecked);
}

// 個別のチェックボックスが変更されたときに「全て選択」の状態を更新
window.updateSelectAllState = function() {
    const checkboxes = document.querySelectorAll('#exhibitorList input[name="exhibitor"]');
    if (checkboxes.length === 0) return;
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    const selectAllCb = document.getElementById('selectAllExhibitors');
    if (selectAllCb) selectAllCb.checked = allChecked;
};

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
    const checkboxes = document.querySelectorAll('#exhibitorList input[name="exhibitor"]');
    const allIds = Array.from(checkboxes).map(cb => parseInt(cb.value));
    
    if (allIds.length === 0) {
        alert('出展者が読み込まれていません。先に出展者一覧を読み込んでください。');
        return;
    }

    await generateImages(allIds);
}

// 画像生成実行
async function generateImages(exhibitorIds) {
    const imageType = document.getElementById('imageType').value;
    const templateId = getTemplateId(imageType);
    const keepSlide = document.getElementById('keepSlideCheckbox')?.checked || false;

    if (!templateId) {
        alert('テンプレートIDを設定してください');
        return;
    }

    if (!exhibitorIds || exhibitorIds.length === 0) {
        alert('出展者が選択されていません');
        return;
    }

    showLoading();
    const statusDiv = document.getElementById('imageGenerationStatus');
    
    // タイムアウト回避のためのチャンク設定
    const CHUNK_SIZE = 3;
    const totalCount = exhibitorIds.length;
    let completedCount = 0;
    let successCount = 0;
    let failCount = 0;
    
    // 結果保持用配列と表示エリアをクリア
    currentGeneratedResults = [];
    localStorage.removeItem('buchiiyashi_generated_results');
    const container = document.getElementById('generatedImages');
    if (container) container.innerHTML = '';
    const downloadGroup = document.getElementById('downloadAllGroup');
    if (downloadGroup) downloadGroup.style.display = 'none';

    try {
        // チャンクごとにバッチ処理としてリクエストを送信
        for (let i = 0; i < totalCount; i += CHUNK_SIZE) {
            const chunkIds = exhibitorIds.slice(i, i + CHUNK_SIZE);
            statusDiv.innerHTML = `⏳ 画像を生成中... (${completedCount}/${totalCount}件終了)<br><small style="color:red;">※画面を閉じないでください</small>`;
            
            const response = await fetch(`${API_BASE}/api/admin/generate-batch-images`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({
                    templateId,
                    exhibitorIds: chunkIds,
                    imageType,
                    spreadsheetId: document.getElementById('currentSpreadsheetId')?.value,
                    options: { keepSlide }
                })
            });

            const result = await response.json();

            if (result.success) {
                successCount += result.succeeded;
                failCount += result.failed;
                
                // 生存結果を保持
                if (result.results) {
                    currentGeneratedResults.push(...result.results);
                }
                
                // 順次画面に結果を追加表示する
                appendGeneratedImages(result.results || []);
            } else {
                console.error('Chunk generation error:', result.error);
                failCount += chunkIds.length;
            }
            
            completedCount += chunkIds.length;
        }

        statusDiv.innerHTML = `✅ 完了: ${successCount}件成功, ${failCount}件失敗`;
        
        // 結果が1件以上あれば一括DLボタン群を表示
        if (currentGeneratedResults.length > 0) {
            if (downloadGroup) downloadGroup.style.display = 'flex';
            // ローカルストレージに保存
            localStorage.setItem('buchiiyashi_generated_results', JSON.stringify(currentGeneratedResults));
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

// 生成された画像を表示 (チャンクごとに順次追加表示)
function appendGeneratedImages(results) {
    const container = document.getElementById('generatedImages');
    if (!container) return;

    if (!results || results.length === 0) return;

    const html = results.map(r => `
        <div class="generated-image-item ${r.success ? '' : 'error'}">
            <span class="name">${r.exhibitorName}</span>
            <div class="actions">
                ${r.success
            ? `<a href="${r.downloadUrl}" target="_blank" class="btn-secondary small">📥 ダウンロード</a>`
            : `<span class="error-msg">${r.error}</span>`
        }
                ${r.presentationUrl ? `<a href="${r.presentationUrl}" target="_blank" class="btn-secondary small" style="margin-left: 5px;">✏️ スライド編集</a>` : ''}
            </div>
        </div>
    `).join('');
    
    // 生成結果を末尾に追加
    container.insertAdjacentHTML('beforeend', html);
}

// ========================================
// 一括ダウンロード機能
// ========================================

// 画像一括ダウンロード (JSZip使用)
async function downloadAllImagesZip() {
    if (currentGeneratedResults.length === 0) {
        alert('ダウンロードできる画像がありません。');
        return;
    }

    const successfulResults = currentGeneratedResults.filter(r => r.success && r.downloadUrl);
    if (successfulResults.length === 0) {
        alert('ダウンロード可能な画像データがありません。');
        return;
    }

    const btn = document.getElementById('downloadAllImagesBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ ZIP作成中...';
    btn.disabled = true;

    try {
        const zip = new JSZip();
        
        // 画像のURLからfetchしてzipに追加
        const promises = successfulResults.map(async (result) => {
            try {
                // ファイル名で使えない文字を置換
                const sanitizedName = result.exhibitorName.replace(/[\\/:*?"<>|]/g, '_');
                const filename = `${sanitizedName}.png`;
                
                // CORS回避のため、Workerのプロキシ経由で取得
                const proxyUrl = `${API_BASE}/api/admin/fetch-image?url=${encodeURIComponent(result.downloadUrl)}`;
                const response = await fetch(proxyUrl, {
                    headers: { 'Authorization': `Bearer ${authToken}` }
                });
                
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const blob = await response.blob();
                
                zip.file(filename, blob);
            } catch (err) {
                console.error(`Failed to fetch image for ${result.exhibitorName}:`, err);
            }
        });

        await Promise.all(promises);

        // ZIPファイルを生成してダウンロード
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        a.download = `イベント画像一括_${dateStr}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('ZIP creation error:', error);
        alert('ZIPファイルの作成中にエラーが発生しました。');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// スライドURL一覧ダウンロード (CSV)
function downloadSlideUrlsCsv() {
    if (currentGeneratedResults.length === 0) {
        alert('ダウンロードできるデータがありません。');
        return;
    }

    const successfulResults = currentGeneratedResults.filter(r => r.success && r.presentationUrl);
    if (successfulResults.length === 0) {
        alert('ダウンロード可能なスライドURLデータがありません。');
        return;
    }

    // CSVヘッダー
    let csvContent = "出展者名,スライドURL\n";

    // データの追加 (CSVエスケープ処理込み)
    successfulResults.forEach(r => {
        let name = r.exhibitorName.replace(/"/g, '""');
        let url = r.presentationUrl;
        csvContent += `"${name}","${url}"\n`;
    });

    // BOM (UTF-8)
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
    const blobUrl = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = blobUrl;
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    a.download = `スライドURL一覧_${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
}

// 全スライドを1つにまとめる
async function combineGeneratedSlides() {
    if (currentGeneratedResults.length === 0) {
        alert('結合できるデータがありません。');
        return;
    }

    const successfulResults = currentGeneratedResults.filter(r => r.success && r.presentationUrl);
    if (successfulResults.length === 0) {
        alert('結合可能なスライドがありません。');
        return;
    }

    // URLからIDを抽出
    const presentationIds = successfulResults.map(r => {
        const match = r.presentationUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
        return match ? match[1] : null;
    }).filter(id => id !== null);

    if (presentationIds.length === 0) {
        alert('有効なスライドIDが見つかりませんでした。');
        return;
    }

    const btn = document.getElementById('combineSlidesBtn');
    if(!btn) return;
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ 結合中... (数十秒かかります)';
    btn.disabled = true;
    showLoading();

    try {
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        // 選択された画像タイプからタイトルを生成
        const imageTypeSelect = document.getElementById('imageType');
        const imageTypeName = imageTypeSelect ? imageTypeSelect.options[imageTypeSelect.selectedIndex].text : 'スライド';
        const title = `[結合済] ${imageTypeName}_${dateStr}`;
        
        // 1. 初期化 (空のプレゼンテーション作成)
        btn.innerHTML = '⏳ 準備中...';
        const initResponse = await fetch(`${API_BASE}/api/admin/combine-presentations`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: 'combine_presentations_init',
                title: title,
                sourceId: presentationIds[0]
            })
        });

        if (initResponse.status === 401) {
            handleLogout();
            return;
        }

        const initResult = await initResponse.json();
        if (!initResult.success) {
            throw new Error(initResult.error || '初期化エラー');
        }

        const targetId = initResult.presentationId;
        const targetUrl = initResult.presentationUrl;

        // 2. チャンクごとにスライドを追加
        const CHUNK_SIZE = 5;
        let successCount = 0;
        
        for (let i = 0; i < presentationIds.length; i += CHUNK_SIZE) {
            const chunk = presentationIds.slice(i, i + CHUNK_SIZE);
            btn.innerHTML = `⏳ 結合中... (${successCount}/${presentationIds.length}件完了)`;
            
            const appendResponse = await fetch(`${API_BASE}/api/admin/combine-presentations`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: 'combine_presentations_append',
                    targetId: targetId,
                    presentationIds: chunk
                })
            });

            if (appendResponse.status === 401) {
                handleLogout();
                return;
            }

            const appendResult = await appendResponse.json();
            if (!appendResult.success) {
                console.error('append chunk error:', appendResult.error);
                throw new Error(appendResult.error || 'スライド追加エラー');
            }
            
            successCount += appendResult.count || 0;
        }

        // 3. 最後の仕上げ (最初の空スライドを削除)
        btn.innerHTML = '⏳ 仕上げ処理中...';
        await fetch(`${API_BASE}/api/admin/combine-presentations`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: 'combine_presentations_cleanup',
                targetId: targetId
            })
        });

        alert(`✅ ${successCount}件のスライドを1つに結合しました！\n新しいタブで開きます。`);
        window.open(targetUrl, '_blank');
    } catch (error) {
        console.error('Combine error:', error);
        alert('スライドの結合中にエラーが発生しました:\n' + error.message);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
        hideLoading();
    }
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
    caption = caption.replace(/\{\{事前予約\}\}/g, formatReservation(exhibitor.advanceReservation));

    // SNS処理
    if (platform === 'instagram') {
        const handles = extractAllInstagramHandles(exhibitor.snsLinks);
        caption = caption.replace(/\{\{SNSアカウント\}\}/g, handles);
    } else {
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

// Instagram URLからハンドル名を抽出（大文字小文字を問わない）
function extractInstagramHandle(url) {
    if (!url) return '';
    const match = url.match(/instagram\.com\/([^\/\?]+)/i);
    return match ? match[1] : '';
}

// snsLinks配列から全Instagramハンドルを "@handle1 @handle2" 形式で返す
// 新形式（配列）・旧形式（オブジェクト）どちらにも対応
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

// SNSリンクをフォーマット（新形式の配列・旧形式のオブジェクト両対応）
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

// 事前予約(AK列)の値を表示用に整形: 可→○可 / 不可→×不可 / それ以外はそのまま
function formatReservation(value) {
    const v = String(value || '').trim();
    if (v === '可') return '○可\n（ご予約の際は直接，出展者様にお問い合わせください。）';
    if (v === '不可') return '×不可（当日受付のみ）';
    return v;
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

// ========================================
// キャプション一括ダウンロード機能
// ========================================

/**
 * 全出展者分のキャプションを生成してTXTファイルとしてダウンロードする
 * @param {'instagram'|'facebook'|'both'} platform
 */
function downloadAllCaptions(platform) {
    if (!exhibitors || exhibitors.length === 0) {
        alert('出展者が読み込まれていません。\n先に「出展者一覧を読み込む」ボタンを押してください。');
        return;
    }

    const statusEl = document.getElementById('captionDownloadStatus');
    statusEl.className = 'status loading';
    statusEl.textContent = 'キャプションを生成中...';

    try {
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

        if (platform === 'both') {
            // Instagram と Facebook をそれぞれ別ファイルでダウンロード
            _triggerCaptionDownload('instagram', dateStr);
            // 少し間を置いて2つ目のダウンロードをトリガー
            setTimeout(() => _triggerCaptionDownload('facebook', dateStr), 300);
        } else {
            _triggerCaptionDownload(platform, dateStr);
        }

        statusEl.className = 'status success';
        statusEl.textContent = `✅ ${exhibitors.length}名分のキャプションをダウンロードしました`;
    } catch (error) {
        console.error('Caption download error:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ エラー: ${error.message}`;
    }
}

/**
 * 指定プラットフォームのキャプションを生成してファイルをトリガーする
 * @param {'instagram'|'facebook'} platform
 * @param {string} dateStr  'YYYYMMDD' 形式の日付文字列
 */
function _triggerCaptionDownload(platform, dateStr) {
    const templateEl = platform === 'instagram'
        ? document.getElementById('captionTemplateInsta')
        : document.getElementById('captionTemplateFb');

    const template = templateEl?.value || getDefaultTemplate(platform);
    const separator = '\n' + '─'.repeat(40) + '\n';

    const lines = exhibitors.map(exhibitor => {
        let caption = template;

        // プレースホルダー置換
        caption = caption.replace(/\{\{出展名\}\}/g, exhibitor.exhibitorName || '');
        caption = caption.replace(/\{\{メニュー\}\}/g, exhibitor.menuName || '');
        caption = caption.replace(/\{\{一言PR\}\}/g, exhibitor.shortPR || '');
        caption = caption.replace(/\{\{自己紹介\}\}/g, exhibitor.selfIntro || '');
        caption = caption.replace(/\{\{事前予約\}\}/g, formatReservation(exhibitor.advanceReservation));

        if (platform === 'instagram') {
            const handles = extractAllInstagramHandles(exhibitor.snsLinks);
            caption = caption.replace(/\{\{SNSアカウント\}\}/g, handles);
        } else {
            const snsLinks = formatSnsLinks(exhibitor.snsLinks);
            caption = caption.replace(/\{\{SNSリンク一覧\}\}/g, snsLinks);
        }

        // ヘッダー (出展者名) を先頭に付ける
        const header = `【${exhibitor.exhibitorName}】`;
        return header + '\n' + caption.trim();
    });

    const fullText = lines.join(separator);
    const platformLabel = platform === 'instagram' ? 'Instagram' : 'Facebook';
    const filename = `キャプション_${platformLabel}_${dateStr}.txt`;

    // BOM付きUTF-8でダウンロード（Windowsのテキストエディタ対応）
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, fullText], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
// 確認ページURLをコピー
async function copyConfirmUrl() {
    const url = document.getElementById('confirmPageUrl')?.value;
    if (!url) return;

    try {
        await navigator.clipboard.writeText(url);
        const btn = document.getElementById('copyConfirmUrlBtn');
        const originalText = btn.textContent;
        btn.textContent = '✅ コピー完了';
        setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (err) {
        alert('コピーに失敗しました: ' + err.message);
    }
}

// ========================================
// 申込時自動返信メールの再送
// ========================================

// 1リクエストあたりの件数。GAS側の上限(20件)より小さくして、進捗を細かく出す。
const RESEND_CHUNK_SIZE = 5;

// 絞り込みで非表示になっても選択を保つため、IDはSetで持つ
let resendSelectedIds = new Set();

// 再送タブの出展者一覧を描画（絞り込み条件に一致するものだけ表示）
function renderResendExhibitorList() {
    const container = document.getElementById('resendExhibitorList');
    const selectAllContainer = document.getElementById('resendSelectAllContainer');
    if (!container) return;

    if (exhibitors.length === 0) {
        container.innerHTML = '<p class="hint">出展者データがありません</p>';
        if (selectAllContainer) selectAllContainer.style.display = 'none';
        return;
    }

    const keyword = (document.getElementById('resendFilter')?.value || '').trim().toLowerCase();
    const visible = keyword
        ? exhibitors.filter(ex => [ex.exhibitorName, ex.name, ex.email]
            .some(v => (v || '').toLowerCase().includes(keyword)))
        : exhibitors;

    if (selectAllContainer) selectAllContainer.style.display = 'flex';

    if (visible.length === 0) {
        container.innerHTML = '<p class="hint">絞り込み条件に一致する出展者がいません</p>';
        updateResendSelectedCount();
        return;
    }

    container.innerHTML = visible.map(ex => {
        const checked = resendSelectedIds.has(ex.id) ? 'checked' : '';
        // メールアドレスがない行は選べないようにする（送っても必ず失敗するため）
        const disabled = ex.email ? '' : 'disabled';
        const emailLabel = ex.email
            ? escapeHtml(ex.email)
            : '<span style="color:#c53030;">メールアドレス未登録</span>';

        return `
        <label class="exhibitor-item">
            <input type="checkbox" name="resendExhibitor" value="${ex.id}" ${checked} ${disabled}
                onchange="toggleResendExhibitor(${ex.id}, this.checked)">
            <span class="exhibitor-name">${escapeHtml(ex.exhibitorName)}</span>
            <span class="exhibitor-seat">${escapeHtml(ex.name || '')} / ${emailLabel}</span>
        </label>`;
    }).join('');

    updateResendSelectedCount();
}

// チェックボックスの操作を選択状態へ反映
window.toggleResendExhibitor = function (id, checked) {
    if (checked) {
        resendSelectedIds.add(id);
    } else {
        resendSelectedIds.delete(id);
    }
    updateResendSelectedCount();
};

// 表示中の出展者をまとめて選択／解除
function toggleAllResendExhibitors(e) {
    const isChecked = e.target.checked;
    document.querySelectorAll('#resendExhibitorList input[name="resendExhibitor"]').forEach(cb => {
        if (cb.disabled) return;
        cb.checked = isChecked;
        toggleResendExhibitor(parseInt(cb.value, 10), isChecked);
    });
}

function updateResendSelectedCount() {
    const countEl = document.getElementById('resendSelectedCount');
    if (countEl) countEl.textContent = `${resendSelectedIds.size}名を選択中`;
}

// 選択した出展者へ確認メールを再送
async function resendConfirmationEmails() {
    const statusEl = document.getElementById('resendStatus');
    const resultsEl = document.getElementById('resendResults');
    const targets = exhibitors.filter(ex => resendSelectedIds.has(ex.id));

    if (targets.length === 0) {
        alert('再送する出展者を選択してください');
        return;
    }

    const testEmail = (document.getElementById('resendTestEmail')?.value || '').trim();
    if (testEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
        alert('テスト送信先のメールアドレスの形式が正しくありません');
        return;
    }

    // 出展者本人へ届くので、送信前に必ず宛先と件数を確認してもらう
    const destination = testEmail
        ? `テスト送信先（${testEmail}）`
        : '出展者ご本人のメールアドレス';
    const names = targets.slice(0, 10).map(ex => `・${ex.exhibitorName}`).join('\n');
    const more = targets.length > 10 ? `\n…ほか${targets.length - 10}名` : '';
    if (!confirm(`${targets.length}名分の申込時自動返信メールを${destination}へ再送します。\n\n${names}${more}\n\nよろしいですか？`)) {
        return;
    }

    const spreadsheetId = document.getElementById('currentSpreadsheetId')?.value || '';
    const allResults = [];
    let sent = 0;

    showLoading();
    statusEl.className = 'status loading';
    statusEl.textContent = `送信中... (0/${targets.length})`;
    resultsEl.innerHTML = '';

    try {
        // GAS側のロックを長く握らないよう、小分けにして送る
        for (let i = 0; i < targets.length; i += RESEND_CHUNK_SIZE) {
            const chunk = targets.slice(i, i + RESEND_CHUNK_SIZE);

            const response = await fetch(`${API_BASE}/api/admin/resend-confirmation`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    spreadsheetId,
                    rowIds: chunk.map(ex => ex.id),
                    testEmail
                })
            });

            if (response.status === 401) {
                handleLogout();
                return;
            }

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || '不明なエラー');
            }

            allResults.push(...(result.results || []));
            sent += chunk.length;
            statusEl.textContent = `送信中... (${sent}/${targets.length})`;
        }

        const succeeded = allResults.filter(r => r.success).length;
        const failed = allResults.length - succeeded;

        statusEl.className = failed > 0 ? 'status error' : 'status success';
        statusEl.textContent = failed > 0
            ? `⚠️ ${succeeded}件を再送しました（${failed}件は失敗）`
            : `✅ ${succeeded}件の再送が完了しました${testEmail ? `（テスト送信先: ${testEmail}）` : ''}`;

        renderResendResults(allResults);

    } catch (error) {
        console.error('Resend confirmation error:', error);
        statusEl.className = 'status error';
        // 途中まで送れている可能性があるので、成功分も残して表示する
        statusEl.textContent = `❌ エラー: ${error.message}（${allResults.filter(r => r.success).length}件は送信済み）`;
        renderResendResults(allResults);
    } finally {
        hideLoading();
    }
}

// 再送結果の一覧を表示
function renderResendResults(results) {
    const resultsEl = document.getElementById('resendResults');
    if (!resultsEl) return;

    if (!results || results.length === 0) {
        resultsEl.innerHTML = '';
        return;
    }

    resultsEl.innerHTML = `
        <div class="exhibitor-list">
            ${results.map(r => `
            <div class="exhibitor-item">
                <span>${r.success ? '✅' : '❌'}</span>
                <span class="exhibitor-name">${escapeHtml(r.exhibitorName || `${r.rowId}行目`)}</span>
                <span class="exhibitor-seat">${r.success
                    ? escapeHtml(r.sentTo || '') + (r.isTest ? '（テスト送信）' : '')
                    : escapeHtml(r.error || '送信できませんでした')}</span>
            </div>`).join('')}
        </div>`;
}

// ========================================
// Googleアカウント連携（GASデプロイ用）
// ========================================

// 連携状態を読み込んで表示する
async function loadGoogleOAuthStatus() {
    const statusEl = document.getElementById('googleOauthStatus');
    if (!statusEl) return;

    try {
        const response = await fetch(`${API_BASE}/api/admin/google-oauth/status`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (response.status === 401) return handleLogout();

        const result = await response.json();

        if (!result.configured) {
            statusEl.className = 'status error';
            statusEl.style.whiteSpace = 'pre-line';
            // どの名前が見えていないかが分からないと、打ち間違いなのか反映漏れなのか切り分けられない
            const missing = (result.missing || []).join('\n・');
            statusEl.textContent = '⚠️ Workerから次のシークレットが見えていません:\n・' + missing
                + '\n\nCloudflareのWorker設定で、この名前どおりに登録されているか確認してください。'
                + '\n登録済みなのに出る場合は、変数を保存したあと「デプロイ」を押して新しいバージョンを反映させる必要があります。';
        } else if (!result.hasStorage) {
            statusEl.className = 'status error';
            statusEl.textContent = '⚠️ R2バケット(R2_BUCKET)が見えていません。連携情報を保存できません。';
        } else if (result.connected) {
            statusEl.className = 'status success';
            const when = result.connectedAt ? new Date(result.connectedAt).toLocaleString('ja-JP') : '';
            statusEl.textContent = `✅ 連携済み${when ? `（${when}）` : ''}`;
        } else {
            statusEl.className = 'status loading';
            statusEl.textContent = '未連携です。「Googleアカウントを連携」を押してください。';
        }
    } catch (error) {
        console.error('Google OAuth status error:', error);
        statusEl.className = 'status error';
        statusEl.textContent = `❌ 連携状態を取得できませんでした: ${error.message}`;
    }
}

// 連携を開始する（Googleの同意画面を別タブで開く）
async function connectGoogle() {
    showLoading();
    try {
        const response = await fetch(`${API_BASE}/api/admin/google-oauth/start`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (response.status === 401) return handleLogout();

        const result = await response.json();
        if (!result.url) throw new Error(result.error || '連携URLを取得できませんでした');

        // ポップアップブロックに掛かることがあるので、開けたかどうかを確認する
        const opened = window.open(result.url, '_blank');
        if (!opened) {
            prompt('別タブを開けませんでした。このURLをコピーしてブラウザで開いてください:', result.url);
        }
        alert('別タブでGoogleの連携画面が開きます。\n完了したらこのタブに戻り、デプロイタブを開き直すと連携状態が更新されます。');
    } catch (error) {
        console.error('Connect Google error:', error);
        alert('連携を開始できませんでした: ' + error.message);
    } finally {
        hideLoading();
    }
}

// 連携を解除する
async function disconnectGoogle() {
    if (!confirm('Googleアカウントの連携を解除します。GASのデプロイができなくなりますが、よろしいですか？')) return;

    showLoading();
    try {
        const response = await fetch(`${API_BASE}/api/admin/google-oauth/disconnect`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (response.status === 401) return handleLogout();
        await response.json();
        await loadGoogleOAuthStatus();
    } catch (error) {
        console.error('Disconnect Google error:', error);
        alert('連携を解除できませんでした: ' + error.message);
    } finally {
        hideLoading();
    }
}
