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
// 直前に画面へ描いた券種。券種を切り替えたかどうかの判定に使う。
let renderedTypeId = null;

// 設定フォームの入力欄。IDの接頭辞 f_ を外したものがAPIのフィールド名になる。
const TEXT_FIELDS = [
    'name', 'note', 'apply_start', 'apply_end', 'lottery_at', 'remind_at',
    'issue_end', 'slot_start_time', 'fixed_time_label', 'color',
    'open_time', 'free_entry_time',
    'msg_receipt', 'msg_win', 'msg_lose', 'msg_remind', 'capacity_mode'
];
const MESSAGE_FIELDS = ['note', 'msg_receipt', 'msg_win', 'msg_lose', 'msg_remind'];
// 案内文は空欄だと何が届くか分からなくなるので既定を入れる。
// 説明文は券種ごとに中身が違うため、選ぶまで空欄のままにする。
const PREFILL_FIELDS = ['msg_receipt', 'msg_win', 'msg_lose', 'msg_remind'];
const NUMBER_FIELDS = [
    'sort_order', 'number_start', 'number_end', 'max_party_size',
    'slot_interval_min', 'slot_capacity'
];
const CHECK_FIELDS = ['enabled', 'slot_enabled'];

// ============================================================
// 案内文の文例
//
// 各欄の1つ目が既定の文面。空欄のまま運用されると何が届くのか分からなくなるため、
// 新しい券種にも、文面が入っていない券種にも、読み込み時にこれを入れておく。
// ============================================================
const TEMPLATES = {
    note: [
        {
            label: '混雑対策の整理券（入場整理券むけ）',
            text: '開場直後は受付が混み合うため、ご来場の時間帯を抽選でお決めします。'
                + 'ご入場に必ず必要なものではありません。'
                + '混雑が落ち着いたあとは、整理券がなくてもそのままご入場いただけます。'
        },
        {
            label: '混雑対策の整理券（時間を明記する）',
            text: '{{open}} の開場直後は受付が混み合うため、ご来場の時間帯を抽選でお決めします。'
                + 'ご入場に必ず必要なものではありません。'
                + '{{free}} 以降にお越しの場合は、お申し込みなしでお待たせせずにご入場いただけます。'
        },
        {
            label: '混雑対策の整理券（短め）',
            text: '開場直後の混雑を避けるための整理券です。ご入場に必ず必要なものではありません。'
        },
        {
            label: '定員制の券種むけ（座席に限りがある）',
            text: '座席数に限りがあるため、抽選で当落をお決めします。'
        }
    ],

    msg_receipt: [
        {
            label: '標準（抽選であることを伝える）',
            text: `{{name}} 様

【{{type}}】のお申し込みを受け付けました。
受付番号：{{receipt}}
ご参加人数：{{party}}名

※これは受付の確認です。整理券ではありません。
抽選日時：{{lottery}}
抽選の結果は、あらためてこのLINEでお知らせします。`
        },
        {
            label: '定員制の券種向け（落選がありうる）',
            text: `{{name}} 様

【{{type}}】のお申し込みを受け付けました。
受付番号：{{receipt}}
ご参加人数：{{party}}名

座席数に限りがあるため、抽選となります。
※これは受付の確認です。整理券ではありません。
抽選日時：{{lottery}}`
        },
        {
            label: '短め',
            text: `{{name}} 様

【{{type}}】のお申し込みを受け付けました（受付番号 {{receipt}}／{{party}}名）。

まだ整理券ではありません。
{{lottery}} に抽選を行い、結果をこのLINEでお送りします。`
        }
    ],

    msg_win: [
        {
            label: '集合時刻を割り当てる券種向け（入場整理券）',
            text: `{{name}} 様

【{{type}}】の抽選結果をお知らせします。
ご当選です。整理番号は {{number}} 番です。

{{time}} を目安にお越しください。
この時刻より前にお越しいただいても、順番は変わりません。
会場前が混み合わないよう、ご協力をお願いいたします。`
        },
        {
            label: '混雑対策の整理券むけ（遅れても入れる）',
            text: `{{name}} 様

【{{type}}】の整理番号をお送りします。
整理番号は {{number}} 番です。

{{time}} を目安にお越しください。
この時刻より前にお越しいただいても、順番は変わりません。
お時間を過ぎてしまっても、そのままご入場いただけますのでご安心ください。`
        },
        {
            label: '開始時刻が決まっている券種向け（講演会）',
            text: `{{name}} 様

【{{type}}】の抽選結果をお知らせします。
ご当選です。整理番号は {{number}} 番です。

{{time}}
整理番号順にご入室いただきますので、お時間までにお越しください。`
        },
        {
            label: '短め',
            text: `{{name}} 様

【{{type}}】にご当選です。
整理番号 {{number}} 番／{{time}}／{{party}}名

当日は受付でこの画面をお見せください。`
        }
    ],

    msg_lose: [
        {
            label: '当日枠の案内あり',
            text: `{{name}} 様

【{{type}}】にお申し込みいただき、ありがとうございました。
厳正な抽選の結果、誠に申し訳ございませんが今回はご用意できませんでした。

当日は空き状況に応じて当日枠のご案内も予定しております。
またの機会をお待ちしております。`
        },
        {
            label: '入場は別途できる場合（講演会などの落選）',
            text: `{{name}} 様

【{{type}}】にお申し込みいただき、ありがとうございました。
座席数に限りがあり、厳正な抽選の結果、今回はご用意できませんでした。
誠に申し訳ございません。

当日、開演10分前に空席があればご案内いたします。
入場整理券をお持ちの方は、そのままご来場いただけます。`
        },
        {
            label: '当日枠なし',
            text: `{{name}} 様

【{{type}}】にお申し込みいただき、ありがとうございました。
厳正な抽選の結果、誠に申し訳ございませんが今回はご用意できませんでした。

今回は当日のご用意がございません。
またの機会をお待ちしております。`
        }
    ],

    msg_remind: [
        {
            label: '集合時刻を割り当てる券種向け',
            text: `{{name}} 様

明日はいよいよ当日です。
整理番号は {{number}} 番、集合時刻は {{time}} です。

当日は受付でこの画面をお見せください。
お気をつけてお越しください。`
        },
        {
            label: '開始時刻が決まっている券種向け',
            text: `{{name}} 様

明日の【{{type}}】の整理番号は {{number}} 番です。
{{time}}

整理番号順にご入室いただきます。
当日は受付でこの画面をお見せください。`
        },
        {
            label: '短め',
            text: `{{name}} 様

明日はいよいよ当日です。
整理番号 {{number}} 番／{{time}}

当日は受付でこの画面をお見せください。`
        }
    ]
};

/** プレビューに使う架空の申込者。実際の設定値と混ぜて、届く姿を見せる */
const PREVIEW_SAMPLE = { name: '山田 花子', party: 3, number: '128', receipt: '123456' };

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
    document.getElementById('resetLotteryBtn').addEventListener('click', resetLottery);

    document.getElementById('deliverResultBtn').addEventListener('click', () => deliver('result', false));
    document.getElementById('deliverRemindBtn').addEventListener('click', () => deliver('remind', false));
    document.getElementById('retryFailedBtn').addEventListener('click', () => deliver('result', true));

    document.getElementById('searchBtn').addEventListener('click', runSearch);
    document.getElementById('searchInput').addEventListener('keypress', e => {
        if (e.key === 'Enter') runSearch();
    });

    initMessageEditors();
});

// ============================================================
// 案内文の編集
// ============================================================

function initMessageEditors() {
    for (const key of MESSAGE_FIELDS) {
        const select = document.querySelector(`.tpl-select[data-target="f_${key}"]`);
        const textarea = document.getElementById(`f_${key}`);
        if (!select || !textarea) continue;

        select.innerHTML = '<option value="">文例を選ぶ…</option>' +
            TEMPLATES[key].map((t, i) =>
                `<option value="${i}">${escapeHtml(t.label)}${i === 0 ? '（既定）' : ''}</option>`
            ).join('');

        select.addEventListener('change', () => {
            // 「文例を選ぶ…」は Number('') が 0 になり、既定の文例で
            // 上書きしてしまうので、先に弾く
            if (select.value === '') return;

            const index = Number(select.value);
            select.value = '';
            if (!TEMPLATES[key][index]) return;

            // 書きかけの文面を黙って捨てない
            const current = textarea.value.trim();
            const isUntouched = TEMPLATES[key].some(t => t.text.trim() === current);
            if (current && !isUntouched && !confirm('いま入力されている文面を、選んだ文例で置き換えます。よろしいですか？')) {
                return;
            }

            textarea.value = TEMPLATES[key][index].text;
            renderPreview(key);
        });

        textarea.addEventListener('input', () => renderPreview(key));
    }

    // 券種名・抽選日時・集合時刻はプレビューに差し込まれるので、変えたら反映する
    for (const id of ['f_name', 'f_lottery_at', 'f_slot_start_time', 'f_fixed_time_label',
        'f_slot_enabled', 'f_open_time', 'f_free_entry_time']) {
        document.getElementById(id)?.addEventListener('input', renderAllPreviews);
        document.getElementById(id)?.addEventListener('change', renderAllPreviews);
    }
}

/** 文面が空の欄に既定の文例を入れる。何が送られるか分からない状態を作らないため */
function fillMissingMessages() {
    for (const key of PREFILL_FIELDS) {
        const textarea = document.getElementById(`f_${key}`);
        if (textarea && !textarea.value.trim()) {
            textarea.value = TEMPLATES[key][0].text;
        }
    }
    renderAllPreviews();
}

function renderAllPreviews() {
    for (const key of PREFILL_FIELDS) renderPreview(key);
}

function renderPreview(key) {
    const textarea = document.getElementById(`f_${key}`);
    const box = document.querySelector(`.preview[data-preview-for="f_${key}"]`);
    if (!textarea || !box) return;

    const slotEnabled = document.getElementById('f_slot_enabled')?.checked;
    const slotFirst = (slotEnabled
        ? document.getElementById('f_slot_start_time')?.value
        : document.getElementById('f_fixed_time_label')?.value) || '（未設定）';
    const vars = {
        ...PREVIEW_SAMPLE,
        open: document.getElementById('f_open_time')?.value || '（未設定）',
        free: document.getElementById('f_free_entry_time')?.value || '（未設定）',
        slotFirst,
        type: document.getElementById('f_name')?.value.trim() || '整理券',
        time: (slotEnabled
            ? document.getElementById('f_slot_start_time')?.value
            : document.getElementById('f_fixed_time_label')?.value) || '（未設定）',
        lottery: formatJapaneseDateTime(document.getElementById('f_lottery_at')?.value) || '（未設定）'
    };

    const filled = textarea.value.replace(/\{\{(\w+)\}\}/g, (_, tag) => {
        const value = vars[tag];
        return value === null || value === undefined ? '' : String(value);
    });

    box.textContent = filled.trim();
}

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

    // 券種を切り替えたときだけ、前の券種のメッセージを消す。
    // 抽選や保存のあとの再読み込みでも消してしまうと、実行結果が一瞬で
    // 消えて「押しても何も起きない」ように見えてしまう。
    const switched = currentTypeId !== renderedTypeId;
    renderedTypeId = currentTypeId;

    fillForm(type);
    renderTypeBadge(type);

    if (switched) {
        clearMessage('settingsMessage');
        clearMessage('lotteryMessage');
        clearMessage('deliverMessage');
    }

    // 抽選が終わると申込ページは「抽選終了」に変わる。設定を見ただけでは
    // 気づけないので、ここで理由と戻し方を出しておく。
    // 状態そのものの表示なので、操作結果のメッセージ欄とは分けている。
    if (type.lottery_status === 'done') {
        showMessage('typeStatusNotice', 'warn',
            'この券種は抽選が完了しています。申込ページには「抽選終了」と表示され、' +
            '新しいお申し込みは受け付けません。\n' +
            'テストで抽選してしまった場合など、受付を再開するには「抽選と配信」タブの' +
            '「抽選前に戻す（受付を再開）」を実行してください（発行済みの整理番号は破棄されます）。');
    } else {
        clearMessage('typeStatusNotice');
    }

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

    fillMissingMessages();
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

    fillMissingMessages();

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
            <td><button class="btn btn-danger btn-sm"
                    data-delete-app="${escapeHtml(a.id)}"
                    data-name="${escapeHtml(a.name)}"
                    data-numbers="${escapeHtml(numbers)}"
                    data-notified="${a.result_notified_at ? '1' : '0'}">削除</button></td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <table>
            <thead><tr>
                <th>整理番号</th><th>集合時刻</th><th>状態</th><th>お名前</th><th>人数</th>
                <th>電話番号</th><th>受付番号</th><th>結果配信</th><th>当日</th><th>申込日時</th>
                <th>操作</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;

    container.querySelectorAll('button[data-delete-app]').forEach(button => {
        button.addEventListener('click', () => deleteApplication(button.dataset));
    });
}

/**
 * 申込を1件消す。
 *
 * 主催者が自分のLINEで申込から整理券までを繰り返し試すための機能。
 * 1人1申込なので、消さないと2回目が試せない。
 *
 * 当選番号を配信済みの相手は、本人の手元に番号が残ったまま無効になる。
 * 取り返しがつかないので、そのときだけ確認の文言を変える。
 */
async function deleteApplication({ deleteApp, name, numbers, notified }) {
    const message = notified === '1'
        ? `${name} 様の申込を削除します。\n\n` +
          `この方には整理番号 ${numbers} 番をすでにLINEでお知らせ済みです。\n` +
          '削除すると、お手元に残った番号が無効になります。当日その番号で来場されても記録がありません。\n\n' +
          '本当に削除しますか？'
        : `${name} 様の申込を削除します。よろしいですか？`;

    if (!confirm(message)) return;

    showLoading(true);
    try {
        const result = await api('/api/admin/tickets/applications/delete', {
            method: 'POST',
            body: JSON.stringify({ applicationId: deleteApp })
        });
        await loadApplications();
        await loadStats();
        alert(`${result.name} 様の申込（受付番号 ${result.receiptNo}）を削除しました。` +
            (result.hadNumber ? '\n整理番号も取り消されています。' : ''));
    } catch (error) {
        alert(error.message);
    } finally {
        showLoading(false);
    }
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
        // 「再送待ち」は放っておけば届く。「未達」だけが主催者の対応が要るもの。
        ['再送待ち', s.retrying || 0, false],
        ['未達', s.stuck || 0, (s.stuck || 0) > 0],
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
        if (result.delivery && result.delivery.remaining > 0) {
            lines.push(`このあと ${result.delivery.remaining}件にLINEでお知らせします。`);
        }

        showMessage('lotteryMessage', result.extendedBeyondRange ? 'warn' : 'ok', lines.join('\n'));

        // 残りがあるなら続けて送る。配信の進捗表示で抽選結果が消えないよう、
        // 送り終わったら抽選結果と配信結果をまとめて出し直す。
        if (result.delivery && result.delivery.remaining > 0) {
            const totals = await deliverLoop('result', false, 'lotteryMessage');
            lines.pop(); // 「このあと〜件にお知らせします」を結果で置き換える
            lines.push(`配信が完了しました。成功 ${totals.sent}件`);
            if (totals.stuck > 0) {
                lines.push(
                    `届かなかった方が ${totals.stuck}件あります。友だち未追加またはブロック中の可能性が高いです。`);
            }
            showMessage('lotteryMessage', totals.stuck > 0 ? 'warn' : 'ok', lines.join('\n'));
        }

        await loadTypes();
        await loadStats();
    } catch (error) {
        showMessage('lotteryMessage', 'err', error.message);
    } finally {
        showLoading(false);
    }
}

/**
 * 抽選前の状態に戻す。
 *
 * テストで抽選を実行したあと、本番の受付を開けるための操作。
 * 「やり直す」と違って抽選は実行せず、受付中の状態に戻すだけ。
 */
async function resetLottery() {
    if (!currentTypeId) return;
    const type = types.find(t => t.id === currentTypeId);

    if (!confirm(
        `「${type ? type.name : ''}」を抽選前の状態に戻します。\n\n` +
        '発行済みの整理番号はすべて破棄され、申込の受付が再開します。\n' +
        'すでに当選をお知らせした方がいる場合、その番号は無効になります。\n\n' +
        '本当に実行しますか？'
    )) return;

    showLoading(true);
    clearMessage('lotteryMessage');
    try {
        const result = await api('/api/admin/tickets/lottery/reset', {
            method: 'POST',
            body: JSON.stringify({ ticketTypeId: currentTypeId })
        });
        showMessage('lotteryMessage', 'ok',
            `「${result.name}」を抽選前に戻しました（整理券 ${result.discarded}件を破棄）。\n` +
            '申込ページの受付が再開しています。');
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
    let stuck = 0;

    // 1回の呼び出しで送る件数はサーバー側で抑えてある（無料プランの通信上限のため）。
    // ここで何度も呼び直すことで、まとめて送り切る。
    for (let round = 1; round <= 120; round++) {
        const result = await api('/api/admin/tickets/deliver', {
            method: 'POST',
            body: JSON.stringify({ ticketTypeId: currentTypeId, kind, retryFailed })
        });

        sent += result.sent || 0;
        failed += result.failed || 0;
        stuck = result.stuck || 0;

        showMessage(messageContainer, failed > 0 ? 'warn' : 'ok',
            `配信中… 成功 ${sent}件 / 残り ${result.remaining}件`);

        if (result.remaining === 0) break;
        // 1件も動かないのに残りがある場合は、同じ相手を延々と叩き続けないよう止める
        if ((result.sent || 0) === 0 && (result.failed || 0) === 0) break;
    }

    const lines = [`配信が完了しました。成功 ${sent}件`];
    if (stuck > 0) {
        lines.push(
            `届かなかった方が ${stuck}件あります。友だち未追加またはブロック中の可能性が高いです。` +
            '申込一覧で確認し、必要なら電話やメールで直接お伝えください。');
    }
    if (failed > stuck) {
        lines.push('一時的に送れなかった分は、5分ごとの自動処理でこのあと送り直されます。');
    }
    showMessage(messageContainer, stuck > 0 ? 'warn' : 'ok', lines.join('\n'));

    return { sent, failed, stuck };
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

/**
 * 日時を "2026年9月16日(水) 20:00" の形にする。
 * 来場者に届く文面と同じ表記。プレビューが実物と食い違わないよう、
 * Workerの formatJapaneseDateTime と同じ結果を返す。
 */
function formatJapaneseDateTime(value) {
    if (!value) return '';
    const date = new Date(String(value).length === 16 ? `${value}:00+09:00` : value);
    if (isNaN(date.getTime())) return '';

    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const p = n => String(n).padStart(2, '0');
    return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日` +
        `(${days[jst.getUTCDay()]}) ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}

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
