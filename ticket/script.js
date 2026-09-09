/**
 * 整理券の申込ページ
 *
 * 1件の申込 = 1グループ。券種を複数選べる場合は、券種ごとに1件ずつ送る。
 * LINEログインで本人が特定できるため、入力してもらう項目は最小限にしている。
 */

let CONFIG = null;
let types = [];
let liffState = { status: 'pending', userId: '', displayName: '', error: '' };

// 券種ID -> { selected: boolean, partySize: number }
const selection = new Map();

document.addEventListener('DOMContentLoaded', async () => {
    try {
        CONFIG = await loadConfig();
    } catch (error) {
        showSetup('設定ファイルを読み込めませんでした。しばらくしてからもう一度お試しください。');
        return;
    }

    renderEventMeta();

    if (!CONFIG.liffId) {
        // LIFFアプリが未登録。誰のお申し込みか特定できないので受け付けない。
        showSetup(
            'お申し込みの準備が完了していません。お手数ですが、しばらくしてから' +
            '公式LINEのメニューからもう一度お開きください。'
        );
        console.error('ticket/config.json の liffId が未設定です');
        return;
    }

    await Promise.all([initLiff(), loadTypes()]);

    document.getElementById('loadingScreen').classList.add('hidden');

    if (types.length === 0) {
        document.getElementById('closedScreen').classList.remove('hidden');
        return;
    }

    document.getElementById('formScreen').classList.remove('hidden');
    renderLiffStatus();
    renderTypes();
    prefillName();

    document.getElementById('submitBtn').addEventListener('click', handleSubmit);
});

async function loadConfig() {
    const response = await fetch(`./config.json?t=${Date.now()}`);
    if (!response.ok) throw new Error('config.json を読み込めません');
    return response.json();
}

function renderEventMeta() {
    setText('eventName', CONFIG.eventName);
    setText('eventDate', CONFIG.eventDate);
    setText('eventLocation', CONFIG.eventLocation);
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el && value) el.textContent = value;
}

function showSetup(message) {
    document.getElementById('loadingScreen').classList.add('hidden');
    document.getElementById('setupMessage').textContent = message;
    document.getElementById('setupScreen').classList.remove('hidden');
}

// ============================================================
// LINE連携
// ============================================================

async function initLiff() {
    // 通信状況によっては一度失敗するため1回だけリトライする
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await liff.init({ liffId: CONFIG.liffId });

            if (!liff.isLoggedIn()) {
                // 読み込み直後なので、リダイレクトしても失う入力内容がない
                liff.login({ redirectUri: window.location.href });
                return;
            }

            const profile = await liff.getProfile();
            if (!profile || !profile.userId) throw new Error('userIdを取得できませんでした');

            liffState = {
                status: 'linked',
                userId: profile.userId,
                displayName: profile.displayName || '',
                error: ''
            };
            return;
        } catch (error) {
            console.error(`LIFF初期化に失敗 (${attempt}回目)`, error);
            if (attempt === 2) {
                liffState = {
                    status: 'error',
                    userId: '',
                    displayName: '',
                    error: String(error?.message || error).slice(0, 200)
                };
            }
        }
    }
}

function renderLiffStatus() {
    const box = document.getElementById('liffStatus');

    if (liffState.status === 'linked') {
        box.className = 'status-box ok';
        box.innerHTML = `✓ LINEを確認しました：<strong>${escapeHtml(liffState.displayName)}</strong> さん`;
        return;
    }

    box.className = 'status-box warn';
    box.innerHTML = `
        <strong>LINEの情報を取得できていません</strong>
        <div style="margin-top:6px;">このままではお申し込みができません。
        公式LINEのメニューからこのページを開き直してください。</div>
        <a class="line-button" href="https://liff.line.me/${encodeURIComponent(CONFIG.liffId)}">
            LINEアプリで開き直す</a>
    `;
}

/** LINEの表示名を初期値に入れておく。多くの方はそのまま使える */
function prefillName() {
    const nameInput = document.getElementById('name');
    if (!nameInput.value && liffState.displayName) {
        nameInput.value = liffState.displayName;
    }
}

// ============================================================
// 券種
// ============================================================

async function loadTypes() {
    try {
        const response = await fetch(`${CONFIG.workerUrl}/api/tickets/types`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        types = data.types || [];
    } catch (error) {
        console.error('券種の取得に失敗:', error);
        types = [];
    }
}

function renderTypes() {
    const list = document.getElementById('typeList');
    list.innerHTML = '';

    for (const type of types) {
        const available = type.acceptingNow;
        const card = document.createElement('div');
        card.className = `type-card${available ? '' : ' unavailable'}`;
        card.dataset.typeId = type.id;

        const maxParty = Math.max(1, Number(type.max_party_size) || 1);
        const options = [];
        for (let n = 1; n <= maxParty; n++) {
            options.push(`<option value="${n}">${n}名</option>`);
        }

        const badge = available
            ? '<span class="type-badge open">受付中</span>'
            : `<span class="type-badge closed">${type.notYetOpen ? '受付開始前' : '受付終了'}</span>`;

        const sub = [];
        if (type.note) sub.push(escapeHtml(type.note));
        if (type.capacity_mode === 'limited') {
            sub.push('定員があるため、抽選で落選する場合があります');
        } else {
            sub.push('お申し込みの方は全員ご入場いただけます（整理番号を抽選でお決めします）');
        }
        if (available && maxParty > 1) {
            sub.push(`1回のお申し込みで${maxParty}名さままで（番号は連番になります）`);
        }
        if (type.apply_end) sub.push(`受付は ${formatDateTime(type.apply_end)} まで`);

        card.innerHTML = `
            <label class="type-head">
                <input type="checkbox" ${available ? '' : 'disabled'}>
                <span>
                    <span class="type-name">${escapeHtml(type.name)}</span>
                    <span class="type-sub">${sub.join('<br>')}</span>
                    ${badge}
                </span>
            </label>
            ${available ? `
            <div class="type-party hidden">
                <label for="party_${type.id}">ご参加人数</label>
                <select id="party_${type.id}">${options.join('')}</select>
                <span class="hint">
                    LINEをお持ちでない方も、人数に含めてお申し込みいただけます。
                    ご一緒の方は連番になりますので、当日は代表者さまと一緒にお越しください。
                </span>
            </div>` : ''}
        `;

        if (available) {
            selection.set(type.id, { selected: false, partySize: 1 });

            const checkbox = card.querySelector('input[type="checkbox"]');
            const partyBox = card.querySelector('.type-party');
            const partySelect = card.querySelector('select');

            checkbox.addEventListener('change', () => {
                const state = selection.get(type.id);
                state.selected = checkbox.checked;
                card.classList.toggle('selected', checkbox.checked);
                partyBox.classList.toggle('hidden', !checkbox.checked);
            });
            partySelect.addEventListener('change', () => {
                selection.get(type.id).partySize = Number(partySelect.value) || 1;
            });
        }

        list.appendChild(card);
    }
}

// ============================================================
// 送信
// ============================================================

async function handleSubmit() {
    const errorBox = document.getElementById('formError');
    errorBox.classList.add('hidden');

    const chosen = [...selection.entries()].filter(([, state]) => state.selected);

    const name = document.getElementById('name').value.trim();
    const phone = document.getElementById('phone').value.replace(/[^\d]/g, '');

    const problems = [];
    if (liffState.status !== 'linked') {
        problems.push('LINEの情報を取得できていません。公式LINEのメニューから開き直してください。');
    }
    if (chosen.length === 0) problems.push('ご希望の整理券を1つ以上お選びください。');
    if (!name) problems.push('お名前を入力してください。');
    if (phone.length < 10) problems.push('電話番号を正しく入力してください。');

    if (problems.length > 0) {
        errorBox.innerHTML = problems.map(escapeHtml).join('<br>');
        errorBox.classList.remove('hidden');
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }

    document.getElementById('formScreen').classList.add('hidden');
    document.getElementById('sendingScreen').classList.remove('hidden');

    const common = {
        lineUserId: liffState.userId,
        lineDisplayName: liffState.displayName,
        name,
        nameKana: document.getElementById('nameKana').value.trim(),
        phone,
        email: document.getElementById('email').value.trim()
    };

    // 券種ごとに1件ずつ送る。1つ失敗しても他は成立させ、結果をそのまま表示する。
    const results = [];
    for (const [typeId, state] of chosen) {
        const type = types.find(t => t.id === typeId);
        try {
            const response = await fetch(`${CONFIG.workerUrl}/api/tickets/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...common, ticketTypeId: typeId, partySize: state.partySize })
            });
            const data = await response.json();
            results.push({
                typeName: type ? type.name : '整理券',
                ok: response.ok,
                receiptNo: data.receiptNo,
                partySize: state.partySize,
                error: data.error,
                lotteryAt: data.lotteryAt
            });
        } catch (error) {
            results.push({
                typeName: type ? type.name : '整理券',
                ok: false,
                error: '通信に失敗しました。電波の良い場所でもう一度お試しください。'
            });
        }
    }

    document.getElementById('sendingScreen').classList.add('hidden');

    if (results.every(r => !r.ok)) {
        // 全部だめだったときは入力内容を消さずにフォームへ戻す
        document.getElementById('formScreen').classList.remove('hidden');
        errorBox.innerHTML = results.map(r =>
            `${escapeHtml(r.typeName)}：${escapeHtml(r.error || 'お申し込みできませんでした')}`
        ).join('<br>');
        errorBox.classList.remove('hidden');
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }

    renderDone(results);
}

function renderDone(results) {
    const list = document.getElementById('receiptList');
    list.innerHTML = '';

    for (const r of results) {
        const item = document.createElement('div');
        item.className = `receipt-item${r.ok ? '' : ' failed'}`;
        item.innerHTML = r.ok
            ? `<div class="name">${escapeHtml(r.typeName)}（${r.partySize}名）</div>
               <div class="no">受付番号 <b>${escapeHtml(r.receiptNo || '')}</b></div>`
            : `<div class="name">${escapeHtml(r.typeName)}</div>
               <div class="no">${escapeHtml(r.error || 'お申し込みできませんでした')}</div>`;
        list.appendChild(item);
    }

    const lotteryAt = results.find(r => r.ok && r.lotteryAt);
    if (lotteryAt) {
        document.getElementById('doneLotteryNote').textContent =
            `${formatDateTime(lotteryAt.lotteryAt)} に抽選を行い、結果をこのLINEでお送りします。` +
            'それまでお待ちください。';
    }

    document.getElementById('doneScreen').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================
// ユーティリティ
// ============================================================

/** "2026-09-16T23:59:00+09:00" を "9月16日(火) 23:59" にする */
function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(String(value).length === 16 ? `${value}:00+09:00` : value);
    if (isNaN(date.getTime())) return String(value);

    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const p = n => String(n).padStart(2, '0');
    return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日(${days[jst.getUTCDay()]}) ` +
        `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}

function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
