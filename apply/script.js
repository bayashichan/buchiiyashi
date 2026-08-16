/**
 * ぶち癒しフェスタ東京 メインスクリプト
 * 動的UI制御・バリデーション・料金計算・SNS自動判別
 */

// ========================================
// グローバル状態
// ========================================
let selectedBooth = null;
let selectedCategory = null;
let optionValues = {
    staff: 0,
    chairs: 0,
    power: false,
    partyCount: 0,
    secondaryPartyCount: 0
};
let snsLinkCount = 1;

// 画像アップロードを断念した理由。
// HEIC・容量超過・変換失敗など「画像だけが原因」で申込ごと弾かれるのを防ぐため、
// 理由が入っているときは写真なしでの送信を許可し、後から公式LINEで受け取る運用に切り替える。
let photoFallbackReason = '';

// 圧縮済みの画像（選択時に作り、送信時に使い回す）
let compressedPhoto = null;
// 圧縮処理の進行中Promise（圧縮完了前に送信されるのを防ぐ）
let photoProcessing = null;

// 送信できる画像サイズの上限。原本ではなく「圧縮後」のサイズに対して判定する。
const MAX_UPLOAD_SIZE = 8 * 1024 * 1024;
// デコードを試みる原本サイズの上限（端末のメモリ保護のための安全弁）
const MAX_DECODE_SIZE = 50 * 1024 * 1024;

// 公式LINE（画像を送っていただく窓口）
const OFFICIAL_LINE_URL = 'https://lin.ee/uqhsDx3';

// ========================================
// SNS判別パターン
// ========================================
const SNS_PATTERNS = [
    { pattern: /instagram\.com|instagr\.am/i, name: 'Instagram', color: '#E4405F' },
    { pattern: /youtube\.com|youtu\.be/i, name: 'YouTube', color: '#FF0000' },
    { pattern: /tiktok\.com/i, name: 'TikTok', color: '#000000' },
    { pattern: /ameblo\.jp|ameba\.jp/i, name: 'Ameblo', color: '#1F8742' },
    { pattern: /note\.com|note\.mu/i, name: 'note', color: '#41C9B4' },
    { pattern: /line\.me|lin\.ee/i, name: '公式LINE', color: '#00B900' },
    { pattern: /twitter\.com|x\.com/i, name: 'X(Twitter)', color: '#1DA1F2' },
    { pattern: /facebook\.com|fb\.com/i, name: 'Facebook', color: '#1877F2' },
    { pattern: /lit\.link/i, name: 'lit.link', color: '#28A0FF' },
    { pattern: /linktr\.ee/i, name: 'Linktree', color: '#43E55E' }
];

// リンクに使えない文字の検出パターン
// - 全角英数字・記号（！-｠）… IMEのまま入力するとリンクが機能しない
// - 全角スペース（　）
// - 半角コンマ（,）… SNSリンクでは使わないため
const INVALID_LINK_CHAR_PATTERN = /[！-｠　,]/;

function hasInvalidLinkChar(str) {
    return INVALID_LINK_CHAR_PATTERN.test(str);
}

// ========================================
// 初期化
// ========================================
// config.json読み込み完了後に初期化
window.addEventListener('configLoaded', () => {
    initCategories();
    initBoothAccordion();
    initCharCounters();
    initSnsInputs();
    initPostalCodeSearch();
    initEmailConfirmation();
    initFileSizeCheck();
    initRepeaterSearch();
    updateHeaderInfo();
    updateEarlyBirdBanner();
    updateOptionsUI();
    calculatePrice();
    initSpecialtyGenres();

    // LIFF初期化（取得中の表示を先に出してから開始する）
    renderLiffStatus();
    initLiff();
});

// 得意ジャンルのチェックボックス変更時に隠しinputを同期
function initSpecialtyGenres() {
    document.querySelectorAll('input[name="specialtyGenre"]').forEach(cb => {
        cb.addEventListener('change', updateSpecialtyGenresInput);
    });
}

function updateSpecialtyGenresInput() {
    const checked = [...document.querySelectorAll('input[name="specialtyGenre"]:checked')]
        .map(cb => cb.value).join('、');
    const hidden = document.getElementById('specialtyGenresInput');
    if (hidden) hidden.value = checked;
}

// ========================================
// LIFF (LINE Front-end Framework)
// ========================================
/**
 * LINE連携の状態。
 * status: 'pending'（取得中） | 'linked'（取得成功） | 'unlinked'（未ログイン） | 'error'（失敗）
 *
 * 以前はLIFFの取得に失敗しても黙って申込を通していたため、
 * LINE情報が空のままスプレッドシートに記録され、申込者も運営も気づけなかった。
 * 失敗を必ず状態として保持し、画面と送信データの両方に反映する。
 */
let liffState = { status: 'pending', userId: '', displayName: '', error: '' };

function setLiffState(next) {
    liffState = { ...liffState, ...next };

    // 隠しフィールドは送信データの入口なので、状態と必ず同期させる
    const userIdInput = document.getElementById('lineUserId');
    const displayNameInput = document.getElementById('lineDisplayName');
    if (userIdInput) userIdInput.value = liffState.userId || '';
    if (displayNameInput) displayNameInput.value = liffState.displayName || '';

    renderLiffStatus();
}

async function initLiff() {
    // LIFF IDが設定されていない場合はスキップ（通常のブラウザ動作）
    if (!CONFIG.liffId) {
        setLiffState({ status: 'error', error: 'liffId未設定' });
        return;
    }

    // 通信状況によっては一度失敗するため1回だけリトライする
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await liff.init({ liffId: CONFIG.liffId });

            // 未ログインなら自動でLINEログインへ送る。
            // ここはページ読み込み直後で入力内容がまだ無いため、リダイレクトしても失うものがない。
            if (!liff.isLoggedIn()) {
                console.log('LIFF: 未ログインのためLINEログインへ遷移します');
                setLiffState({ status: 'unlinked', userId: '', displayName: '' });
                liff.login({ redirectUri: window.location.href });
                return;
            }

            const profile = await liff.getProfile();
            if (!profile || !profile.userId) {
                throw new Error('プロフィールにuserIdが含まれていません');
            }

            setLiffState({
                status: 'linked',
                userId: profile.userId,
                displayName: profile.displayName || '',
                error: '',
            });
            console.log('LIFF initialized. User:', profile.displayName);
            return;
        } catch (err) {
            console.error(`LIFF initialization failed (attempt ${attempt})`, err);
            if (attempt === 2) {
                setLiffState({
                    status: 'error',
                    userId: '',
                    displayName: '',
                    error: String(err && err.message ? err.message : err).slice(0, 200),
                });
            }
        }
    }
}

/**
 * LINE連携の状態をフォーム冒頭に表示する。
 * 連携できていないことを申込者自身が気づける状態にするのが目的。
 */
function renderLiffStatus() {
    const box = document.getElementById('liffStatus');
    if (!box) return;

    if (liffState.status === 'linked') {
        box.className = 'mb-6 p-3 rounded-lg bg-green-50 border border-green-200 text-green-800 text-sm';
        box.innerHTML = `✓ LINE連携済み：<strong>${escapeHtml(liffState.displayName)}</strong> さん`;
        return;
    }

    if (liffState.status === 'pending') {
        box.className = 'mb-6 p-3 rounded-lg bg-slate-50 border border-slate-200 text-slate-600 text-sm';
        box.textContent = 'LINE情報を確認しています...';
        return;
    }

    // unlinked / error
    const reopenUrl = CONFIG.liffId ? `https://liff.line.me/${CONFIG.liffId}` : '';
    box.className = 'mb-6 p-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm';
    box.innerHTML = `
        <p class="font-bold">⚠ LINE情報を取得できていません</p>
        <p class="mt-1 leading-relaxed">このまま申し込むと、当日のご案内をLINEでお送りできません。
        公式LINEのリッチメニューから開き直してください。</p>
        ${reopenUrl ? `<a href="${reopenUrl}" class="inline-block mt-2 px-4 py-2 rounded-lg bg-[#06C755] text-white font-bold">LINEアプリで開き直す</a>` : ''}
    `;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * 早割バナーの表示/非表示
 */
function updateEarlyBirdBanner() {
    const deadline = new Date(CONFIG.earlyBirdDeadline);
    const now = new Date();
    const banner = document.getElementById('earlyBirdBanner');

    if (now > deadline) {
        banner.style.display = 'none';
    } else {
        // 日付を「M/D」形式にする
        const month = deadline.getMonth() + 1;
        const date = deadline.getDate();
        const dateStr = `${month}/${date}`;

        // バナーのテキストを更新
        const badge = banner.querySelector('.early-bird-badge');
        if (badge) {
            badge.textContent = `🎉 早割期間中！${dateStr}まで`;
        }
    }
}



/**
 * 開催日時・場所の表示
 */
function updateHeaderInfo() {
    const container = document.getElementById('eventInfoContainer');
    const dateEl = document.getElementById('headerEventDateDisplay');
    const locationEl = document.getElementById('headerEventLocationDisplay');
    const titleEl = document.getElementById('eventTitle');

    // タイトル更新（eventNameが「第◯回」形式の場合はフルタイトルに変換）
    if (titleEl && CONFIG.eventName) {
        // 「第◯回」が含まれていればそれを使用、なければそのまま使用
        const eventNumber = CONFIG.eventName.match(/第.+回/)?.[0] || CONFIG.eventName;
        titleEl.textContent = `🌸 ${eventNumber}ぶち癒しフェスタin東京 🌸`;
    }

    if (CONFIG.eventDate || CONFIG.eventLocation) {
        container.classList.remove('hidden');

        if (CONFIG.eventDate) {
            dateEl.textContent = CONFIG.eventDate;
            dateEl.classList.remove('hidden');
        } else {
            dateEl.classList.add('hidden');
        }

        if (CONFIG.eventLocation) {
            locationEl.textContent = CONFIG.eventLocation;
            locationEl.classList.remove('hidden');
        } else {
            locationEl.classList.add('hidden');
        }
    } else {
        container.classList.add('hidden');
    }
}

/**
 * 早割期間中かどうか
 */
function isEarlyBird() {
    const deadline = new Date(CONFIG.earlyBirdDeadline);
    const now = new Date();
    return now <= deadline;
}

// ========================================
// カテゴリ選択
// ========================================
function initCategories() {
    const container = document.getElementById('categoryButtons');

    CONFIG.categories.forEach(category => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'category-btn';
        btn.textContent = category;
        btn.onclick = () => selectCategory(category, btn);
        container.appendChild(btn);
    });
}

function selectCategory(category, btn) {
    // 全ボタンの選択解除
    document.querySelectorAll('.category-btn').forEach(b => {
        b.classList.remove('selected', 'bg-orange-500', 'text-white');
        b.classList.add('bg-gray-100');
    });

    // 選択
    btn.classList.add('selected');
    btn.classList.remove('bg-gray-100');
    selectedCategory = category;
    document.getElementById('categoryInput').value = category;

    // セッション禁止警告の更新
    updateSessionWarning();
}

// ========================================
// ブースアコーディオン
// ========================================
function initBoothAccordion() {
    const container = document.getElementById('boothAccordion');

    // location でグループ化
    const locations = [...new Set(CONFIG.booths.map(b => b.location))];

    locations.forEach(location => {
        const booths = CONFIG.booths.filter(b => b.location === location);

        // アコーディオンヘッダー
        // 折りたたまれた状態でも、キャンセル待ちのブースが含まれることが分かるようにする
        const waitlistCount = booths.filter(b => b.soldOut).length;
        let waitlistHeaderBadge = '';
        if (waitlistCount > 0) {
            const label = waitlistCount === booths.length ? 'キャンセル待ち' : '一部キャンセル待ち';
            waitlistHeaderBadge = `<span class="waitlist-badge ml-2">${label}</span>`;
        }

        const header = document.createElement('div');
        header.className = 'accordion-header';
        header.innerHTML = `
      <span class="font-bold">${location}${waitlistHeaderBadge}</span>
      <span class="accordion-icon">▼</span>
    `;

        // アコーディオンコンテンツ
        const content = document.createElement('div');
        content.className = 'accordion-content';

        booths.forEach(booth => {
            const earlyPrice = booth.prices.earlyBird;
            const regularPrice = booth.prices.regular;

            // 通常価格と早割価格が同じ場合は通常価格を併記しない
            let priceDisplay;
            if (isEarlyBird()) {
                if (earlyPrice === regularPrice) {
                    priceDisplay = `¥${earlyPrice.toLocaleString()}`;
                } else {
                    priceDisplay = `¥${earlyPrice.toLocaleString()} <span class="booth-price-early">(通常¥${regularPrice.toLocaleString()})</span>`;
                }
            } else {
                priceDisplay = `¥${regularPrice.toLocaleString()}`;
            }

            const option = document.createElement('label');
            option.className = 'booth-option' + (booth.soldOut ? ' waitlist' : '');

            if (booth.soldOut) {
                // 満枠のブースも「キャンセル待ち」として申し込めるようにする。
                // 選択不可にすると申込機会そのものが失われるため、
                // 選べる状態のまま通常枠との違いを明示する。
                // バッジは名前の上に置く（横並びにすると狭い画面でブース名が潰れるため）
                option.innerHTML = `
        <input type="radio" name="boothRadio" value="${booth.id}" onchange="selectBooth('${booth.id}')">
        <span class="ml-2 flex-1 booth-name-wrap">
          <span class="waitlist-badge">キャンセル待ち</span>
          <span class="booth-name-text">${booth.name}</span>
          <span class="waitlist-note">満枠のため、キャンセル待ちでの受付となります</span>
        </span>
        <span class="booth-price">${priceDisplay}</span>
      `;
            } else {
                option.innerHTML = `
        <input type="radio" name="boothRadio" value="${booth.id}" onchange="selectBooth('${booth.id}')">
        <span class="ml-2 flex-1">${booth.name}</span>
        <span class="booth-price">${priceDisplay}</span>
      `;
            }
            content.appendChild(option);
        });

        // クリックでトグル
        header.onclick = () => {
            header.classList.toggle('active');
            content.classList.toggle('open');
        };

        container.appendChild(header);
        container.appendChild(content);
    });
}

// ========================================
// ブース選択処理
// ========================================
function selectBooth(boothId) {
    selectedBooth = CONFIG.booths.find(b => b.id === boothId);
    document.getElementById('boothIdInput').value = boothId;

    // 選択状態のスタイル更新
    document.querySelectorAll('.booth-option').forEach(opt => {
        opt.classList.remove('selected');
        if (opt.querySelector(`input[value="${boothId}"]`)) {
            opt.classList.add('selected');
        }
    });

    // オプション数値リセット
    optionValues.staff = 0;
    optionValues.chairs = 0;
    document.getElementById('staffValue').textContent = '1';
    document.getElementById('chairsValue').textContent = '1';
    document.getElementById('extraStaffInput').value = '0';
    document.getElementById('extraChairsInput').value = '0';

    // はい/いいえをリセット
    const wantStaffNo = document.querySelector('input[name="wantStaff"][value="0"]');
    const wantChairsNo = document.querySelector('input[name="wantChairs"][value="0"]');
    if (wantStaffNo) wantStaffNo.checked = true;
    if (wantChairsNo) wantChairsNo.checked = true;
    document.getElementById('staffCountSection').classList.add('hidden');
    document.getElementById('chairsCountSection').classList.add('hidden');

    // ボディケアブースの場合、持ち込み物品入力欄を表示
    const equipmentSection = document.getElementById('equipmentSection');
    if (boothId.startsWith('body_')) {
        equipmentSection.classList.remove('hidden');
    } else {
        equipmentSection.classList.add('hidden');
    }

    // UIとセッション警告を更新
    updateOptionsUI();
    updateSessionWarning();
    updateWaitlistNotice();
    calculatePrice();
}

// ========================================
// キャンセル待ちの案内
// ========================================
/**
 * 選択中のブースがキャンセル待ち（満枠）かどうか。
 */
function isWaitlistSelected() {
    return !!(selectedBooth && selectedBooth.soldOut);
}

/**
 * キャンセル待ちブースを選んだときの案内を表示する。
 * 「申し込めた ＝ 出展確定」と誤解されると入金トラブルになるため、
 * 選択直後に、確定ではないこと・入金はまだ不要なことをはっきり伝える。
 */
function updateWaitlistNotice() {
    const notice = document.getElementById('waitlistNotice');
    if (!notice) return;

    if (isWaitlistSelected()) {
        const nameEl = document.getElementById('waitlistBoothName');
        if (nameEl) nameEl.textContent = selectedBooth.name;
        notice.classList.remove('hidden');
    } else {
        notice.classList.add('hidden');
    }
}

// ========================================
// オプションUI動的表示
// ========================================
function updateOptionsUI() {
    const staffSection = document.getElementById('optionStaff');
    const chairsSection = document.getElementById('optionChairs');
    const powerSection = document.getElementById('optionPower');
    const noOptionsMessage = document.getElementById('noOptionsMessage');

    if (!selectedBooth) {
        // ブース未選択時はすべて非表示
        staffSection.classList.add('hidden');
        chairsSection.classList.add('hidden');
        powerSection.classList.add('hidden');
        noOptionsMessage.classList.remove('hidden');
        return;
    }

    const limits = selectedBooth.limits;
    let hasAnyOption = false;

    // 追加スタッフ
    if (limits.maxStaff > 0) {
        staffSection.classList.remove('hidden');
        document.getElementById('staffMax').textContent = limits.maxStaff;
        hasAnyOption = true;
    } else {
        staffSection.classList.add('hidden');
    }

    // 追加椅子
    if (limits.maxChairs > 0) {
        chairsSection.classList.remove('hidden');
        document.getElementById('chairsMax').textContent = limits.maxChairs;
        hasAnyOption = true;
    } else {
        chairsSection.classList.add('hidden');
    }

    // 電源
    if (limits.allowPower) {
        powerSection.classList.remove('hidden');
        hasAnyOption = true;
    } else {
        powerSection.classList.add('hidden');
    }

    // オプションがない場合のメッセージ
    if (hasAnyOption) {
        noOptionsMessage.classList.add('hidden');
    } else {
        noOptionsMessage.classList.remove('hidden');
    }
}

// ========================================
// セッション禁止警告
// ========================================
function updateSessionWarning() {
    const warning = document.getElementById('sessionWarning');

    if (!selectedBooth || !selectedCategory) {
        warning.classList.remove('visible');
        return;
    }

    // 物販ブース + セッション系カテゴリ の場合に警告
    const isSessionCategory = ['占い・スピリチュアル', 'ボディケア・美容'].includes(selectedCategory);

    if (selectedBooth.prohibitSession && isSessionCategory) {
        warning.classList.add('visible');
    } else {
        warning.classList.remove('visible');
    }
}

// ========================================
// オプション切り替え
// ========================================
function toggleStaffCount() {
    const section = document.getElementById('staffCountSection');
    const wantStaff = document.querySelector('input[name="wantStaff"]:checked')?.value === '1';

    if (wantStaff) {
        section.classList.remove('hidden');
        optionValues.staff = 1;
        document.getElementById('staffValue').textContent = '1';
        document.getElementById('extraStaffInput').value = '1';
    } else {
        section.classList.add('hidden');
        optionValues.staff = 0;
        document.getElementById('extraStaffInput').value = '0';
    }

    calculatePrice();
}

function toggleChairsCount() {
    const section = document.getElementById('chairsCountSection');
    const wantChairs = document.querySelector('input[name="wantChairs"]:checked')?.value === '1';

    if (wantChairs) {
        section.classList.remove('hidden');
        optionValues.chairs = 1;
        document.getElementById('chairsValue').textContent = '1';
        document.getElementById('extraChairsInput').value = '1';
    } else {
        section.classList.add('hidden');
        optionValues.chairs = 0;
        document.getElementById('extraChairsInput').value = '0';
    }

    calculatePrice();
}

// ========================================
// 数量調整
// ========================================
function adjustQuantity(type, delta) {
    if (!selectedBooth) return;

    const limits = selectedBooth.limits;
    let max, current, valueEl, inputEl;

    if (type === 'staff') {
        max = limits.maxStaff;
        current = optionValues.staff;
        valueEl = document.getElementById('staffValue');
        inputEl = document.getElementById('extraStaffInput');
    } else if (type === 'chairs') {
        max = limits.maxChairs;
        current = optionValues.chairs;
        valueEl = document.getElementById('chairsValue');
        inputEl = document.getElementById('extraChairsInput');
    }

    const newValue = Math.max(1, Math.min(max, current + delta));
    optionValues[type] = newValue;
    valueEl.textContent = newValue;
    inputEl.value = newValue;

    calculatePrice();
}

// ========================================
// 懇親会・二次会
// ========================================
function togglePartyCount() {
    const section = document.getElementById('partyCountSection');
    const attending = document.querySelector('input[name="partyAttend"]:checked')?.value === '出席';

    if (attending) {
        section.classList.remove('hidden');
        optionValues.partyCount = 1;
        document.getElementById('partyValue').textContent = '1';
        document.getElementById('partyCountInput').value = '1';
    } else {
        section.classList.add('hidden');
        optionValues.partyCount = 0;
        document.getElementById('partyCountInput').value = '0';
    }

    calculatePrice();
}

function toggleSecondaryPartyCount() {
    const section = document.getElementById('secondaryPartyCountSection');
    const attending = document.querySelector('input[name="secondaryPartyAttend"]:checked')?.value === '出席';

    if (attending) {
        section.classList.remove('hidden');
        optionValues.secondaryPartyCount = 1;
        document.getElementById('secondaryValue').textContent = '1';
        document.getElementById('secondaryPartyCountInput').value = '1';
    } else {
        section.classList.add('hidden');
        optionValues.secondaryPartyCount = 0;
        document.getElementById('secondaryPartyCountInput').value = '0';
    }
    // 二次会は料金計算に含めない
}

function adjustPartyCount(type, delta) {
    let current, valueEl, inputEl;

    if (type === 'party') {
        current = optionValues.partyCount;
        valueEl = document.getElementById('partyValue');
        inputEl = document.getElementById('partyCountInput');
    } else {
        current = optionValues.secondaryPartyCount;
        valueEl = document.getElementById('secondaryValue');
        inputEl = document.getElementById('secondaryPartyCountInput');
    }

    const newValue = Math.max(1, current + delta); // 最低1名

    if (type === 'party') {
        optionValues.partyCount = newValue;
    } else {
        optionValues.secondaryPartyCount = newValue;
    }

    valueEl.textContent = newValue;
    inputEl.value = newValue;

    if (type === 'party') {
        calculatePrice();
    }
    // 二次会は料金計算に含めない
}

// ========================================
// スタンプラリー景品
// ========================================
function togglePrizeInput() {
    const section = document.getElementById('prizeInputSection');
    const hasPrize = document.querySelector('input[name="stampRallyPrize"]:checked')?.value === 'ある';

    if (hasPrize) {
        section.classList.remove('hidden');
    } else {
        section.classList.add('hidden');
    }
}

// ========================================
// 規約モーダル
// ========================================
function showTerms() {
    document.getElementById('termsModal').classList.remove('hidden');
}

function hideTerms() {
    document.getElementById('termsModal').classList.add('hidden');
    // 規約を開いた後にチェックボックスを有効化
    const cb = document.getElementById('agreeTermsCheckbox');
    if (cb) {
        cb.disabled = false;
        cb.classList.remove('opacity-50', 'cursor-not-allowed');
        cb.classList.add('cursor-pointer');
        const text = document.getElementById('agreeTermsText');
        if (text) {
            text.classList.remove('opacity-40', 'cursor-not-allowed');
        }
        const hint = document.getElementById('termsHint');
        if (hint) hint.classList.add('hidden');
    }
}

// ========================================
// 料金計算（二次会は除外）
// ========================================
// ========================================
// 料金計算（二次会は除外）
// ========================================
function calculatePrice() {
    const breakdown = [];
    let total = 0;

    if (selectedBooth) {
        // ブース料金
        const boothPrice = isEarlyBird()
            ? selectedBooth.prices.earlyBird
            : selectedBooth.prices.regular;

        breakdown.push(`${selectedBooth.name}: ¥${boothPrice.toLocaleString()}`);
        total += boothPrice;

        // 追加スタッフ
        if (optionValues.staff > 0) {
            const staffCost = optionValues.staff * CONFIG.unitPrices.staff;
            breakdown.push(`追加スタッフ×${optionValues.staff}: ¥${staffCost.toLocaleString()}`);
            total += staffCost;
        }

        // 追加椅子
        if (optionValues.chairs > 0) {
            const chairsCost = optionValues.chairs * CONFIG.unitPrices.chair;
            breakdown.push(`追加椅子×${optionValues.chairs}: ¥${chairsCost.toLocaleString()}`);
            total += chairsCost;
        }

        // 電源
        const usePower = document.querySelector('input[name="usePower"]:checked')?.value === '1';
        if (usePower && selectedBooth.limits.allowPower) {
            breakdown.push(`電源使用: ¥${CONFIG.unitPrices.power.toLocaleString()}`);
            total += CONFIG.unitPrices.power;
            optionValues.power = true;
        } else {
            optionValues.power = false;
        }
    }

    // 懇親会（二次会は料金計算に含めない）
    if (optionValues.partyCount > 0) {
        const partyCost = optionValues.partyCount * CONFIG.unitPrices.party;
        breakdown.push(`懇親会×${optionValues.partyCount}: ¥${partyCost.toLocaleString()}`);
        total += partyCost;
    }

    // 表示更新
    document.getElementById('priceBreakdown').textContent = breakdown.length > 0
        ? breakdown.join(' + ')
        : 'ブースを選択してください';
    document.getElementById('totalPrice').textContent = `¥${total.toLocaleString()}`;

    // キャンセル待ちの場合、合計金額は「確定した場合の金額」でしかない。
    // フッターは常に見えているので、ここでも入金不要であることを添える。
    const priceNote = document.getElementById('waitlistPriceNote');
    if (priceNote) priceNote.classList.toggle('hidden', !isWaitlistSelected());
}

// ========================================
// SNS入力
// ========================================
function initSnsInputs() {
    const container = document.getElementById('snsLinksContainer');
    const addBtn = document.getElementById('addSnsBtn');

    // 既存の入力欄にイベントリスナーを設定
    container.querySelectorAll('.sns-input').forEach(input => {
        input.addEventListener('input', handleSnsInput);
    });

    // 追加ボタン
    addBtn.addEventListener('click', () => {
        if (snsLinkCount >= 6) return; // 最大6つ

        snsLinkCount++;
        const row = document.createElement('div');
        row.className = 'sns-link-row';
        row.innerHTML = `
      <div class="sns-link-main flex gap-2">
        <span class="sns-badge" data-index="${snsLinkCount - 1}">未入力</span>
        <input type="url" name="snsLink${snsLinkCount}" class="input-field flex-1 sns-input" data-index="${snsLinkCount - 1}" placeholder="https://...">
        <button type="button" class="text-red-500 hover:text-red-700 px-2" onclick="removeSnsRow(this)">✕</button>
      </div>
      <p class="sns-fullwidth-warning" data-index="${snsLinkCount - 1}" style="display:none;">⚠️ 使えない文字（全角文字・コンマ）が含まれています。リンクは半角で入力してください。</p>
    `;
        container.appendChild(row);

        // 新しい入力欄にイベントリスナー
        row.querySelector('.sns-input').addEventListener('input', handleSnsInput);

        if (snsLinkCount >= 6) {
            addBtn.style.display = 'none';
        }
    });
}

function handleSnsInput(e) {
    const url = e.target.value;
    const index = e.target.dataset.index;
    const badge = document.querySelector(`.sns-badge[data-index="${index}"]`);
    const warning = document.querySelector(`.sns-fullwidth-warning[data-index="${index}"]`);

    // リンクに使えない文字（全角文字・半角コンマ）のチェック
    if (warning) {
        if (hasInvalidLinkChar(url)) {
            warning.style.display = 'block';
            e.target.classList.add('border-red-500');
        } else {
            warning.style.display = 'none';
            e.target.classList.remove('border-red-500');
        }
    }

    if (!url) {
        badge.textContent = '未入力';
        badge.style.backgroundColor = '#e5e7eb';
        badge.style.color = '#6b7280';
        return;
    }

    // SNS判別
    let detected = null;
    for (const sns of SNS_PATTERNS) {
        if (sns.pattern.test(url)) {
            detected = sns;
            break;
        }
    }

    if (detected) {
        badge.textContent = detected.name;
        badge.style.backgroundColor = detected.color;
        badge.style.color = 'white';
    } else {
        badge.textContent = 'HP';
        badge.style.backgroundColor = '#6366f1';
        badge.style.color = 'white';
    }
}

function removeSnsRow(btn) {
    const row = btn.closest('.sns-link-row');
    row.remove();
    snsLinkCount--;
    document.getElementById('addSnsBtn').style.display = 'block';
}

// SNSリンク入力欄を追加（リピーター検索用）
function addSnsLinkInput(url = '') {
    const container = document.getElementById('snsLinksContainer');
    const addBtn = document.getElementById('addSnsBtn');

    if (snsLinkCount >= 6) return; // 最大6つ

    snsLinkCount++;
    const row = document.createElement('div');
    row.className = 'sns-link-row';
    row.innerHTML = `
      <div class="sns-link-main flex gap-2">
        <span class="sns-badge" data-index="${snsLinkCount - 1}">未入力</span>
        <input type="url" name="snsLink${snsLinkCount}" class="input-field flex-1 sns-input" data-index="${snsLinkCount - 1}" placeholder="https://..." value="${url}">
        <button type="button" class="text-red-500 hover:text-red-700 px-2" onclick="removeSnsRow(this)">✕</button>
      </div>
      <p class="sns-fullwidth-warning" data-index="${snsLinkCount - 1}" style="display:none;">⚠️ 使えない文字（全角文字・コンマ）が含まれています。リンクは半角で入力してください。</p>
    `;
    container.appendChild(row);

    // 入力欄にイベントリスナー
    const input = row.querySelector('.sns-input');
    input.addEventListener('input', handleSnsInput);

    // 既存の値があれば、バッジを更新
    if (url) {
        input.dispatchEvent(new Event('input'));
    }

    if (snsLinkCount >= 6) {
        addBtn.style.display = 'none';
    }
}

// ========================================
// 文字数カウンター
// ========================================
function initCharCounters() {
    const fields = [
        { name: 'menuName', counterId: 'menuNameCount', max: 100 },
        { name: 'selfIntro', counterId: 'selfIntroCount', max: 200 },
        { name: 'shortPR', counterId: 'shortPRCount', max: 35 }
    ];

    fields.forEach(field => {
        const input = document.querySelector(`[name="${field.name}"]`);
        const counter = document.getElementById(field.counterId);

        input.addEventListener('input', () => {
            const len = input.value.length;
            counter.textContent = len;
            counter.parentElement.classList.toggle('over', len > field.max);
        });
    });
}



// ========================================
// バリデーション
// ========================================
function validateForm() {
    const form = document.getElementById('applicationForm');
    const errors = [];

    // 必須フィールド
    const requiredFields = [
        { name: 'name', label: 'お名前' },
        { name: 'furigana', label: 'ふりがな' },
        { name: 'postalCode', label: '郵便番号' },
        { name: 'address', label: 'ご住所' },
        { name: 'email', label: 'メールアドレス' },
        { name: 'exhibitorName', label: '出展名' },
        { name: 'menuName', label: '出展メニュー名' },
        { name: 'selfIntro', label: '自己紹介' },
        { name: 'shortPR', label: '一言PR' }
    ];

    requiredFields.forEach(field => {
        const input = form.querySelector(`[name="${field.name}"]`);
        if (!input.value.trim()) {
            errors.push(`${field.label}を入力してください`);
            input.classList.add('border-red-500');
        } else {
            input.classList.remove('border-red-500');
        }
    });

    // カテゴリ
    if (!selectedCategory) {
        errors.push('出展カテゴリを選択してください');
    }

    // ブース
    if (!selectedBooth) {
        errors.push('出展ブースタイプを選択してください');
    }

    // 写真
    const photoInput = form.querySelector('[name="profileImage"]');
    // 写真再利用の場合はチェックを緩和
    const usePrevious = form.querySelector('[name="usePreviousPhoto"]')?.checked;

    // 画像を取り込めなかった場合（photoFallbackReason）は、写真なしでの申込を許可する。
    // 写真は後から公式LINEで回収できるが、申込機会は取り戻せないため。
    // サイズ上限は選択時に「圧縮後のサイズ」で判定済みなので、ここでは選択の有無だけ見る。
    if (!usePrevious && !photoFallbackReason) {
        if (!photoInput.files || photoInput.files.length === 0) {
            errors.push('ご自身の写真をアップロードしてください');
        }
    }

    // 写真掲載可否
    const photoPermission = form.querySelector('input[name="photoPermission"]:checked');
    if (!photoPermission) {
        errors.push('写真のSNS投稿への掲載可否を選択してください');
    }

    // 規約同意
    const agreeTerms = form.querySelector('input[name="agreeTerms"]');
    if (!agreeTerms.checked) {
        errors.push('出展規約への同意が必要です');
    }

    // メールアドレス形式
    const emailInput = form.querySelector('[name="email"]');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailInput.value && !emailRegex.test(emailInput.value)) {
        errors.push('メールアドレスの形式が正しくありません');
    }

    // メールアドレス確認一致チェック
    const emailConfirmInput = form.querySelector('[name="emailConfirm"]');
    if (emailInput.value !== emailConfirmInput.value) {
        errors.push('メールアドレスが一致しません');
        emailConfirmInput.classList.add('border-red-500');
    } else {
        emailConfirmInput.classList.remove('border-red-500');
    }

    // 文字数制限
    if (form.querySelector('[name="menuName"]').value.length > 100) {
        errors.push('出展メニュー名は100文字以内で入力してください');
    }
    if (form.querySelector('[name="selfIntro"]').value.length > 200) {
        errors.push('自己紹介は200文字以内で入力してください');
    }
    if (form.querySelector('[name="shortPR"]').value.length > 35) {
        errors.push('一言PRは35文字以内で入力してください');
    }

    // SNSリンクに使えない文字（全角文字・半角コンマ）のチェック
    let hasInvalidLink = false;
    form.querySelectorAll('.sns-input').forEach(input => {
        if (input.value && hasInvalidLinkChar(input.value)) {
            hasInvalidLink = true;
            input.classList.add('border-red-500');
        }
    });
    if (hasInvalidLink) {
        errors.push('SNSリンクに使えない文字（全角文字・コンマ）が含まれています。半角で入力してください');
    }

    return errors;
}

// ========================================
// フォーム送信
// ========================================
async function submitForm() {
    const errors = validateForm();

    if (errors.length > 0) {
        alert('入力エラー:\n\n' + errors.join('\n'));
        return;
    }

    // セッション禁止警告が表示されている場合
    const warning = document.getElementById('sessionWarning');
    if (warning.classList.contains('visible')) {
        const confirmed = confirm(
            '⚠️ ご注意\n\n' +
            '選択されたブースでは「占い・スピリチュアル」「ボディケア・美容」のセッションを行うことができません。\n' +
            '物販・飲食のみの出展となりますがよろしいですか？'
        );
        if (!confirmed) return;
    }

    // キャンセル待ちのブースを選んでいる場合の確認。
    // 画面の案内を読み飛ばしたまま送信されると「出展確定した」と誤解されるため、
    // 送信前に必ず一度、確定ではないこと・入金がまだ不要なことに同意してもらう。
    if (isWaitlistSelected()) {
        const proceedWaitlist = confirm(
            '⚠️ キャンセル待ちでのお申し込みです\n\n' +
            `「${selectedBooth.name}」は満枠のため、キャンセル待ちでの受付となります。\n\n` +
            '・現時点では出展確定ではありません\n' +
            '・空きが出た場合のみ、事務局から順番にご連絡いたします\n' +
            '・出展料のお振込みは、確定のご連絡があるまで行わないでください\n\n' +
            'この内容でお申し込みを進めますか？'
        );
        if (!proceedWaitlist) return;
    }

    // LINE連携が取れていない場合の確認。
    // 申込自体はブロックしない（連携失敗で申込機会を失う方が損失が大きい）が、
    // 無言で通していた従来と違い、申込者に必ず自覚してもらう。
    if (liffState.status !== 'linked') {
        const proceed = confirm(
            '⚠️ LINE情報を取得できていません\n\n' +
            'このまま申し込むと、当日のご案内をLINEでお送りできません。\n' +
            '公式LINEのリッチメニューから開き直すことをおすすめします。\n\n' +
            'このまま送信しますか？'
        );
        if (!proceed) return;
    }

    // ローディング表示
    document.getElementById('loadingOverlay').classList.add('visible');
    document.getElementById('submitBtn').disabled = true;

    try {
        const form = document.getElementById('applicationForm');
        const formData = new FormData(form);

        // 追加データ
        formData.append('boothId', selectedBooth.id);
        formData.append('boothName', selectedBooth.name);
        formData.append('category', selectedCategory);
        formData.append('isEarlyBird', isEarlyBird() ? '1' : '0');
        // キャンセル待ちかどうか（メール文面・管理シートの区分に使う）
        formData.append('isWaitlist', isWaitlistSelected() ? '1' : '0');

        // 料金計算結果
        const boothPrice = isEarlyBird()
            ? selectedBooth.prices.earlyBird
            : selectedBooth.prices.regular;
        formData.append('boothPrice', boothPrice);
        formData.append('extraStaff', optionValues.staff);
        formData.append('extraChairs', optionValues.chairs);
        formData.append('usePower', optionValues.power ? '1' : '0');
        formData.append('partyCount', optionValues.partyCount);
        formData.append('secondaryPartyCount', optionValues.secondaryPartyCount);

        // 得意ジャンルを収集（チェックされた項目をカンマ区切りに）
        const checkedGenres = [...document.querySelectorAll('input[name="specialtyGenre"]:checked')]
            .map(cb => cb.value).join('、');
        formData.set('specialtyGenres', checkedGenres);

        // 事前予約
        const advanceReservation = document.querySelector('input[name="advanceReservation"]:checked')?.value || '不可';
        formData.set('advanceReservation', advanceReservation);

        // SNSリンクを収集
        const snsLinks = [];
        document.querySelectorAll('.sns-input').forEach((input, index) => {
            if (input.value) {
                const badge = document.querySelector(`.sns-badge[data-index="${index}"]`);
                snsLinks.push({
                    type: badge?.textContent || 'HP',
                    url: input.value
                });
            }
        });
        formData.append('snsLinks', JSON.stringify(snsLinks));

        // スプレッドシートID設定
        if (CONFIG.currentSpreadsheetId) {
            formData.append('currentSpreadsheetId', CONFIG.currentSpreadsheetId);
        }
        if (CONFIG.databaseSpreadsheetId) {
            formData.append('databaseSpreadsheetId', CONFIG.databaseSpreadsheetId);
        }
        // イベント名（マスターDBの「開催回」列用）
        if (CONFIG.eventName) {
            formData.append('eventName', CONFIG.eventName);
        }

        // 画像処理 (Base64変換)
        // 画像の失敗で申込ごと落とさない。変換に失敗しても理由を添えて送信を続行し、
        // 写真は後から公式LINEで受け取る運用に切り替える。
        let imageUploadError = photoFallbackReason;
        const photoInput = form.querySelector('[name="profileImage"]');

        if (photoInput.files && photoInput.files.length > 0) {
            // 選択時の圧縮がまだ終わっていなければ待つ
            if (photoProcessing) {
                await photoProcessing;
                imageUploadError = photoFallbackReason;
            }

            if (compressedPhoto) {
                // 選択時に圧縮済み（サイズ判定もその結果に対して実施済み）
                formData.append('profileImageBase64', compressedPhoto.base64);
                formData.append('profileImageMimeType', compressedPhoto.mimeType);
                formData.append('profileImageName', compressedPhoto.name);
                imageUploadError = '';
                // 圧縮版を送るので原本は不要。載せたままだと回線を二重に使い、
                // 通信タイムアウトの原因になる。
                formData.delete('profileImage');
            } else if (!imageUploadError) {
                // 選択イベントを経ずにファイルが入っている場合の保険
                // 元ファイルは formData に残るので、Worker 側の変換にフォールバックできる
                try {
                    const base64Data = await convertFileToBase64(photoInput.files[0]);
                    formData.append('profileImageBase64', base64Data.base64);
                    formData.append('profileImageMimeType', base64Data.mimeType);
                    formData.append('profileImageName', base64Data.name);
                } catch (imageError) {
                    console.error('Image processing error:', imageError);
                    imageUploadError = `ブラウザでの画像変換に失敗: ${imageError.message || '不明なエラー'}`;
                }
            }

            // 圧縮できなかった場合、原本はWorker側の変換にフォールバックさせる。
            // ただしWorkerが扱えないサイズの原本は送っても捨てられるだけなので外す。
            if (imageUploadError && photoInput.files[0].size > MAX_UPLOAD_SIZE) {
                formData.delete('profileImage');
            }
        }
        formData.append('imageUploadError', imageUploadError);

        // LIFFデータ
        // 連携状態も一緒に送る。空で届いたときに「どこで失敗したか」が残るようにするため。
        formData.append('lineUserId', liffState.userId || '');
        formData.append('lineDisplayName', liffState.displayName || '');
        formData.append('lineLinkStatus', liffState.status);
        formData.append('lineLinkError', liffState.error || '');

        // APIへ送信（タイムアウト付き）
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000); // 90秒タイムアウト

        let response;
        try {
            response = await fetch(CONFIG.workerUrl, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                throw new Error('通信がタイムアウトしました。電波の良い場所で再度お試しください。');
            }
            throw new Error('ネットワークに接続できませんでした。インターネット接続を確認して再度お試しください。');
        }
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error('サーバーとの通信に失敗しました。しばらくしてから再度お試しください。');
        }

        let result;
        try {
            result = await response.json();
        } catch (parseError) {
            throw new Error('サーバーからの応答が正しく受信できませんでした。再度お試しください。');
        }

        if (result.success) {
            // 完了モーダル表示（画像が登録できていない場合は案内を添える）
            showCompleteModal(result, imageUploadError);
        } else {
            throw new Error(result.error || '送信に失敗しました。再度お試しください。');
        }

    } catch (error) {
        console.error('Submit error:', error);
        const errorMessage = error.message || '予期しないエラーが発生しました。';
        alert('送信エラー:\n\n' + errorMessage + '\n\n解決しない場合は、公式LINEまでお問い合わせください。');
    } finally {
        document.getElementById('loadingOverlay').classList.remove('visible');
        document.getElementById('submitBtn').disabled = false;
    }
}

/**
 * 完了モーダルを表示する。
 * 画像が登録できていない場合（result.imageStatus !== 'ok'）は、
 * 出展名を添えて公式LINEへ画像を送っていただくよう案内する。
 */
function showCompleteModal(result, clientImageError) {
    const modal = document.getElementById('completeModal');
    const warning = document.getElementById('imageMissingWarning');

    // キャンセル待ちの場合は、完了画面の見出しから「確定ではない」と分かるようにする
    const waitlist = isWaitlistSelected();
    const completeTitle = document.getElementById('completeTitle');
    const completeMessage = document.getElementById('completeMessage');
    const waitlistComplete = document.getElementById('waitlistCompleteNotice');

    if (waitlist) {
        if (completeTitle) completeTitle.textContent = 'キャンセル待ちで受け付けました';
        if (completeMessage) {
            completeMessage.innerHTML =
                'ご登録いただいたメールアドレスに<br>キャンセル待ちの受付メールをお送りしました。<br>内容をご確認ください。';
        }
        const nameEl = document.getElementById('waitlistCompleteBoothName');
        if (nameEl && selectedBooth) nameEl.textContent = selectedBooth.name;
    }
    if (waitlistComplete) waitlistComplete.classList.toggle('hidden', !waitlist);

    // サーバーの判定を優先する（ブラウザ側が失敗してもWorker側の変換で救えている場合があるため）。
    // 古いGASデプロイで imageStatus が返らない場合のみ、ブラウザ側の結果で判断する。
    const imageMissing = result.imageStatus
        ? result.imageStatus !== 'ok'
        : !!clientImageError;

    if (warning) {
        if (imageMissing) {
            const exhibitorName = document.querySelector('input[name="exhibitorName"]')?.value || '';
            const nameEl = document.getElementById('imageMissingExhibitorName');
            if (nameEl) nameEl.textContent = exhibitorName || '（ご記入の出展名）';

            const lineLink = document.getElementById('imageMissingLineLink');
            if (lineLink) lineLink.href = OFFICIAL_LINE_URL;

            warning.classList.remove('hidden');
        } else {
            warning.classList.add('hidden');
        }
    }

    // 登録できた場合も、その旨をはっきり伝える（無表示だと成否が分からないため）
    const okNotice = document.getElementById('imageOkNotice');
    if (okNotice) okNotice.classList.toggle('hidden', imageMissing);

    modal.classList.remove('hidden');
}

// ========================================
// 電源オプション変更時の価格再計算
// ========================================
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[name="usePower"]').forEach(radio => {
        radio.addEventListener('change', calculatePrice);
    });
});

// ========================================
// 郵便番号から住所自動入力
// ========================================
function initPostalCodeSearch() {
    const postalCodeInput = document.getElementById('postalCode');

    if (postalCodeInput) {
        // ハイフン自動挿入
        postalCodeInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/[^0-9]/g, '');
            if (value.length > 3) {
                value = value.slice(0, 3) + '-' + value.slice(3, 7);
            }
            e.target.value = value;

            // エラーメッセージをクリア
            document.getElementById('postalCodeError').classList.add('hidden');

            // 7桁入力で自動検索
            if (value.replace('-', '').length === 7) {
                searchAddress();
            }
        });
    }
}

async function searchAddress() {
    const postalCodeInput = document.getElementById('postalCode');
    const addressInput = document.getElementById('addressInput');
    const searchBtn = document.getElementById('searchAddressBtn');
    const errorEl = document.getElementById('postalCodeError');

    // 郵便番号を取得（ハイフンを除去）
    const postalCode = postalCodeInput.value.replace(/[^0-9]/g, '');

    if (postalCode.length !== 7) {
        errorEl.textContent = '郵便番号は7桁で入力してください';
        errorEl.classList.remove('hidden');
        return;
    }

    // ローディング状態
    searchBtn.classList.add('loading');
    searchBtn.textContent = '検索中...';
    errorEl.classList.add('hidden');

    try {
        // ZipCloud API を使用（無料・登録不要）
        const response = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${postalCode}`);
        const data = await response.json();

        if (data.status === 200 && data.results && data.results.length > 0) {
            const result = data.results[0];
            const address = result.address1 + result.address2 + result.address3;
            addressInput.value = address;
            addressInput.focus();

            // 成功フィードバック
            searchBtn.textContent = '✓ 反映済み';
            setTimeout(() => {
                searchBtn.textContent = '住所検索';
            }, 2000);
        } else {
            errorEl.textContent = '郵便番号が見つかりません';
            errorEl.classList.remove('hidden');
            searchBtn.textContent = '住所検索';
        }
    } catch (error) {
        console.error('Address search error:', error);
        errorEl.textContent = '検索に失敗しました。もう一度お試しください';
        errorEl.classList.remove('hidden');
        searchBtn.textContent = '住所検索';
    } finally {
        searchBtn.classList.remove('loading');
    }
}

// ========================================
// メールアドレス確認リアルタイムチェック
// ========================================
function initEmailConfirmation() {
    const emailInput = document.getElementById('emailInput');
    const emailConfirmInput = document.getElementById('emailConfirmInput');
    const errorEl = document.getElementById('emailMatchError');

    if (!emailInput || !emailConfirmInput) return;

    const checkMatch = () => {
        const email = emailInput.value;
        const confirmEmail = emailConfirmInput.value;

        if (confirmEmail === '') {
            errorEl.classList.add('hidden');
            emailConfirmInput.classList.remove('border-red-500', 'border-green-500');
            return;
        }

        if (email === confirmEmail) {
            errorEl.classList.add('hidden');
            emailConfirmInput.classList.remove('border-red-500');
            emailConfirmInput.classList.add('border-green-500');
        } else {
            errorEl.classList.remove('hidden');
            emailConfirmInput.classList.add('border-red-500');
            emailConfirmInput.classList.remove('border-green-500');
        }
    };

    emailInput.addEventListener('input', checkMatch);
    emailConfirmInput.addEventListener('input', checkMatch);
}

// ========================================
// ファイルサイズ即時チェック
// ========================================
function initFileSizeCheck() {
    const photoInput = document.getElementById('profileImage');
    if (!photoInput) return;

    photoInput.addEventListener('change', (e) => {
        const file = e.target.files[0];

        // 新しく選び直したので、前回の結果はリセットする
        clearPhotoFallback();
        hidePhotoReady();
        compressedPhoto = null;
        if (!file) return;

        // HEIC/HEIFチェック
        const fileName = file.name.toLowerCase();
        if (fileName.endsWith('.heic') || fileName.endsWith('.heif')) {
            e.target.value = '';
            setPhotoFallback(
                'HEIC/HEIF形式のため取り込めませんでした',
                'HEIC形式の画像はこのフォームでは取り込めませんでした。\n\n' +
                'JPGまたはPNGの画像を選び直していただくか、\n' +
                'このまま申し込みを進めて、写真だけ後から公式LINEへお送りいただくこともできます。'
            );
            return;
        }

        // 選択直後に圧縮まで済ませ、圧縮後のサイズで上限を判定する。
        // 送信時の待ち時間も減らせる。
        photoProcessing = prepareSelectedPhoto(file, e.target);
    });
}

/**
 * 選択された画像を圧縮し、圧縮後のサイズで上限判定を行う。
 *
 * 原本のサイズで弾くと、縮小すれば余裕で収まる写真まで申込できなくなる。
 * 判定は実際に送信するデータ（圧縮後）に対して行う。
 */
async function prepareSelectedPhoto(file, inputEl) {
    // デコード自体を試さない安全弁。これを超える画像はブラウザがメモリ不足で固まりやすい。
    if (file.size > MAX_DECODE_SIZE) {
        inputEl.value = '';
        setPhotoFallback(
            `ファイルが大きすぎます（${formatMB(file.size)}MB）`,
            `画像のサイズが大きすぎるため取り込めませんでした（${formatMB(file.size)}MB）。\n\n` +
            '小さい画像を選び直していただくか、\n' +
            'このまま申し込みを進めて、写真だけ後から公式LINEへお送りいただくこともできます。'
        );
        return;
    }

    showPhotoProcessing(true);
    try {
        const result = await convertFileToBase64(file);

        // 圧縮しても上限を超える場合のみ断念する
        if (result.bytes > MAX_UPLOAD_SIZE) {
            inputEl.value = '';
            setPhotoFallback(
                `圧縮後も上限超過（${formatMB(result.bytes)}MB）`,
                `画像を縮小しましたが、まだサイズが大きすぎます（${formatMB(result.bytes)}MB）。\n\n` +
                '別の画像を選び直していただくか、\n' +
                'このまま申し込みを進めて、写真だけ後から公式LINEへお送りいただくこともできます。'
            );
            return;
        }

        compressedPhoto = result;
        // 実際に送信される画像そのものを見せる。
        // 「準備しています…」が消えるだけだと、登録できたのか分からないため。
        showPhotoReady(result, file.size);
    } catch (imageError) {
        console.error('Image processing error:', imageError);
        // 原本は input に残しておく（送信時にWorker側の変換へフォールバックできる）
        setPhotoFallback(
            `ブラウザでの画像変換に失敗: ${imageError.message || '不明なエラー'}`,
            '画像を読み込めませんでした。\n\n' +
            '別の画像を選び直していただくか、\n' +
            'このまま申し込みを進めて、写真だけ後から公式LINEへお送りいただくこともできます。'
        );
    } finally {
        showPhotoProcessing(false);
    }
}

function formatMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(2);
}

// 圧縮中の表示（数秒かかる端末があるため、無反応に見えないようにする）
function showPhotoProcessing(processing) {
    const el = document.getElementById('photoProcessingNotice');
    if (el) el.classList.toggle('hidden', !processing);
}

/**
 * 取り込めた写真を、送信される状態そのままでプレビュー表示する。
 * 申込者が「どの写真が登録されるのか」を送信前に確認できるようにする。
 */
function showPhotoReady(result, originalBytes) {
    const notice = document.getElementById('photoReadyNotice');
    if (!notice) return;

    const preview = document.getElementById('photoReadyPreview');
    if (preview) preview.src = `data:${result.mimeType};base64,${result.base64}`;

    const detail = document.getElementById('photoReadyDetail');
    if (detail) {
        // 縮小が効いた場合だけ、その旨も伝える（「勝手に画質が変わった」と驚かせないため）
        detail.textContent = originalBytes > result.bytes * 1.2
            ? `大きい写真のため自動で縮小しました（${formatKB(result.bytes)}）`
            : `送信サイズ: ${formatKB(result.bytes)}`;
    }

    notice.classList.remove('hidden');
}

function hidePhotoReady() {
    const notice = document.getElementById('photoReadyNotice');
    if (notice) notice.classList.add('hidden');
}

function formatKB(bytes) {
    return bytes >= 1024 * 1024
        ? `${formatMB(bytes)}MB`
        : `${Math.round(bytes / 1024)}KB`;
}

/**
 * 画像を取り込めなかったことを記録し、写真なしでも申込を進められる状態にする。
 * 画面上にも案内を出し、「送信ボタンを押しても何も起きない」状態を作らない。
 */
function setPhotoFallback(reason, alertMessage) {
    photoFallbackReason = reason;
    hidePhotoReady();

    const photoInput = document.getElementById('profileImage');
    if (photoInput) {
        photoInput.required = false;
    }

    const notice = document.getElementById('photoFallbackNotice');
    if (notice) {
        const reasonEl = document.getElementById('photoFallbackReason');
        if (reasonEl) reasonEl.textContent = reason;
        notice.classList.remove('hidden');
    }

    const requiredTag = document.getElementById('photoRequiredTag');
    if (requiredTag) requiredTag.style.display = 'none';

    if (alertMessage) alert(alertMessage);
}

// 画像を選び直せたときに案内を引っ込める
function clearPhotoFallback() {
    if (!photoFallbackReason) return;
    photoFallbackReason = '';

    const photoInput = document.getElementById('profileImage');
    if (photoInput && !photoInput.disabled) {
        photoInput.required = true;
    }

    const notice = document.getElementById('photoFallbackNotice');
    if (notice) notice.classList.add('hidden');

    const requiredTag = document.getElementById('photoRequiredTag');
    if (requiredTag && !document.getElementById('usePreviousPhoto')?.checked) {
        requiredTag.style.display = 'inline';
    }
}

// ========================================
// リピーター検索機能
// ========================================
function initRepeaterSearch() {
    const toggleBtn = document.getElementById('toggleRepeaterSearchBtn');
    const searchArea = document.getElementById('repeaterSearchArea');
    const sendAuthBtn = document.getElementById('sendAuthCodeBtn');
    const verifyBtn = document.getElementById('verifyAuthCodeBtn');
    const authCodeArea = document.getElementById('authCodeArea');

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            searchArea.classList.toggle('hidden');
        });
    }

    // 認証コード送信
    if (sendAuthBtn) {
        sendAuthBtn.addEventListener('click', async () => {
            const name = document.getElementById('repeaterName').value;
            const email = document.getElementById('repeaterEmail').value;
            const statusEl = document.getElementById('repeaterSearchStatus');

            if (!name || !email) {
                statusEl.textContent = '❌ お名前とメールアドレスを入力してください';
                statusEl.className = 'mt-2 text-sm font-medium text-red-600';
                return;
            }

            statusEl.textContent = '📧 認証コードを送信中...';
            statusEl.className = 'mt-2 text-sm font-medium text-blue-600';
            sendAuthBtn.disabled = true;

            try {
                // GAS APIを呼び出す
                const url = new URL(`${CONFIG.workerUrl}/api/repeater`);
                url.searchParams.append('action', 'send_auth_code');
                url.searchParams.append('name', name);
                url.searchParams.append('email', email);

                const response = await fetch(url);
                const result = await response.json();

                if (result.success) {
                    statusEl.textContent = '✅ メールに認証コードを送信しました。入力して「認証して呼出」を押してください。';
                    statusEl.className = 'mt-2 text-sm font-medium text-green-600';
                    authCodeArea.classList.remove('hidden');
                    sendAuthBtn.classList.add('hidden'); // 送信ボタンは隠す
                } else {
                    statusEl.textContent = `⚠️ ${result.error || '該当するデータが見つかりませんでした'}`;
                    statusEl.className = 'mt-2 text-sm font-medium text-amber-600';
                    sendAuthBtn.disabled = false;
                }
            } catch (error) {
                console.error('Send auth code error:', error);
                statusEl.textContent = '❌ エラーが発生しました。通信環境を確認してください。';
                statusEl.className = 'mt-2 text-sm font-medium text-red-600';
                sendAuthBtn.disabled = false;
            }
        });
    }

    // 認証コード検証・データ取得
    if (verifyBtn) {
        verifyBtn.addEventListener('click', async () => {
            const name = document.getElementById('repeaterName').value;
            const email = document.getElementById('repeaterEmail').value;
            const codeInput = document.getElementById('repeaterAuthCode');
            // 全角数字・空白・記号が混ざっていても認証できるように正規化する
            const code = normalizeAuthCode(codeInput.value);
            codeInput.value = code; // 実際に送信される値を画面にも反映
            const statusEl = document.getElementById('repeaterSearchStatus');

            if (code.length !== 4) {
                statusEl.textContent = '❌ 4桁の認証コードを入力してください';
                statusEl.className = 'mt-2 text-sm font-medium text-red-600';
                return;
            }

            statusEl.textContent = '🔍 認証中...';
            statusEl.className = 'mt-2 text-sm font-medium text-blue-600';
            verifyBtn.disabled = true;

            try {
                const url = new URL(`${CONFIG.workerUrl}/api/repeater`);
                url.searchParams.append('action', 'verify_auth_code');
                url.searchParams.append('name', name);
                url.searchParams.append('email', email);
                url.searchParams.append('code', code);

                const response = await fetch(url);
                const result = await response.json();

                if (result.success) {
                    // 結果がある場合は必ずモーダルで選択させる
                    const dataList = result.list || [result.data]; // result.data is fallback if verification returns single record mixed in root
                    // verify_auth_code API returns { success: true, list: [...] } or { success: true, found: true, list: [...] }

                    console.log('Repeater data found:', dataList);

                    if (dataList.length === 1) {
                        statusEl.textContent = '🔍 認証成功！データが見つかりました。';
                    } else {
                        statusEl.textContent = '🔍 認証成功！複数の履歴が見つかりました。';
                    }
                    statusEl.className = 'mt-2 text-sm font-medium text-blue-600';

                    // モーダル表示
                    if (dataList && dataList.length > 0) {
                        showRepeaterSelectionModal(dataList, statusEl, searchArea);
                    } else {
                        // 万が一 list が空だった場合 (API上はありえないはずだが)
                        statusEl.textContent = '⚠️ 認証は成功しましたが、データが見つかりませんでした。';
                        statusEl.className = 'mt-2 text-sm font-medium text-amber-600';
                    }

                } else {
                    statusEl.textContent = `❌ ${result.error || '認証に失敗しました'}`;
                    statusEl.className = 'mt-2 text-sm font-medium text-red-600';
                }
            } catch (error) {
                console.error('Verify auth code error:', error);
                statusEl.textContent = '❌ エラーが発生しました。通信環境を確認してください。';
                statusEl.className = 'mt-2 text-sm font-medium text-red-600';
            } finally {
                // 成功・キャンセル後も必ず再認証できるようにボタンを復帰させる
                verifyBtn.disabled = false;
            }
        });
    }
}

// 認証コードの正規化（全角数字→半角、数字以外は除去）
function normalizeAuthCode(raw) {
    return String(raw || '')
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[^0-9]/g, '');
}

// リピーター選択モーダル表示
function showRepeaterSelectionModal(list, statusEl, searchArea) {
    const modal = document.getElementById('repeaterSelectModal');
    const listContainer = document.getElementById('repeaterList');
    const closeBtn = document.getElementById('closeRepeaterModalBtn');

    if (!modal || !listContainer) return;

    listContainer.innerHTML = ''; // クリア

    list.forEach((data, index) => {
        const item = document.createElement('div');
        item.className = 'border border-gray-200 rounded-lg p-4 hover:bg-orange-50 transition-colors cursor-pointer flex justify-between items-center';
        item.innerHTML = `
            <div>
                <p class="font-bold text-gray-800">${data.eventName || '開催回不明'}</p>
                <p class="text-sm text-gray-500">${data.submittedAt || '日時不明'} 申込</p>
                <p class="text-sm text-gray-600 mt-1">出展名: ${data.exhibitorName}</p>
            </div>
            <button type="button" class="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-orange-600">
                選択
            </button>
        `;

        // 選択時の動作
        item.addEventListener('click', () => {
            fillFormWithData(data);
            modal.classList.add('hidden');

            // ステータス更新
            if (statusEl) {
                statusEl.textContent = '✅ データを選択しました！自動入力しました。';
                statusEl.className = 'mt-2 text-sm font-medium text-green-600';
            }

            // 検索エリアを閉じる
            if (searchArea) {
                setTimeout(() => {
                    searchArea.classList.add('hidden');
                }, 1500);
            }
        });

        listContainer.appendChild(item);
    });

    // キャンセルボタン
    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.classList.add('hidden');
            if (statusEl) {
                statusEl.textContent = '⚠️ 選択がキャンセルされました。';
                statusEl.className = 'mt-2 text-sm font-medium text-amber-600';
            }
        };
    }

    modal.classList.remove('hidden');
}


// 取得したデータでフォームを埋める
function fillFormWithData(data) {
    console.log('Filling form with:', data);

    // 基本情報
    if (data.name) document.getElementById('nameInput').value = data.name;
    if (data.furigana) document.querySelector('input[name="furigana"]').value = data.furigana;
    if (data.address) document.getElementById('addressInput').value = data.address;
    if (data.email) {
        document.getElementById('emailInput').value = data.email;
        document.getElementById('emailConfirmInput').value = data.email;
    }
    // 電話番号（新規追加項目）
    if (data.phone) document.querySelector('input[name="phoneNumber"]').value = data.phone;
    // 郵便番号（新規追加項目）
    if (data.postalCode) document.getElementById('postalCode').value = data.postalCode;

    // 出展内容
    if (data.exhibitorName) document.querySelector('input[name="exhibitorName"]').value = data.exhibitorName;

    // 出展カテゴリの復元
    if (data.category) {
        document.getElementById('categoryInput').value = data.category;
        selectedCategory = data.category;  // グローバル変数も更新（バリデーション用）
        // カテゴリボタンの選択状態を更新
        const categoryButtons = document.querySelectorAll('#categoryButtons button');
        categoryButtons.forEach(btn => {
            if (btn.textContent.includes(data.category) ||
                btn.dataset.category === data.category) {
                btn.classList.add('selected', 'bg-orange-500', 'text-white');
                btn.classList.remove('bg-gray-100');
            }
        });
    }

    if (data.menuName) document.querySelector('textarea[name="menuName"]').value = data.menuName;
    if (data.selfIntro) document.querySelector('textarea[name="selfIntro"]').value = data.selfIntro;
    if (data.shortPR) document.querySelector('input[name="shortPR"]').value = data.shortPR;

    // 得意ジャンルの復元
    if (data.specialtyGenres) {
        const genres = data.specialtyGenres.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
        document.querySelectorAll('input[name="specialtyGenre"]').forEach(cb => {
            cb.checked = genres.includes(cb.value);
        });
        updateSpecialtyGenresInput();
    }

    // 事前予約の復元
    if (data.advanceReservation) {
        const radio = document.querySelector(`input[name="advanceReservation"][value="${data.advanceReservation}"]`);
        if (radio) radio.checked = true;
    }

    // 写真再利用（GASは photoUrl で返すので両方対応）
    const imageUrl = data.profileImageUrl || data.photoUrl;
    if (imageUrl) {
        const reuseOption = document.getElementById('reusePhotoOption');
        const prevImg = document.getElementById('prevPhotoImg');
        const hiddenUrl = document.getElementById('profileImageUrl');

        if (reuseOption && prevImg && hiddenUrl) {
            reuseOption.classList.remove('hidden');

            // Google DriveのURLを表示可能な形式に変換
            // 形式: https://lh3.googleusercontent.com/d/FILE_ID
            let displayUrl = imageUrl;
            console.log('Original Profile Image URL:', displayUrl); // デバッグ用

            // ID抽出（/d/ID または id=ID）
            const fileIdMatch = displayUrl.match(/(?:\/d\/|id=)([\w-]+)/);
            if (fileIdMatch && fileIdMatch[1]) {
                const fileId = fileIdMatch[1];
                displayUrl = `https://lh3.googleusercontent.com/d/${fileId}`;
                console.log('Converted Preview URL:', displayUrl); // デバッグ用
            }

            prevImg.src = displayUrl;
            prevImg.onerror = function () {
                // 画像読み込みエラー時の代替表示
                this.style.display = 'none';
                this.parentElement.insertAdjacentHTML('beforeend',
                    '<p class="text-sm text-gray-500">（プレビュー表示できません。前回の写真は使用可能です）</p>');
            };
            hiddenUrl.value = imageUrl; // 元のURLを保持
        }
    }

    // SNSリンク統合
    // 既存の入力欄をクリア
    const container = document.getElementById('snsLinksContainer');
    container.innerHTML = '';
    snsLinkCount = 0;

    // 過去データのSNS各項目をチェックして追加
    const snsData = data.sns || data.snsLinks;
    const snsList = [];
    if (snsData) {
        if (Array.isArray(snsData)) {
            // 新形式: [{type, url}, ...] 配列
            snsData.forEach(item => { if (item.url) snsList.push(item.url); });
        } else {
            // 旧形式: {hp, blog, fb, insta, line, other} オブジェクト（後方互換）
            if (snsData.hp) snsList.push(snsData.hp);
            if (snsData.blog) snsList.push(snsData.blog);
            if (snsData.fb) snsList.push(snsData.fb);
            if (snsData.insta) snsList.push(snsData.insta);
            if (snsData.insta2) snsList.push(snsData.insta2);
            if (snsData.line) snsList.push(snsData.line);
            if (snsData.other) snsList.push(snsData.other);
        }
    }

    if (snsList.length > 0) {
        snsList.forEach(url => {
            if (url && url.trim() !== '') {
                addSnsLinkInput(url);
            }
        });
    } else {
        // 空でも1つ作っておく
        addSnsLinkInput();
    }

    // 文字数カウント更新
    document.querySelectorAll('textarea, input[type="text"]').forEach(input => {
        input.dispatchEvent(new Event('input'));
    });
}

// 写真再利用トグル
function togglePhotoUpload() {
    const checkbox = document.getElementById('usePreviousPhoto');
    const fileInput = document.getElementById('profileImage');
    const preview = document.getElementById('previousPhotoPreview');
    const requiredTag = document.getElementById('photoRequiredTag');
    const hiddenUrl = document.getElementById('profileImageUrl');

    if (checkbox.checked) {
        // 前回写真を使用（前回画像があるので、取り込み失敗の案内は不要）
        clearPhotoFallback();
        hidePhotoReady();
        compressedPhoto = null;
        fileInput.disabled = true;
        fileInput.required = false;
        fileInput.value = ''; // ファイル選択解除
        preview.classList.remove('hidden');
        requiredTag.style.display = 'none';

        // 隠しフィールドにURLがセットされているはず
        if (!hiddenUrl.value && document.getElementById('prevPhotoImg').src) {
            hiddenUrl.value = document.getElementById('prevPhotoImg').src;
        }
    } else {
        // 新規アップロード
        fileInput.disabled = false;
        // 取り込みに失敗している最中は必須に戻さない（申込ごと止めないため）
        fileInput.required = !photoFallbackReason;
        preview.classList.add('hidden');
        requiredTag.style.display = photoFallbackReason ? 'none' : 'inline';
        // URLはクリアしなくてよい（送信時にcheckboxを見て判定するなら）
    }
}

// ========================================
// ユーティリティ
// ========================================
function convertFileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    if (!ctx) {
                        reject(new Error('Canvas の初期化に失敗しました'));
                        return;
                    }

                    // 最大サイズ設定 (1200px - Android端末のメモリ対策で縮小)
                    const MAX_SIZE = 1200;
                    let width = img.width;
                    let height = img.height;

                    if (width > height) {
                        if (width > MAX_SIZE) {
                            height *= MAX_SIZE / width;
                            width = MAX_SIZE;
                        }
                    } else {
                        if (height > MAX_SIZE) {
                            width *= MAX_SIZE / height;
                            height = MAX_SIZE;
                        }
                    }

                    // 整数に丸める（Canvas は小数を受け付けない場合がある）
                    width = Math.round(width);
                    height = Math.round(height);

                    canvas.width = width;
                    canvas.height = height;
                    ctx.drawImage(img, 0, 0, width, height);

                    // JPEG形式、品質0.8で圧縮してBase64取得
                    // 元がPNGでもJPEG変換して容量削減
                    const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);

                    const base64Only = compressedDataUrl.split(',')[1];

                    if (!base64Only) {
                        reject(new Error('画像の変換結果が空です'));
                        return;
                    }

                    // Base64は元データの約4/3の長さになる。上限判定に使う実バイト数を求める。
                    const padding = (base64Only.endsWith('==') ? 2 : base64Only.endsWith('=') ? 1 : 0);
                    const bytes = Math.floor(base64Only.length * 3 / 4) - padding;

                    console.log(`Image compressed: ${width}x${height}, Quality: 0.8, Size: ${Math.round(bytes / 1024)}KB`);

                    resolve({
                        base64: base64Only,
                        mimeType: 'image/jpeg',
                        name: file.name.replace(/\.[^/.]+$/, "") + ".jpg", // 拡張子をjpgに変更
                        bytes: bytes
                    });
                } catch (canvasError) {
                    console.error('Canvas processing error:', canvasError);
                    reject(new Error('画像の圧縮処理に失敗しました: ' + (canvasError.message || '不明なエラー')));
                }
            };
            img.onerror = () => reject(new Error('画像の読み込みに失敗しました。ファイルが破損している可能性があります。'));
        };
        reader.onerror = () => reject(new Error('画像ファイルの読み取りに失敗しました。'));
    });
}
