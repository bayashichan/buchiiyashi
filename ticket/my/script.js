/**
 * 整理券の表示ページ
 *
 * LINEのトークに届いた券とは別に、いつでも開き直せる場所を用意している。
 * トークを遡らなくても番号にたどり着けることが、当日の受付を止めない一番の対策になる。
 */

let CONFIG = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const response = await fetch(`../config.json?t=${Date.now()}`);
        CONFIG = await response.json();
    } catch (error) {
        showError();
        return;
    }

    setText('eventName', CONFIG.eventName);
    setText('eventDate', CONFIG.eventDate);
    setText('eventLocation', CONFIG.eventLocation);

    const link = document.getElementById('reopenLink');
    if (link && CONFIG.liffId) link.href = `https://liff.line.me/${encodeURIComponent(CONFIG.liffId)}`;

    if (!CONFIG.liffId) {
        showError();
        return;
    }

    const userId = await getLineUserId();
    if (!userId) {
        showError();
        return;
    }

    await loadTickets(userId);
});

async function getLineUserId() {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await liff.init({ liffId: CONFIG.liffId });
            if (!liff.isLoggedIn()) {
                liff.login({ redirectUri: window.location.href });
                return null;
            }
            const profile = await liff.getProfile();
            if (profile && profile.userId) return profile.userId;
            throw new Error('userIdを取得できませんでした');
        } catch (error) {
            console.error(`LIFF初期化に失敗 (${attempt}回目)`, error);
        }
    }
    return null;
}

async function loadTickets(lineUserId) {
    let items = [];
    try {
        const response = await fetch(`${CONFIG.workerUrl}/api/tickets/mine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lineUserId })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        items = data.items || [];
    } catch (error) {
        console.error('整理券の取得に失敗:', error);
        showError();
        return;
    }

    document.getElementById('loadingScreen').classList.add('hidden');

    if (items.length === 0) {
        document.getElementById('emptyScreen').classList.remove('hidden');
        return;
    }

    renderTickets(items);
    document.getElementById('ticketScreen').classList.remove('hidden');
}

function renderTickets(items) {
    const list = document.getElementById('ticketList');
    list.innerHTML = '';

    for (const item of items) {
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

/** 抽選前・落選・発行期間外は、番号の代わりに今の状況を出す */
function buildPending(item) {
    const el = document.createElement('div');
    el.className = 'ticket-pending';

    let message;
    if (item.status === 'lost') {
        message = '誠に申し訳ございませんが、今回は抽選の結果ご用意できませんでした。' +
            '当日は当日枠のご案内も予定しております。';
    } else if (item.lotteryStatus !== 'done') {
        message = item.lotteryAt
            ? `${formatDateTime(item.lotteryAt)} に抽選を行います。結果はこのLINEでお知らせします。`
            : '抽選の結果が出ましたら、このLINEでお知らせします。';
    } else {
        message = '整理券の表示期間外です。表示が始まりましたらこのLINEでお知らせします。';
    }

    el.innerHTML = `
        <div class="kind">${escapeHtml(item.typeName)}</div>
        <div class="msg">${escapeHtml(message)}</div>
        <div class="receipt">受付番号 ${escapeHtml(item.receiptNo)}／${escapeHtml(item.name)} 様（${item.partySize}名）</div>
    `;
    return el;
}

function showError() {
    document.getElementById('loadingScreen').classList.add('hidden');
    document.getElementById('errorScreen').classList.remove('hidden');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el && value) el.textContent = value;
}

/** 券面の色から、集合時刻の帯に使う淡い背景色を作る */
function hexToSoft(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.10)`;
}

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
