/**
 * 整理券 管理画面
 *
 * 認証は既存の管理画面と同じ ADMIN_PASSWORD。sessionStorage のトークンを共有するので、
 * 片方でログインしていればもう片方も開ける。
 */

const API_BASE = 'https://buchiiyashi-festa-form.wakaossan2001.workers.dev';

let authToken = null;
let types = [];
let currentTypeId = null;

// 設定フォームの入力欄。IDの接頭辞 f_ を外したものがAPIのフィールド名になる。
const TEXT_FIELDS = [
    'name', 'note', 'apply_start', 'apply_end', 'lottery_at', 'remind_at',
    'issue_start', 'issue_end', 'slot_start_time', 'fixed_time_label', 'color',
    'msg_receipt', 'msg_win', 'msg_lose', 'msg_remind', 'capacity_mode'
];
const NUMBER_FIELDS = [
    'sort_order', 'number_start', 'number_end', 'max_party_size',
    'slot_interval_min', 'slot_capacity'
];
const CHECK_FIELDS = ['enabled', 'slot_enabled'];

// ============================================================
// 初期化
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    authToken = sessionStorage.getItem('adminToken');
    if (authToken) showMain();

    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    document.getElementById('passwordInput').addEventListener('keypress', e => {
        if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('logoutBtn').addEventListener('click', () => {
        sessionStorage.removeItem('adminToken');
        location.reload();
    });

    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    document.getElementById('typeSelect').addEventListener('change', e => {
        currentTypeId = e.target.value;
        onTypeChanged();
    });
    document.getElementById('newTypeBtn').addEventListener('click', startNewType);
    document.getElementById('saveTypeBtn').addEventListener('click', saveType);
    document.getElementById('deleteTypeBtn').addEventListener('click', deleteType);

    document.getElementById('reloadAppsBtn').addEventListener('click', loadApplications);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);

    document.getElementById('reloadStatsBtn').addEventListener('click', loadStats);
    document.getElementById('runLotteryBtn').addEventListener('click', () => runLottery(false));
    document.getElementById('rerunLotteryBtn').addEventListener('click', () => runLottery(true));

    document.getElementById('deliverResultBtn').addEventListener('click', () => deliver('result', false));
    document.getElementById('deliverRemindBtn').addEventListener('click', () => deliver('remind', false));
    document.getElementById('retryFailedBtn').addEventListener('click', () => deliver('result', true));

    document.getElementById('searchBtn').addEventListener('click', runSearch);
    document.getElementById('searchInput').addEventListener('keypress', e => {
        if (e.key === 'Enter') runSearch();
    });
});

async function handleLogin() {
    const password = document.getElementById('passwordInput').value;
    const token = btoa(password);

    const errorBox = document.getElementById('loginError');
    errorBox.classList.add('hidden');

    showLoading(true);
    try {
        const response = await fetch(`${API_BASE}/api/admin/tickets/types`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401) {
            errorBox.textContent = 'パスワードが正しくありません';
            errorBox.classList.remove('hidden');
            return;
        }
        if (!response.ok) {
            // パスワードは合っているがデータベースに繋がらない場合。
            // 「パスワードが違う」と出すと原因を探せなくなるため区別する。
            const data = await response.json().catch(() => ({}));
            errorBox.textContent = data.error || `サーバーに接続できません (${response.status})`;
            errorBox.classList.remove('hidden');
            return;
        }

        authToken = token;
        sessionStorage.setItem('adminToken', token);
        showMain();
    } catch (error) {
        errorBox.textContent = '通信に失敗しました。ネットワークをご確認ください。';
        errorBox.classList.remove('hidden');
    } finally {
        showLoading(false);
    }
}

function showMain() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('mainScreen').classList.remove('hidden');
    loadTypes();
}

function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.toggle('active', c.id === `tab-${name}`);
    });

    if (!currentTypeId) return;
    if (name === 'applications') loadApplications();
    if (name === 'lottery') loadStats();
}

// ============================================================
// 通信
// ============================================================

async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${authToken}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });

    if (response.status === 401) {
        sessionStorage.removeItem('adminToken');
        location.reload();
        throw new Error('セッションが切れました');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `通信に失敗しました (${response.status})`);
    return data;
}

function showLoading(show) {
    document.getElementById('loadingOverlay').classList.toggle('hidden', !show);
}

function showMessage(containerId, kind, text) {
    const box = document.getElementById(containerId);
    box.innerHTML = `<div class="msg ${kind}">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

function clearMessage(containerId) {
    document.getElementById(containerId).innerHTML = '';
}

// ============================================================
// 券種
// ============================================================

async function loadTypes() {
    try {
        const data = await api('/api/admin/tickets/types');
        types = data.types || [];
    } catch (error) {
        showMessage('settingsMessage', 'err', error.message);
        return;
    }

    const select = document.getElementById('typeSelect');
    select.innerHTML = types.length === 0
        ? '<option value="">（券種がありません。追加してください）</option>'
        : types.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');

    if (types.length > 0) {
        if (!types.some(t => t.id === currentTypeId)) currentTypeId = types[0].id;
        select.value = currentTypeId;
        onTypeChanged();
    } else {
        currentTypeId = null;
        startNewType();
    }
}

function onTypeChanged() {
    const type = types.find(t => t.id === currentTypeId);
    if (!type) return;

    fillForm(type);
    renderTypeBadge(type);
    clearMessage('settingsMessage');
    clearMessage('lotteryMessage');
    clearMessage('deliverMessage');

    const activeTab = document.querySelector('.tab.active')?.dataset.tab;
    if (activeTab === 'applications') loadApplications();
    if (activeTab === 'lottery') loadStats();
}

function renderTypeBadge(type) {
    const badge = document.getElementById('typeStatusBadge');
    const label = { pending: '抽選前', running: '抽選中', done: '抽選済み' }[type.lottery_status] || '';
    badge.innerHTML = `<span class="badge ${type.lottery_status}">${label}</span>`;
}

function fillForm(type) {
    for (const key of TEXT_FIELDS) {
        const el = document.getElementById(`f_${key}`);
        if (!el) continue;
        const value = type[key];
        el.value = key.endsWith('_at') || key.startsWith('apply_') || key.startsWith('issue_')
            ? toInputDateTime(value)
            : (value === null || value === undefined ? '' : value);
    }
    for (const key of NUMBER_FIELDS) {
        const el = document.getElementById(`f_${key}`);
        if (el) el.value = type[key] === null || type[key] === undefined ? '' : type[key];
    }
    for (const key of CHECK_FIELDS) {
        const el = document.getElementById(`f_${key}`);
        if (el) el.checked = !!type[key];
    }
    document.getElementById('f_color').value =
        /^#[0-9A-Fa-f]{6}$/.test(type.color || '') ? type.color : '#B01B54';
    document.getElementById('f_seed').value = type.lottery_seed || '';
}

function startNewType() {
    currentTypeId = null;
    document.getElementById('typeStatusBadge').innerHTML = '<span class="badge pending">新規</span>';

    for (const key of [...TEXT_FIELDS, ...NUMBER_FIELDS]) {
        const el = document.getElementById(`f_${key}`);
        if (el) el.value = '';
    }
    document.getElementById('f_name').value = '';
    document.getElementById('f_sort_order').value = '0';
    document.getElementById('f_number_start').value = '1';
    document.getElementById('f_number_end').value = '400';
    document.getElementById('f_max_party_size').value = '5';
    document.getElementById('f_slot_start_time').value = '10:45';
    document.getElementById('f_slot_interval_min').value = '30';
    document.getElementById('f_slot_capacity').value = '50';
    document.getElementById('f_capacity_mode').value = 'all_win';
    document.getElementById('f_color').value = '#B01B54';
    document.getElementById('f_enabled').checked = true;
    document.getElementById('f_slot_enabled').checked = true;
    document.getElementById('f_seed').value = '';

    switchTab('settings');
    clearMessage('settingsMessage');
}

async function saveType() {
    const payload = { id: currentTypeId || '' };

    for (const key of TEXT_FIELDS) {
        const el = document.getElementById(`f_${key}`);
        payload[key] = el ? el.value.trim() : '';
    }
    for (const key of NUMBER_FIELDS) {
        const el = document.getElementById(`f_${key}`);
        payload[key] = el ? Number(el.value) : 0;
    }
    for (const key of CHECK_FIELDS) {
        const el = document.getElementById(`f_${key}`);
        payload[key] = el ? el.checked : false;
    }

    if (!payload.name) {
        showMessage('settingsMessage', 'err', '券種名を入力してください。');
        return;
    }
    if (Number(payload.number_end) < Number(payload.number_start)) {
        showMessage('settingsMessage', 'err', '最終番号は開始番号以上にしてください。');
        return;
    }

    showLoading(true);
    try {
        const result = await api('/api/admin/tickets/types', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        currentTypeId = result.id;
        await loadTypes();
        document.getElementById('typeSelect').value = currentTypeId;
        showMessage('settingsMessage', 'ok', '保存しました。');
    } catch (error) {
        showMessage('settingsMessage', 'err', error.message);
    } finally {
        showLoading(false);
    }
}

async function deleteType() {
    if (!currentTypeId) return;
    const type = types.find(t => t.id === currentTypeId);
    if (!confirm(`「${type ? type.name : ''}」を削除します。よろしいですか？`)) return;

    showLoading(true);
    try {
        await api('/api/admin/tickets/types/delete', {
            method: 'POST',
            body: JSON.stringify({ ticketTypeId: currentTypeId })
        });
        currentTypeId = null;
        await loadTypes();
        showMessage('settingsMessage', 'ok', '削除しました。');
    } catch (error) {
        showMessage('settingsMessage', 'err', error.message);
    } finally {
        showLoading(false);
    }
}

// ============================================================
// 申込一覧
// ============================================================

async function loadApplications() {
    if (!currentTypeId) return;
    const container = document.getElementById('appsTable');
    container.innerHTML = '<div class="empty">読み込んでいます…</div>';

    let applications = [];
    try {
        const data = await api(`/api/admin/tickets/applications?typeId=${encodeURIComponent(currentTypeId)}`);
        applications = data.applications || [];
    } catch (error) {
        container.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        return;
    }

    if (applications.length === 0) {
        container.innerHTML = '<div class="empty">まだ申込がありません。</div>';
        return;
    }

    const rows = applications.map(a => {
        const numbers = a.number_start === null || a.number_start === undefined
            ? '—'
            : (a.number_start === a.number_end ? a.number_start : `${a.number_start}–${a.number_end}`);
        const statusLabel = { applied: '抽選前', won: '当選', lost: '落選', cancelled: '取消' }[a.status] || a.status;
        const delivery = a.result_notified_at
            ? '<span class="badge done">配信済</span>'
            : (a.notify_error ? `<span class="badge err">${escapeHtml(a.notify_error)}</span>` : '—');

        return `<tr>
            <td class="num">${escapeHtml(numbers)}</td>
            <td class="num">${escapeHtml(a.slot_time || '—')}</td>
            <td><span class="badge ${a.status === 'won' ? 'won' : (a.status === 'lost' ? 'lost' : 'pending')}">${statusLabel}</span></td>
            <td>${escapeHtml(a.name)}</td>
            <td class="num">${a.party_size}</td>
            <td class="num">${escapeHtml(a.phone || '')}</td>
            <td class="num">${escapeHtml(a.receipt_no || '')}</td>
            <td>${delivery}</td>
            <td>${a.checked_in_at ? '受付済' : '—'}</td>
            <td class="num">${escapeHtml(formatDateTime(a.created_at))}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <table>
            <thead><tr>
                <th>整理番号</th><th>集合時刻</th><th>状態</th><th>お名前</th><th>人数</th>
                <th>電話番号</th><th>受付番号</th><th>結果配信</th><th>当日</th><th>申込日時</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

async function exportCsv() {
    if (!currentTypeId) return;
    showLoading(true);
    try {
        const response = await fetch(
            `${API_BASE}/api/admin/tickets/export?typeId=${encodeURIComponent(currentTypeId)}`,
            { headers: { 'Authorization': `Bearer ${authToken}` } }
        );
        if (!response.ok) throw new Error('CSVを取得できませんでした');

        const blob = await response.blob();
        const type = types.find(t => t.id === currentTypeId);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `整理券_${type ? type.name : currentTypeId}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    } catch (error) {
        alert(error.message);
    } finally {
        showLoading(false);
    }
}

// ============================================================
// 抽選と配信
// ============================================================

async function loadStats() {
    if (!currentTypeId) return;

    let data;
    try {
        data = await api(`/api/admin/tickets/stats?typeId=${encodeURIComponent(currentTypeId)}`);
    } catch (error) {
        showMessage('lotteryMessage', 'err', error.message);
        return;
    }

    const s = data.stats || {};
    const cells = [
        ['申込件数', s.applications || 0, false],
        ['申込人数', s.people || 0, false],
        ['当選', s.won || 0, false],
        ['落選', s.lost || 0, false],
        ['結果配信済', s.result_sent || 0, false],
        ['リマインド済', s.remind_sent || 0, false],
        ['未達', s.undelivered || 0, (s.undelivered || 0) > 0],
        ['当日受付済', s.checked_in || 0, false]
    ];

    document.getElementById('statsBox').innerHTML = cells.map(([label, value, warn]) =>
        `<div class="stat"><div class="l">${label}</div>
         <div class="v${warn ? ' warn' : ''}">${value}</div></div>`
    ).join('');

    const runs = data.runs || [];
    document.getElementById('runsTable').innerHTML = runs.length === 0
        ? '<div class="empty">まだ抽選を実行していません。</div>'
        : `<table>
            <thead><tr>
                <th>実行日時</th><th>実行</th><th>状態</th><th>申込</th>
                <th>当選</th><th>落選</th><th>発行番号数</th><th>シード値</th>
            </tr></thead>
            <tbody>${runs.map(r => `<tr>
                <td class="num">${escapeHtml(formatDateTime(r.started_at))}</td>
                <td>${r.trigger === 'cron' ? '自動' : '手動'}</td>
                <td><span class="badge ${r.status === 'done' ? 'done' : (r.status === 'failed' ? 'err' : 'running')}">
                    ${r.status === 'done' ? '完了' : (r.status === 'failed' ? '失敗' : '実行中')}</span>
                    ${r.error ? `<br><span style="font-size:11px">${escapeHtml(r.error)}</span>` : ''}</td>
                <td class="num">${r.total_applications ?? ''}</td>
                <td class="num">${r.won_applications ?? ''}</td>
                <td class="num">${r.lost_applications ?? ''}</td>
                <td class="num">${r.issued_numbers ?? ''}</td>
                <td class="num">${escapeHtml(r.seed || '')}</td>
            </tr>`).join('')}</tbody>
        </table>`;
}

async function runLottery(force) {
    if (!currentTypeId) return;
    const type = types.find(t => t.id === currentTypeId);

    const message = force
        ? `「${type ? type.name : ''}」の抽選をやり直します。\n\n` +
          '確定済みの整理番号と集合時刻はすべて破棄され、番号が変わります。\n' +
          'すでに当選をお知らせした方がいる場合、その番号は無効になります。\n\n本当に実行しますか？'
        : `「${type ? type.name : ''}」の抽選を実行します。よろしいですか？`;
    if (!confirm(message)) return;

    const deliverAfter = document.getElementById('f_deliver').checked;

    showLoading(true);
    clearMessage('lotteryMessage');
    try {
        const result = await api('/api/admin/tickets/lottery', {
            method: 'POST',
            body: JSON.stringify({
                ticketTypeId: currentTypeId,
                seed: document.getElementById('f_seed').value.trim() || undefined,
                force,
                deliver: deliverAfter
            })
        });

        const lines = [
            `抽選が完了しました。申込 ${result.total}件 → 当選 ${result.won}件 / 落選 ${result.lost}件`,
            `発行した番号：${result.issuedNumbers}個（最終番号 ${result.lastNumber}）`,
            `シード値：${result.seed}`
        ];
        if (result.extendedBeyondRange) {
            lines.push('※ 全員当選の設定のため、最終番号を超えて発行しました。番号範囲の見直しをおすすめします。');
        }
        if (result.delivery) {
            lines.push(
                `配信：成功 ${result.delivery.sent}件 / 失敗 ${result.delivery.failed}件 / 残り ${result.delivery.remaining}件`
            );
        }

        showMessage('lotteryMessage', result.extendedBeyondRange ? 'warn' : 'ok', lines.join('\n'));

        // 残りがあるなら続けて送る
        if (result.delivery && result.delivery.remaining > 0) {
            await deliverLoop('result', false, 'lotteryMessage');
        }

        await loadTypes();
        await loadStats();
    } catch (error) {
        showMessage('lotteryMessage', 'err', error.message);
    } finally {
        showLoading(false);
    }
}

async function deliver(kind, retryFailed) {
    if (!currentTypeId) return;

    const label = kind === 'remind' ? '前日リマインド' : (retryFailed ? '未達の方への再送' : '抽選結果');
    if (!confirm(`${label}をLINEで配信します。よろしいですか？`)) return;

    showLoading(true);
    clearMessage('deliverMessage');
    try {
        await deliverLoop(kind, retryFailed, 'deliverMessage');
        await loadStats();
    } catch (error) {
        showMessage('deliverMessage', 'err', error.message);
    } finally {
        showLoading(false);
    }
}

/**
 * 送りきるまで繰り返す。
 * 1回のリクエストで送る件数を制限しているのは、Workerの外部リクエスト数の
 * 上限に当たらないため。ここで残りを見て続けて呼ぶ。
 */
async function deliverLoop(kind, retryFailed, messageContainer) {
    let sent = 0;
    let failed = 0;

    for (let round = 1; round <= 40; round++) {
        const result = await api('/api/admin/tickets/deliver', {
            method: 'POST',
            body: JSON.stringify({ ticketTypeId: currentTypeId, kind, retryFailed, limit: 60 })
        });

        sent += result.sent || 0;
        failed += result.failed || 0;

        showMessage(messageContainer, failed > 0 ? 'warn' : 'ok',
            `配信中… 成功 ${sent}件 / 失敗 ${failed}件 / 残り ${result.remaining}件`);

        // 1件も送れず残りだけがある場合は、同じ相手を延々と叩き続けないよう止める
        if (result.remaining === 0 || (result.sent === 0 && result.failed === 0)) break;
    }

    showMessage(messageContainer, failed > 0 ? 'warn' : 'ok',
        `配信が完了しました。成功 ${sent}件 / 失敗 ${failed}件` +
        (failed > 0 ? '\n失敗した方は友だち未追加またはブロック中の可能性があります。申込一覧で確認できます。' : ''));
}

// ============================================================
// 当日受付
// ============================================================

async function runSearch() {
    const q = document.getElementById('searchInput').value.trim();
    const container = document.getElementById('searchResults');

    if (q.length < 2) {
        container.innerHTML = '<div class="msg warn">2文字以上で検索してください。</div>';
        return;
    }

    container.innerHTML = '<div class="empty">検索しています…</div>';
    try {
        const data = await api(`/api/admin/tickets/search?q=${encodeURIComponent(q)}`);
        renderSearchResults(data.results || []);
    } catch (error) {
        container.innerHTML = `<div class="msg err">${escapeHtml(error.message)}</div>`;
    }
}

function renderSearchResults(results) {
    const container = document.getElementById('searchResults');

    if (results.length === 0) {
        container.innerHTML = '<div class="empty">該当する方が見つかりませんでした。</div>';
        return;
    }

    container.innerHTML = results.map(r => {
        const numbers = r.number_start === null || r.number_start === undefined
            ? '—'
            : (r.number_start === r.number_end ? r.number_start : `${r.number_start}–${r.number_end}`);
        const time = r.slot_enabled ? (r.slot_time || '') : (r.fixed_time_label || '');
        const statusLabel = { applied: '抽選前', won: '当選', lost: '落選' }[r.status] || r.status;

        return `<div class="result-card${r.checked_in_at ? ' checked' : ''}">
            <div class="big-num">${escapeHtml(String(numbers))}</div>
            <div class="info">
                <div class="nm">${escapeHtml(r.name)} 様（${r.party_size}名）</div>
                <div class="sub">
                    ${escapeHtml(r.type_name)}
                    ${time ? ` ／ ${escapeHtml(time)}` : ''}
                    ／ ${statusLabel}
                    ／ 受付番号 ${escapeHtml(r.receipt_no || '')}
                    ／ ${escapeHtml(r.phone || '')}
                </div>
            </div>
            ${r.ticket_id ? `
                <button class="btn ${r.checked_in_at ? 'btn-secondary' : 'btn-primary'}"
                        data-ticket="${escapeHtml(r.ticket_id)}"
                        data-undo="${r.checked_in_at ? '1' : '0'}">
                    ${r.checked_in_at ? '受付を取り消す' : '受付する'}
                </button>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('button[data-ticket]').forEach(button => {
        button.addEventListener('click', () => checkIn(button.dataset.ticket, button.dataset.undo === '1'));
    });
}

async function checkIn(ticketId, undo) {
    showLoading(true);
    try {
        await api('/api/admin/tickets/checkin', {
            method: 'POST',
            body: JSON.stringify({ ticketId, undo })
        });
        await runSearch();
    } catch (error) {
        alert(error.message);
    } finally {
        showLoading(false);
    }
}

// ============================================================
// ユーティリティ
// ============================================================

/** 保存値（ISO8601）を datetime-local の値にする */
function toInputDateTime(value) {
    if (!value) return '';
    const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return match ? `${match[1]}T${match[2]}` : '';
}

function formatDateTime(value) {
    if (!value) return '';
    return String(value).replace('T', ' ').replace(/(\+09:00|Z)$/, '').slice(0, 16);
}

function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
