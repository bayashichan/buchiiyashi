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

// ========================================
// SNS判別パターン
// ========================================
const SNS_PATTERNS = [
    { pattern: /instagram\.com|instagr\.am/i, name: 'Instagram', color: '#E4405F' },
    { pattern: /youtube\.com|youtu\.be/i, name: 'YouTube', color: '#FF0000' },
    { pattern: /tiktok\.com/i, name: 'TikTok', color: '#000000' },
    { pattern: /ameblo\.jp|ameba\.jp/i, name: 'Ameblo', color: '#1F8742' },
    { pattern: /line\.me|lin\.ee/i, name: '公式LINE', color: '#00B900' },
    { pattern: /twitter\.com|x\.com/i, name: 'X(Twitter)', color: '#1DA1F2' },
    { pattern: /facebook\.com|fb\.com/i, name: 'Facebook', color: '#1877F2' },
    { pattern: /lit\.link/i, name: 'lit.link', color: '#28A0FF' },
    { pattern: /linktr\.ee/i, name: 'Linktree', color: '#43E55E' }
];

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
    updateEarlyBirdBanner();
    updateOptionsUI();
    calculatePrice();

    // LIFF初期化
    initLiff();
});

// ========================================
// LIFF (LINE Front-end Framework)
// ========================================
async function initLiff() {
    // LIFF IDが設定されていない場合はスキップ（通常のブラウザ動作）
    if (!CONFIG.liffId) return;

    try {
        await liff.init({ liffId: CONFIG.liffId });

        // LINE内ブラウザ、または外部ブラウザでログイン済みの場合
        if (liff.isLoggedIn()) {
            const profile = await liff.getProfile();

            // 隠しフィールドにセット
            document.getElementById('lineUserId').value = profile.userId;
            document.getElementById('lineDisplayName').value = profile.displayName;

            console.log('LIFF initialized. User:', profile.displayName);
        } else {
            // 外部ブラウザで未ログインの場合は何もしない（強制ログインはさせない）
            console.log('LIFF initialized but not logged in.');
        }
    } catch (err) {
        console.error('LIFF initialization failed', err);
    }
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
    document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('selected'));

    // 選択
    btn.classList.add('selected');
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
        const header = document.createElement('div');
        header.className = 'accordion-header';
        header.innerHTML = `
      <span class="font-bold">${location}</span>
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
            option.className = 'booth-option';
            option.innerHTML = `
        <input type="radio" name="boothRadio" value="${booth.id}" onchange="selectBooth('${booth.id}')">
        <span class="ml-2 flex-1">${booth.name}</span>
        <span class="booth-price">${priceDisplay}</span>
      `;
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
    calculatePrice();
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
}

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
        row.className = 'sns-link-row flex gap-2';
        row.innerHTML = `
      <span class="sns-badge" data-index="${snsLinkCount - 1}">未入力</span>
      <input type="url" name="snsLink${snsLinkCount}" class="input-field flex-1 sns-input" data-index="${snsLinkCount - 1}" placeholder="https://...">
      <button type="button" class="text-red-500 hover:text-red-700 px-2" onclick="removeSnsRow(this)">✕</button>
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
    if (!photoInput.files || photoInput.files.length === 0) {
        errors.push('ご自身の写真をアップロードしてください');
    } else if (photoInput.files[0].size > 8 * 1024 * 1024) {
        errors.push('画像ファイルのサイズは8MB以下にしてください');
        photoInput.classList.add('border-red-500');
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

        // LIFFデータ
        formData.append('lineUserId', document.getElementById('lineUserId').value);
        formData.append('lineDisplayName', document.getElementById('lineDisplayName').value);

        // APIへ送信
        const response = await fetch(CONFIG.workerUrl, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error('送信に失敗しました');
        }

        const result = await response.json();

        if (result.success) {
            // 完了モーダル表示
            document.getElementById('completeModal').classList.remove('hidden');
        } else {
            throw new Error(result.error || '送信に失敗しました');
        }

    } catch (error) {
        console.error('Submit error:', error);
        alert('送信エラー: ' + error.message);
    } finally {
        document.getElementById('loadingOverlay').classList.remove('visible');
        document.getElementById('submitBtn').disabled = false;
    }
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
        if (!file) return;

        // HEIC/HEIFチェック
        const fileName = file.name.toLowerCase();
        if (fileName.endsWith('.heic') || fileName.endsWith('.heif')) {
            alert('HEIC形式の画像はサポートされていません。\nJPGまたはPNG形式の画像を選択してください。\n\niPhoneの場合は「設定 > カメラ > フォーマット」を「互換性優先」にするか、スクリーンショットを撮ってそれをアップロードしてください。');
            e.target.value = '';
            return;
        }

        // サイズチェック
        if (file.size > 8 * 1024 * 1024) {
            alert('画像ファイルのサイズは8MB以下にしてください。\n現在のサイズ: ' + (file.size / 1024 / 1024).toFixed(2) + 'MB');
            e.target.value = ''; // 選択をクリア
        }
    });
}
