/**
 * 整理券ページ（申込と表示を兼ねる）
 *
 * リンクは1つだけ。開いた人の状況で中身が変わる。
 *   まだ申し込んでいない  → 申込フォーム
 *   申込済み・抽選前      → 受付内容と、いつ抽選するか
 *   当選                  → 整理券（番号と集合時刻）
 *   落選                  → その案内
 *
 * 券種ごとに状態が違うので、両方が同時に出ることもある
 * （入場は当選済み、講演会はまだ受付中、など）。
 *
 * 表示がどうであれ二重申込は起きない。同じ人が同じ券種に申し込めないことは
 * データベースの制約で担保していて、画面はその状態を映しているだけ。
 */

let CONFIG = null;
let types = [];      // 公開されている券種
let mine = [];       // この人の申込・整理券
let mineFailed = false;
let liffState = { status: 'pending', userId: '', displayName: '', error: '' };

// 券種ID -> { selected: boolean, partySize: number }
const selection = new Map();

document.addEventListener('DOMContentLoaded', async () => {
    try {
        CONFIG = await loadConfig();
    } catch (error) {
        showSetup('設定を読み込めませんでした。しばらくしてからもう一度お試しください。');
        return;
    }

    renderEventMeta();

    if (!CONFIG.liffId) {
        showSetup(
            '準備が完了していません。お手数ですが、しばらくしてから' +
            '公式LINEのメニューからもう一度お開きください。'
        );
        console.error('ticket/config.json の liffId が未設定です');
        return;
    }

    await initLiff();
    await loadAll();

    document.getElementById('loadingScreen').classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');

    render();
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

// ============================================================
// データの取得
// ============================================================

async function loadAll() {
    // 券種一覧と自分の申込を同時に取りに行く。
    // 片方が失敗しても、取れた方だけで画面を作る。
    const [typesResult, mineResult] = await Promise.allSettled([loadTypes(), loadMine()]);

    if (typesResult.status === 'rejected') {
        console.error('券種の取得に失敗:', typesResult.reason);
        types = [];
    }
    if (mineResult.status === 'rejected') {
        console.error('申込状況の取得に失敗:', mineResult.reason);
        mine = [];
        mineFailed = true;
    }
}

async function loadTypes() {
    const response = await fetch(`${CONFIG.workerUrl}/api/tickets/types`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    types = data.types || [];
}

async function loadMine() {
    if (liffState.status !== 'linked') {
        mine = [];
        return;
    }
    const response = await fetch(`${CONFIG.workerUrl}/api/tickets/mine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: liffState.userId })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    mine = data.items || [];
}

// ============================================================
// 画面の組み立て
// ============================================================

function render() {
    renderLiffStatus();
    renderStatusList();
    renderApplySection();

    const hasTicket = mine.some(item => item.ticketVisible);
    document.getElementById('dayGuide').classList.toggle('hidden', !hasTicket);

    // 券種が1つも公開されていないときだけ「ありません」を出す。
    // 受付前・受付終了・抽選済みの券種は、理由を添えて表示する（消してしまうと
    // 来場者も運用者も、なぜ出ないのか分からなくなる）。
    const nothingToShow = mine.length === 0 && types.length === 0;
    document.getElementById('emptyState').classList.toggle('hidden', !nothingToShow);
}

/** まだ申し込んでいない券種（受付中かどうかは問わない） */
function unappliedTypes() {
    const appliedIds = new Set(mine.map(item => item.typeId));
    return types.filter(type => !appliedIds.has(type.id));
}

function renderLiffStatus() {
    const box = document.getElementById('liffStatus');

    if (liffState.status === 'linked') {
        box.classList.add('hidden');
        return;
    }

    box.classList.remove('hidden');
    box.className = 'status-box warn';
    box.innerHTML = `
        <strong>LINEの情報を取得できていません</strong>
        <div style="margin-top:6px;">このままではお申し込みや整理券の表示ができません。
        公式LINEのメニューからこのページを開き直してください。</div>
        <a class="line-button" href="https://liff.line.me/${encodeURIComponent(CONFIG.liffId)}">
            LINEアプリで開き直す</a>
    `;
}

/** 申込済みの券種を、状態ごとの見た目で並べる */
function renderStatusList() {
    const list = document.getElementById('statusList');
    list.innerHTML = '';

    if (mineFailed && liffState.status === 'linked') {
        const warn = document.createElement('div');
        warn.className = 'status-box warn';
        warn.innerHTML = `
            <strong>お申し込み状況を確認できませんでした</strong>
            <div style="margin-top:6px;">電波の良い場所で、もう一度お開きください。
            すでにお申し込み済みの場合、重ねて申し込むことはできませんのでご安心ください。</div>
        `;
        list.appendChild(warn);
    }

    if (mine.length === 0) return;

    const heading = document.createElement('h2');
    heading.textContent = 'お申し込み済みの整理券';
    list.appendChild(heading);

    for (const item of mine) {
        list.appendChild(item.ticketVisible ? buildTicket(item) : buildPending(item));
    }
}

function buildTicket(item) {
    const el = document.createElement('div');
    el.className = 'ticket';

    const color = /^#[0-9A-Fa-f]{6}$/.test(item.color || '') ? item.color : '#B01B54';
    const range = item.numberStart === item.numberEnd
        ? null
        : `${item.numberStart} 〜 ${item.numberEnd}`;

    el.innerHTML = `
        <div class="band" style="background:${color}"></div>
        <div class="ticket-body">
            <div class="kind" style="color:${color}">${escapeHtml(item.typeName)}</div>
            <div class="event">${escapeHtml(CONFIG.eventName || '')}</div>
            <div class="num-label">整理番号</div>
            <div class="num">${item.numberStart}<small>番</small></div>
            ${item.timeLabel ? `
            <div class="when" style="background:${hexToSoft(color)}">
                <div class="l">${item.slotEnabled ? '集合時刻' : 'ご案内'}</div>
                <div class="v">${escapeHtml(item.timeLabel)}</div>
            </div>` : ''}
        </div>
        <div class="rows">
            <div class="row"><span>お名前</span><span>${escapeHtml(item.name)} 様</span></div>
            <div class="row"><span>人数</span><span>${item.partySize}名</span></div>
            ${range ? `<div class="row"><span>同行者番号</span><span>${range}</span></div>` : ''}
            <div class="row"><span>会場</span><span>${escapeHtml(CONFIG.eventLocation || '')}</span></div>
            ${item.checkedIn ? '<div class="row"><span>受付</span><span>受付済み</span></div>' : ''}
        </div>
    `;
    return el;
}

/**
 * 抽選前・落選・表示期間外のときの表示。
 *
 * 抽選前の人がここを開く動機は「自分の申込が通っているか」と
 * 「いつ結果が分かるか」の2つなので、その2つを最初に出す。
 */
function buildPending(item) {
    const el = document.createElement('div');
    el.className = 'ticket-pending';

    let title;
    let message;

    if (item.status === 'lost') {
        title = '今回はご用意できませんでした';
        message = '厳正な抽選の結果、誠に申し訳ございませんが今回はご用意できませんでした。' +
            '当日は空き状況に応じてご案内できる場合があります。';
    } else if (item.lotteryStatus !== 'done') {
        title = 'お申し込みを受け付けています';
        message = item.lotteryAt
            ? `${formatDateTime(item.lotteryAt)} に抽選を行います。\n` +
              '結果はこのLINEでお知らせし、当選された方の整理番号はこのページに表示されます。\n' +
              'それまでお待ちください。'
            : '抽選の結果が出ましたら、このLINEでお知らせします。\n' +
              '当選された方の整理番号は、このページに表示されます。';
    } else {
        title = 'お申し込みを受け付けています';
        message = '整理券の表示期間外です。表示が始まりましたらこのLINEでお知らせします。';
    }

    // 券種の色は受付での見分けにも使うので、抽選前・落選のカードでも揃える
    const color = /^#[0-9A-Fa-f]{6}$/.test(item.color || '') ? item.color : '#B01B54';

    el.innerHTML = `
        <div class="kind" style="color:${color}">${escapeHtml(item.typeName)}</div>
        <div class="pending-title">${escapeHtml(title)}</div>
        <div class="msg">${escapeHtml(message)}</div>
        <div class="receipt">
            受付番号 ${escapeHtml(item.receiptNo)}／${escapeHtml(item.name)} 様（${item.partySize}名）
        </div>
    `;
    return el;
}

/**
 * まだ申し込んでいない券種を並べる。
 *
 * 受付中のものは選べる形で、そうでないものは理由を添えた読み取り専用で出す。
 * 受付中の券種が1つもなければ、連絡先の入力欄と送信ボタンは出さない。
 */
function renderApplySection() {
    const remaining = unappliedTypes();
    const available = remaining.filter(type => type.acceptingNow);
    const section = document.getElementById('applySection');

    if (remaining.length === 0 || liffState.status !== 'linked') {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    document.getElementById('applyHeading').textContent = available.length === 0
        ? '現在お申し込みいただけない整理券'
        : (mine.length > 0 ? '追加でお申し込みできる整理券' : 'ご希望の整理券');

    const list = document.getElementById('typeList');
    list.innerHTML = '';
    selection.clear();

    for (const type of remaining) {
        list.appendChild(type.acceptingNow ? buildTypeCard(type) : buildUnavailableCard(type));
    }

    const canApply = available.length > 0;
    document.getElementById('applyNotice').classList.toggle('hidden', !canApply);
    document.getElementById('contactSection').classList.toggle('hidden', !canApply);
    document.getElementById('submitArea').classList.toggle('hidden', !canApply);

    if (canApply) prefillName();
}

/** 受付中でない券種。なぜ申し込めないのかを必ず書く */
function buildUnavailableCard(type) {
    const card = document.createElement('div');
    card.className = 'type-card unavailable';

    let badge;
    let reason;
    if (type.notYetOpen) {
        badge = '受付開始前';
        reason = type.apply_start
            ? `${formatDateTime(type.apply_start)} から受付を開始します。`
            : '受付開始までお待ちください。';
    } else if (type.closed) {
        badge = '受付終了';
        reason = 'お申し込みの受付は終了しました。';
    } else if (type.lottery_status === 'done') {
        badge = '抽選終了';
        reason = '抽選が終了したため、これ以上のお申し込みは受け付けていません。';
    } else {
        badge = '受付停止中';
        reason = '現在お申し込みを受け付けていません。';
    }

    card.innerHTML = `
        <div class="type-head" style="cursor:default;">
            <span>
                <span class="type-name">${escapeHtml(type.name)}</span>
                <span class="type-sub">${escapeHtml(reason)}</span>
                <span class="type-badge closed">${escapeHtml(badge)}</span>
            </span>
        </div>
    `;
    return card;
}

function buildTypeCard(type) {
    const card = document.createElement('div');
    card.className = 'type-card';
    card.dataset.typeId = type.id;

    const maxParty = Math.max(1, Number(type.max_party_size) || 1);
    const options = [];
    for (let n = 1; n <= maxParty; n++) options.push(`<option value="${n}">${n}名</option>`);

    const sub = [];
    if (type.note) sub.push(escapeHtml(fillTypeTags(type.note, type)));
    sub.push(type.capacity_mode === 'limited'
        ? '定員があるため、抽選で落選する場合があります'
        : '落選はありません。お申し込みの方全員に整理番号をお出しします');
    if (maxParty > 1) sub.push(`1回のお申し込みで${maxParty}名さままで（番号は連番になります）`);
    if (type.apply_end) sub.push(`受付は ${formatDateTime(type.apply_end)} まで`);

    card.innerHTML = `
        <label class="type-head">
            <input type="checkbox">
            <span>
                <span class="type-name">${escapeHtml(type.name)}</span>
                <span class="type-sub">${sub.join('<br>')}</span>
                <span class="type-badge open">受付中</span>
            </span>
        </label>
        <div class="type-party hidden">
            <label for="party_${type.id}">ご参加人数</label>
            <select id="party_${type.id}">${options.join('')}</select>
            <span class="hint">
                LINEをお持ちでない方も、人数に含めてお申し込みいただけます。
                ご一緒の方は連番になりますので、当日は代表者さまと一緒にお越しください。
            </span>
        </div>
    `;

    selection.set(type.id, { selected: false, partySize: 1 });

    const checkbox = card.querySelector('input[type="checkbox"]');
    const partyBox = card.querySelector('.type-party');
    const partySelect = card.querySelector('select');

    checkbox.addEventListener('change', () => {
        selection.get(type.id).selected = checkbox.checked;
        card.classList.toggle('selected', checkbox.checked);
        partyBox.classList.toggle('hidden', !checkbox.checked);
    });
    partySelect.addEventListener('change', () => {
        selection.get(type.id).partySize = Number(partySelect.value) || 1;
    });

    return card;
}

/** LINEの表示名を初期値に入れておく。多くの方はそのまま使える */
function prefillName() {
    const nameInput = document.getElementById('name');
    if (nameInput && !nameInput.value) {
        // 追加申込のときは、前回と同じ内容を初期値にする
        const previous = mine.find(item => item.name);
        nameInput.value = previous ? previous.name : (liffState.displayName || '');
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

    document.getElementById('content').classList.add('hidden');
    document.getElementById('sendingScreen').classList.remove('hidden');

    const common = {
        lineUserId: liffState.userId,
        lineDisplayName: liffState.displayName,
        name,
        nameKana: document.getElementById('nameKana').value.trim(),
        phone,
        email: document.getElementById('email').value.trim()
    };

    // 券種ごとに1件ずつ送る。1つ失敗しても他は成立させる。
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
                error: data.error
            });
        } catch (error) {
            results.push({
                typeName: type ? type.name : '整理券',
                ok: false,
                error: '通信に失敗しました。電波の良い場所でもう一度お試しください。'
            });
        }
    }

    // 申込後の状態をサーバーから読み直す。画面が推測で状態を持たないようにする。
    await loadAll();

    document.getElementById('sendingScreen').classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');

    render();
    renderFlash(results);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 申込直後のお知らせ。成功も失敗もここにまとめて出す */
function renderFlash(results) {
    const flash = document.getElementById('flash');
    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    const parts = [];
    if (succeeded.length > 0) {
        parts.push(`
            <div class="notice" style="background:#E9F8EF;border-color:#9BD9B4;">
                <h3 style="color:#17663C;">お申し込みを受け付けました</h3>
                ${succeeded.map(r => `<p>${escapeHtml(r.typeName)}（${r.partySize}名）／受付番号 <strong>${escapeHtml(r.receiptNo || '')}</strong></p>`).join('')}
                <p>まだ整理券ではありません。抽選の結果は、このLINEでお知らせします。</p>
            </div>
        `);
    }
    if (failed.length > 0) {
        parts.push(`
            <div class="error-box" style="margin-top:0;margin-bottom:16px;">
                ${failed.map(r => `${escapeHtml(r.typeName)}：${escapeHtml(r.error || 'お申し込みできませんでした')}`).join('<br>')}
            </div>
        `);
    }

    flash.innerHTML = parts.join('');
    flash.classList.toggle('hidden', parts.length === 0);
}

// ============================================================
// ユーティリティ
// ============================================================

/**
 * 説明文の差込タグを、券種の設定から埋める。
 *
 * 文面に時刻を直接書くと、時間が変わったときに直し漏れる。
 * LINEの案内文と同じタグが使えるようにしてある。
 */
function fillTypeTags(text, type) {
    const vars = {
        open: type.open_time || '',
        free: type.free_entry_time || '',
        slotFirst: (type.slot_enabled ? type.slot_start_time : type.fixed_time_label) || '',
        type: type.name || ''
    };
    return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

/** 券面の色から、集合時刻の帯に使う淡い背景色を作る */
function hexToSoft(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.10)`;
}

/**
 * "2026-09-16T20:00:00+09:00" を "2026年9月16日(水) 20:00" にする。
 * LINEに届く文面と同じ表記に揃えている。
 */
function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(String(value).length === 16 ? `${value}:00+09:00` : value);
    if (isNaN(date.getTime())) return String(value);

    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const p = n => String(n).padStart(2, '0');
    return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日` +
        `(${days[jst.getUTCDay()]}) ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}

function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
