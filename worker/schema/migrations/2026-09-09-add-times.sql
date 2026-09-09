-- ticket_types に会場の時刻を足す
--
-- 案内文や説明文に「10:30開場」「13時以降は不要」と直接書いていると、
-- 時間が変わったときに全部の文面を直すことになる。設定にして
-- {{open}} {{free}} で差し込めるようにする。
--
-- 適用方法（どちらか）:
--   npx wrangler d1 execute buchiiyashi-tickets --remote \
--     --file=./schema/migrations/2026-09-09-add-times.sql
--   または Cloudflare の D1 Studio に貼り付けて実行
--
-- これから作るデータベースには tickets.sql に含まれているので不要。
-- すでに列がある場合は "duplicate column name" になるが、その場合は何もしなくてよい。

ALTER TABLE ticket_types ADD COLUMN open_time TEXT;
ALTER TABLE ticket_types ADD COLUMN free_entry_time TEXT;
