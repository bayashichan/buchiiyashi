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
    
    // リピーターチェック
    if (action === 'check_repeater') {
      const email = e.parameter.email;
      const name = e.parameter.name;
      
      if (!email || !name) {
        throw new Error('Name and Email are required');
      }
      
      const result = searchRepeater(name, email);
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Invalid action' }))
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
  
  // 列インデックスを特定（マスターシートのヘッダー名に合わせる）
  const idx = {
    name: headers.indexOf('氏名'),
    email: headers.indexOf('メールアドレス'),
    furigana: headers.indexOf('フリガナ'),
    phone: headers.indexOf('電話番号'),
    zip: headers.indexOf('郵便番号'),
    address: headers.indexOf('住所'),
    exhibitorName: headers.indexOf('出展名'),
    menuName: headers.indexOf('出展メニュー'),
    selfIntro: headers.indexOf('自己紹介'),
    shortPR: headers.indexOf('一言PR'),
    photoUrl: headers.indexOf('プロフィール写真'),
    snsLinks: headers.indexOf('SNS')
    // 合計金額、備考・質問は返さない
  };
  
  // 照合用正規化関数（スペース除去）
  const normalize = (str) => String(str).replace(/[\s\u3000]/g, '').toLowerCase();
  const targetName = normalize(name);
  const targetEmail = normalize(email);
  
  // 新しい順に検索（後ろから）
  for (let i = data.length - 1; i > 0; i--) {
    const row = data[i];
    const rowName = normalize(row[idx.name]);
    const rowEmail = normalize(row[idx.email]);
    
    if (rowName === targetName && rowEmail === targetEmail) {
      // ヒット！データを返す
      
      // SNSリンク文字列をパース
      const snsStr = idx.snsLinks > -1 ? row[idx.snsLinks] : '';
      const snsParsed = parseSnsLinks(snsStr);
      
      return {
        found: true,
        data: {
          name: row[idx.name],
          email: row[idx.email], // メールアドレスを追加
          furigana: idx.furigana > -1 ? row[idx.furigana] : '',
          phone: idx.phone > -1 ? row[idx.phone] : '',
          postalCode: idx.zip > -1 ? row[idx.zip] : '',
          address: idx.address > -1 ? row[idx.address] : '',
          exhibitorName: idx.exhibitorName > -1 ? row[idx.exhibitorName] : '',
          menuName: idx.menuName > -1 ? row[idx.menuName] : '',
          selfIntro: idx.selfIntro > -1 ? row[idx.selfIntro] : '',
          shortPR: idx.shortPR > -1 ? row[idx.shortPR] : '',
          profileImageUrl: idx.photoUrl > -1 ? row[idx.photoUrl] : '',
          sns: snsParsed
        }
      };
    }
  }
  
  return { found: false };
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
    
    // 画像アップロード処理
    let profileImageUrl = '';
    
    if (params.profileImageBase64) {
       profileImageUrl = saveImageToDrive(
         params.profileImageBase64,
         params.profileImageMimeType,
         params.profileImageName
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
function saveImageToDrive(base64Data, mimeType, fileName) {
  try {
    const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    const decodedBlob = Utilities.base64Decode(base64Data);
    const blob = Utilities.newBlob(decodedBlob, mimeType, fileName);
    
    // タイムスタンプを付与して重複回避
    const timestamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
    blob.setName(`${timestamp}_${fileName}`);
    
    const file = folder.createFile(blob);
    
    // 公開設定（リンクを知っている人全員）
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    return file.getUrl();
    
  } catch (e) {
    console.error('Image save error:', e);
    throw new Error('画像の保存に失敗しました: ' + e.message);
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
    
    // 参加人数（基本1名 + 追加スタッフ）
    const totalStaff = 1 + (parseInt(data.extraStaff) || 0);
    
    // データ行追加（座席番号列を含む、元ファイル名なし）
    sheet.appendRow([
      '',                                          // 座席番号（運営が後で入力）
      data.submittedAt,                            // 申込日時
      data.name,                                   // 氏名
      data.furigana,                               // フリガナ
      data.email,                                  // メールアドレス
      data.phoneNumber || '',                      // 電話番号
      data.exhibitorName,                          // 出展名
      data.boothName,                              // 出展ブース
      data.menuName,                               // 出展メニュー
      data.equipment || '',                        // ボディーブース持ち込み物品
      data.shortPR,                                // 一言PR
      data.selfIntro,                              // 自己紹介
      formatSnsLinks(data.snsLinks),               // SNS
      data.photoPermission,                        // 写真掲載可否
      data.profileImageUrl || '',                  // プロフィール写真
      totalStaff,                                  // 参加人数追加オプション
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
      ''                                           // 入金日（空欄）
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
    
    // 参加人数（基本1名 + 追加スタッフ）
    const totalStaff = 1 + (parseInt(data.extraStaff) || 0);
    
    // データ行追加（座席番号列なし、開催回あり）
    sheet.appendRow([
      eventName || '',                             // 開催回（イベント名）
      data.submittedAt,                            // 申込日時
      data.name,                                   // 氏名
      data.furigana,                               // フリガナ
      data.email,                                  // メールアドレス
      data.phoneNumber || '',                      // 電話番号
      data.exhibitorName,                          // 出展名
      data.boothName,                              // 出展ブース
      data.menuName,                               // 出展メニュー
      data.equipment || '',                        // ボディーブース持ち込み物品
      data.shortPR,                                // 一言PR
      data.selfIntro,                              // 自己紹介
      formatSnsLinks(data.snsLinks),               // SNS
      data.photoPermission,                        // 写真掲載可否
      data.profileImageUrl || '',                  // プロフィール写真
      totalStaff,                                  // 参加人数追加オプション
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
      ''                                           // 入金日（空欄）
    ]);
  } catch (e) {
    console.error(`Failed to save to master spreadsheet ${spreadsheetId}:`, e);
  }
}

// マスターDB用ヘッダー行（開催回列あり）
function addHeaderRow(sheet) {
  sheet.appendRow([
    '開催回', '申込日時', '氏名', 'フリガナ', 'メールアドレス', '電話番号',
    '出展名', '出展ブース', '出展メニュー', 'ボディーブース持ち込み物品', '一言PR', '自己紹介',
    'SNS', '写真掲載可否', 'プロフィール写真', '参加人数追加オプション', 'コンセント', '椅子追加',
    '懇親会出欠', '懇親会人数', '二次会出欠', '二次会人数', '協会会員',
    '景品提供', '景品内容', '郵便番号', '住所', '備考・質問',
    'スタッフメモ', '合計金額', '入金確認', '入金日'
  ]);
}

// 新規イベント用ヘッダー行（座席番号を含む、元ファイル名なし）
function addEventHeaderRow(sheet) {
  sheet.appendRow([
    '座席番号',  // ★運営が後で入力
    '申込日時', '氏名', 'フリガナ', 'メールアドレス', '電話番号',
    '出展名', '出展ブース', '出展メニュー', 'ボディーブース持ち込み物品', '一言PR', '自己紹介',
    'SNS', '写真掲載可否', 'プロフィール写真', '参加人数追加オプション', 'コンセント', '椅子追加',
    '懇親会出欠', '懇親会人数', '二次会出欠', '二次会人数', '協会会員',
    '景品提供', '景品内容', '郵便番号', '住所', '備考・質問',
    'スタッフメモ', '合計金額', '入金確認', '入金日'
  ]);
}

// 管理者へメール通知
function sendAdminEmail(data, calculationResult) {
  const subject = `【出展申込】${data.name}様 (${data.exhibitorName})`;
  const body = `
新しい出展申込がありました。

■ 申込者情報
お名前: ${data.name}
ふりがな: ${data.furigana}
電話番号: ${data.phoneNumber || '-'}
郵便番号: ${data.postalCode || '-'}
ご住所: ${data.address}
メールアドレス: ${data.email}
LINE名: ${data.lineDisplayName || '-'}

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

// 申込者へ確認メール送信
function sendConfirmationEmail(data, calculationResult) {
  // 会員かどうか
  const isMember = data.isMember === '1';
  
  // テンプレート用のデータを準備（フィールド名をテンプレートの期待する形式に変換）
  const formData = {
    'お名前': data.name,
    'ふりがな': data.furigana,
    'ご住所': data.address,
    'メールアドレス': data.email,
    '出展名（セラピスト名／屋号）': data.exhibitorName,
    '出展カテゴリ': data.category,
    '出展ブース': data.boothName,
    '持ち込み物品': data.equipment || '',
    '出展メニュー名': data.menuName,
    '自己紹介': data.selfIntro,
    '一言PR': data.shortPR,
    '写真掲載許可': data.photoPermission,
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
  
  // HTMLテンプレートを読み込み
  const template = HtmlService.createTemplateFromFile('mail_template');
  template.formData = formData;
  template.calculationResult = calculationResult;
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
