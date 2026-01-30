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
  SPREADSHEET_ID: '1lJy6rcEiHawekobSmEe3evtbFwcNh7WDnQ_GZ_WcHnY',
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

// リピーター検索 (doGet)
function doGet(e) {
  try {
    const action = e.parameter.action;
    
    // リピーターチェック（認証コード送信）
    if (action === 'send_auth_code') {
      const email = e.parameter.email;
      const name = e.parameter.name;
      
      if (!email || !name) {
        throw new Error('Name and Email are required');
      }
      
      // まず該当者がいるかチェック
      const checkResult = searchRepeater(name, email);
      if (!checkResult.found) {
        return ContentService
          .createTextOutput(JSON.stringify({ success: false, error: '該当するデータが見つかりませんでした' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      // 認証コード生成 (6桁数字)
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      
      // キャッシュに保存 (有効期限10分)
      const cache = CacheService.getScriptCache();
      const cacheKey = `auth_${email}`; // メールアドレスをキーにする
      cache.put(cacheKey, code, 600);
      
      // メール送信
      sendAuthEmail(email, code);
      
      return ContentService
        .createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // リピーターチェック（認証コード検証）
    if (action === 'verify_auth_code') {
      const email = e.parameter.email;
      const name = e.parameter.name;
      const code = e.parameter.code;
      
      if (!email || !name || !code) {
        throw new Error('Missing required parameters');
      }
      
      // キャッシュからコード取得
      const cache = CacheService.getScriptCache();
      const cacheKey = `auth_${email}`;
      const savedCode = cache.get(cacheKey);
      
      if (savedCode && savedCode === code) {
        // 認証成功 -> データを返す
        const result = searchRepeater(name, email);
        cache.remove(cacheKey); // 使い終わったコードは削除
        
        return ContentService
          .createTextOutput(JSON.stringify({ success: true, ...result }))
          .setMimeType(ContentService.MimeType.JSON);
      } else {
        // 認証失敗
        return ContentService
          .createTextOutput(JSON.stringify({ success: false, error: '認証コードが正しくないか、有効期限切れです' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    // 出展者一覧取得（管理画面用）
    if (action === 'get_exhibitors') {
      const spreadsheetId = e.parameter.spreadsheetId || CONFIG.SPREADSHEET_ID;
      const result = getExhibitorList(spreadsheetId);
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService
      .createTextOutput(JSON.stringify({ error: `Invalid action (GAS): ${action}` }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 過去データ検索
function searchRepeater(name, email) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  
  if (!sheet) return { found: false }; // シートがなければデータなし
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { found: false }; // ヘッダーのみならデータなし

  const headers = data[0]; // ヘッダー行
  
  // 列インデックスを特定（新旧両フォーマット対応）
  // 新形式: 開催回, 申込日時, 氏名...
  // 旧形式: 元ファイル名, 申込日時, 氏名...
  // イベント形式: 座席番号, 申込日時, 氏名...
  const getColIndex = (names) => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx > -1) return idx;
    }
    return -1;
  };
  
  const idx = {
    eventName: getColIndex(['開催回', '元ファイル名']), // 新形式または旧形式
    submittedAt: getColIndex(['申込日時']),
    name: getColIndex(['氏名']),
    email: getColIndex(['メールアドレス']),
    furigana: getColIndex(['フリガナ']),
    phone: getColIndex(['電話番号']),
    zip: getColIndex(['郵便番号']),
    address: getColIndex(['住所']),
    category: getColIndex(['出展カテゴリ']),  // 追加
    exhibitorName: getColIndex(['出展名']),
    menuName: getColIndex(['出展メニュー']),
    selfIntro: getColIndex(['自己紹介']),
    shortPR: getColIndex(['一言PR']),
    photoUrl: getColIndex(['プロフィール写真']),
    equipment: getColIndex(['ボディーブース持ち込み物品']),
    boothName: getColIndex(['出展ブース']),
    sns: getColIndex(['SNS'])
  };
  
  // メールアドレス列がないなら検索不可
  if (idx.email < 0) {
    console.error('Email column not found in headers:', headers);
    return { found: false };
  }
  
  // 照合用正規化関数
  const normalize = (str) => String(str || '').replace(/[\s\u3000]/g, '').toLowerCase();
  const targetEmail = normalize(email);
  const targetName = normalize(name);
  
  // 安全に日付をフォーマット
  const formatDate = (val) => {
    if (!val) return '';
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return ''; // Invalid Date
      return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    } catch (e) {
      return '';
    }
  };
  
  // 安全にセル値を取得
  const getCell = (row, colIdx) => {
    if (colIdx < 0 || colIdx >= row.length) return '';
    return row[colIdx] || '';
  };
  
  const matches = [];

  // 新しい順に検索（後ろから、ヘッダー行はスキップ）
  for (let i = data.length - 1; i > 0; i--) {
    const row = data[i];
    const rowEmail = normalize(getCell(row, idx.email));
    const rowName = normalize(getCell(row, idx.name));
    
    // 氏名とメールアドレスの両方が一致する場合のみ
    if (rowEmail === targetEmail && rowName === targetName) {
      matches.push({
        eventName: getCell(row, idx.eventName) || '',
        submittedAt: formatDate(getCell(row, idx.submittedAt)),
        name: getCell(row, idx.name),
        email: getCell(row, idx.email),
        furigana: getCell(row, idx.furigana),
        phone: getCell(row, idx.phone),
        postalCode: getCell(row, idx.zip),
        address: getCell(row, idx.address),
        category: getCell(row, idx.category),  // 追加
        exhibitorName: getCell(row, idx.exhibitorName),
        boothName: getCell(row, idx.boothName),
        menuName: getCell(row, idx.menuName),
        selfIntro: getCell(row, idx.selfIntro),
        shortPR: getCell(row, idx.shortPR),
        equipment: getCell(row, idx.equipment),
        snsLinks: parseSnsLinks(getCell(row, idx.sns)),
        photoUrl: getCell(row, idx.photoUrl)
      });
    }
  }
  
  if (matches.length > 0) {
    return {
      found: true,
      count: matches.length,
      list: matches
    };
  } else {
    return { found: false };
  }
} // searchRepeater end

// ========================================
// 出展者一覧取得（管理画面用）
// ========================================
function getExhibitorList(spreadsheetId) {
  try {
    const ss = SpreadsheetApp.openById(spreadsheetId || CONFIG.SPREADSHEET_ID);
    let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    
    if (!sheet) return { success: false, error: 'シートが見つかりません', exhibitors: [] };
    
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return { success: true, exhibitors: [] };
    
    const headers = data[0];
    
    // 列インデックスを特定
    const getColIndex = (names) => {
      for (const name of names) {
        const idx = headers.indexOf(name);
        if (idx > -1) return idx;
      }
      return -1;
    };
    
    const idx = {
      rowNum: -1, // 行番号用（ループ内で設定）
      seatNumber: getColIndex(['座席番号']),
      submittedAt: getColIndex(['申込日時']),
      name: getColIndex(['氏名']),
      email: getColIndex(['メールアドレス']),
      exhibitorName: getColIndex(['出展名']),
      menuName: getColIndex(['出展メニュー']),
      selfIntro: getColIndex(['自己紹介']),
      shortPR: getColIndex(['一言PR']),
      boothName: getColIndex(['出展ブース']),
      photoUrl: getColIndex(['プロフィール写真']),
      sns: getColIndex(['SNS'])
    };
    
    const getCell = (row, colIdx) => {
      if (colIdx < 0 || colIdx >= row.length) return '';
      const val = row[colIdx];
      return val !== undefined && val !== null ? String(val).trim() : '';
    };
    
    const exhibitors = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const exhibitorName = getCell(row, idx.exhibitorName);
      
      // 出展名がない行はスキップ
      if (!exhibitorName) continue;
      
      exhibitors.push({
        id: i, // 行番号をIDとして使用
        seatNumber: getCell(row, idx.seatNumber),
        submittedAt: getCell(row, idx.submittedAt),
        name: getCell(row, idx.name),
        email: getCell(row, idx.email),
        exhibitorName: exhibitorName,
        menuName: getCell(row, idx.menuName),
        selfIntro: getCell(row, idx.selfIntro),
        shortPR: getCell(row, idx.shortPR),
        boothName: getCell(row, idx.boothName),
        photoUrl: getCell(row, idx.photoUrl),
        snsLinks: parseSnsLinks(getCell(row, idx.sns))
      });
    }
    
    return { success: true, exhibitors: exhibitors };
    
  } catch (error) {
    console.error('getExhibitorList error:', error);
    return { success: false, error: error.message, exhibitors: [] };
  }
}


// SNSリンク文字列（"Type: URL\nType: URL" または単純なURL）をパース
function parseSnsLinks(str) {
  const result = { hp: '', blog: '', fb: '', insta: '', line: '', other: '' };
  if (!str || str === 'なし' || str === '（形式エラー）') return result;
  
  const lines = str.split('\n');
  lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    // "Type: URL" 形式かチェック
    const parts = line.split(': ');
    if (parts.length >= 2 && !line.startsWith('http')) {
      const type = parts[0];
      const url = parts.slice(1).join(': ');
      
      if (type === 'HP' || type === 'Linktree' || type === 'lit.link') result.hp = url;
      else if (type === 'ブログ' || type === 'Ameblo') result.blog = url;
      else if (type === 'Facebook') result.fb = url;
      else if (type === 'Instagram') result.insta = url;
      else if (type === '公式LINE') result.line = url;
      else result.other = url;
    } else {
      // "Type: " 形式でない場合（URLのみの場合）、ドメインで判定
      const url = line;
      if (url.includes('instagram.com')) result.insta = url;
      else if (url.includes('facebook.com')) result.fb = url;
      else if (url.includes('ameblo.jp')) result.blog = url;
      else if (url.includes('lin.ee') || url.includes('line.me')) result.line = url;
      else if (url.includes('youtube.com') || url.includes('tiktok.com') || url.includes('twitter.com') || url.includes('x.com')) result.other = url;
      else result.hp = url; // その他はHP枠へ
    }
  });
  return result;
}

// データ受信 (doPost)
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // 30秒ロック
    
    // データ解析
    let params = e.parameter || {};
    
    // JSONリクエストの場合はパースしてマージ
    if (e.postData && e.postData.contents) {
      try {
        const jsonParams = JSON.parse(e.postData.contents);
        params = { ...params, ...jsonParams };
      } catch (err) {
        // JSONパースエラー時は無視（通常のparamsのみ使用）
        console.warn('JSON parse error:', err);
      }
    }
    
    // スプレッドシート作成アクション
    if (params.action === 'create_spreadsheet') {
      const name = params.name;
      if (!name) throw new Error('Spreadsheet name is required');
      
      const newSs = SpreadsheetApp.create(name);
      
      // デフォルトシートをリネーム（または削除して新規作成）
      // ここでは最初のシートを「申込データ」にする
      const firstSheet = newSs.getSheets()[0];
      firstSheet.setName(CONFIG.SHEET_NAME);
      
      // ヘッダー追加（イベント用：座席番号列あり）
      addEventHeaderRow(firstSheet);
      
      // 権限設定（必要であれば）
      // newSs.addEditor(CONFIG.ADMIN_EMAIL);
      
      return ContentService
        .createTextOutput(JSON.stringify({ 
          success: true, 
          spreadsheetId: newSs.getId(),
          spreadsheetUrl: newSs.getUrl()
        }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 画像生成アクション
    if (params.action === 'generate_image') {
      const { templateId, exhibitorData, imageType } = params;
      if (!templateId || !exhibitorData || !imageType) {
        throw new Error('templateId, exhibitorData, imageType are required');
      }
      
      const result = generateExhibitorImage(templateId, exhibitorData, imageType);
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 一括画像生成アクション
    if (params.action === 'generate_batch_images') {
      const { templateId, exhibitorIds, imageType, spreadsheetId } = params;
      if (!templateId || !imageType) {
        throw new Error('templateId, imageType are required');
      }
      
      const result = generateBatchImages(templateId, exhibitorIds || [], imageType, spreadsheetId);
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // スライドテンプレート作成アクション
    if (params.action === 'create_slide_template') {
      const { templateType } = params;
      if (!templateType) {
        throw new Error('templateType is required');
      }
      
      const result = createSlideTemplatePresentation(templateType);
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 画像アップロード処理
    let profileImageUrl = params.profileImageUrl || ''; // 既存のURLがあればそれを使用
    
    if (params.profileImageBase64) {
       // 新しい画像がアップロードされた場合は上書き
       profileImageUrl = saveImageToDrive(
         params.profileImageBase64,
         params.profileImageMimeType,
         params.profileImageName,
         params.eventName,
         params.name
       );
    }
    
    // データの整理
    const data = {
      submittedAt: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      ...params,
      profileImageUrl: profileImageUrl
    };
    
    // 料金再計算 (改ざん防止)
    const calculationResult = calculatePrice(data);
    
    // スプレッドシート保存 (二重保存)
    saveToSpreadsheet(data, calculationResult, params.currentSpreadsheetId, params.databaseSpreadsheetId, params.eventName);
    
    // 申込者へ確認メール送信
    sendConfirmationEmail(data, calculationResult);
    
    // 管理者へメール通知
    sendAdminEmail(data, calculationResult);
    
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, totalFee: calculationResult.totalFee }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Google Driveに画像保存
function saveImageToDrive(base64Data, mimeType, fileName, eventName, applicantName) {
  try {
    // フォルダ取得（リトライ処理付き）
    let rootFolder;
    const maxRetries = 3;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            rootFolder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
            break; // 成功したらループを抜ける
        } catch (e) {
            console.warn(`Retry ${i+1}/${maxRetries} failed to get root folder: ${e.message}`);
            if (i === maxRetries - 1) throw e; // 最後のリトライで失敗したらエラーを投げる
            Utilities.sleep(1000); // 1秒待機
        }
    }
    
    // イベント名フォルダの取得または作成
    let targetFolder;
    if (eventName) {
      // フォルダ検索
      const folders = rootFolder.getFoldersByName(eventName);
      if (folders.hasNext()) {
        targetFolder = folders.next();
      } else {
        targetFolder = rootFolder.createFolder(eventName);
        // 新規作成したフォルダを「リンクを知っている全員が閲覧可」に設定
        targetFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }
    } else {
      targetFolder = rootFolder; // イベント名がない場合はルートに保存
    }

    const decodedBlob = Utilities.base64Decode(base64Data);
    
    // ファイル名を「氏名.拡張子」または「氏名_元ファイル名」に変更
    let newFileName = fileName;
    if (applicantName) {
      // 拡張子を取得
      const ext = fileName.includes('.') ? fileName.split('.').pop() : 'jpg';
      newFileName = `${applicantName}.${ext}`;
    }

    // Blob作成
    const blob = Utilities.newBlob(decodedBlob, mimeType, newFileName);
    
    // 保存
    const file = targetFolder.createFile(blob);
    
    // 公開設定（リンクを知っている人全員）
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    // 埋め込み用直リンクURLを返す
    return `https://lh3.googleusercontent.com/d/${file.getId()}`;
    
  } catch (e) {
    console.error('Image save error:', e);
    const errorDetail = (e.stack || e.toString());
    throw new Error('画像の保存に失敗しました。詳細: ' + e.message + ' (' + errorDetail + ')');
  }
}

// 料金計算
function calculatePrice(data) {
  let total = 0;
  
  // ブース特定
  const boothInfo = CONFIG.BOOTHS[data.boothId];
  if (!boothInfo) throw new Error('Invalid Booth ID');
  
  // ブース料金
  const isEarlyBird = data.isEarlyBird === '1';
  const boothPrice = isEarlyBird ? boothInfo.earlyBird : boothInfo.regular;
  total += boothPrice;
  
  // 追加スタッフ
  const extraStaff = parseInt(data.extraStaff || 0);
  total += extraStaff * CONFIG.UNIT_PRICES.staff;
  
  // 追加椅子
  const extraChairs = parseInt(data.extraChairs || 0);
  total += extraChairs * CONFIG.UNIT_PRICES.chair;
  
  // 電源
  if (data.usePower === '1') {
    total += CONFIG.UNIT_PRICES.power;
  }
  
  // 懇親会
  const partyCount = parseInt(data.partyCount || 0);
  total += partyCount * CONFIG.UNIT_PRICES.party;
  
  return {
    totalFee: total,
    breakdown: {
      booth: boothPrice,
      staff: extraStaff * CONFIG.UNIT_PRICES.staff,
      chairs: extraChairs * CONFIG.UNIT_PRICES.chair,
      power: data.usePower === '1' ? CONFIG.UNIT_PRICES.power : 0,
      party: partyCount * CONFIG.UNIT_PRICES.party
    }
  };
}

// スプレッドシート保存（二重保存対応）
function saveToSpreadsheet(data, calculationResult, currentSsId, databaseSsId, eventName) {
  // 1. 今回のイベント用シートへ保存（座席番号列あり、元ファイル名なし）
  const targetId = currentSsId || CONFIG.SPREADSHEET_ID;
  saveToEventSpreadsheet(targetId, data, calculationResult);
  
  // 2. マスターデータベースへ保存（座席番号列なし、開催回あり）
  const masterId = databaseSsId || CONFIG.SPREADSHEET_ID;
  
  if (masterId && masterId !== targetId) {
     saveToMasterSpreadsheet(masterId, data, calculationResult, eventName || '');
  }
}

// イベント用スプレッドシートへの保存処理（座席番号列あり）
function saveToEventSpreadsheet(spreadsheetId, data, calculationResult) {
  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    
    // シートがなければ作成
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.SHEET_NAME);
      addEventHeaderRow(sheet);
    }
    
    // ヘッダー行確認
    if (sheet.getLastRow() === 0) {
       addEventHeaderRow(sheet);
    }
    
    // 参加人数追加オプション（追加人数のみ、0〜2）
    const additionalStaff = parseInt(data.extraStaff) || 0;
    
    // データ行追加（座席番号列を含む、元ファイル名なし）
    sheet.appendRow([
      '',                                          // 座席番号（運営が後で入力）
      data.submittedAt,                            // 申込日時
      data.name,                                   // 氏名
      data.furigana,                               // フリガナ
      data.email,                                  // メールアドレス
      data.phoneNumber || '',                      // 電話番号
      data.category || '',                         // 出展カテゴリ
      data.exhibitorName,                          // 出展名
      data.boothName,                              // 出展ブース
      data.menuName,                               // 出展メニュー
      data.equipment || '',                        // ボディーブース持ち込み物品
      data.shortPR,                                // 一言PR
      data.selfIntro,                              // 自己紹介
      formatSnsLinks(data.snsLinks),               // SNS
      data.photoPermission,                        // 写真掲載可否
      data.profileImageUrl || '',                  // プロフィール写真
      additionalStaff,                             // 参加人数追加オプション
      data.usePower === '1' ? 'あり' : 'なし',    // コンセント
      data.extraChairs || 0,                       // 椅子追加
      data.partyAttend || '欠席',                  // 懇親会出欠
      data.partyCount || 0,                        // 懇親会人数
      data.secondaryPartyAttend || '欠席',         // 二次会出欠
      data.secondaryPartyCount || 0,               // 二次会人数
      data.isMember === '1' ? 'はい' : 'いいえ',  // 協会会員
      data.stampRallyPrize || 'ない',              // 景品提供
      data.prizeContent || '',                     // 景品内容
      data.postalCode || '',                       // 郵便番号  
      data.address,                                // 住所
      data.notes || '',                            // 備考・質問
      '',                                          // スタッフメモ（空欄）
      calculationResult.totalFee,                  // 合計金額
      '',                                          // 入金確認（空欄）
      '',                                          // 入金日（空欄）
      data.lineUserId || '',                       // LINE UserID
      data.lineDisplayName || ''                   // LINE DisplayName
    ]);
  } catch (e) {
    console.error(`Failed to save to event spreadsheet ${spreadsheetId}:`, e);
  }
}

// マスターDB用スプレッドシートへの保存処理（座席番号列なし、開催回あり）
function saveToMasterSpreadsheet(spreadsheetId, data, calculationResult, eventName) {
  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    
    // シートがなければ作成
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.SHEET_NAME);
      addHeaderRow(sheet);
    }
    
    // ヘッダー行確認
    if (sheet.getLastRow() === 0) {
       addHeaderRow(sheet);
    }
    
    // 参加人数追加オプション（追加人数のみ、0〜2）
    const additionalStaff = parseInt(data.extraStaff) || 0;
    
    // データ行追加（座席番号列なし、開催回あり）
    sheet.appendRow([
      eventName || '',                             // 開催回（イベント名）
      data.submittedAt,                            // 申込日時
      data.name,                                   // 氏名
      data.furigana,                               // フリガナ
      data.email,                                  // メールアドレス
      data.phoneNumber || '',                      // 電話番号
      data.category || '',                         // 出展カテゴリ
      data.exhibitorName,                          // 出展名
      data.boothName,                              // 出展ブース
      data.menuName,                               // 出展メニュー
      data.equipment || '',                        // ボディーブース持ち込み物品
      data.shortPR,                                // 一言PR
      data.selfIntro,                              // 自己紹介
      formatSnsLinks(data.snsLinks),               // SNS
      data.photoPermission,                        // 写真掲載可否
      data.profileImageUrl || '',                  // プロフィール写真
      additionalStaff,                             // 参加人数追加オプション
      data.usePower === '1' ? 'あり' : 'なし',    // コンセント
      data.extraChairs || 0,                       // 椅子追加
      data.partyAttend || '欠席',                  // 懇親会出欠
      data.partyCount || 0,                        // 懇親会人数
      data.secondaryPartyAttend || '欠席',         // 二次会出欠
      data.secondaryPartyCount || 0,               // 二次会人数
      data.isMember === '1' ? 'はい' : 'いいえ',  // 協会会員
      data.stampRallyPrize || 'ない',              // 景品提供
      data.prizeContent || '',                     // 景品内容
      data.postalCode || '',                       // 郵便番号  
      data.address,                                // 住所
      data.notes || '',                            // 備考・質問
      '',                                          // スタッフメモ（空欄）
      calculationResult.totalFee,                  // 合計金額
      '',                                          // 入金確認（空欄）
      '',                                          // 入金日（空欄）
      data.lineUserId || '',                       // LINE UserID
      data.lineDisplayName || ''                   // LINE DisplayName
    ]);
  } catch (e) {
    console.error(`Failed to save to master spreadsheet ${spreadsheetId}:`, e);
  }
}

// マスターDB用ヘッダー行（開催回列あり）
function addHeaderRow(sheet) {
  sheet.appendRow([
    '開催回', '申込日時', '氏名', 'フリガナ', 'メールアドレス', '電話番号',
    '出展カテゴリ', '出展名', '出展ブース', '出展メニュー', 'ボディーブース持ち込み物品', '一言PR', '自己紹介',
    'SNS', '写真掲載可否', 'プロフィール写真', '参加人数追加オプション', 'コンセント', '椅子追加',
    '懇親会出欠', '懇親会人数', '二次会出欠', '二次会人数', '協会会員',
    '景品提供', '景品内容', '郵便番号', '住所', '備考・質問',
    'スタッフメモ', '合計金額', '入金確認', '入金日', 'LINEユーザーID', 'LINE表示名'
  ]);
}

// 新規イベント用ヘッダー行（座席番号を含む、元ファイル名なし）
function addEventHeaderRow(sheet) {
  sheet.appendRow([
    '座席番号',  // ★運営が後で入力
    '申込日時', '氏名', 'フリガナ', 'メールアドレス', '電話番号',
    '出展カテゴリ', '出展名', '出展ブース', '出展メニュー', 'ボディーブース持ち込み物品', '一言PR', '自己紹介',
    'SNS', '写真掲載可否', 'プロフィール写真', '参加人数追加オプション', 'コンセント', '椅子追加',
    '懇親会出欠', '懇親会人数', '二次会出欠', '二次会人数', '協会会員',
    '景品提供', '景品内容', '郵便番号', '住所', '備考・質問',
    'スタッフメモ', '合計金額', '入金確認', '入金日', 'LINEユーザーID', 'LINE表示名'
  ]);
}

// 管理者へメール通知（HTMLメール）
function sendAdminEmail(data, calculationResult) {
  const subject = `【出展申込】${data.name}様 (${data.exhibitorName})`;
  
  // テキスト版（HTMLが表示できないクライアント用）
  const textBody = `
新しい出展申込がありました。

■ 申込者情報
お名前: ${data.name}
ふりがな: ${data.furigana}
電話番号: ${data.phoneNumber || '-'}
郵便番号: ${data.postalCode || '-'}
ご住所: ${data.address}
メールアドレス: ${data.email}
LINE名: ${data.lineDisplayName || '-'}
協会会員: ${data.isMember === '1' ? 'はい' : 'いいえ'}

■ 出展情報
出展名: ${data.exhibitorName}
カテゴリ: ${data.category}
ブース: ${data.boothName}
持ち込み物品: ${data.equipment || 'なし'}
出展メニュー名:
${data.menuName}
自己紹介:
${data.selfIntro}
一言PR: ${data.shortPR}
写真掲載許可: ${data.photoPermission}

■ カタログ掲載画像
画像URL: ${data.profileImageUrl || '取得失敗'}

■ オプション
追加スタッフ: ${data.extraStaff || 0}名
追加椅子: ${data.extraChairs || 0}脚
電源: ${data.usePower === '1' ? 'あり' : 'なし'}

■ SNSリンク
${formatSnsLinks(data.snsLinks)}

■ 企画・協会
スタンプラリー景品: ${data.stampRallyPrize || 'ない'}
景品内容: ${data.prizeContent || '-'}

■ 懇親会・二次会
懇親会: ${data.partyAttend || '欠席'} ${data.partyCount ? `(${data.partyCount}名)` : ''}
二次会: ${data.secondaryPartyAttend || '欠席'} ${data.secondaryPartyCount ? `(${data.secondaryPartyCount}名)` : ''} ※現場徴収

■ 備考
${data.notes || 'なし'}

■ 料金
合計: ¥${calculationResult.totalFee.toLocaleString()}

申込日時: ${data.submittedAt}
  `.trim();

  // HTMLテンプレートを読み込み
  const template = HtmlService.createTemplateFromFile('admin_mail_template');
  template.data = data;
  template.calculationResult = calculationResult;
  template.snsLinksFormatted = formatSnsLinks(data.snsLinks);
  
  const htmlBody = template.evaluate().getContent();
  
  GmailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, textBody, {
    name: 'ぶち癒やしフェスタin東京事務局',
    htmlBody: htmlBody
  });
}

// 申込者へ確認メール送信
function sendConfirmationEmail(data, calculationResult) {
  // 会員かどうか
  const isMember = data.isMember === '1';
  
  // テンプレート用のデータを準備（フィールド名をテンプレートの期待する形式に変換）
  const formData = {
    'お名前': data.name,
    'ふりがな': data.furigana,
    '電話番号': data.phoneNumber || '',
    '郵便番号': data.postalCode || '',
    'ご住所': data.address,
    'メールアドレス': data.email,
    '協会会員': isMember ? 'はい' : 'いいえ',
    '出展名（セラピスト名／屋号）': data.exhibitorName,
    '出展カテゴリ': data.category,
    '出展ブース': data.boothName,
    '持ち込み物品': data.equipment || '',
    '出展メニュー名': data.menuName,
    '自己紹介': data.selfIntro,
    '一言PR': data.shortPR,
    '写真掲載許可': data.photoPermission,
    'プロフィール写真URL': data.profileImageUrl || '',
    'SNSリンク': formatSnsLinks(data.snsLinks),
    '追加スタッフ': data.extraStaff || 0,
    '追加椅子': data.extraChairs || 0,
    'コンセント使用': data.usePower === '1' ? 'あり' : 'なし',
    'スタンプラリー景品': data.stampRallyPrize || 'ない',
    '景品内容': data.prizeContent || '',
    '懇親会の出欠': data.partyAttend || '欠席',
    '懇親会参加人数': data.partyCount || 0,
    '二次会の出欠': data.secondaryPartyAttend || '欠席',
    '二次会参加人数': data.secondaryPartyCount || 0,
    '備考': data.notes || ''
  };

  
  // 料金内訳の表示用リスト作成
  const breakdownList = [
    { item: '出展ブース料', price: calculationResult.breakdown.booth },
    { item: '追加スタッフ (×' + (data.extraStaff || 0) + ')', price: calculationResult.breakdown.staff },
    { item: '追加椅子 (×' + (data.extraChairs || 0) + ')', price: calculationResult.breakdown.chairs },
    { item: '電源使用料', price: calculationResult.breakdown.power },
    { item: '懇親会費 (×' + (data.partyCount || 0) + ')', price: calculationResult.breakdown.party }
  ].filter(item => item.price > 0);

  // HTMLテンプレートを読み込み
  const template = HtmlService.createTemplateFromFile('mail_template');
  template.formData = formData;
  template.calculationResult = calculationResult;
  template.breakdownList = breakdownList; // 追加
  template.isMember = isMember;
  template.CONFIG = CONFIG;
  
  // HTMLを評価
  const htmlBody = template.evaluate().getContent();
  
  // テキスト版（HTMLが表示できないクライアント用）
  const textBody = `
${data.name} 様

この度は「ぶち癒やしフェスタin東京」へのお申し込み、誠にありがとうございます。
以下の内容でお申し込みを受け付けました。

■ お申し込み内容
お名前: ${data.name}
ふりがな: ${data.furigana}
ご住所: ${data.address}
メールアドレス: ${data.email}
出展名: ${data.exhibitorName}
出展ブース: ${data.boothName}
出展メニュー: ${data.menuName}

■ 料金
合計: ¥${calculationResult.totalFee.toLocaleString()}

詳細はHTML版メールをご確認ください。

-----
ぶち癒やしフェスタin東京 事務局
Email: ${CONFIG.REPLY_TO_EMAIL}
  `.trim();
  
  // メール送信
  const subject = `【ぶち癒やしフェスタin東京】お申し込みありがとうございます`;
  
  GmailApp.sendEmail(data.email, subject, textBody, {
    name: 'ぶち癒やしフェスタin東京事務局',
    replyTo: CONFIG.REPLY_TO_EMAIL,
    htmlBody: htmlBody
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
// スライドテンプレート新規作成
// ========================================

/**
 * 指定されたタイプのスライドテンプレートを新規作成
 * @param {string} templateType - 'earlySns', 'lateSns', 'venue'
 * @returns {Object} 作成結果
 */
function createSlideTemplatePresentation(templateType) {
  try {
    const typeConfig = {
      'earlySns': {
        name: 'SNS用テンプレート（早期）',
        placeholders: ['{{プロフィール画像}}', '{{出展名}}', '{{メニュー}}']
      },
      'lateSns': {
        name: 'SNS用テンプレート（後期）',
        placeholders: ['{{プロフィール画像}}', '{{出展名}}', '{{メニュー}}', '{{座席番号}}']
      },
      'venue': {
        name: '会場掲示用テンプレート',
        placeholders: ['{{プロフィール画像}}', '{{出展名}}', '{{メニュー}}', '{{座席番号}}', '{{一言PR}}']
      }
    };
    
    const config = typeConfig[templateType];
    if (!config) {
      throw new Error('無効なテンプレートタイプです: ' + templateType);
    }
    
    // 新しいプレゼンテーション作成
    const presentation = SlidesApp.create(config.name);
    const presentationId = presentation.getId();
    
    // 最初のスライドを取得（空白スライド）
    let slide = presentation.getSlides()[0];
    if (!slide) {
      slide = presentation.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    }
    
    // プレースホルダーテキストボックスを配置
    const slideWidth = presentation.getPageWidth();
    const slideHeight = presentation.getPageHeight();
    
    // プロフィール画像プレースホルダー（左上）
    const imageBox = slide.insertTextBox('{{プロフィール画像}}', 30, 30, 200, 200);
    imageBox.getText().getTextStyle().setFontSize(14).setBold(true);
    imageBox.setContentAlignment(SlidesApp.ContentAlignment.MIDDLE);
    
    // テキストプレースホルダーを縦に配置
    let yPos = 30;
    for (const placeholder of config.placeholders) {
      if (placeholder === '{{プロフィール画像}}') continue; // 画像は別処理
      
      const textBox = slide.insertTextBox(placeholder, 260, yPos, 400, 50);
      textBox.getText().getTextStyle().setFontSize(18);
      yPos += 60;
    }
    
    // 説明コメントを追加
    const commentBox = slide.insertTextBox(
      '【編集方法】\n' +
      '1. 背景画像やデザインを自由に設定\n' +
      '2. プレースホルダー（{{...}}）の位置やスタイルを調整\n' +
      '3. {{プロフィール画像}}は実際の画像に置換されます',
      30, slideHeight - 150, slideWidth - 60, 120
    );
    commentBox.getText().getTextStyle().setFontSize(11).setForegroundColor('#888888');
    
    presentation.saveAndClose();
    
    // プレゼンテーションの共有設定（編集者として自分のみ、閲覧はリンク共有）
    const file = DriveApp.getFileById(presentationId);
    // デフォルトで自分のみ編集可能
    
    return {
      success: true,
      presentationId: presentationId,
      presentationUrl: `https://docs.google.com/presentation/d/${presentationId}/edit`,
      message: `${config.name}を作成しました`
    };
    
  } catch (error) {
    console.error('createSlideTemplatePresentation error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ========================================
// Google Slides 画像生成機能
// ========================================

/**
 * テンプレートスライドから出展者画像を生成
 * @param {string} templateId - テンプレートスライドのID
 * @param {Object} exhibitorData - 出展者データ
 * @param {string} imageType - 画像タイプ (earlySns, lateSns, venue)
 * @returns {Object} 結果 { success, imageUrl, error }
 */
function generateExhibitorImage(templateId, exhibitorData, imageType) {
  try {
    // 1. テンプレートをコピー
    const templateFile = DriveApp.getFileById(templateId);
    const copyName = `temp_${exhibitorData.exhibitorName}_${imageType}_${Date.now()}`;
    const copiedFile = templateFile.makeCopy(copyName);
    const copiedId = copiedFile.getId();
    
    // 2. スライドを開く
    const presentation = SlidesApp.openById(copiedId);
    const slides = presentation.getSlides();
    
    if (slides.length === 0) {
      throw new Error('テンプレートにスライドがありません');
    }
    
    const slide = slides[0];
    
    // 3. テキストプレースホルダーを置換
    const placeholders = {
      '{{出展名}}': exhibitorData.exhibitorName || '',
      '{{メニュー}}': exhibitorData.menuName || '',
      '{{一言PR}}': exhibitorData.shortPR || '',
      '{{座席番号}}': exhibitorData.seatNumber || '',
      '{{自己紹介}}': exhibitorData.selfIntro || ''
    };
    
    replaceTextInSlide(slide, placeholders);
    
    // 4. プロフィール画像を挿入（プレースホルダーシェイプがあれば）
    if (exhibitorData.photoUrl) {
      insertProfileImageInSlide(slide, exhibitorData.photoUrl);
    }
    
    // 5. 変更を保存
    presentation.saveAndClose();
    
    // 6. スライドをPNG画像としてエクスポート
    const imageBlob = exportSlideAsImage(copiedId);
    
    // 7. 画像をDriveに保存
    const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    let targetFolder;
    
    // 画像用フォルダを取得または作成
    const folderName = 'SNS画像';
    const folders = folder.getFoldersByName(folderName);
    if (folders.hasNext()) {
      targetFolder = folders.next();
    } else {
      targetFolder = folder.createFolder(folderName);
      targetFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    
    const imageName = `${exhibitorData.exhibitorName}_${imageType}.png`;
    const imageFile = targetFolder.createFile(imageBlob.setName(imageName));
    imageFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    // 8. 一時ファイルを削除
    copiedFile.setTrashed(true);
    
    return {
      success: true,
      imageUrl: imageFile.getUrl(),
      imageId: imageFile.getId(),
      downloadUrl: `https://drive.google.com/uc?export=download&id=${imageFile.getId()}`
    };
    
  } catch (error) {
    console.error('generateExhibitorImage error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * スライド内のテキストプレースホルダーを置換
 */
function replaceTextInSlide(slide, placeholders) {
  const shapes = slide.getShapes();
  
  shapes.forEach(shape => {
    if (shape.getText) {
      const textRange = shape.getText();
      let text = textRange.asString();
      
      for (const [placeholder, value] of Object.entries(placeholders)) {
        if (text.includes(placeholder)) {
          textRange.replaceAllText(placeholder, value);
        }
      }
    }
  });
}

/**
 * プロフィール画像をスライドに挿入
 * {{プロフィール画像}}というテキストを持つシェイプを画像に置換
 */
function insertProfileImageInSlide(slide, photoUrl) {
  try {
    const shapes = slide.getShapes();
    
    for (const shape of shapes) {
      if (shape.getText) {
        const text = shape.getText().asString();
        
        if (text.includes('{{プロフィール画像}}')) {
          // シェイプの位置とサイズを取得
          const left = shape.getLeft();
          const top = shape.getTop();
          const width = shape.getWidth();
          const height = shape.getHeight();
          
          // 画像を取得
          let imageBlob;
          if (photoUrl.includes('drive.google.com')) {
            // Google Drive URL の場合
            const fileId = extractDriveFileId(photoUrl);
            if (fileId) {
              const file = DriveApp.getFileById(fileId);
              imageBlob = file.getBlob();
            }
          } else {
            // 外部URLの場合
            const response = UrlFetchApp.fetch(photoUrl);
            imageBlob = response.getBlob();
          }
          
          if (imageBlob) {
            // シェイプを削除して画像を挿入
            shape.remove();
            slide.insertImage(imageBlob, left, top, width, height);
          }
          
          break;
        }
      }
    }
  } catch (error) {
    console.error('insertProfileImageInSlide error:', error);
    // 画像挿入に失敗してもエラーにはしない
  }
}

/**
 * DriveのURLからファイルIDを抽出
 */
function extractDriveFileId(url) {
  // /d/FILE_ID/ 形式
  let match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  
  // id=FILE_ID 形式
  match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  
  return null;
}

/**
 * スライドをPNG画像としてエクスポート
 */
function exportSlideAsImage(presentationId) {
  const url = `https://docs.google.com/presentation/d/${presentationId}/export/png`;
  const token = ScriptApp.getOAuthToken();
  
  const response = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token
    }
  });
  
  return response.getBlob();
}

/**
 * 複数の出展者の画像を一括生成
 */
function generateBatchImages(templateId, exhibitorIds, imageType, spreadsheetId) {
  const results = [];
  
  // 出展者一覧を取得
  const listResult = getExhibitorList(spreadsheetId);
  if (!listResult.success) {
    return { success: false, error: listResult.error, results: [] };
  }
  
  const exhibitors = listResult.exhibitors.filter(e => 
    exhibitorIds.includes(e.id) || exhibitorIds.length === 0 // 空配列の場合は全員
  );
  
  for (const exhibitor of exhibitors) {
    const result = generateExhibitorImage(templateId, exhibitor, imageType);
    results.push({
      exhibitorId: exhibitor.id,
      exhibitorName: exhibitor.exhibitorName,
      ...result
    });
    
    // APIレート制限対策
    Utilities.sleep(1000);
  }
  
  return {
    success: true,
    total: results.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results: results
  };
}

// ========================================
// 認証メール送信
// ========================================
function sendAuthEmail(email, code) {
  const subject = `【ぶち癒しフェスタ東京】認証コードのお知らせ`;
  
  const body = `
ぶち癒しフェスタ東京 出展申込フォームをご利用いただきありがとうございます。

以下の認証コードを入力して、手続きを進めてください。

認証コード: ${code}

※このコードの有効期限は10分です。
※本メールにお心当たりがない場合は、破棄してください。

--------------------------------------------------
ぶち癒しフェスタ東京 実行委員会
--------------------------------------------------
  `.trim();
  
  MailApp.sendEmail({
    to: email,
    subject: subject,
    body: body,
    name: 'ぶち癒しフェスタ東京 実行委員会',
    replyTo: CONFIG.REPLY_TO_EMAIL
  });
}

/**
 * ★診断用★ DriveApp動作確認テスト
 * GASエディタから直接実行してください
 * 「実行ログ」で結果を確認できます
 */
function testDriveAccess() {
  console.log('=== DriveApp診断テスト開始 ===');
  console.log('フォルダID: ' + CONFIG.DRIVE_FOLDER_ID);
  
  try {
    // Step 1: フォルダ取得テスト
    console.log('Step 1: フォルダ取得中...');
    const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    console.log('✅ フォルダ取得成功: ' + folder.getName());
    
    // Step 2: 権限確認
    console.log('Step 2: 権限確認中...');
    const access = folder.getSharingAccess();
    const permission = folder.getSharingPermission();
    console.log('共有設定: ' + access + ' / ' + permission);
    
    // Step 3: テストファイル作成
    console.log('Step 3: テストファイル作成中...');
    const testBlob = Utilities.newBlob('テストデータ', 'text/plain', 'test_' + Date.now() + '.txt');
    const testFile = folder.createFile(testBlob);
    console.log('✅ ファイル作成成功: ' + testFile.getName());
    
    // Step 4: テストファイル削除
    testFile.setTrashed(true);
    console.log('✅ テストファイル削除済み');
    
    console.log('=== 診断テスト完了: すべて正常 ===');
    return '成功';
    
  } catch (e) {
    console.error('❌ エラー発生: ' + e.message);
    console.error('スタックトレース: ' + e.stack);
    return 'エラー: ' + e.message;
  }
}
