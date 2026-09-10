/**
 * ぶち癒しフェスタ 抽選式オンライン整理券システム
 *
 * 当日の会場前に行列をつくらないための、事前申込・抽選・整理券配信のしくみ。
 *
 * 設計の要点:
 *  - 抽選するのは「人」ではなく「申込」。グループは分割せず連番をまとめて確保する。
 *  - 番号だけでなく集合時刻を配る。来場そのものを時間で分散させるのが目的。
 *  - 配信はLINEのFlex Message。画像を焼かずに大きな数字を出せるので、
 *    文字サイズを大きくしている端末でも読め、あとから文面だけ直せる。
 *  - 抽選は二重実行で番号が壊れるため、ticket_types.lottery_status で排他する。
 */

// ============================================================
// 共通ヘルパー
// ============================================================

function json(data, corsHeaders, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// ============================================================
// スキーマの自動追従
//
// 列を足すたびに手作業でALTERを流す運用にしていたため、コードが先に出て
// データベースが追いつかず、申込ページが券種を1件も取れなくなる事故を
// 2度起こした（note / open_time）。追加だけなら自動で追いつかせる。
//
// ここに書けるのは「あとから足した、NULLを許す列」だけ。
// 列の削除や型変更は自動化しない（データを壊しうるため）。
// ============================================================
const ADDITIVE_COLUMNS = {
    ticket_types: {
        note: 'TEXT',
        remind_at: 'TEXT',
        issue_end: 'TEXT',
        open_time: 'TEXT',
        free_entry_time: 'TEXT'
    },
    applications: {
        receipt_notified_at: 'TEXT',
        result_notified_at: 'TEXT',
        remind_notified_at: 'TEXT',
        notify_error: 'TEXT'
    }
};

// Workerのインスタンスごとに1回だけ確認する
let schemaEnsured = false;

/**
 * 足りない列があれば追加する。
 *
 * ふだんは「全部そろっているか」を確かめる1クエリで終わる。
 * 表名と列名はこのファイルの定数だけで、外から来た値は混ざらない。
 */
export async function ensureSchema(env) {
    if (schemaEnsured || !env.TICKETS_DB) return;
    const database = env.TICKETS_DB;

    try {
        for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
            const names = Object.keys(columns);

            // そろっていれば何もしない（通常はここで終わる）
            try {
                await database.prepare(`SELECT ${names.join(', ')} FROM ${table} LIMIT 0`).all();
                continue;
            } catch (error) {
                if (!String(error?.message || '').includes('no such column')) {
                    // テーブル自体が無い等。初期構築前なので触らない。
                    continue;
                }
            }

            for (const [column, type] of Object.entries(columns)) {
                try {
                    await database.prepare(`SELECT ${column} FROM ${table} LIMIT 0`).all();
                    continue;
                } catch (error) {
                    if (!String(error?.message || '').includes('no such column')) continue;
                }
                try {
                    await database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
                    console.log(`整理券: ${table}.${column} を追加しました`);
                } catch (error) {
                    // 別のリクエストが先に足していた場合は重複エラーになる。実害はない。
                    if (!String(error?.message || '').includes('duplicate column')) {
                        console.error(`整理券: ${table}.${column} を追加できません:`, error?.message || error);
                    }
                }
            }
        }
        schemaEnsured = true;
    } catch (error) {
        // ここで失敗しても本来の処理は続ける。次のリクエストでまた試す。
        console.error('整理券: スキーマの確認に失敗:', error?.message || error);
    }
}

function db(env) {
    if (!env.TICKETS_DB) {
        throw new Error('TICKETS_DB が未設定です。wrangler.toml のD1バインディングを確認してください');
    }
    return env.TICKETS_DB;
}

/** 現在時刻をJSTのISO8601文字列で返す（ログと保存の表記を揃えるため） */
function nowIso() {
    return toJstIso(new Date());
}

function toJstIso(date) {
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}` +
        `T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}+09:00`;
}

/**
 * 設定された日時文字列をDateにする。
 * 管理画面のdatetime-localは "2026-09-17T20:00" のようにタイムゾーンなしで来るため、
 * タイムゾーンが書かれていなければJSTとして解釈する（運用者の頭の中の時刻に合わせる）。
 */
function parseJst(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
    const normalized = hasZone ? raw : `${raw.length === 16 ? `${raw}:00` : raw}+09:00`;
    const date = new Date(normalized);
    return isNaN(date.getTime()) ? null : date;
}

function isBefore(value, now = new Date()) {
    const date = parseJst(value);
    return date ? date.getTime() <= now.getTime() : false;
}

function isAfter(value, now = new Date()) {
    const date = parseJst(value);
    return date ? date.getTime() > now.getTime() : false;
}

/**
 * 日時を "2026年9月16日(水) 20:00" の形にする。
 *
 * 来場者に見せる文面で使う。"2026-09-16 20:00" のような区切りは、
 * 見慣れていない人には一瞬で読めない。
 */
export function formatJapaneseDateTime(value) {
    const date = parseJst(value);
    if (!date) return '';

    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const p = n => String(n).padStart(2, '0');

    return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日` +
        `(${days[jst.getUTCDay()]}) ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`;
}

function newId(prefix) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function escapeCsv(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// ============================================================
// 抽選用の乱数（シードから再現できること）
//
// 「同じシードなら同じ結果になる」ことが抽選の公平性の説明になる。
// 抽選をやり直せと言われたときに、記録したシードで第三者が検証できる。
// ============================================================

/** 文字列から32bit整数4つを作る（cyrb128） */
function seedToInts(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
        const k = str.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    return [
        (h1 ^ h2 ^ h3 ^ h4) >>> 0,
        (h2 ^ h1) >>> 0,
        (h3 ^ h1) >>> 0,
        (h4 ^ h1) >>> 0
    ];
}

/** sfc32。シードが同じなら常に同じ列を返す */
function makeRng(seed) {
    let [a, b, c, d] = seedToInts(seed);
    return function rng() {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
        let t = (a + b) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        d = (d + 1) | 0;
        t = (t + d) | 0;
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
    };
}

/** Fisher–Yatesシャッフル。元配列は変更しない */
function shuffleWithSeed(items, seed) {
    const rng = makeRng(seed);
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ============================================================
// 時間枠
// ============================================================

/** 'HH:MM' に分を足して 'HH:MM' で返す */
function addMinutesToTime(hhmm, minutes) {
    const [h, m] = String(hhmm || '10:45').split(':').map(Number);
    const total = (h * 60 + m + minutes) % (24 * 60);
    const p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(total / 60))}:${p(total % 60)}`;
}

/**
 * 券種の設定から取れる、時刻の差込タグ。
 *
 * 文面に「10:30開場」「13時以降は不要」と直接書くと、時間が変わったときに
 * 案内文4つと説明文を全部直すことになる。設定を1か所変えれば全部に効くようにする。
 */
function typeTimeVars(type) {
    return {
        open: type.open_time || '',
        free: type.free_entry_time || '',
        slotFirst: type.slot_enabled
            ? (type.slot_start_time || '')
            : (type.fixed_time_label || '')
    };
}

/**
 * 券種の設定から集合時刻を組み立てる。
 * 枠を使わない券種（講演会など）は固定の文言を券面に出す。
 */
function slotLabel(type, slotTime) {
    if (!type.slot_enabled) return type.fixed_time_label || '';
    return slotTime || '';
}

// ============================================================
// LINE配信
// ============================================================

/**
 * Messaging APIのpushを1件送る。
 *
 * 失敗しても呼び出し側の処理を止めない。友だち未追加・ブロックは再送しても
 * 結果が変わらないため、その旨を返して管理画面の未達リストに載せる。
 */
async function pushLine(env, to, messages) {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
        return { ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN未設定', permanent: true };
    }
    if (!to) {
        return { ok: false, error: 'LINEユーザーIDがありません', permanent: true };
    }

    const body = JSON.stringify({ to, messages });
    const retryKey = crypto.randomUUID();

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await fetch('https://api.line.me/v2/bot/message/push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
                    'X-Line-Retry-Key': retryKey
                },
                body
            });

            if (response.ok) return { ok: true };

            const errorText = (await response.text()).slice(0, 300);

            // 友だち未追加・ブロック中。再送しても届かない。
            if (response.status === 403) {
                return { ok: false, error: '友だち未追加またはブロック中', permanent: true };
            }
            if (response.status !== 429 && response.status < 500) {
                return { ok: false, error: `${response.status} ${errorText}`, permanent: true };
            }
            if (attempt === 2) {
                return { ok: false, error: `${response.status} ${errorText}`, permanent: false };
            }
        } catch (error) {
            if (attempt === 2) {
                return { ok: false, error: String(error?.message || error).slice(0, 300), permanent: false };
            }
        }
        await new Promise(resolve => setTimeout(resolve, 400));
    }

    return { ok: false, error: '送信できませんでした', permanent: false };
}

/** 差込タグを埋める。空欄のタグは空文字にして「{{name}}」が本文に出ないようにする */
function fillTemplate(template, vars) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const value = vars[key];
        return value === null || value === undefined ? '' : String(value);
    });
}

/**
 * 整理券のFlex Message。
 *
 * 画像を焼かずにこの形にしているのは、端末の文字サイズ設定が大きい方でも
 * 数字が潰れないことと、文面の誤りを再送なしで直せるため。
 */
function buildTicketFlex(type, ticket, application, env) {
    const color = type.color || '#B01B54';
    const numbers = ticket.number_start === ticket.number_end
        ? `${ticket.number_start}`
        : `${ticket.number_start} – ${ticket.number_end}`;
    const time = slotLabel(type, ticket.slot_time);
    // LINEのトークから開くときは、LIFFのURLを使うとログイン済みのまま整理券が出る。
    // 素のURLだとログインし直す画面が挟まり、そこで諦める人が出る。
    // TICKET_LIFF_ID が未設定のときだけ、素のURLで代替する。
    const liffId = String(env.TICKET_LIFF_ID || '').trim();
    const siteUrl = (env.TICKET_SITE_URL || '').replace(/\/$/, '');
    const ticketPageUrl = liffId
        ? `https://liff.line.me/${liffId}`
        : (siteUrl ? `${siteUrl}/ticket/` : '');

    const rows = [
        ['お名前', `${application.name} 様`],
        ['人数', `${application.party_size}名`]
    ];
    if (ticket.number_start !== ticket.number_end) {
        rows.push(['同行者番号', numbers]);
    }

    const bubble = {
        type: 'bubble',
        size: 'mega',
        header: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '16px',
            backgroundColor: color,
            contents: [
                { type: 'text', text: type.name, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true }
            ]
        },
        body: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '20px',
            spacing: 'none',
            contents: [
                { type: 'text', text: '整理番号', size: 'sm', color: '#888888' },
                {
                    type: 'text',
                    text: `${ticket.number_start}`,
                    size: '5xl',
                    weight: 'bold',
                    color: '#222222',
                    margin: 'none'
                },
                ...(time ? [{
                    type: 'box',
                    layout: 'vertical',
                    margin: 'lg',
                    paddingAll: '12px',
                    backgroundColor: '#F4ECEC',
                    cornerRadius: '6px',
                    contents: [
                        { type: 'text', text: type.slot_enabled ? '集合時刻' : 'ご案内', size: 'xs', color: '#888888' },
                        { type: 'text', text: time, size: 'xxl', weight: 'bold', color: '#222222' }
                    ]
                }] : []),
                {
                    type: 'box',
                    layout: 'vertical',
                    margin: 'lg',
                    spacing: 'sm',
                    contents: rows.map(([label, value]) => ({
                        type: 'box',
                        layout: 'baseline',
                        contents: [
                            { type: 'text', text: label, size: 'sm', color: '#888888', flex: 3 },
                            { type: 'text', text: value, size: 'sm', color: '#333333', flex: 5, wrap: true }
                        ]
                    }))
                }
            ]
        }
    };

    if (ticketPageUrl) {
        bubble.footer = {
            type: 'box',
            layout: 'vertical',
            paddingAll: '12px',
            contents: [{
                type: 'button',
                style: 'primary',
                color,
                height: 'sm',
                action: { type: 'uri', label: '整理券を開く', uri: ticketPageUrl }
            }]
        };
    }

    return {
        type: 'flex',
        altText: `【${type.name}】整理番号 ${numbers}${time ? ` / ${time}` : ''}`,
        contents: bubble
    };
}

/**
 * 券の内容をテキストでも送る。
 *
 * Flexが表示できない環境と、あとからトークを遡って番号を探す場面のため。
 * 当日「番号が見つからない」で受付が止まるのを防ぐのが目的。
 */
function buildTicketText(type, ticket, application) {
    const numbers = ticket.number_start === ticket.number_end
        ? `${ticket.number_start}番`
        : `${ticket.number_start}番 〜 ${ticket.number_end}番`;
    const time = slotLabel(type, ticket.slot_time);

    const lines = [
        `【${type.name}】`,
        '',
        `整理番号：${numbers}`,
        time ? `${type.slot_enabled ? '集合時刻' : 'ご案内'}：${time}` : '',
        `お名前：${application.name} 様（${application.party_size}名）`,
        '',
        '当日は受付でこの画面をお見せください。'
    ];
    return { type: 'text', text: lines.filter(Boolean).join('\n') };
}

// ============================================================
// 抽選エンジン
// ============================================================

/**
 * 申込の並べ替えから番号・集合時刻の割り当てまでを決める。
 *
 * データベースに触らない純粋な処理として切り出してある。番号が重複したり
 * 飛んだりすると当日そのまま事故になるため、ここだけは単体で検証できる形にしておく。
 *
 * @param {object} type          券種の設定
 * @param {Array}  applications  申込。呼び出し側で並び順を固定しておくこと
 * @param {string} seed          同じシードなら同じ結果になる
 */
export function planAssignment(type, applications, seed) {
    const shuffled = shuffleWithSeed(applications, seed);

    const numberStart = Number(type.number_start) || 1;
    const numberEnd = Number(type.number_end) || numberStart;
    const allWin = type.capacity_mode !== 'limited';
    const slotCapacity = Math.max(1, Number(type.slot_capacity) || 50);
    const slotInterval = Math.max(1, Number(type.slot_interval_min) || 30);

    let cursor = numberStart;
    let slotIndex = 0;
    let slotUsed = 0;
    let extendedBeyondRange = false;

    const winners = [];
    const losers = [];

    for (const app of shuffled) {
        const party = Math.max(1, Number(app.party_size) || 1);

        if (cursor + party - 1 > numberEnd) {
            if (!allWin) {
                // 定員制。ここから先は落選。
                // グループが入りきらないだけの場合も落選にする。あとから来た
                // 少人数の申込に番号を先に渡すと、抽選の順番が意味を失うため。
                losers.push(app);
                continue;
            }
            // 全員当選の券種では番号範囲を超えても発行する。
            // 「全員当選」の約束を番号設定の都合で破らないため。管理画面で警告を出す。
            extendedBeyondRange = true;
        }

        // グループは分割しない。枠がすでに埋まっていれば次の枠へ送り、
        // 埋まっていなければ人数がはみ出してもこの枠に入れる。
        // 番号を飛ばしたり家族を別の時間に分けたりする方が、現場では確実に揉める。
        if (slotUsed >= slotCapacity) {
            slotIndex += 1;
            slotUsed = 0;
        }

        winners.push({
            app,
            numberStart: cursor,
            numberEnd: cursor + party - 1,
            slotTime: type.slot_enabled
                ? addMinutesToTime(type.slot_start_time, slotIndex * slotInterval)
                : null
        });

        cursor += party;
        slotUsed += party;
    }

    return { winners, losers, lastNumber: cursor - 1, extendedBeyondRange };
}

/**
 * 発行済みの整理券を捨てて、申込を抽選前に戻す。
 *
 * やり直しと、途中で落ちた実行の後始末で使う。どちらも
 * 「この券種にはまだ有効な整理券が無い」状態に揃えるための処理。
 */
async function clearIssued(database, ticketTypeId, at) {
    await database.batch([
        database.prepare('DELETE FROM tickets WHERE ticket_type_id = ?').bind(ticketTypeId),
        database.prepare(
            `UPDATE applications SET status = 'applied', result_notified_at = NULL,
             remind_notified_at = NULL, notify_error = NULL, updated_at = ?
             WHERE ticket_type_id = ? AND status IN ('won','lost')`
        ).bind(at, ticketTypeId)
    ]);
}

/**
 * 1つの券種の抽選を実行して、番号と集合時刻を確定させる。
 *
 * 二重実行を防ぐため、lottery_status を 'pending' → 'running' に
 * 条件つきUPDATEで書き換えられた実行だけが先に進む。
 */
export async function runLottery(env, ticketTypeId, options = {}) {
    const { trigger = 'manual', seed: providedSeed = null, force = false } = options;
    const database = db(env);
    const startedAt = nowIso();

    const type = await database.prepare('SELECT * FROM ticket_types WHERE id = ?')
        .bind(ticketTypeId).first();
    if (!type) {
        return { ok: false, error: '券種が見つかりません' };
    }

    // やり直しは、確定済みの番号を捨てる操作なので明示的な指示があるときだけ許す
    if (type.lottery_status === 'done' && !force) {
        return { ok: false, error: 'この券種の抽選はすでに完了しています', alreadyDone: true };
    }
    if (force) {
        await clearIssued(database, ticketTypeId, startedAt);
        await database.prepare(
            `UPDATE ticket_types SET lottery_status = 'pending', updated_at = ? WHERE id = ?`
        ).bind(startedAt, ticketTypeId).run();
    }

    // ここで確保できた実行だけが抽選を行う
    const claim = await database.prepare(
        `UPDATE ticket_types SET lottery_status = 'running', updated_at = ?
         WHERE id = ? AND lottery_status = 'pending'`
    ).bind(startedAt, ticketTypeId).run();

    if (!claim.meta || claim.meta.changes === 0) {
        return { ok: false, error: '抽選がすでに実行中か、完了しています' };
    }

    const seed = providedSeed || `${ticketTypeId}-${startedAt}`;
    const runId = newId('run');

    await database.prepare(
        `INSERT INTO lottery_runs (id, ticket_type_id, seed, trigger, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`
    ).bind(runId, ticketTypeId, seed, trigger, startedAt).run();

    // 実行を確保できたということは、この券種の抽選はまだ完了していない。
    // それでも整理券の行が残っているなら、途中で落ちた実行の残骸なので捨てる。
    // これがないと、次の実行が application_id の重複で必ず落ちる。
    await clearIssued(database, ticketTypeId, startedAt);

    try {
        // 基準の並びを固定してからシャッフルする。
        // ここが実行のたびに変わると、同じシードでも結果が再現できなくなる。
        const { results: applications } = await database.prepare(
            `SELECT * FROM applications
             WHERE ticket_type_id = ? AND status IN ('applied','won','lost')
             ORDER BY created_at ASC, id ASC`
        ).bind(ticketTypeId).all();

        const entries = applications || [];
        const { winners, losers, lastNumber, extendedBeyondRange } =
            planAssignment(type, entries, seed);

        const issuedAt = nowIso();
        const statements = [];

        for (const w of winners) {
            statements.push(
                database.prepare(
                    `INSERT INTO tickets
                     (id, application_id, ticket_type_id, number_start, number_end, slot_time, issued_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                ).bind(newId('tkt'), w.app.id, ticketTypeId, w.numberStart, w.numberEnd, w.slotTime, issuedAt)
            );
            // 申込受付の通知が届かなかった人にも結果配信を試すため、ここでエラーを消す
            statements.push(
                database.prepare(
                    `UPDATE applications SET status = 'won', notify_error = NULL, updated_at = ? WHERE id = ?`
                ).bind(issuedAt, w.app.id)
            );
        }
        for (const app of losers) {
            statements.push(
                database.prepare(
                    `UPDATE applications SET status = 'lost', notify_error = NULL, updated_at = ? WHERE id = ?`
                ).bind(issuedAt, app.id)
            );
        }

        // D1のbatchはトランザクションで走るため、途中で失敗すれば番号は1つも入らない
        for (let i = 0; i < statements.length; i += 50) {
            await database.batch(statements.slice(i, i + 50));
        }

        const issuedNumbers = winners.reduce((sum, w) => sum + (w.numberEnd - w.numberStart + 1), 0);

        await database.batch([
            database.prepare(
                `UPDATE lottery_runs SET status = 'done', finished_at = ?, total_applications = ?,
                 won_applications = ?, lost_applications = ?, issued_numbers = ? WHERE id = ?`
            ).bind(issuedAt, entries.length, winners.length, losers.length, issuedNumbers, runId),
            database.prepare(
                `UPDATE ticket_types SET lottery_status = 'done', lottery_seed = ?,
                 lottery_done_at = ?, updated_at = ? WHERE id = ?`
            ).bind(seed, issuedAt, issuedAt, ticketTypeId)
        ]);

        return {
            ok: true,
            runId,
            seed,
            total: entries.length,
            won: winners.length,
            lost: losers.length,
            issuedNumbers,
            lastNumber,
            extendedBeyondRange
        };
    } catch (error) {
        const message = String(error?.message || error).slice(0, 500);
        const failedAt = nowIso();

        // 失敗した実行の痕跡を残さない。整理券の書き込みまで進んでから落ちると、
        // 番号だけが残って次の実行が重複で弾かれる。そのまま pending に戻すと
        // 「やり直せるはずなのに何度やっても失敗する」状態になる。
        await clearIssued(database, ticketTypeId, failedAt);
        await database.batch([
            database.prepare(
                `UPDATE lottery_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`
            ).bind(message, failedAt, runId),
            database.prepare(
                `UPDATE ticket_types SET lottery_status = 'pending', updated_at = ? WHERE id = ?`
            ).bind(failedAt, ticketTypeId)
        ]);
        console.error('抽選に失敗:', message);
        return { ok: false, error: message };
    }
}

// ============================================================
// 配信
// ============================================================

/**
 * 案内文が未設定のときに使う既定の文面。
 * 管理画面で文面を空にしたまま抽選日を迎えても、案内が届く状態を保つ。
 */
function defaultBody(kind, won, type, vars) {
    if (kind === 'remind') {
        return [
            `${vars.name} 様`,
            '',
            `明日はいよいよ「${type.name}」の当日です。`,
            '整理券をあらためてお送りします。当日は受付でこの画面をお見せください。'
        ].join('\n');
    }
    if (won) {
        return [
            `${vars.name} 様`,
            '',
            `【${type.name}】の抽選結果をお知らせします。`,
            'ご当選です。整理番号をお送りしますので、当日は受付でこの画面をお見せください。'
        ].join('\n');
    }
    return [
        `${vars.name} 様`,
        '',
        `【${type.name}】にお申し込みいただき、ありがとうございました。`,
        '厳正な抽選の結果、誠に申し訳ございませんが今回はご用意できませんでした。',
        'またの機会をお待ちしております。'
    ].join('\n');
}

/**
 * 抽選結果（当選・落選）または前日リマインドをLINEで送る。
 *
 * 1回の呼び出しで送る件数に上限を設けているのは、Workerの外部リクエスト数の
 * 制限に当たらないため。残りはcronの次の実行か、管理画面の再実行で片づく。
 */
export async function deliverMessages(env, ticketTypeId, options = {}) {
    const { kind = 'result', limit = 60, retryFailed = false } = options;
    const database = db(env);

    const type = await database.prepare('SELECT * FROM ticket_types WHERE id = ?')
        .bind(ticketTypeId).first();
    if (!type) return { ok: false, error: '券種が見つかりません' };
    if (type.lottery_status !== 'done') {
        return { ok: false, error: '抽選が完了していないため配信できません' };
    }

    const column = kind === 'remind' ? 'remind_notified_at' : 'result_notified_at';
    // リマインドは当選者だけに送る（落選者に前日の案内を送っても混乱するため）
    const statusFilter = kind === 'remind' ? "a.status = 'won'" : "a.status IN ('won','lost')";
    // 未達の再送では、一度失敗した人だけをもう一度対象にする
    const notifiedFilter = retryFailed
        ? `(a.${column} IS NULL)`
        : `(a.${column} IS NULL AND a.notify_error IS NULL)`;

    const { results: rows } = await database.prepare(
        `SELECT a.*, t.number_start, t.number_end, t.slot_time
         FROM applications a
         LEFT JOIN tickets t ON t.application_id = a.id
         WHERE a.ticket_type_id = ? AND ${statusFilter} AND ${notifiedFilter}
         ORDER BY t.number_start ASC, a.created_at ASC
         LIMIT ?`
    ).bind(ticketTypeId, limit).all();

    let sent = 0;
    let failed = 0;

    for (const row of rows || []) {
        const won = row.status === 'won' && row.number_start !== null;
        const ticket = won
            ? { number_start: row.number_start, number_end: row.number_end, slot_time: row.slot_time }
            : null;

        const vars = {
            ...typeTimeVars(type),
            name: row.name,
            party: row.party_size,
            number: ticket ? (ticket.number_start === ticket.number_end
                ? `${ticket.number_start}` : `${ticket.number_start}〜${ticket.number_end}`) : '',
            time: ticket ? slotLabel(type, ticket.slot_time) : '',
            type: type.name,
            receipt: row.receipt_no
        };

        let template;
        if (kind === 'remind') template = type.msg_remind;
        else template = won ? type.msg_win : type.msg_lose;

        // 文面が未設定でも必ず何かを送る。ここで送信を飛ばすと配信済みの印が付かず、
        // cronが同じ人を延々と対象にし続けてしまう。
        const body = fillTemplate(template, vars).trim() || defaultBody(kind, won, type, vars);

        const messages = [{ type: 'text', text: body }];
        if (ticket) {
            messages.push(buildTicketFlex(type, ticket, row, env));
            messages.push(buildTicketText(type, ticket, row));
        }

        const result = await pushLine(env, row.line_user_id, messages.slice(0, 5));
        const at = nowIso();

        if (result.ok) {
            await database.prepare(
                `UPDATE applications SET ${column} = ?, notify_error = NULL, updated_at = ? WHERE id = ?`
            ).bind(at, at, row.id).run();
            sent += 1;
        } else {
            await database.prepare(
                `UPDATE applications SET notify_error = ?, updated_at = ? WHERE id = ?`
            ).bind(result.error, at, row.id).run();
            failed += 1;
        }
    }

    // まだ残っているかを返して、管理画面が続きを流せるようにする
    const remaining = await database.prepare(
        `SELECT COUNT(*) AS c FROM applications a
         WHERE a.ticket_type_id = ? AND ${statusFilter} AND a.${column} IS NULL`
    ).bind(ticketTypeId).first();

    return { ok: true, sent, failed, remaining: remaining ? remaining.c : 0 };
}

// ============================================================
// 公開API（来場者向け）
// ============================================================

export async function handleTicketAPI(request, env, corsHeaders, url) {
    const path = url.pathname;

    try {
        await ensureSchema(env);
        if (path === '/api/tickets/types' && request.method === 'GET') {
            return await listPublicTypes(env, corsHeaders);
        }
        if (path === '/api/tickets/apply' && request.method === 'POST') {
            return await submitApplication(request, env, corsHeaders);
        }
        if (path === '/api/tickets/mine' && request.method === 'POST') {
            return await getMyTickets(request, env, corsHeaders);
        }
    } catch (error) {
        console.error('整理券API エラー:', error);
        return json({ error: String(error?.message || error) }, corsHeaders, 500);
    }

    return null; // このモジュールの担当外
}

/** 申込ページに出す券種。内部設定（シード・文面）は返さない */
async function listPublicTypes(env, corsHeaders) {
    const { results } = await db(env).prepare(
        `SELECT id, name, apply_start, apply_end, lottery_at, number_start, number_end,
                capacity_mode, max_party_size, slot_enabled, slot_start_time,
                slot_interval_min, slot_capacity, fixed_time_label, color, note,
                open_time, free_entry_time, lottery_status
         FROM ticket_types WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC`
    ).all();

    const now = new Date();
    const types = (results || []).map(type => {
        // 未設定は「制限なし」として扱う。開始日時を空欄にしただけで
        // 誰も申し込めなくなる、という事故を避けるため。
        const notYetOpen = isAfter(type.apply_start, now);
        const closed = type.apply_end ? isBefore(type.apply_end, now) : false;
        return {
            ...type,
            slot_enabled: !!type.slot_enabled,
            acceptingNow: !notYetOpen && !closed && type.lottery_status !== 'done',
            notYetOpen,
            closed
        };
    });

    return json({ types, serverTime: nowIso() }, corsHeaders);
}

async function submitApplication(request, env, corsHeaders) {
    const data = await request.json();
    const database = db(env);

    const ticketTypeId = String(data.ticketTypeId || '').trim();
    const lineUserId = String(data.lineUserId || '').trim();
    const name = String(data.name || '').trim();
    const phone = String(data.phone || '').replace(/[^\d]/g, '');
    const partySize = Number(data.partySize) || 0;

    if (!ticketTypeId) return json({ error: '券種が選ばれていません' }, corsHeaders, 400);
    if (!lineUserId) {
        return json({
            error: 'LINEの情報を取得できませんでした。公式LINEのメニューから開き直してください。'
        }, corsHeaders, 400);
    }
    if (!name) return json({ error: 'お名前を入力してください' }, corsHeaders, 400);
    if (phone.length < 10) return json({ error: '電話番号を正しく入力してください' }, corsHeaders, 400);

    const type = await database.prepare('SELECT * FROM ticket_types WHERE id = ? AND enabled = 1')
        .bind(ticketTypeId).first();
    if (!type) return json({ error: 'この券種は現在受け付けていません' }, corsHeaders, 404);

    // 期間が未設定なら制限なしとして扱う（listPublicTypes と揃えている）
    const now = new Date();
    if (isAfter(type.apply_start, now)) {
        return json({ error: `${type.name} の申込はまだ開始していません` }, corsHeaders, 400);
    }
    if (type.apply_end && isBefore(type.apply_end, now)) {
        return json({ error: `${type.name} の申込は締め切りました` }, corsHeaders, 400);
    }
    if (type.lottery_status === 'done') {
        return json({ error: `${type.name} は抽選が終了しています` }, corsHeaders, 400);
    }

    const maxParty = Math.max(1, Number(type.max_party_size) || 1);
    if (partySize < 1 || partySize > maxParty) {
        return json({ error: `人数は1〜${maxParty}名で入力してください` }, corsHeaders, 400);
    }

    // 1人1申込。UNIQUE制約でも弾けるが、先に見て分かりやすい文言を返す。
    const existing = await database.prepare(
        'SELECT id, receipt_no FROM applications WHERE ticket_type_id = ? AND line_user_id = ?'
    ).bind(ticketTypeId, lineUserId).first();
    if (existing) {
        return json({
            error: `${type.name} はすでにお申し込み済みです（受付番号 ${existing.receipt_no}）。` +
                '内容の変更は主催者までご連絡ください。',
            duplicated: true
        }, corsHeaders, 409);
    }

    const id = newId('app');
    const receiptNo = `${String(Math.floor(Math.random() * 900000) + 100000)}`;
    const at = nowIso();
    const companions = Array.isArray(data.companions)
        ? JSON.stringify(data.companions.filter(Boolean).slice(0, maxParty))
        : null;

    try {
        await database.prepare(
            `INSERT INTO applications
             (id, ticket_type_id, receipt_no, line_user_id, line_display_name, name, name_kana,
              phone, email, party_size, companions, note, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`
        ).bind(
            id, ticketTypeId, receiptNo, lineUserId,
            String(data.lineDisplayName || '').slice(0, 100),
            name.slice(0, 100),
            String(data.nameKana || '').slice(0, 100),
            phone,
            String(data.email || '').slice(0, 200),
            partySize, companions,
            String(data.note || '').slice(0, 500),
            at, at
        ).run();
    } catch (error) {
        if (String(error?.message || '').includes('UNIQUE')) {
            return json({ error: 'すでにお申し込み済みです', duplicated: true }, corsHeaders, 409);
        }
        throw error;
    }

    // 受付の通知。「申し込んだ＝当選した」という誤解が当日のトラブルの大半なので、
    // まだ整理券ではないことをここで必ず伝える。
    const lotteryLabel = formatJapaneseDateTime(type.lottery_at);
    const receiptText = fillTemplate(type.msg_receipt, {
        ...typeTimeVars(type),
        name, party: partySize, receipt: receiptNo, type: type.name, lottery: lotteryLabel
    }).trim() || [
        `${name} 様`,
        '',
        `【${type.name}】のお申し込みを受け付けました。`,
        `受付番号：${receiptNo}`,
        `人数：${partySize}名`,
        '',
        '※これは受付の確認です。整理券ではありません。',
        lotteryLabel ? `抽選日時：${lotteryLabel}` : '',
        '抽選の結果は、あらためてこのLINEでお知らせします。'
    ].filter(Boolean).join('\n');

    const push = await pushLine(env, lineUserId, [{ type: 'text', text: receiptText }]);
    if (push.ok) {
        await database.prepare(
            'UPDATE applications SET receipt_notified_at = ?, updated_at = ? WHERE id = ?'
        ).bind(nowIso(), nowIso(), id).run();
    } else {
        await database.prepare(
            'UPDATE applications SET notify_error = ?, updated_at = ? WHERE id = ?'
        ).bind(push.error, nowIso(), id).run();
    }

    return json({
        ok: true,
        receiptNo,
        typeName: type.name,
        lotteryAt: type.lottery_at,
        lineDelivered: push.ok
    }, corsHeaders);
}

/** LIFFでログインした本人の申込・整理券を返す */
async function getMyTickets(request, env, corsHeaders) {
    const data = await request.json();
    const lineUserId = String(data.lineUserId || '').trim();
    if (!lineUserId) return json({ error: 'LINEの情報を取得できませんでした' }, corsHeaders, 400);

    const { results } = await db(env).prepare(
        `SELECT a.id, a.receipt_no, a.name, a.party_size, a.status, a.created_at,
                t.number_start, t.number_end, t.slot_time, t.checked_in_at,
                ty.id AS type_id, ty.name AS type_name, ty.color, ty.slot_enabled,
                ty.fixed_time_label, ty.lottery_status, ty.lottery_at, ty.issue_end
         FROM applications a
         JOIN ticket_types ty ON ty.id = a.ticket_type_id
         LEFT JOIN tickets t ON t.application_id = a.id
         WHERE a.line_user_id = ?
         ORDER BY ty.sort_order ASC, a.created_at ASC`
    ).bind(lineUserId).all();

    const now = new Date();
    const items = (results || []).map(row => {
        // 当選が確定した時点で整理券は発行済み。表示開始を別に設けると、
        // LINEには番号が届いているのにページでは見られない、という食い違いが起きる。
        // 表示終了だけは残す（イベント後に古い番号が出続けるのを防ぐため）。
        const afterIssue = row.issue_end ? isBefore(row.issue_end, now) : false;
        const visible = row.status === 'won' && !afterIssue;
        return {
            applicationId: row.id,
            receiptNo: row.receipt_no,
            name: row.name,
            partySize: row.party_size,
            status: row.status,
            // 申込ページが「この券種はもう申し込み済み」を判定するのに使う
            typeId: row.type_id,
            typeName: row.type_name,
            color: row.color,
            slotEnabled: !!row.slot_enabled,
            lotteryStatus: row.lottery_status,
            lotteryAt: row.lottery_at,
            checkedIn: !!row.checked_in_at,
            ticketVisible: visible,
            numberStart: visible ? row.number_start : null,
            numberEnd: visible ? row.number_end : null,
            timeLabel: visible
                ? (row.slot_enabled ? row.slot_time : row.fixed_time_label) || ''
                : ''
        };
    });

    return json({ items, serverTime: nowIso() }, corsHeaders);
}

// ============================================================
// 管理API
// ============================================================

export async function handleTicketAdminAPI(request, env, corsHeaders, url) {
    const path = url.pathname;

    try {
        await ensureSchema(env);
        if (path === '/api/admin/tickets/types' && request.method === 'GET') {
            const { results } = await db(env).prepare(
                'SELECT * FROM ticket_types ORDER BY sort_order ASC, created_at ASC'
            ).all();
            return json({ types: results || [], serverTime: nowIso() }, corsHeaders);
        }
        if (path === '/api/admin/tickets/types' && request.method === 'POST') {
            return await upsertType(request, env, corsHeaders);
        }
        if (path === '/api/admin/tickets/types/delete' && request.method === 'POST') {
            return await deleteType(request, env, corsHeaders);
        }
        if (path === '/api/admin/tickets/applications' && request.method === 'GET') {
            return await listApplications(env, corsHeaders, url);
        }
        if (path === '/api/admin/tickets/applications/delete' && request.method === 'POST') {
            return await deleteApplication(request, env, corsHeaders);
        }
        if (path === '/api/admin/tickets/stats' && request.method === 'GET') {
            return await getStats(env, corsHeaders, url);
        }
        if (path === '/api/admin/tickets/lottery' && request.method === 'POST') {
            return await runLotteryEndpoint(request, env, corsHeaders);
        }
        if (path === '/api/admin/tickets/deliver' && request.method === 'POST') {
            const body = await request.json();
            const result = await deliverMessages(env, String(body.ticketTypeId || ''), {
                kind: body.kind === 'remind' ? 'remind' : 'result',
                limit: Math.min(120, Math.max(1, Number(body.limit) || 60)),
                retryFailed: !!body.retryFailed
            });
            return json(result, corsHeaders, result.ok ? 200 : 400);
        }
        if (path === '/api/admin/tickets/search' && request.method === 'GET') {
            return await searchForReception(env, corsHeaders, url);
        }
        if (path === '/api/admin/tickets/checkin' && request.method === 'POST') {
            return await checkIn(request, env, corsHeaders);
        }
        if (path === '/api/admin/tickets/export' && request.method === 'GET') {
            return await exportCsv(env, corsHeaders, url);
        }
    } catch (error) {
        console.error('整理券 管理API エラー:', error);
        return json({ error: String(error?.message || error) }, corsHeaders, 500);
    }

    return null;
}

/** 券種の作成・更新。抽選後も設定は編集できる（確定済みの番号には影響しない） */
async function upsertType(request, env, corsHeaders) {
    const data = await request.json();
    const database = db(env);
    const at = nowIso();

    const name = String(data.name || '').trim();
    if (!name) return json({ error: '券種名を入力してください' }, corsHeaders, 400);

    const numberStart = Math.max(1, Number(data.number_start) || 1);
    const numberEnd = Math.max(numberStart, Number(data.number_end) || numberStart);

    const fields = {
        name,
        sort_order: Number(data.sort_order) || 0,
        enabled: data.enabled ? 1 : 0,
        apply_start: data.apply_start || null,
        apply_end: data.apply_end || null,
        lottery_at: data.lottery_at || null,
        remind_at: data.remind_at || null,
        issue_end: data.issue_end || null,
        number_start: numberStart,
        number_end: numberEnd,
        capacity_mode: data.capacity_mode === 'limited' ? 'limited' : 'all_win',
        max_party_size: Math.max(1, Math.min(20, Number(data.max_party_size) || 5)),
        slot_enabled: data.slot_enabled ? 1 : 0,
        slot_start_time: String(data.slot_start_time || '10:45').slice(0, 5),
        slot_interval_min: Math.max(1, Number(data.slot_interval_min) || 30),
        slot_capacity: Math.max(1, Number(data.slot_capacity) || 50),
        open_time: data.open_time || null,
        free_entry_time: data.free_entry_time || null,
        fixed_time_label: data.fixed_time_label || null,
        color: /^#[0-9A-Fa-f]{6}$/.test(data.color || '') ? data.color : '#B01B54',
        note: data.note || null,
        msg_receipt: data.msg_receipt || null,
        msg_win: data.msg_win || null,
        msg_lose: data.msg_lose || null,
        msg_remind: data.msg_remind || null
    };

    const id = String(data.id || '').trim();
    if (id) {
        const keys = Object.keys(fields);
        await database.prepare(
            `UPDATE ticket_types SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
        ).bind(...keys.map(k => fields[k]), at, id).run();
        return json({ ok: true, id }, corsHeaders);
    }

    const newTypeId = newId('type');
    const keys = Object.keys(fields);
    await database.prepare(
        `INSERT INTO ticket_types (id, ${keys.join(', ')}, created_at, updated_at)
         VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?)`
    ).bind(newTypeId, ...keys.map(k => fields[k]), at, at).run();

    return json({ ok: true, id: newTypeId }, corsHeaders);
}

async function deleteType(request, env, corsHeaders) {
    const { ticketTypeId } = await request.json();
    if (!ticketTypeId) return json({ error: '券種IDがありません' }, corsHeaders, 400);

    const database = db(env);
    const count = await database.prepare(
        'SELECT COUNT(*) AS c FROM applications WHERE ticket_type_id = ?'
    ).bind(ticketTypeId).first();

    if (count && count.c > 0) {
        // 申込が入っている券種を消すと申込者の記録ごと消える。無効化を案内する。
        return json({
            error: `この券種には申込が${count.c}件あります。削除ではなく「申込ページに表示しない」で運用してください。`
        }, corsHeaders, 400);
    }

    await database.prepare('DELETE FROM ticket_types WHERE id = ?').bind(ticketTypeId).run();
    return json({ ok: true }, corsHeaders);
}

async function listApplications(env, corsHeaders, url) {
    const ticketTypeId = url.searchParams.get('typeId');
    if (!ticketTypeId) return json({ error: '券種IDがありません' }, corsHeaders, 400);

    const { results } = await db(env).prepare(
        `SELECT a.*, t.number_start, t.number_end, t.slot_time, t.checked_in_at
         FROM applications a
         LEFT JOIN tickets t ON t.application_id = a.id
         WHERE a.ticket_type_id = ?
         ORDER BY CASE WHEN t.number_start IS NULL THEN 1 ELSE 0 END,
                  t.number_start ASC, a.created_at ASC`
    ).bind(ticketTypeId).all();

    return json({ applications: results || [] }, corsHeaders);
}

/**
 * 申込を1件消す。
 *
 * 主な用途は、主催者が自分のLINEで申込から整理券までを繰り返し試すこと。
 * 1人1申込の制約があるので、消せないと2回目が試せない。
 *
 * 発行済みの整理番号も一緒に消える。すでに当選をお知らせした相手だと、
 * 本人の手元には番号が残ったまま無効になるため、その旨を返して
 * 管理画面側で確認の文言を変えている。
 */
async function deleteApplication(request, env, corsHeaders) {
    const { applicationId } = await request.json();
    if (!applicationId) return json({ error: '申込IDがありません' }, corsHeaders, 400);

    const database = db(env);
    const target = await database.prepare(
        `SELECT a.id, a.name, a.receipt_no, a.status, a.result_notified_at,
                t.number_start, t.number_end
         FROM applications a
         LEFT JOIN tickets t ON t.application_id = a.id
         WHERE a.id = ?`
    ).bind(applicationId).first();

    if (!target) return json({ error: 'この申込は見つかりません' }, corsHeaders, 404);

    await database.batch([
        database.prepare('DELETE FROM tickets WHERE application_id = ?').bind(applicationId),
        database.prepare('DELETE FROM applications WHERE id = ?').bind(applicationId)
    ]);

    console.log(`整理券: 申込を削除 (${target.name} / 受付番号 ${target.receipt_no})`);

    return json({
        ok: true,
        name: target.name,
        receiptNo: target.receipt_no,
        hadNumber: target.number_start !== null && target.number_start !== undefined,
        wasNotified: !!target.result_notified_at
    }, corsHeaders);
}

async function getStats(env, corsHeaders, url) {
    const ticketTypeId = url.searchParams.get('typeId');
    if (!ticketTypeId) return json({ error: '券種IDがありません' }, corsHeaders, 400);
    const database = db(env);

    const summary = await database.prepare(
        `SELECT
            COUNT(*) AS applications,
            COALESCE(SUM(party_size), 0) AS people,
            COALESCE(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END), 0) AS won,
            COALESCE(SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END), 0) AS lost,
            COALESCE(SUM(CASE WHEN result_notified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS result_sent,
            COALESCE(SUM(CASE WHEN remind_notified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS remind_sent,
            COALESCE(SUM(CASE WHEN notify_error IS NOT NULL AND result_notified_at IS NULL
                              THEN 1 ELSE 0 END), 0) AS undelivered
         FROM applications WHERE ticket_type_id = ?`
    ).bind(ticketTypeId).first();

    const checkedIn = await database.prepare(
        'SELECT COUNT(*) AS c FROM tickets WHERE ticket_type_id = ? AND checked_in_at IS NOT NULL'
    ).bind(ticketTypeId).first();

    const { results: runs } = await database.prepare(
        'SELECT * FROM lottery_runs WHERE ticket_type_id = ? ORDER BY started_at DESC LIMIT 5'
    ).bind(ticketTypeId).all();

    return json({
        stats: { ...summary, checked_in: checkedIn ? checkedIn.c : 0 },
        runs: runs || []
    }, corsHeaders);
}

async function runLotteryEndpoint(request, env, corsHeaders) {
    const body = await request.json();
    const ticketTypeId = String(body.ticketTypeId || '');
    if (!ticketTypeId) return json({ error: '券種IDがありません' }, corsHeaders, 400);

    const result = await runLottery(env, ticketTypeId, {
        trigger: 'manual',
        seed: body.seed ? String(body.seed).slice(0, 200) : null,
        force: !!body.force
    });
    if (!result.ok) return json(result, corsHeaders, 400);

    // 抽選直後に配信までやる。cronで夜間に走ったときに誰も送らない、を防ぐ。
    let delivery = null;
    if (body.deliver !== false) {
        delivery = await deliverMessages(env, ticketTypeId, { kind: 'result', limit: 60 });
    }
    return json({ ...result, delivery }, corsHeaders);
}

/**
 * 当日の受付窓口用の検索。
 *
 * 券が見つからない・LINEを消した・機種変更した、を吸収するための最後の砦。
 * 姓の一部、電話番号の下4桁、整理番号、受付番号のどれでも引ける。
 */
async function searchForReception(env, corsHeaders, url) {
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json({ error: '2文字以上で検索してください' }, corsHeaders, 400);

    const like = `%${q}%`;
    const digits = q.replace(/[^\d]/g, '');
    const asNumber = /^\d+$/.test(q) ? Number(q) : -1;

    const { results } = await db(env).prepare(
        `SELECT a.id, a.receipt_no, a.name, a.name_kana, a.phone, a.party_size, a.status,
                t.id AS ticket_id, t.number_start, t.number_end, t.slot_time, t.checked_in_at,
                ty.name AS type_name, ty.color, ty.slot_enabled, ty.fixed_time_label
         FROM applications a
         JOIN ticket_types ty ON ty.id = a.ticket_type_id
         LEFT JOIN tickets t ON t.application_id = a.id
         WHERE a.name LIKE ? OR a.name_kana LIKE ? OR a.receipt_no = ?
            OR (LENGTH(?) >= 4 AND a.phone LIKE ?)
            OR (? >= 0 AND t.number_start <= ? AND t.number_end >= ?)
         ORDER BY t.number_start ASC, a.created_at ASC
         LIMIT 30`
    ).bind(like, like, q, digits, `%${digits}`, asNumber, asNumber, asNumber).all();

    return json({ results: results || [] }, corsHeaders);
}

async function checkIn(request, env, corsHeaders) {
    const { ticketId, undo } = await request.json();
    if (!ticketId) return json({ error: '整理券IDがありません' }, corsHeaders, 400);

    await db(env).prepare('UPDATE tickets SET checked_in_at = ? WHERE id = ?')
        .bind(undo ? null : nowIso(), ticketId).run();

    return json({ ok: true, checkedIn: !undo }, corsHeaders);
}

async function exportCsv(env, corsHeaders, url) {
    const ticketTypeId = url.searchParams.get('typeId');
    if (!ticketTypeId) return json({ error: '券種IDがありません' }, corsHeaders, 400);

    const { results } = await db(env).prepare(
        `SELECT t.number_start, t.number_end, t.slot_time, t.checked_in_at,
                a.receipt_no, a.name, a.name_kana, a.phone, a.email, a.party_size,
                a.status, a.result_notified_at, a.notify_error, a.created_at
         FROM applications a
         LEFT JOIN tickets t ON t.application_id = a.id
         WHERE a.ticket_type_id = ?
         ORDER BY CASE WHEN t.number_start IS NULL THEN 1 ELSE 0 END,
                  t.number_start ASC, a.created_at ASC`
    ).bind(ticketTypeId).all();

    const header = [
        '整理番号(開始)', '整理番号(終了)', '集合時刻', '受付済み',
        '受付番号', '氏名', 'フリガナ', '電話番号', 'メール', '人数',
        '状態', '結果配信日時', '配信エラー', '申込日時'
    ];

    const lines = [header.join(',')];
    for (const r of results || []) {
        lines.push([
            r.number_start, r.number_end, r.slot_time, r.checked_in_at ? '済' : '',
            r.receipt_no, r.name, r.name_kana, r.phone, r.email, r.party_size,
            r.status, r.result_notified_at, r.notify_error, r.created_at
        ].map(escapeCsv).join(','));
    }

    // Excelで開いたときに文字化けしないようBOMを付ける
    return new Response(`\uFEFF${lines.join('\n')}`, {
        headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="tickets_${ticketTypeId}.csv"`
        }
    });
}

// ============================================================
// 定期実行（cron）
//
// 抽選日時が来た券種の抽選と、送りきれていない配信の続きを引き受ける。
// 管理者が夜中に画面を開いていなくても運用が回るようにするのが目的。
// ============================================================

export async function runTicketSchedule(env) {
    if (!env.TICKETS_DB) return { lotteries: 0, delivered: 0 };
    await ensureSchema(env);

    const database = env.TICKETS_DB;
    const summary = { lotteries: 0, delivered: 0, reminded: 0, recovered: 0 };

    // 0. 途中で落ちて 'running' のまま止まっている券種を戻す。
    //    夜間に自動で走る想定なので、ここで自力で復旧できないと翌朝まで抽選が止まる。
    const { results: stuck } = await database.prepare(
        `SELECT t.id, t.name, r.id AS run_id, r.started_at
         FROM ticket_types t
         JOIN lottery_runs r ON r.ticket_type_id = t.id AND r.status = 'running'
         WHERE t.lottery_status = 'running'`
    ).all();

    for (const row of stuck || []) {
        const startedAt = parseJst(row.started_at);
        if (!startedAt || Date.now() - startedAt.getTime() < 10 * 60 * 1000) continue;

        await database.batch([
            database.prepare(
                `UPDATE lottery_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`
            ).bind('実行中のまま応答がなくなったため中断扱いにしました', nowIso(), row.run_id),
            database.prepare(
                `UPDATE ticket_types SET lottery_status = 'pending', updated_at = ? WHERE id = ?`
            ).bind(nowIso(), row.id)
        ]);
        summary.recovered += 1;
        console.warn(`整理券: ${row.name} の抽選が中断していたため未実行に戻しました`);
    }

    // 1. 抽選日時を過ぎていて、まだ実行していない券種
    const { results: due } = await database.prepare(
        `SELECT id, name, lottery_at FROM ticket_types
         WHERE enabled = 1 AND lottery_status = 'pending' AND lottery_at IS NOT NULL`
    ).all();

    for (const type of due || []) {
        if (!isBefore(type.lottery_at)) continue;
        const result = await runLottery(env, type.id, { trigger: 'cron' });
        if (result.ok) {
            summary.lotteries += 1;
            console.log(`整理券: ${type.name} の抽選を実行 (当選${result.won}件/落選${result.lost}件)`);
        } else {
            console.error(`整理券: ${type.name} の抽選に失敗 - ${result.error}`);
        }
    }

    // 2. 抽選済みで、まだ結果を送れていない人への配信の続き
    const { results: doneTypes } = await database.prepare(
        `SELECT id, name, remind_at FROM ticket_types WHERE lottery_status = 'done'`
    ).all();

    for (const type of doneTypes || []) {
        const pending = await database.prepare(
            `SELECT COUNT(*) AS c FROM applications
             WHERE ticket_type_id = ? AND status IN ('won','lost')
               AND result_notified_at IS NULL AND notify_error IS NULL`
        ).bind(type.id).first();

        if (pending && pending.c > 0) {
            const result = await deliverMessages(env, type.id, { kind: 'result', limit: 40 });
            if (result.ok) summary.delivered += result.sent;
            continue; // 結果配信が終わるまでリマインドには進まない
        }

        // 3. リマインド日時を過ぎていれば、当選者に前日の案内を送る
        if (type.remind_at && isBefore(type.remind_at)) {
            const result = await deliverMessages(env, type.id, { kind: 'remind', limit: 40 });
            if (result.ok) summary.reminded += result.sent;
        }
    }

    return summary;
}
