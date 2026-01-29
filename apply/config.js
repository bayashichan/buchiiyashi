/**
 * ぶち癒しフェスタ東京 設定ファイル
 * config.json から動的に読み込み
 */

// グローバル設定オブジェクト
let CONFIG = null;

// 設定を読み込む
async function loadConfig() {
  try {
    const response = await fetch(`./config.json?t=${new Date().getTime()}`);
    if (!response.ok) {
      throw new Error('Failed to load config.json');
    }
    CONFIG = await response.json();
    console.log('Config loaded:', CONFIG);
    return CONFIG;
  } catch (error) {
    console.error('Config load error:', error);
    // フォールバック: デフォルト設定
    CONFIG = getDefaultConfig();
    return CONFIG;
  }
}

// デフォルト設定（フォールバック用）
function getDefaultConfig() {
  return {
    eventName: "第5回ぶち癒しフェスタin東京",
    eventDate: "",
    eventLocation: "",
    earlyBirdDeadline: "2025-10-31 23:59:59",
    memberDiscount: 2000,
    unitPrices: {
      chair: 100,
      power: 500,
      staff: 1000,
      party: 5000,
      secondaryParty: 3000
    },
    categories: [
      "占い・スピリチュアル",
      "ボディケア・美容",
      "物販",
      "飲食"
    ],
    workerUrl: "https://buchiiyashi-festa-form.wakaossan2001.workers.dev",
    liffId: "2008192225-T1E8T5yi",
    booths: []
  };
}

// ページ読み込み時に設定をロード
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  // 設定が読み込まれた後に初期化イベントを発火
  window.dispatchEvent(new Event('configLoaded'));
});
