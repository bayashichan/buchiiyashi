-- ticket_types に note 列を足す
--
-- 初期のスキーマに note を書き忘れたまま公開してしまった。
-- シードとWorkerのINSERT/SELECTだけがこの列を使っていたため、
-- 管理画面で「table ticket_types has no column named note」が出て、
-- 初期データの投入も失敗していた（券種が0件になる）。
--
-- 適用方法（どちらか）:
--   npx wrangler d1 execute buchiiyashi-tickets --remote \
--     --file=./schema/migrations/2026-09-09-add-note.sql
--   または Cloudflare の D1 Studio に貼り付けて実行
--
-- そのあと、券種が0件なら seed-6th.sql をもう一度実行すること。
--
-- これから作るデータベースには tickets.sql に含まれているので不要。
-- すでに note 列がある場合は "duplicate column name" になるが、
-- その場合は何もしなくてよい。

ALTER TABLE ticket_types ADD COLUMN note TEXT;
