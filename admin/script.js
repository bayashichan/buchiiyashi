/**
 * ぶち癒しフェスタ 管理画面スクリプト
 */

// API Base URL (Worker)
const API_BASE = 'https://buchiiyashi-festa-form.wakaossan2001.workers.dev';

// 状態管理
let config = null;
let authToken = null;

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
});

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
}

function renderBasicSettings() {
    if (!config) return;

    document.getElementById('eventName').value = config.eventName || '';
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
    config.currentSpreadsheetId = document.getElementById('currentSpreadsheetId').value;
    // databaseSpreadsheetId は readonly なのでそのまま（もしくは hidden があればそこから）
    // 現状 config オブジェクトはメモリ上にあるので変更なければそのまま維持される

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
