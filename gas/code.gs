/**
 * ぶち癒しフェスタ東京 Google Apps Script
 * データ受信・金額計算・スプレッドシート保存・メール送信
 * (Based on initial implementation by Claude, with image upload features)
 */

// ========================================
// 設定
// ========================================
const CONFIG = {
  // スプレッドシートID
  SPREADSHEET_ID: '1iFQnMST_FOriiMRfPOZmkOTsBfS9ow55ploWXp1drkI',
  SHEET_NAME: '申込データ',
  
  // Google Drive 画像保存フォルダID
  DRIVE_FOLDER_ID: '12WmOIcUQPGxZEwl5jCoabLfeqmAdjQ4F',
  
  // メール設定
  ADMIN_EMAIL: 'buchi.iyashi.tokyo.info@gmail.com',
  REPLY_TO_EMAIL: 'buchi.iyashi.tokyo.info@gmail.com',
  
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
    
    // アクション分岐
    if (data.action === 'getConfig') {
      return handleGetConfig();
    }
    if (data.action === 'saveConfig') {
      return handleSaveConfig(data.payload);
    }
    
    // 通常の申し込み処理 (action指定なし、またはaction='submit')
    return handleApplicationSubmit(data);
    
  } catch (error) {
    console.error('doPost error:', error);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ========================================
// 申し込み処理 (元の処理を関数化)
// ========================================
function handleApplicationSubmit(data) {
    // Base64画像をGoogle Driveに保存
    if (data.profileImageBase64 && data.profileImageMimeType && data.profileImageName) {
      // ファイル名をカスタム生成: yyyyMMdd_HHmm_出展名.拡張子
      const dateStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
      const ext = data.profileImageName.split('.').pop();
      // 出展名からファイル名に使えない文字を除去
      const safeName = (data.exhibitorName || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
      const newFileName = `${dateStr}_${safeName}.${ext}`;
      
      const driveUrl = saveImageToDrive(data.profileImageBase64, data.profileImageMimeType, newFileName);
      data.profileImageUrl = driveUrl;
    }
    
    // 会員判定
    const isMember = data.isMember === '1';
    
    // 金額再計算（Dynamic Configを使用）
    const calculationResult = calculateFee(data, isMember);
    
    // スプレッドシートに保存
    saveToSpreadsheet(data, calculationResult);
    
    // 確認メール送信
    sendConfirmationEmail(data, isMember, calculationResult);
    
    // 管理者通知
    sendAdminNotification(data, calculationResult);
    
    return ContentService
      .createTextOutput(JSON.stringify({ 
        success: true, 
        message: 'Processing complete',
        totalFee: calculationResult.totalFee
      }))
      .setMimeType(ContentService.MimeType.JSON);
}

// ========================================
// 画像をGoogle Driveに保存
// ========================================
function saveImageToDrive(base64Data, mimeType, fileName) {
  try {
    // Base64をBlobに変換
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
    
    // 保存先フォルダを取得
    let folder;
    try {
      if (CONFIG.DRIVE_FOLDER_ID && CONFIG.DRIVE_FOLDER_ID !== 'YOUR_DRIVE_FOLDER_ID') {
        folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      }
    } catch (e) {
      console.warn('指定フォルダへのアクセスに失敗しました。代替フォルダを使用します。', e);
    }

    // 指定フォルダがない、またはアクセスできない場合は代替フォルダを使用
    if (!folder) {
      const folderName = 'ぶち癒しフェスタ申込画像_代替';
      const folders = DriveApp.getFoldersByName(folderName);
      if (folders.hasNext()) {
        folder = folders.next();
      } else {
        folder = DriveApp.createFolder(folderName);
      }
    }
    
    // ファイルを保存
    const file = folder.createFile(blob);
    
    // 公開リンク設定（誰でも閲覧可能）
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    // 直接アクセス可能なURLを生成
    const fileId = file.getId();
    // プレビュー用URLではなく、表示用URLを使用
    const directUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
    
    return directUrl;
    
  } catch (error) {
    console.error('Drive save error:', error);
    // エラー内容を返す（デバッグ用）
    return `Error: ${error.message}`;
  }
}

// ========================================
// 料金計算ロジック (Claude Original Logic)
// ========================================
// ========================================
// 料金計算 (ラッパー：Configを使用)
// ========================================
function calculateFee(data, isMember, config) {
  // configが渡されていない場合は都度読み込む
  if (!config) config = getConfig();
   
  // 整形 (デフォルト値はCONFIGから、もしくは適当な初期値)
  const unitPrices = {
    chair: Number((config.unitPrices && config.unitPrices.chair) || CONFIG.UNIT_PRICES.chair),
    power: Number((config.unitPrices && config.unitPrices.power) || CONFIG.UNIT_PRICES.power),
    staff: Number((config.unitPrices && config.unitPrices.staff) || CONFIG.UNIT_PRICES.staff),
    party: Number((config.unitPrices && config.unitPrices.party) || CONFIG.UNIT_PRICES.party),
    secondaryParty: Number((config.unitPrices && config.unitPrices.secondaryParty) || 3000)
  };
  
  const memberDiscount = Number(config.memberDiscount !== undefined ? config.memberDiscount : CONFIG.MEMBER_DISCOUNT);
  
  // 日付変換
  let earlyBirdDeadline;
  if (config.earlyBirdDeadline) {
      earlyBirdDeadline = new Date(config.earlyBirdDeadline);
  } else {
      earlyBirdDeadline = new Date(CONFIG.earlyBirdDeadline || "2025-10-31 23:59:59");
  }

  // ロジック実行
  const result = _calculateFeesLogic(data, isMember, config, unitPrices, memberDiscount, earlyBirdDeadline);
  
  return result;
}

// ========================================
// スプレッドシート保存 (Claude Original Order)
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
      '規約同意', '備考', '合計金額', 'プロフィール画像URL',
      'LINE User ID', 'LINE 表示名'
    ]);
  }
  
  // データ行追加
  sheet.appendRow([
    data.submittedAt,
    data.name,
    data.furigana,
    data.address, // フロントエンドからの住所そのもの
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
    calculationResult.totalFee,
    data.profileImageUrl || '',
    data.lineUserId || '',
    data.lineDisplayName || ''
  ]);
}

// ========================================
// 確認メール送信
// ========================================
function sendConfirmationEmail(data, isMember, calculationResult) {
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
    'コンセント使用': data.usePower === '1' ? 'あり' : '',
    'スタンプラリー景品': data.stampRallyPrize,
    '景品内容': data.prizeContent,
    '懇親会の出欠': data.partyAttend,
    '懇親会参加人数': data.partyCount,
    '二次会の出欠': data.secondaryPartyAttend,
    '二次会参加人数': data.secondaryPartyCount,
    '備考': data.notes
  };
  
  const template = HtmlService.createTemplateFromFile('mail_template');
  template.formData = formData;
  template.isMember = isMember;
  template.calculationResult = calculationResult;
  template.CONFIG = CONFIG;
  
  const htmlBody = template.evaluate().getContent();
  
  GmailApp.sendEmail(data.email, 
    '【ぶち癒やしフェスタin東京】出展お申し込み受付完了', 
    '',
    {
      htmlBody: htmlBody,
      replyTo: CONFIG.REPLY_TO_EMAIL,
      name: 'ぶち癒やしフェスタin東京事務局'
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
ご住所: ${data.address}
メール: ${data.email}
LINE: ${data.lineDisplayName ? `${data.lineDisplayName} (IDあり)` : '未連携'}

■ 出展情報
出展名: ${data.exhibitorName}
カテゴリ: ${data.category}
ブース: ${data.boothName}
ブース: ${data.boothName}
持ち込み物品: ${data.equipment || 'なし'}
出展メニュー名:
${data.menuName}
自己紹介:
${data.selfIntro}
一言PR: ${data.shortPR}

■ カタログ掲載画像
画像URL: ${data.profileImageUrl || '取得失敗'}
(画像データ受信: ${data.profileImageBase64 ? 'あり' : 'なし'})

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
  
  GmailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, body, {
    name: 'ぶち癒やしフェスタin東京事務局'
  });
}

// ========================================
// ユーティリティ
// ========================================
function formatSnsLinks(snsJson) {
  try {
    const links = JSON.parse(snsJson);
    if (!Array.isArray(links) || links.length === 0) return 'なし';
    return links.map(l => `${l.type}: ${l.url}`).join('\n');
  } catch (e) {
    return '（形式エラー）';
  }
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

// ========================================
// 設定管理機能
// ========================================

// 設定シート名
const SHEET_CONFIG_GLOBAL = 'Config_Global';
const SHEET_CONFIG_BOOTHS = 'Config_Booths';

// 設定取得
function handleGetConfig() {
  const config = getConfig();
  return ContentService.createTextOutput(JSON.stringify(config))
    .setMimeType(ContentService.MimeType.JSON);
}

// 設定保存
function handleSaveConfig(newConfig) {
  saveConfigToSheet(newConfig);
  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// シートから設定を読み込む（なければデフォルト作成）
function getConfig() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ensureConfigSheets(ss);
  
  // 1. グローバル設定
  const globalSheet = ss.getSheetByName(SHEET_CONFIG_GLOBAL);
  const globalData = globalSheet.getDataRange().getValues();
  const globalConfig = {};
  globalData.forEach(row => {
    if (row[0]) globalConfig[row[0]] = row[1];
  });
  
  // 2. ブース設定
  const boothSheet = ss.getSheetByName(SHEET_CONFIG_BOOTHS);
  const boothData = boothSheet.getDataRange().getValues();
  
  if (boothData.length < 2) {
      return { ...globalConfig, booths: [] };
  }

  const headers = boothData[0];
  const booths = [];
  
  for (let i = 1; i < boothData.length; i++) {
    const row = boothData[i];
    const booth = {};
    headers.forEach((header, index) => {
      booth[header] = row[index];
    });
    if (booth.limits) {
        try { booth.limits = JSON.parse(booth.limits); } catch(e) {}
    }
    if (booth.prices) {
        try { booth.prices = JSON.parse(booth.prices); } catch(e) {}
    }
    booths.push(booth);
  }
  
  return {
    ...globalConfig,
    booths: booths
  };
}

// シートに設定を保存
function saveConfigToSheet(config) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ensureConfigSheets(ss);
  
  // 1. グローバル設定更新
  const globalSheet = ss.getSheetByName(SHEET_CONFIG_GLOBAL);
  globalSheet.clear();
  const globalRows = [];
  
  globalRows.push(['Key', 'Value', 'Description']);
  globalRows.push(['earlyBirdDeadline', config.earlyBirdDeadline, '早割期限']);
  globalRows.push(['memberDiscount', config.memberDiscount, '会員割引額']);
  globalRows.push(['liffId', config.liffId, 'LIFF ID']);
  
  if (config.unitPrices) {
      globalRows.push(['unitPrices_chair', config.unitPrices.chair, '追加椅子単価']);
      globalRows.push(['unitPrices_power', config.unitPrices.power, '電源使用料']);
      globalRows.push(['unitPrices_staff', config.unitPrices.staff, '追加スタッフ単価']);
      globalRows.push(['unitPrices_party', config.unitPrices.party, '懇親会費']);
      globalRows.push(['unitPrices_secondaryParty', config.unitPrices.secondaryParty, '二次会費']);
  }
  
  globalSheet.getRange(1, 1, globalRows.length, 3).setValues(globalRows);

  // 2. ブース設定更新
  const boothSheet = ss.getSheetByName(SHEET_CONFIG_BOOTHS);
  boothSheet.clear();
  
  if (config.booths && config.booths.length > 0) {
    const headerRow = ['id', 'name', 'location', 'prices', 'limits', 'soldOut', 'prohibitSession'];
    const boothRows = [headerRow];
    
    config.booths.forEach(b => {
      boothRows.push([
        b.id,
        b.name,
        b.location,
        JSON.stringify(b.prices),
        JSON.stringify(b.limits),
        b.soldOut ? true : false,
        b.prohibitSession ? true : false
      ]);
    });
    
    boothSheet.getRange(1, 1, boothRows.length, headerRow.length).setValues(boothRows);
  }
}

// 設定用シート初期化
function ensureConfigSheets(ss) {
  if (!ss.getSheetByName(SHEET_CONFIG_GLOBAL)) {
    ss.insertSheet(SHEET_CONFIG_GLOBAL);
  }
  if (!ss.getSheetByName(SHEET_CONFIG_BOOTHS)) {
    ss.insertSheet(SHEET_CONFIG_BOOTHS);
  }
}

// Configを使った料金計算ロジック（分離）
function _calculateFeesLogic(data, isMember, config, unitPrices, memberDiscount, earlyBirdDeadline) {
  let total = 0;
  const items = [];
  let hasInvalidOption = false;

  // ブース特定
  let booth = null;
  if (config.booths) {
      booth = config.booths.find(b => b.id === data.boothId);
  }
  
  if (!booth) {
      // Configに見つからない場合はデフォルトCONFIG.BOOTHSから検索（後方互換）
      const boothConfig = CONFIG.BOOTHS[data.boothId];
      if (boothConfig) {
          booth = {
              name: boothConfig.name,
              prices: { regular: boothConfig.regular, earlyBird: boothConfig.earlyBird },
              limits: { maxStaff: boothConfig.maxStaff, maxChairs: boothConfig.maxChairs }
          };
      } else {
          return { totalFee: 0, breakdown: [], hasInvalidOption: true };
      }
  }

  // 早割判定（サーバー時刻ベース）
  const now = new Date();
  const isEarlyBird = now <= earlyBirdDeadline;
  const boothPrice = isEarlyBird ? booth.prices.earlyBird : booth.prices.regular;

  total += boothPrice;
  items.push({ item: booth.name, price: boothPrice, note: isEarlyBird ? '(早割)' : '' });

  // オプション: 電源
  if (data.usePower === '1') {
    total += unitPrices.power;
    items.push({ item: '電源使用', price: unitPrices.power });
  }

  // オプション: 追加椅子
  const chairs = parseInt(data.extraChairs || 0);
  if (chairs > 0) {
    if (booth.limits && chairs > booth.limits.maxChairs) hasInvalidOption = true;
    const chairsFee = chairs * unitPrices.chair;
    total += chairsFee;
    items.push({ item: `追加椅子 ${chairs}脚`, price: chairsFee });
  }

  // オプション: 追加スタッフ
  const staff = parseInt(data.extraStaff || 0);
  if (staff > 0) {
    if (booth.limits && staff > booth.limits.maxStaff) hasInvalidOption = true;
    const staffFee = staff * unitPrices.staff;
    total += staffFee;
    items.push({ item: `追加スタッフ ${staff}名`, price: staffFee });
  }

  // オプション: 懇親会
  const partyCount = parseInt(data.partyCount || 0);
  if (partyCount > 0) {
    const partyFee = partyCount * unitPrices.party;
    total += partyFee;
    items.push({ item: `懇親会 ${partyCount}名`, price: partyFee });
  }

  // 会員割引
  if (isMember) {
    total -= memberDiscount;
    items.push({ item: '会員割引', price: -memberDiscount });
  }
  
  if (total < 0) total = 0;

  return {
    breakdown: items, // format difference from original, check references
    totalFee: total,
    hasInvalidOption: hasInvalidOption
  };
}
