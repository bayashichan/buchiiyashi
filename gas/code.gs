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

  // 公式LINE（画像が登録できなかった場合の受け取り窓口）
  OFFICIAL_LINE_URL: 'https://lin.ee/uqhsDx3',
  
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
      
      // 認証コード生成 (4桁数字)
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      
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

    // 指定フォルダ内の画像をスキャンしてリストを返す
    if (action === 'get_folder_images') {
      const folderId = e.parameter.folderId;
      if (!folderId) throw new Error('folderId is required');
      const result = getFolderImagesList(folderId);

      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Drive上の画像をJPEGへ変換してBase64で返す（SNS投稿用）
    // InstagramはJPEGしか受け付けないため、PNGで作った画像を変換する
    if (action === 'get_image_jpeg') {
      const fileId = e.parameter.fileId;
      if (!fileId) throw new Error('fileId is required');
      const result = getImageAsJpegBase64(fileId);

      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 確認サイト参照先の候補フォルダ一覧を返す（管理画面用）
    if (action === 'list_image_folders') {
      const result = listImageFolders();

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
    category: getColIndex(['出展カテゴリ']),
    specialtyGenres: getColIndex(['得意ジャンル']),
    exhibitorName: getColIndex(['出展名']),
    menuName: getColIndex(['出展メニュー']),
    advanceReservation: getColIndex(['事前予約']),
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
        category: getCell(row, idx.category),
        specialtyGenres: getCell(row, idx.specialtyGenres),
        exhibitorName: getCell(row, idx.exhibitorName),
        boothName: getCell(row, idx.boothName),
        menuName: getCell(row, idx.menuName),
        advanceReservation: getCell(row, idx.advanceReservation),
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
      advanceReservation: getColIndex(['事前予約']),
      selfIntro: getColIndex(['自己紹介']),
      shortPR: getColIndex(['一言PR']),
      boothName: getColIndex(['出展ブース']),
      photoUrl: getColIndex(['プロフィール写真']),
      sns: getColIndex(['SNS']),
      specialtyGenres: getColIndex(['得意ジャンル'])
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
        advanceReservation: getCell(row, idx.advanceReservation),
        selfIntro: getCell(row, idx.selfIntro),
        shortPR: getCell(row, idx.shortPR),
        boothName: getCell(row, idx.boothName),
        photoUrl: getCell(row, idx.photoUrl),
        snsLinks: parseSnsLinks(getCell(row, idx.sns)),
        specialtyGenres: getCell(row, idx.specialtyGenres)
      });
    }
    
    return { success: true, exhibitors: exhibitors };
    
  } catch (error) {
    console.error('getExhibitorList error:', error);
    return { success: false, error: error.message, exhibitors: [] };
  }
}


// SNSリンク文字列（"Type: URL\nType: URL" または単純なURL）をパース
// 返り値: [{type, url}, ...] の配列（同一タイプの複数エントリも全て保持）
function parseSnsLinks(str) {
  const result = [];
  if (!str || str === 'なし' || str === '（形式エラー）') return result;

  const lines = str.split('\n');
  lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    // "Type: URL" 形式かチェック
    const colonIdx = line.indexOf(': ');
    if (colonIdx > 0 && !line.startsWith('http')) {
      const type = line.slice(0, colonIdx);
      const url = line.slice(colonIdx + 2);
      if (url) result.push({ type, url });
    } else {
      // URLのみの場合、ドメインからタイプを推定
      const url = line;
      let type = 'HP';
      if (url.includes('instagram.com') || url.includes('instagr.am')) type = 'Instagram';
      else if (url.includes('facebook.com') || url.includes('fb.com')) type = 'Facebook';
      else if (url.includes('ameblo.jp') || url.includes('ameba.jp')) type = 'Ameblo';
      else if (url.includes('note.com') || url.includes('note.mu')) type = 'note';
      else if (url.includes('lin.ee') || url.includes('line.me')) type = '公式LINE';
      else if (url.includes('youtube.com') || url.includes('youtu.be')) type = 'YouTube';
      else if (url.includes('tiktok.com')) type = 'TikTok';
      else if (url.includes('twitter.com') || url.includes('x.com')) type = 'X(Twitter)';
      else if (url.includes('lit.link')) type = 'lit.link';
      else if (url.includes('linktr.ee')) type = 'Linktree';
      result.push({ type, url });
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
    
    // スライド結合アクション
    if (params.action === 'combine_presentations') {
      const { presentationIds, title } = params;
      if (!presentationIds || !Array.isArray(presentationIds)) {
        throw new Error('presentationIds array is required');
      }
      
      const result = combinePresentations(presentationIds, title || '結合されたスライド');
      
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (params.action === 'combine_presentations_init') {
      const result = combinePresentationsInit(params.title || '結合されたスライド', params.sourceId);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    if (params.action === 'combine_presentations_append') {
      const result = combinePresentationsAppend(params.targetId, params.presentationIds);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    if (params.action === 'combine_presentations_cleanup') {
      const result = combinePresentationsCleanup(params.targetId);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // GASプロジェクトの自己更新アクション（管理画面のデプロイボタン）
    if (params.action === 'self_update') {
      const result = selfUpdateFromRepo();
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 申込時自動返信メールの再送アクション（管理画面用）
    if (params.action === 'resend_confirmation_email') {
      const result = resendConfirmationEmails(params.spreadsheetId, params.rowIds, params.testEmail);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 画像アップロード処理
    // 画像の失敗で申込ごと落とさない。Drive保存に失敗しても申込は受け付け、
    // 「画像だけ未登録」であることを管理者・申込者の双方に伝える。
    let profileImageUrl = params.profileImageUrl || ''; // 既存のURLがあればそれを使用
    let imageUploadError = params.imageUploadError || ''; // フロント／Worker側で既に失敗している場合

    if (params.profileImageBase64) {
       // 新しい画像がアップロードされた場合は上書き
       try {
         profileImageUrl = saveImageToDrive(
           params.profileImageBase64,
           params.profileImageMimeType,
           params.profileImageName,
           params.eventName,
           params.name
         );
         imageUploadError = '';
       } catch (imageError) {
         console.error('Image upload failed (continuing without image):', imageError);
         imageUploadError = `Driveへの保存に失敗: ${imageError.message}`;
       }
    }

    // データの整理
    const data = {
      submittedAt: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      ...params,
      profileImageUrl: profileImageUrl,
      imageUploadError: imageUploadError,
      imageUploadOk: !!profileImageUrl
    };
    
    // 料金再計算 (改ざん防止)
    const calculationResult = calculatePrice(data);
    
    // スプレッドシート保存 (二重保存)
    saveToSpreadsheet(data, calculationResult, params.currentSpreadsheetId, params.databaseSpreadsheetId, params.eventName);
    
    // 申込者へ確認メール送信
    sendConfirmationEmail(data, calculationResult);
    
    // 管理者へメール通知
    sendAdminEmail(data, calculationResult);
    
    // imageStatus は申込フォーム側で「公式LINEへ画像を送ってください」の案内を出すために使う
    return ContentService
      .createTextOutput(JSON.stringify({
        success: true,
        totalFee: calculationResult.totalFee,
        imageStatus: data.imageUploadOk ? 'ok' : 'missing',
        imageStatusText: formatImageUploadStatus(data)
      }))
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
        try {
          targetFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        } catch (sharingError) {
          console.warn('Failed to set sharing on folder: ' + sharingError.message);
        }
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
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (sharingError) {
      console.warn('Failed to set sharing on file: ' + sharingError.message);
    }
    
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
  
  // 会員判定
  const isMember = data.isMember === '1';
  
  // ブース料金
  // 会員は早割適用外（通常価格）
  let isEarlyBird = data.isEarlyBird === '1';
  if (isMember) {
    isEarlyBird = false;
  }
  
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

  // 会員割引
  if (isMember) {
    total -= CONFIG.MEMBER_DISCOUNT;
  }
  
  return {
    totalFee: total,
    breakdown: {
      booth: boothPrice,
      staff: extraStaff * CONFIG.UNIT_PRICES.staff,
      chairs: extraChairs * CONFIG.UNIT_PRICES.chair,
      power: data.usePower === '1' ? CONFIG.UNIT_PRICES.power : 0,
      party: partyCount * CONFIG.UNIT_PRICES.party,
      memberDiscount: isMember ? -CONFIG.MEMBER_DISCOUNT : 0
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
    ensureImageStatusHeader(sheet);
    
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
      data.lineDisplayName || '',                  // LINE DisplayName
      data.specialtyGenres || '',                  // 得意ジャンル
      data.advanceReservation || '不可',           // 事前予約
      formatLineLinkStatus(data),                  // LINE連携状態（空欄で届いた原因の切り分け用）
      formatImageUploadStatus(data)                // 画像アップロード状態（未登録なら公式LINEで回収）
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
    ensureImageStatusHeader(sheet);
    
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
      data.lineDisplayName || '',                  // LINE DisplayName
      data.specialtyGenres || '',                  // 得意ジャンル
      data.advanceReservation || '不可',           // 事前予約
      formatLineLinkStatus(data),                  // LINE連携状態（空欄で届いた原因の切り分け用）
      formatImageUploadStatus(data)                // 画像アップロード状態（未登録なら公式LINEで回収）
    ]);
  } catch (e) {
    console.error(`Failed to save to master spreadsheet ${spreadsheetId}:`, e);
  }
}

/**
 * 既存シートに「画像アップロード状態」列の見出しを補う。
 *
 * ヘッダー行は新規シート作成時にしか書かれないため、運用中のシートでは
 * 値だけが入って見出しが空になってしまう。運営が列の意味を追えるようにする。
 */
function ensureImageStatusHeader(sheet) {
  try {
    if (sheet.getLastRow() === 0) return;

    const lastCol = Math.max(sheet.getLastColumn(), 1);
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    if (headers.indexOf('画像アップロード状態') > -1) return;

    // 定位置は「LINE連携状態」の隣。見つからない古いシートは末尾に追加する。
    const lineIdx = headers.indexOf('LINE連携状態');
    const col = lineIdx > -1 ? lineIdx + 2 : lastCol + 1;
    sheet.getRange(1, col).setValue('画像アップロード状態');
  } catch (e) {
    console.warn('Failed to add image status header: ' + e.message);
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
    'スタッフメモ', '合計金額', '入金確認', '入金日', 'LINEユーザーID', 'LINE表示名',
    '得意ジャンル', '事前予約', 'LINE連携状態', '画像アップロード状態'
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
    'スタッフメモ', '合計金額', '入金確認', '入金日', 'LINEユーザーID', 'LINE表示名',
    '得意ジャンル', '事前予約', 'LINE連携状態', '画像アップロード状態'
  ]);
}

/**
 * LINE連携の状態を人が読める文字列にする。
 *
 * 申込フォーム側から lineLinkStatus（linked / unlinked / error）が送られてくる。
 * LINEユーザーIDが空で届いたとき、それがどの段階で失敗したのかを後から追えるようにする。
 */
function formatLineLinkStatus(data) {
  if (data.lineUserId) return '連携済み';

  const status = data.lineLinkStatus || '不明';
  const detail = data.lineLinkError ? `: ${data.lineLinkError}` : '';

  if (status === 'unlinked') return '未連携（LINE未ログイン）';
  if (status === 'error') return `未連携（取得エラー${detail}）`;
  return `未連携（${status}${detail}）`;
}

/**
 * 画像アップロードの状態を人が読める文字列にする。
 *
 * 画像が登録できていない申込は、後から公式LINEで写真を受け取る必要がある。
 * どの申込に対応が必要かをシート・メールから一目で分かるようにする。
 */
function formatImageUploadStatus(data) {
  if (data.profileImageUrl) return '登録済み';

  // 失敗理由にはスタックトレースが混ざることがある。
  // シートやメールに流し込むので1行に潰し、長すぎるものは切り詰める（詳細は実行ログに残る）。
  let reason = '';
  if (data.imageUploadError) {
    const oneLine = String(data.imageUploadError).replace(/\s+/g, ' ').trim();
    reason = `: ${oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine}`;
  }
  return `未登録（要LINE回収${reason}）`;
}

// 管理者へメール通知（HTMLメール）
function sendAdminEmail(data, calculationResult) {
  // LINE情報が取れていない申込は件名で分かるようにする（後追いの案内が必要なため）
  const linkPrefix = data.lineUserId ? '' : '【LINE未連携】';
  // 画像が登録できなかった申込も件名で分かるようにする（公式LINEで写真を受け取る必要があるため）
  const imagePrefix = data.profileImageUrl ? '' : '【画像未登録】';
  const subject = `${imagePrefix}${linkPrefix}【出展申込】${data.name}様 (${data.exhibitorName})`;
  
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
得意ジャンル: ${data.specialtyGenres || '未選択'}
ブース: ${data.boothName}
持ち込み物品: ${data.equipment || 'なし'}
出展メニュー名:
${data.menuName}
事前予約: ${data.advanceReservation || '不可'}
自己紹介:
${data.selfIntro}
一言PR: ${data.shortPR}
写真掲載許可: ${data.photoPermission}

■ カタログ掲載画像
状態: ${formatImageUploadStatus(data)}
${data.profileImageUrl
  ? `画像URL: ${data.profileImageUrl}`
  : `※画像が登録できていません。申込者には「公式LINEへ出展名を添えて画像を送ってください」と案内済みです。
　 届かない場合はこちらから催促してください（出展名: ${data.exhibitorName}）。`}

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
  template.imageStatusText = formatImageUploadStatus(data);
  
  // 料金内訳の表示用リスト作成
  const breakdownList = [
    { item: '出展ブース料', price: calculationResult.breakdown.booth },
    { item: '追加スタッフ (×' + (data.extraStaff || 0) + ')', price: calculationResult.breakdown.staff },
    { item: '追加椅子 (×' + (data.extraChairs || 0) + ')', price: calculationResult.breakdown.chairs },
    { item: '電源使用料', price: calculationResult.breakdown.power },
    { item: '懇親会費 (×' + (data.partyCount || 0) + ')', price: calculationResult.breakdown.party },
    { item: '会員様特別割引', price: calculationResult.breakdown.memberDiscount || 0 }
  ].filter(item => item.price !== 0);

  template.breakdownList = breakdownList;
  template.isMember = data.isMember === '1';

  const htmlBody = template.evaluate().getContent();
  
  GmailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, textBody, {
    name: 'ぶち癒やしフェスタin東京事務局',
    htmlBody: htmlBody
  });
}

/**
 * 申込者へ確認メールを送る。
 *
 * recipientOverride は管理画面からのテスト再送用。指定した場合も本文はそのままに、
 * 宛先だけを差し替える（申込者に届かない状態で内容を確認できるようにする）。
 */
function sendConfirmationEmail(data, calculationResult, recipientOverride) {
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
    '得意ジャンル': data.specialtyGenres || '',
    '出展ブース': data.boothName,
    '持ち込み物品': data.equipment || '',
    '出展メニュー名': data.menuName,
    '事前予約': data.advanceReservation || '不可',
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
    { item: '懇親会費 (×' + (data.partyCount || 0) + ')', price: calculationResult.breakdown.party },
    { item: '会員様特別割引', price: calculationResult.breakdown.memberDiscount || 0 }
  ].filter(item => item.price !== 0);

  // HTMLテンプレートを読み込み
  const template = HtmlService.createTemplateFromFile('mail_template');
  template.formData = formData;
  template.calculationResult = calculationResult;
  template.breakdownList = breakdownList; // 追加
  template.isMember = isMember;
  template.CONFIG = CONFIG;
  // 画像が登録できなかった場合、公式LINEでの送付をお願いする案内を出す
  template.imageUploadOk = !!data.profileImageUrl;
  template.exhibitorName = data.exhibitorName || '';
  
  // HTMLを評価
  const htmlBody = template.evaluate().getContent();
  
  // テキスト版（HTMLが表示できないクライアント用）
  let memberMessage = '';
  if (isMember) {
    memberMessage = '\n※アーキエンジェルハピネス協会会員様は早割適用外となりますが、会員様特別割引（-2,000円）を適用しております。\n';
  }

  // 画像が登録できなかった場合の案内（公式LINEへ出展名を添えて送っていただく）
  let imageMessage = '';
  if (!data.profileImageUrl) {
    imageMessage = `
━━━━━━━━━━━━━━━━━━━━
⚠️ お写真のご送付のお願い
━━━━━━━━━━━━━━━━━━━━
システムの不具合により、プロフィールのお写真のみ登録できておりません。
お申し込み自体は正常に受け付けておりますのでご安心ください。

お手数ですが、お写真は下記の公式LINEへ直接お送りください。
${CONFIG.OFFICIAL_LINE_URL}

★その際、必ず下記の出展名をお書き添えください。
　出展名: ${data.exhibitorName}
━━━━━━━━━━━━━━━━━━━━
`;
  }

  const textBody = `
${data.name} 様

この度は「ぶち癒やしフェスタin東京」へのお申し込み、誠にありがとうございます。
以下の内容でお申し込みを受け付けました。
${imageMessage}
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
${memberMessage}
詳細はHTML版メールをご確認ください。

-----
ぶち癒やしフェスタin東京 事務局
Email: ${CONFIG.REPLY_TO_EMAIL}
  `.trim();
  
  // メール送信
  const subject = `【ぶち癒やしフェスタin東京】お申し込みありがとうございます`;
  
  const recipient = recipientOverride || data.email;

  GmailApp.sendEmail(recipient, subject, textBody, {
    name: 'ぶち癒やしフェスタin東京事務局',
    replyTo: CONFIG.REPLY_TO_EMAIL,
    htmlBody: htmlBody
  });
}

// ========================================
// 確認メールの再送（管理画面用）
// ========================================

// 1回のリクエストで再送できる上限。doPost のロックを長時間握らないための保険。
const RESEND_MAX_PER_REQUEST = 20;

/**
 * スプレッドシートの申込行をもとに、申込時と同じ確認メールを再送する。
 *
 * 申込フォームから届いた生データは残っていないため、シートに保存された内容から
 * data / calculationResult を組み立て直して sendConfirmationEmail に渡す。
 *
 * @param {string} spreadsheetId 対象スプレッドシートID（省略時は CONFIG.SPREADSHEET_ID）
 * @param {Array<number>} rowIds getExhibitorList が返す id（＝シートの行インデックス）
 * @param {string} testEmail 指定するとこのアドレスへ送る（申込者には届かない）
 * @return {{success: boolean, results: Array}}
 */
function resendConfirmationEmails(spreadsheetId, rowIds, testEmail) {
  try {
    const targets = (rowIds || [])
      .map(id => parseInt(id, 10))
      .filter(id => Number.isFinite(id) && id > 0);

    if (targets.length === 0) {
      return { success: false, error: '再送する出展者が選択されていません', results: [] };
    }
    if (targets.length > RESEND_MAX_PER_REQUEST) {
      return {
        success: false,
        error: `一度に再送できるのは${RESEND_MAX_PER_REQUEST}件までです（${targets.length}件が指定されました）`,
        results: []
      };
    }

    const override = String(testEmail || '').trim();
    if (override && !isValidEmail(override)) {
      return { success: false, error: `テスト送信先のメールアドレスが正しくありません: ${override}`, results: [] };
    }

    // 送信途中で日次上限に当たると「一部だけ届いた」状態になるため、先に残数を確認する
    let remainingQuota = null;
    try {
      remainingQuota = MailApp.getRemainingDailyQuota();
    } catch (quotaError) {
      console.warn('Failed to read mail quota: ' + quotaError.message);
    }
    if (remainingQuota !== null && remainingQuota < targets.length) {
      return {
        success: false,
        error: `本日の送信可能数が足りません（残り${remainingQuota}件 / 再送${targets.length}件）。時間をおいて再度お試しください。`,
        results: []
      };
    }

    const ss = SpreadsheetApp.openById(spreadsheetId || CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) {
      return { success: false, error: 'シートが見つかりません', results: [] };
    }

    // 表示どおりの文字列で扱う（郵便番号の先頭0や日時の書式をそのまま再現するため）
    const values = sheet.getDataRange().getDisplayValues();
    if (values.length <= 1) {
      return { success: false, error: '申込データがありません', results: [] };
    }

    const headers = values[0].map(h => String(h).trim());
    const results = [];

    targets.forEach(rowId => {
      let exhibitorName = '';
      try {
        if (rowId >= values.length) {
          throw new Error('該当する申込データが見つかりません（一覧を読み込み直してください）');
        }

        const data = buildApplicationDataFromRow(headers, values[rowId]);
        exhibitorName = data.exhibitorName || data.name || `${rowId}行目`;

        if (!data.email) {
          throw new Error('メールアドレスが登録されていません');
        }
        if (!override && !isValidEmail(data.email)) {
          throw new Error(`メールアドレスの形式が正しくありません: ${data.email}`);
        }

        // ブース名が定義と一致しないと boothId を復元できず、確認メール側の料金計算が
        // "Invalid Booth ID" で落ちる。どの行のどのブース名が問題なのかを分かるようにする。
        if (!data.boothId) {
          throw new Error(`出展ブース「${data.boothName || '（空欄）'}」がブース定義（CONFIG.BOOTHS）と一致しません`);
        }

        const calculationResult = rebuildCalculationResult(data);
        const recipient = override || data.email;
        sendConfirmationEmail(data, calculationResult, recipient);

        results.push({
          rowId: rowId,
          exhibitorName: exhibitorName,
          registeredEmail: data.email,
          sentTo: recipient,
          isTest: !!override,
          success: true
        });
      } catch (rowError) {
        console.error(`Resend failed for row ${rowId}:`, rowError);
        results.push({
          rowId: rowId,
          exhibitorName: exhibitorName,
          success: false,
          error: rowError.message
        });
      }
    });

    return {
      success: true,
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results: results
    };

  } catch (error) {
    console.error('resendConfirmationEmails error:', error);
    return { success: false, error: error.message, results: [] };
  }
}

/**
 * シート1行分の値を、申込フォームから届く data と同じ形に戻す。
 *
 * 列の並びはイベント用（座席番号あり）とマスターDB用（開催回あり）で異なるので、
 * 位置ではなく見出し名で引く。
 */
function buildApplicationDataFromRow(headers, row) {
  const cell = (name) => {
    const idx = headers.indexOf(name);
    if (idx < 0 || idx >= row.length) return '';
    const val = row[idx];
    return val !== undefined && val !== null ? String(val).trim() : '';
  };

  // 「あり」「はい」といった保存済みの表示文字列を、フォームが送ってくる '1' / '0' に戻す
  const flag = (name, trueLabel) => cell(name) === trueLabel ? '1' : '0';

  const data = {
    submittedAt: cell('申込日時'),
    name: cell('氏名'),
    furigana: cell('フリガナ'),
    email: cell('メールアドレス'),
    phoneNumber: cell('電話番号'),
    postalCode: cell('郵便番号'),
    address: cell('住所'),
    isMember: flag('協会会員', 'はい'),
    category: cell('出展カテゴリ'),
    exhibitorName: cell('出展名'),
    specialtyGenres: cell('得意ジャンル'),
    // 申込フォームは boothId を送ってくるが、シートにはブース名しか残っていない。
    // 申込時と同じ形で渡せるよう、ブース定義から逆引きする。
    boothId: findBoothIdByName(cell('出展ブース')),
    boothName: cell('出展ブース'),
    equipment: cell('ボディーブース持ち込み物品'),
    menuName: cell('出展メニュー'),
    advanceReservation: cell('事前予約') || '不可',
    selfIntro: cell('自己紹介'),
    shortPR: cell('一言PR'),
    photoPermission: cell('写真掲載可否'),
    profileImageUrl: cell('プロフィール写真'),
    // シートには "Instagram: https://..." の形で入っているので、
    // sendConfirmationEmail が期待するJSON文字列へ戻す
    snsLinks: JSON.stringify(parseSnsLinks(cell('SNS'))),
    extraStaff: toNumber(cell('参加人数追加オプション')),
    extraChairs: toNumber(cell('椅子追加')),
    usePower: flag('コンセント', 'あり'),
    stampRallyPrize: cell('景品提供') || 'ない',
    prizeContent: cell('景品内容'),
    partyAttend: cell('懇親会出欠') || '欠席',
    partyCount: toNumber(cell('懇親会人数')),
    secondaryPartyAttend: cell('二次会出欠') || '欠席',
    secondaryPartyCount: toNumber(cell('二次会人数')),
    notes: cell('備考・質問'),
    lineUserId: cell('LINEユーザーID'),
    lineDisplayName: cell('LINE表示名'),
    recordedTotalFee: toNumber(cell('合計金額'))
  };

  // 早割の適用有無も保存されていないため、逆算したブース料が早割価格と一致するかで判定する
  data.isEarlyBird = inferEarlyBird(data) ? '1' : '0';

  return data;
}

/**
 * 再送用に料金内訳を組み立て直す。
 */
function rebuildCalculationResult(data) {
  const options = buildOptionFees(data);
  const boothFee = deriveBoothFee(data);

  return {
    totalFee: boothFee + options.total,
    breakdown: {
      booth: boothFee,
      staff: options.staff,
      chairs: options.chairs,
      power: options.power,
      party: options.party,
      memberDiscount: options.memberDiscount
    }
  };
}

// シートに残っている項目だけでオプション料金を積み直す
function buildOptionFees(data) {
  const staff = (parseInt(data.extraStaff || 0, 10) || 0) * CONFIG.UNIT_PRICES.staff;
  const chairs = (parseInt(data.extraChairs || 0, 10) || 0) * CONFIG.UNIT_PRICES.chair;
  const power = data.usePower === '1' ? CONFIG.UNIT_PRICES.power : 0;
  const party = (parseInt(data.partyCount || 0, 10) || 0) * CONFIG.UNIT_PRICES.party;
  const memberDiscount = data.isMember === '1' ? -CONFIG.MEMBER_DISCOUNT : 0;

  return {
    staff: staff,
    chairs: chairs,
    power: power,
    party: party,
    memberDiscount: memberDiscount,
    total: staff + chairs + power + party + memberDiscount
  };
}

/**
 * ブース料を求める。
 *
 * 早割の適用有無は保存されていないため、確定額であるシートの合計金額を正とし、
 * 「合計 − オプション計」で逆算する。こうすると申込時に案内した金額と必ず一致する。
 * 合計金額が空の行（手入力の行など）だけ、ブース定義の通常価格にフォールバックする。
 */
function deriveBoothFee(data) {
  const recordedTotalFee = parseInt(data.recordedTotalFee || 0, 10) || 0;
  if (recordedTotalFee > 0) {
    return recordedTotalFee - buildOptionFees(data).total;
  }

  const booth = CONFIG.BOOTHS[data.boothId];
  return booth ? booth.regular : 0;
}

/**
 * 早割が適用されていたかを、逆算したブース料から判定する。
 *
 * 会員は早割適用外（calculatePrice と同じ扱い）。早割価格と通常価格が同額のブースは
 * どちらでも結果が変わらないため false を返す。
 */
function inferEarlyBird(data) {
  const booth = CONFIG.BOOTHS[data.boothId];
  if (!booth) return false;
  if (data.isMember === '1') return false;
  if (booth.earlyBird === booth.regular) return false;

  return deriveBoothFee(data) === booth.earlyBird;
}

// ブース名（シートに保存されている表示名）からブースIDを逆引きする。見つからなければ空文字。
function findBoothIdByName(boothName) {
  const target = String(boothName || '').trim();
  if (!target) return '';

  for (const key in CONFIG.BOOTHS) {
    if (CONFIG.BOOTHS[key].name === target) return key;
  }
  return '';
}

// "¥30,000" や "3,000円" のような表示文字列から数値を取り出す
function toNumber(value) {
  const num = parseInt(String(value || '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(num) ? num : 0;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
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
 * @param {Object} options - オプション { keepSlide: boolean }
 * @returns {Object} 結果 { success, imageUrl, error, presentationUrl }
 */
function generateExhibitorImage(templateId, exhibitorData, imageType, options = {}) {
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
    
    // 8. 一時ファイルを削除（オプションで残す場合を除く）
    if (!options.keepSlide) {
      copiedFile.setTrashed(true);
    }
    
    return {
      success: true,
      imageUrl: imageFile.getUrl(),
      imageId: imageFile.getId(),
      downloadUrl: `https://lh3.googleusercontent.com/d/${imageFile.getId()}`,
      presentationUrl: `https://docs.google.com/presentation/d/${copiedId}/edit` // スライドURLを返す
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
 * {{プロフィール画像}}という代替テキストを持つ画像、またはテキストを持つ図形を実際の写真に置換
 */
function insertProfileImageInSlide(slide, photoUrl) {
  try {
    // 置換用の画像Blobを取得
    let imageBlob;
    if (photoUrl.includes('drive.google.com') || photoUrl.includes('lh3.googleusercontent.com')) {
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
    
    if (!imageBlob) return;
    
    let targetElement = null;

    // 1. 画像の「代替テキスト（タイトルまたは説明）」を検索
    const images = slide.getImages();
    for (const img of images) {
      const title = img.getTitle() || '';
      const desc = img.getDescription() || '';
      if (title.includes('{{プロフィール画像}}') || desc.includes('{{プロフィール画像}}')) {
        targetElement = img;
        break;
      }
    }

    // 2. 見つからなければ、図形内のテキスト「{{プロフィール画像}}」を検索
    if (!targetElement) {
      const shapes = slide.getShapes();
      for (const shape of shapes) {
        if (shape.getText) {
          const text = shape.getText().asString();
          if (text.includes('{{プロフィール画像}}')) {
            targetElement = shape;
            break;
          }
        }
      }
    }

    // ターゲットが見つかれば置換する
    if (targetElement) {
      // Image要素の場合は replace() を使って角丸などの書式を保持したまま中身だけ差し替える
      if (targetElement.getPageElementType && 
          targetElement.getPageElementType() === SlidesApp.PageElementType.IMAGE) {
        // ★ replace(blob, true) で角丸等の書式を保持しつつ、縦横比を維持してトリミング
        targetElement.replace(imageBlob, true);
      } else {
        // テキストボックス(図形)の場合は従来どおりremove+insert
        const left = targetElement.getLeft();
        const top = targetElement.getTop();
        const width = targetElement.getWidth();
        const height = targetElement.getHeight();
        
        targetElement.remove();
        const newImage = slide.insertImage(imageBlob, left, top, width, height);
        newImage.setTitle('{{プロフィール画像}}');
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
function generateBatchImages(templateId, exhibitorIds, imageType, spreadsheetId, options = {}) {
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
    const result = generateExhibitorImage(templateId, exhibitor, imageType, options);
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
認証コード: ${code}

ぶち癒しフェスタ東京 出展申込フォームをご利用いただきありがとうございます。

上記の認証コードを入力して、手続きを進めてください。

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

/**
 * ★診断用★ SlidesApp動作確認テスト
 * この関数を実行して、スライド作成権限を承認してください
 */
function testSlidesAccess() {
  console.log('=== SlidesApp診断テスト開始 ===');
  try {
    const pres = SlidesApp.create('【テスト】権限確認用スライド');
    console.log('✅ スライド作成成功 ID: ' + pres.getId());
    
    // 作成したゴミファイルを削除（DriveApp権限も確認）
    const file = DriveApp.getFileById(pres.getId());
    file.setTrashed(true);
    console.log('✅ テスト用スライドを削除しました');
    
    return '成功';
  } catch (e) {
    console.error('❌ エラー: ' + e.message);
    throw e;
  }
}

// ========================================
// スライド結合機能
// ========================================

/**
 * 複数のスライドプレゼンテーションを1つに結合
 * @param {string[]} presentationIds 
 * @param {string} title 
 */
function combinePresentations(presentationIds, title) {
  try {
    const combined = SlidesApp.create(title);
    const combinedId = combined.getId();
    const slideToKeep = combined.getSlides()[0]; // 作成時に自動生成される空白スライド
    
    let successCount = 0;
    for (const id of presentationIds) {
      if (!id) continue;
      try {
        const sourcePres = SlidesApp.openById(id);
        const sourceSlides = sourcePres.getSlides();
        if (sourceSlides.length > 0) {
          combined.appendSlide(sourceSlides[0]);
          successCount++;
        }
      } catch (err) {
        console.error(`Failed to copy slide from ${id}:`, err);
      }
    }
    
    // 最初の空スライドを削除（ただし追加が成功した場合のみ）
    if (successCount > 0 && slideToKeep) {
      slideToKeep.remove();
    }
    
    combined.saveAndClose();
    
    // フォルダ移動と共有設定（リンクを知っている全員が閲覧可能）
    try {
      const file = DriveApp.getFileById(combinedId);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      
      // SNS画像フォルダに移動
      const rootFolder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      const folderName = 'SNS画像';
      let targetFolder;
      const folders = rootFolder.getFoldersByName(folderName);
      if (folders.hasNext()) {
        targetFolder = folders.next();
      } else {
        targetFolder = rootFolder.createFolder(folderName);
        targetFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }
      file.moveTo(targetFolder);
    } catch (e) {
      console.warn('Failed to move/share combined file (it may still exist in root):', e);
    }
    
    return {
      success: true,
      presentationId: combinedId,
      presentationUrl: `https://docs.google.com/presentation/d/${combinedId}/edit`,
      count: successCount
    };
  } catch (error) {
    console.error('combinePresentations error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 結合用の空スライドを作成して初期化
 */
function combinePresentationsInit(title, sourceId) {
  try {
    let combinedId;
    
    if (sourceId) {
      // テンプレートの縦横比を維持するためにコピーを作成
      const sourceFile = DriveApp.getFileById(sourceId);
      const newFile = sourceFile.makeCopy(title);
      combinedId = newFile.getId();
      
      const combined = SlidesApp.openById(combinedId);
      const slides = combined.getSlides();
      
      // 空白の仮スライドを追加し、元からあったスライドを全て削除
      // combinePresentationsCleanup() でこの最初の空スライドが削除される
      combined.appendSlide(SlidesApp.PredefinedLayout.BLANK);
      for (const slide of slides) {
        slide.remove();
      }
      combined.saveAndClose();
    } else {
      const combined = SlidesApp.create(title);
      combinedId = combined.getId();
    }
    
    // フォルダ移動と共有設定
    try {
      const file = DriveApp.getFileById(combinedId);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      
      const rootFolder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      const folderName = 'SNS画像';
      let targetFolder;
      const folders = rootFolder.getFoldersByName(folderName);
      if (folders.hasNext()) {
        targetFolder = folders.next();
      } else {
        targetFolder = rootFolder.createFolder(folderName);
        targetFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      }
      file.moveTo(targetFolder);
    } catch (e) {
      console.warn('Failed to move/share combined file', e);
    }
    
    return {
      success: true,
      presentationId: combinedId,
      presentationUrl: `https://docs.google.com/presentation/d/${combinedId}/edit`
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 結合用スライドに既存のスライドを追加
 */
function combinePresentationsAppend(targetId, presentationIds) {
  try {
    const combined = SlidesApp.openById(targetId);
    let successCount = 0;
    
    for (const id of presentationIds) {
      if (!id) continue;
      try {
        const sourcePres = SlidesApp.openById(id);
        const sourceSlides = sourcePres.getSlides();
        if (sourceSlides.length > 0) {
          combined.appendSlide(sourceSlides[0]);
          successCount++;
        }
      } catch (err) {
        console.error(`Failed to copy slide from ${id}:`, err);
      }
    }
    
    combined.saveAndClose();
    return { success: true, count: successCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 最終クリーンアップ（最初の空スライドを削除）
 */
function combinePresentationsCleanup(targetId) {
  try {
    const combined = SlidesApp.openById(targetId);
    const slides = combined.getSlides();
    if (slides.length > 1) {
      slides[0].remove(); // 最初の空スライドを削除
    }
    combined.saveAndClose();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
/**
 * 指定されたフォルダ内の画像をスキャンして、正規化されたファイル名とIDのマップを返す
 * ファイル名が「番号_出展名.jpg」形式（例: 12_ぶち工房.jpg）の場合は、
 * 先頭の連番を除いた「出展名」でも照合できるよう別名キーも登録する。
 */
function getFolderImagesList(folderId) {
  try {
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFiles();
    const imageMap = {};
    const aliasMap = {}; // 連番を除いた別名キー（実ファイル名の一致を優先するため後でマージ）

    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();

      // 拡張子を除去
      const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");

      // 正規化（記号・スペースを除去して小文字化）
      const normalized = normalizeName(nameWithoutExt);

      // 「番号_出展名」形式なら連番部分を除いたキーも作る
      const strippedName = stripLeadingNumber(nameWithoutExt);
      const normalizedStripped = strippedName ? normalizeName(strippedName) : "";

      if (normalized || normalizedStripped) {
        // ファイルの共有設定を確認し、必要なら「リンクを知っている全員が閲覧可能」にする
        try {
          if (file.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK) {
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          }
        } catch (e) {
          console.warn('Failed to set sharing for ' + fileName);
        }

        if (normalized) {
          imageMap[normalized] = file.getId();
        }
        if (normalizedStripped && normalizedStripped !== normalized && !aliasMap[normalizedStripped]) {
          aliasMap[normalizedStripped] = file.getId();
        }
      }
    }

    // 別名キーは、同名の正規キーが無い場合のみ採用する
    Object.keys(aliasMap).forEach(function (key) {
      if (!imageMap[key]) imageMap[key] = aliasMap[key];
    });

    return { success: true, images: imageMap };
  } catch (error) {
    console.error('getFolderImagesList error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * ファイル名の先頭に付いた連番（「12_」「3-」「01. 」など）を取り除く
 * 区切り文字が無い場合（例:「3期生ぶち工房」）は連番と判断せずそのまま返さない。
 * ※ この関数は worker/src/index.js の stripLeadingNumber と必ず一致させること
 */
function stripLeadingNumber(name) {
  if (!name) return "";
  const matched = String(name).match(/^[\s　]*[0-9０-９]+[\s　]*[_＿\-ー－–—.．・,、:：)）\]】][\s　]*(.+)$/);
  return matched ? matched[1] : "";
}

/**
 * Drive上の画像をJPEGに変換してBase64で返す
 * SNS投稿（Instagram）はJPEGのみ対応のため、PNG等はここで変換する。
 */
function getImageAsJpegBase64(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    let blob = file.getBlob();

    if (blob.getContentType() !== 'image/jpeg') {
      blob = blob.getAs('image/jpeg');
    }

    return {
      success: true,
      mimeType: 'image/jpeg',
      base64: Utilities.base64Encode(blob.getBytes())
    };
  } catch (error) {
    console.error('getImageAsJpegBase64 error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 確認サイトの参照先候補フォルダ一覧を返す（管理画面用）
 * 画像保存ルート(CONFIG.DRIVE_FOLDER_ID)直下のサブフォルダを列挙し、
 * 各フォルダ内の画像枚数と最終更新日時も返す。
 * 管理者が「どのフォルダを確認ページで参照するか」をIDの手入力なしで選べるようにする。
 */
function listImageFolders() {
  try {
    const root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
    const folders = root.getFolders();
    const list = [];

    while (folders.hasNext()) {
      const folder = folders.next();

      // フォルダ直下の画像ファイル数をカウント
      let imageCount = 0;
      const files = folder.getFiles();
      while (files.hasNext()) {
        const mime = files.next().getMimeType();
        if (mime && mime.indexOf('image/') === 0) imageCount++;
      }

      list.push({
        id: folder.getId(),
        name: folder.getName(),
        imageCount: imageCount,
        updated: folder.getLastUpdated().getTime()
      });
    }

    // 最終更新日時の新しい順に並べる
    list.sort(function (a, b) { return b.updated - a.updated; });

    return { success: true, folders: list, rootId: CONFIG.DRIVE_FOLDER_ID };
  } catch (error) {
    console.error('listImageFolders error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 照合用の正規化関数
 * スペース（全角半角）、ハイフン、アンダースコア、ドット、その他記号を除去
 * ファイル名に使えない記号（/ \ : * ? " < > |）は画像保存時に除去または「_」へ
 * 置換されるため、出展名側・ファイル名側の双方から取り除いてキーを一致させる。
 */
function normalizeName(name) {
  if (!name) return "";
  return String(name)
    .normalize('NFC') // Unicode正規化を追加（濁点・半濁点の差異を吸収）
    .replace(/[ 　\-_.\(\)（）!！?？｜|\/／\\＼:：*＊"＂”<＜>＞]/g, "") // 一般的な記号・スペース＋ファイル名禁止文字を削除
    .toLowerCase();
  // ※ この正規表現は worker/src/index.js の出展名正規化と必ず一致させること
}

// ========================================
// GASプロジェクトの自己更新（デプロイ）
// ========================================

/**
 * このスクリプト自身を、GitHub上の gas/ の内容へ更新する。
 *
 * サービスアカウントではApps Script APIの書き込みができない。アカウントごとの
 * 有効化設定（script.google.com/home/usersettings）を持てないためで、読み取りは
 * 通るのに書き込みだけが403になる。スクリプト自身のトークンなら所有アカウントの
 * 権限で動くので、更新をGAS側で行う。
 *
 * 取得元はこのリポジトリのmainに固定している。外部からコードを受け取らないので、
 * このエンドポイントを誰が呼んでも、公開済みのリポジトリの内容が反映されるだけになる。
 */
const SELF_UPDATE_RAW_BASE = 'https://raw.githubusercontent.com/bayashichan/buchiiyashi/main/';

/**
 * 反映対象のファイル。
 *
 * appsscript.json は意図的に含めない。マニフェストはWebアプリの公開設定
 * （誰がアクセスできるか）を持っており、リポジトリのコピーにはそれが無い。
 * 上書きすると公開URLが機能しなくなる。
 */
const SELF_UPDATE_FILES = [
  { path: 'gas/code.gs', name: 'code', type: 'SERVER_JS' },
  { path: 'gas/mail_template.html', name: 'mail_template', type: 'HTML' },
  { path: 'gas/admin_mail_template.html', name: 'admin_mail_template', type: 'HTML' }
];

/**
 * リポジトリの内容をこのプロジェクトへ反映し、Webアプリを更新する。
 *
 * エディタから直接実行してもよい（初回の承認はこの関数を実行して行う）。
 * @return {Object} 反映結果
 */
function selfUpdateFromRepo() {
  const scriptId = ScriptApp.getScriptId();
  const token = ScriptApp.getOAuthToken();

  // 1. リポジトリの最新を取得
  const repoFiles = SELF_UPDATE_FILES.map(file => ({
    name: file.name,
    type: file.type,
    source: fetchRepoSource(file.path)
  }));

  // 2. 現在の内容
  const current = scriptApi(token, `projects/${scriptId}/content`);
  const currentFiles = current.files || [];

  // 3. 差分。何が上書きされるのかを管理画面に返すため
  const changedFiles = repoFiles.filter(file => {
    const currentFile = currentFiles.filter(f => f.name === file.name)[0];
    return normalizeSource(currentFile && currentFile.source) !== normalizeSource(file.source);
  }).map(file => file.name);

  // Apps Script側にしか無いファイル（エディタで直接追加されたもの）は消さずに残す
  const keptFiles = currentFiles.filter(f => !repoFiles.some(r => r.name === f.name));

  let backupVersion = null;

  if (changedFiles.length > 0) {
    // 4. 上書きの前に、いまのコードをバージョンとして退避する。
    //    エディタで直接直した内容が入っていても、ここから復元できる。
    backupVersion = createScriptVersion(token, scriptId, '上書き前の自動バックアップ');

    // 5. 内容を差し替え
    scriptApi(token, `projects/${scriptId}/content`, 'put', {
      files: repoFiles.concat(keptFiles)
    });
  }

  // 6. 新しいバージョンを作成
  const versionNumber = createScriptVersion(token, scriptId, '管理画面からデプロイ');

  // 7. 既存のデプロイを新しいバージョンへ向ける（/exec のURLは変わらない）
  const deployments = updateScriptDeployments(token, scriptId, versionNumber);

  return {
    success: true,
    changedFiles: changedFiles,
    versionNumber: versionNumber,
    backupVersion: backupVersion,
    deployments: deployments,
    message: changedFiles.length > 0
      ? `${changedFiles.join(', ')} を更新し、バージョン${versionNumber}として公開しました`
      : `コードに変更はありませんでした。バージョン${versionNumber}として公開し直しました`
  };
}

/**
 * リポジトリからファイルの中身を取得する。
 *
 * 壊れた内容で自分を上書きすると、この関数ごと失われて元に戻せなくなる。
 * 取得できた内容が妥当かどうかを、書き込む前に確認する。
 */
function fetchRepoSource(path) {
  // rawはCDNキャッシュが効くため、毎回異なるURLにして最新を取りに行く
  const url = `${SELF_UPDATE_RAW_BASE}${path}?_=${Date.now()}`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error(`GitHubからの取得に失敗しました (${path}): ${response.getResponseCode()}`);
  }

  const source = response.getContentText();
  if (!source || source.length < 500) {
    throw new Error(`取得した内容が短すぎます (${path}): ${source.length}文字`);
  }
  // 通信途中で切れた内容で上書きしないよう、要となる記述が含まれているか確かめる
  if (path === 'gas/code.gs' && source.indexOf('function selfUpdateFromRepo') < 0) {
    throw new Error('取得したcode.gsに selfUpdateFromRepo が含まれていません。中断します');
  }

  return source;
}

// Apps Script API 呼び出しの共通処理
function scriptApi(token, path, method, body) {
  const options = {
    method: method || 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }

  const response = UrlFetchApp.fetch(`https://script.googleapis.com/v1/${path}`, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(`Apps Script API ${options.method.toUpperCase()} ${path} が失敗しました: ${code} ${text}`);
  }
  return JSON.parse(text);
}

// 新しいバージョンを作成して、そのバージョン番号を返す
function createScriptVersion(token, scriptId, description) {
  const version = scriptApi(token, `projects/${scriptId}/versions`, 'post', {
    description: `${description}: ${new Date().toISOString()}`
  });
  return version.versionNumber;
}

/**
 * 既存のデプロイを新しいバージョンへ向ける。
 *
 * 既存のデプロイを更新するので /exec のURLは変わらない。
 * バージョンを持たないHEAD（テスト用）デプロイは常に最新コードを返すため触らない。
 */
function updateScriptDeployments(token, scriptId, versionNumber) {
  const list = scriptApi(token, `projects/${scriptId}/deployments`);
  const results = [];

  (list.deployments || []).forEach(deployment => {
    const config = deployment.deploymentConfig || {};
    if (config.versionNumber === undefined || config.versionNumber === null) return;

    try {
      scriptApi(token, `projects/${scriptId}/deployments/${deployment.deploymentId}`, 'put', {
        deploymentConfig: {
          scriptId: scriptId,
          versionNumber: versionNumber,
          manifestFileName: config.manifestFileName || 'appsscript',
          description: config.description || ''
        }
      });
      results.push({ deploymentId: deployment.deploymentId, updated: true });
    } catch (error) {
      // 1つ失敗しても他のデプロイの更新は続ける。結果は管理画面に出す
      console.error(`Failed to update deployment ${deployment.deploymentId}:`, error);
      results.push({ deploymentId: deployment.deploymentId, updated: false, error: error.message });
    }
  });

  return results;
}

// 改行コードと末尾の空白の違いは差分とみなさない（Apps Script側で正規化されるため）
function normalizeSource(source) {
  return String(source || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}
