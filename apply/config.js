/**
 * ぶち癒しフェスタ東京 設定ファイル
 * ブース定義・料金・オプション制限を管理
 */
const CONFIG = {
  // ■ スケジュール設定
  earlyBirdDeadline: "2026-05-31 23:59:59",

  // ■ 会員特典（ステルス適用：メール通知時に減額）
  memberDiscount: 2000,

  // ■ オプション・参加費単価
  unitPrices: {
    chair: 100,          // 追加椅子 (円/脚)
    power: 500,          // 電源使用料 (円)
    staff: 1000,         // 追加スタッフ (円/人)
    party: 5000,         // 懇親会費 (円/人)
    secondaryParty: 3000 // 二次会費 (円/人)
  },

  // ■ カテゴリ定義
  categories: [
    "占い・スピリチュアル",
    "ボディケア・美容",
    "物販",
    "飲食"
  ],

  // ■ システム設定
  workerUrl: "https://buchiiyashi-festa-form.buchiiyashi-festa.workers.dev",

  // ■ ブース定義（完全版）
  // limits仕様: { maxStaff: 追加可能人数, maxChairs: 追加可能椅子数, allowPower: 電源可否 }
  booths: [
    // ----------------------------------------------------------------
    // 1. 内側エリア (Inner)
    // ※特徴: 人数追加不可、椅子追加不可、電源のみOK
    // ----------------------------------------------------------------
    {
      id: "inner_half",
      name: "内側半テーブル（標準1名）",
      location: "内側",
      prices: { regular: 8000, earlyBird: 7500 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },
    {
      id: "inner_1",
      name: "内側1テーブル（標準2名）",
      location: "内側",
      prices: { regular: 15000, earlyBird: 14000 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },
    {
      id: "inner_2",
      name: "内側2テーブル（標準4名）",
      location: "内側",
      prices: { regular: 26000, earlyBird: 26000 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },

    // ----------------------------------------------------------------
    // 2. 内側・物販エリア (Inner Product)
    // ※特徴: 追加不可、電源のみOK、★セッション禁止
    // ----------------------------------------------------------------
    {
      id: "inner_prod_half",
      name: "内側物販半テーブル（標準1名）",
      location: "内側・物販",
      prohibitSession: true,
      prices: { regular: 7000, earlyBird: 6500 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },
    {
      id: "inner_prod_1",
      name: "内側物販1テーブル（標準2名）",
      location: "内側・物販",
      prohibitSession: true,
      prices: { regular: 13000, earlyBird: 12000 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },
    {
      id: "inner_prod_2",
      name: "内側物販2テーブル（標準4名）",
      location: "内側・物販",
      prohibitSession: true,
      prices: { regular: 23000, earlyBird: 23000 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },

    // ----------------------------------------------------------------
    // 3. 壁側エリア (Wall)
    // ※特徴: 半テーブルは追加不可。1テーブルは各+1、2テーブルは各+2までOK
    // ----------------------------------------------------------------
    {
      id: "wall_half",
      name: "壁側半テーブル（標準1名）",
      location: "壁側",
      prices: { regular: 9000, earlyBird: 8500 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },
    {
      id: "wall_1",
      name: "壁側1テーブル（標準2名）",
      location: "壁側",
      prices: { regular: 17000, earlyBird: 16000 },
      limits: { maxStaff: 1, maxChairs: 1, allowPower: true }
    },
    {
      id: "wall_2",
      name: "壁側2テーブル（標準4名）",
      location: "壁側",
      prices: { regular: 30000, earlyBird: 30000 },
      limits: { maxStaff: 2, maxChairs: 2, allowPower: true }
    },

    // ----------------------------------------------------------------
    // 4. 壁側・物販エリア (Wall Product)
    // ※特徴: 追加ルールは壁側と同じ。★セッション禁止
    // ----------------------------------------------------------------
    {
      id: "wall_prod_half",
      name: "壁側物販半テーブル（標準1名）",
      location: "壁側・物販",
      prohibitSession: true,
      prices: { regular: 9000, earlyBird: 8500 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },
    {
      id: "wall_prod_1",
      name: "壁側物販1テーブル（標準2名）",
      location: "壁側・物販",
      prohibitSession: true,
      prices: { regular: 17000, earlyBird: 16000 },
      limits: { maxStaff: 1, maxChairs: 1, allowPower: true }
    },
    {
      id: "wall_prod_2",
      name: "壁側物販2テーブル（標準4名）",
      location: "壁側・物販",
      prohibitSession: true,
      prices: { regular: 30000, earlyBird: 30000 },
      limits: { maxStaff: 2, maxChairs: 2, allowPower: true }
    },

    // ----------------------------------------------------------------
    // 5. ボディケアエリア (Body Care)
    // ※特徴: 小は追加不可。大は各+1までOK。
    // ----------------------------------------------------------------
    {
      id: "body_small",
      name: "ボディケアブース小（標準1名）",
      location: "ボディケア",
      prices: { regular: 15000, earlyBird: 14500 },
      limits: { maxStaff: 0, maxChairs: 0, allowPower: true }
    },
    {
      id: "body_large",
      name: "ボディケアブース大（標準2名）",
      location: "ボディケア",
      prices: { regular: 20000, earlyBird: 19000 },
      limits: { maxStaff: 1, maxChairs: 1, allowPower: true }
    }
  ]
};
