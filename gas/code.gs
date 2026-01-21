/**
 * ぶち癒しフェスタ東京 Google Apps Script
 * データ受信・金額計算・スプレッドシート保存・メール送信
 */

// ========================================
// 設定
// ========================================
const CONFIG = {
  // スプレッドシートID
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',
  SHEET_NAME: '申込データ',
  
  // メール設定
  ADMIN_EMAIL: 'admin@example.com',
  REPLY_TO_EMAIL: 'info@buchiiyashifestatokyo.com',
  
  // 会員割引
  MEMBER_DISCOUNT: 2000,
  
  // 単価（二次会は現場徴収のため除外）
  UNIT_PRICES: {
    chair: 100,
    power: 500,
    staff: 1000,
    party: 5000
  },
  
  // ブース定義（バリデーション・再計算用）
  BOOTHS: {
    "inner_half": { name: "内側半テーブル（標準1名）", regular: 8000, earlyBird: 7500, maxStaff: 0, maxChairs: 0 },
    "inner_1": { name: "内側1テーブル（標準2名）", regular: 15000, earlyBird: 14000, maxStaff: 0, maxChairs: 0 },
    "inner_2": { name: "内側2テーブル（標準4名）", regular: 26000, earlyBird: 26000, maxStaff: 0, maxChairs: 0 },
    "inner_prod_half": { name: "内側物販半テーブル（標準1名）", regular: 7000, earlyBird: 6500, maxStaff: 0, maxChairs: 0 },
    "inner_prod_1": { name: "内側物販1テーブル（標準2名）", regular: 13000, earlyBird: 12000, maxStaff: 0, maxChairs: 0 },
    "inner_prod_2": { name: "内側物販2テーブル（標準4名）", regular: 23000, earlyBird: 23000, maxStaff: 0, maxChairs: 0 },
    "wall_half": { name: "壁側半テーブル（標準1名）", regular: 9000, earlyBird: 8500, maxStaff: 0, maxChairs: 0 },
    "wall_1": { name: "壁側1テーブル（標準2名）", regular: 17000, earlyBird: 16000, maxStaff: 1, maxChairs: 1 },
    "wall_2": { name: "壁側2テーブル（標準4名）", regular: 30000, earlyBird: 30000, maxStaff: 2, maxChairs: 2 },
    "wall_prod_half": { name: "壁側物販半テーブル（標準1名）", regular: 9000, earlyBird: 8500, maxStaff: 0, maxChairs: 0 },
    "wall_prod_1": { name: "壁側物販1テーブル（標準2名）", regular: 17000, earlyBird: 16000, maxStaff: 1, maxChairs: 1 },
    "wall_prod_2": { name: "壁側物販2テーブル（標準4名）", regular: 30000, earlyBird: 30000, maxStaff: 2, maxChairs: 2 },
    "body_small": { name: "ボディケアブース小（標準1名）", regular: 15000, earlyBird: 14500, maxStaff: 0, maxChairs: 0 },
    "body_large": { name: "ボディケアブース大（標準2名）", regular: 20000, earlyBird: 19000, maxStaff: 1, maxChairs: 1 }
  }
};

// ========================================
// メインエントリポイント
// ========================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    
    // 会員判定
    const isMember = data.isMember === '1';
    
    // 金額再計算（サーバーサイドで正確に計算、二次会は除外）
    const calculationResult = calculateFee(data, isMember);
    
    // スプレッドシートに保存
    saveToSpreadsheet(data, calculationResult);
    
    // 確認メール送信
    sendConfirmationEmail(data, isMember, calculationResult);
    
    // 管理者通知
    sendAdminNotification(data, calculationResult);
    
    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    console.error('doPost error:', error);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ========================================
// 料金計算（サーバーサイド、二次会は除外）
// ========================================
function calculateFee(data, isMember) {
  const booth = CONFIG.BOOTHS[data.boothId];
  if (!booth) {
    throw new Error('Invalid booth ID');
  }
  
  const isEarlyBird = data.isEarlyBird === '1';
  const breakdown = [];
  let totalFee = 0;
  let hasInvalidOption = false;
  
  // ブース料金
  const boothPrice = isEarlyBird ? booth.earlyBird : booth.regular;
  breakdown.push({ item: booth.name + (isEarlyBird ? '（早割）' : ''), price: boothPrice });
  totalFee += boothPrice;
  
  // 追加スタッフ（上限チェック）
  let extraStaff = parseInt(data.extraStaff) || 0;
  if (extraStaff > booth.maxStaff) {
    extraStaff = booth.maxStaff;
    hasInvalidOption = true;
  }
  if (extraStaff > 0) {
    const staffCost = extraStaff * CONFIG.UNIT_PRICES.staff;
    breakdown.push({ item: `追加スタッフ ${extraStaff}名`, price: staffCost });
    totalFee += staffCost;
  }
  
  // 追加椅子（上限チェック）
  let extraChairs = parseInt(data.extraChairs) || 0;
  if (extraChairs > booth.maxChairs) {
    extraChairs = booth.maxChairs;
    hasInvalidOption = true;
  }
  if (extraChairs > 0) {
    const chairsCost = extraChairs * CONFIG.UNIT_PRICES.chair;
    breakdown.push({ item: `追加椅子 ${extraChairs}脚`, price: chairsCost });
    totalFee += chairsCost;
  }
  
  // 電源
  if (data.usePower === '1') {
    breakdown.push({ item: '電源使用', price: CONFIG.UNIT_PRICES.power });
    totalFee += CONFIG.UNIT_PRICES.power;
  }
  
  // 懇親会（二次会は現場徴収のため除外）
  const partyCount = parseInt(data.partyCount) || 0;
  if (partyCount > 0) {
    const partyCost = partyCount * CONFIG.UNIT_PRICES.party;
    breakdown.push({ item: `懇親会 ${partyCount}名`, price: partyCost });
    totalFee += partyCost;
  }
  
  // 会員割引（ステルス適用）
  if (isMember) {
    breakdown.push({ item: '会員割引', price: -CONFIG.MEMBER_DISCOUNT });
    totalFee -= CONFIG.MEMBER_DISCOUNT;
  }
  
  return {
    breakdown: breakdown,
    totalFee: totalFee,
    hasInvalidOption: hasInvalidOption
  };
}

// ========================================
// SNSリンクをフォーマット
// ========================================
function formatSnsLinks(snsLinksJson) {
  if (!snsLinksJson) return '未入力';
  
  try {
    const links = JSON.parse(snsLinksJson);
    if (!Array.isArray(links) || links.length === 0) return '未入力';
    
    return links.map(link => `${link.type}: ${link.url}`).join('\n');
  } catch (e) {
    return snsLinksJson;
  }
}

// ========================================
// スプレッドシート保存
// ========================================
function saveToSpreadsheet(data, calculationResult) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  
  // シートがなければ作成
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    // ヘッダー行
    sheet.appendRow([
      '申込日時', 'お名前', 'ふりがな', 'ご住所', 'メールアドレス',
      '出展名', 'カテゴリ', 'ブース', '持ち込み物品',
      'メニュー名', '自己紹介', '一言PR', '写真掲載許可',
      'SNSリンク', '電源', '追加椅子', '追加スタッフ',
      'スタンプラリー景品', '景品内容', '会員',
      '懇親会', '懇親会人数', '二次会', '二次会人数',
      '規約同意', '備考', '合計金額', 'プロフィール画像URL'
    ]);
  }
  
  // データ行追加
  sheet.appendRow([
    data.submittedAt,
    data.name,
    data.furigana,
    data.address,
    data.email,
    data.exhibitorName,
    data.category,
    data.boothName,
    data.equipment || '',
    data.menuName,
    data.selfIntro,
    data.shortPR,
    data.photoPermission,
    formatSnsLinks(data.snsLinks),
    data.usePower === '1' ? 'あり' : 'なし',
    data.extraChairs || 0,
    data.extraStaff || 0,
    data.stampRallyPrize || 'ない',
    data.prizeContent || '',
    data.isMember === '1' ? 'はい' : 'いいえ',
    data.partyAttend || '欠席',
    data.partyCount || 0,
    data.secondaryPartyAttend || '欠席',
    data.secondaryPartyCount || 0,
    data.agreeTerms ? '同意' : '',
    data.notes || '',
    calculationResult.totalFee,
    data.profileImageUrl || ''
  ]);
}

// ========================================
// 確認メール送信
// ========================================
function sendConfirmationEmail(data, isMember, calculationResult) {
  // フォームデータをテンプレート用に変換
  const formData = {
    'お名前': data.name,
    'ふりがな': data.furigana,
    'ご住所': data.address,
    'メールアドレス': data.email,
    '出展名（セラピスト名／屋号）': data.exhibitorName,
    '出展カテゴリ': data.category,
    '出展ブース': data.boothName,
    '持ち込み物品': data.equipment,
    '出展メニュー名': data.menuName,
    '自己紹介': data.selfIntro,
    '一言PR': data.shortPR,
    '写真掲載許可': data.photoPermission,
    'SNSリンク': formatSnsLinks(data.snsLinks),
    '追加スタッフ': data.extraStaff,
    '追加椅子': data.extraChairs,
    'コンセント使用': data.usePower === '1' ? '使用する' : null,
    'スタンプラリー景品': data.stampRallyPrize,
    '景品内容': data.prizeContent,
    '懇親会の出欠': data.partyAttend || '欠席',
    '懇親会参加人数': data.partyCount,
    '二次会の出欠': data.secondaryPartyAttend || '欠席',
    '二次会参加人数': data.secondaryPartyCount,
    '備考': data.notes
  };
  
  // HTMLテンプレートを取得
  const template = HtmlService.createTemplateFromFile('mail_template');
  template.formData = formData;
  template.isMember = isMember;
  template.calculationResult = calculationResult;
  template.CONFIG = CONFIG;
  
  const htmlBody = template.evaluate().getContent();
  
  // メール送信
  GmailApp.sendEmail(data.email, 
    '【ぶち癒やしフェスタin東京】出展お申し込み受付完了', 
    '', // プレーンテキスト本文（HTML優先）
    {
      htmlBody: htmlBody,
      replyTo: CONFIG.REPLY_TO_EMAIL,
      name: 'ぶち癒やしフェスタin東京 事務局'
    }
  );
}

// ========================================
// 管理者通知
// ========================================
function sendAdminNotification(data, calculationResult) {
  const subject = `【新規申込】${data.exhibitorName} 様 - ${data.boothName}`;
  
  const body = `
新規出展申し込みがありました。

■ 申込者情報
お名前: ${data.name}
ふりがな: ${data.furigana}
ご住所: ${data.address}
メール: ${data.email}

■ 出展情報
出展名: ${data.exhibitorName}
カテゴリ: ${data.category}
ブース: ${data.boothName}
持ち込み物品: ${data.equipment || 'なし'}

■ オプション
追加スタッフ: ${data.extraStaff || 0}名
追加椅子: ${data.extraChairs || 0}脚
電源: ${data.usePower === '1' ? 'あり' : 'なし'}

■ SNSリンク
${formatSnsLinks(data.snsLinks)}

■ 企画・協会
スタンプラリー景品: ${data.stampRallyPrize || 'ない'}
景品内容: ${data.prizeContent || '-'}
会員: ${data.isMember === '1' ? 'はい' : 'いいえ'}

■ 懇親会・二次会
懇親会: ${data.partyAttend || '欠席'} ${data.partyCount ? `(${data.partyCount}名)` : ''}
二次会: ${data.secondaryPartyAttend || '欠席'} ${data.secondaryPartyCount ? `(${data.secondaryPartyCount}名)` : ''} ※現場徴収

■ 備考
${data.notes || 'なし'}

■ 料金
合計: ¥${calculationResult.totalFee.toLocaleString()}

申込日時: ${data.submittedAt}
  `.trim();
  
  GmailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, body);
}

// ========================================
// テスト用関数
// ========================================
function testDoPost() {
  const testData = {
    postData: {
      contents: JSON.stringify({
        name: 'テスト太郎',
        furigana: 'てすとたろう',
        address: '東京都渋谷区1-2-3',
        email: 'test@example.com',
        exhibitorName: 'テストサロン',
        category: '占い・スピリチュアル',
        boothId: 'wall_1',
        boothName: '壁側1テーブル（標準2名）',
        boothPrice: 16000,
        isEarlyBird: '1',
        equipment: '',
        menuName: 'タロット占い',
        selfIntro: 'はじめまして',
        shortPR: '心を癒します',
        photoPermission: '可',
        snsLinks: JSON.stringify([
          { type: 'Instagram', url: 'https://instagram.com/test' },
          { type: 'YouTube', url: 'https://youtube.com/@test' }
        ]),
        extraStaff: '1',
        extraChairs: '0',
        usePower: '1',
        stampRallyPrize: 'ある',
        prizeContent: 'オリジナルお守り',
        isMember: '1',
        partyAttend: '出席',
        partyCount: '2',
        secondaryPartyAttend: '出席',
        secondaryPartyCount: '1',
        agreeTerms: 'on',
        notes: 'テスト備考',
        submittedAt: new Date().toISOString()
      })
    }
  };
  
  const result = doPost(testData);
  console.log(result.getContent());
}
