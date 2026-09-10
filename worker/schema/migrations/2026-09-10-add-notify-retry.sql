-- 配信の自動再送に使う列を追加する。
-- Workerが起動時に自動で追加するので、ふだんは実行不要。
-- 手で流したい場合のために残してある。
ALTER TABLE applications ADD COLUMN notify_attempts INTEGER;
ALTER TABLE applications ADD COLUMN notify_permanent INTEGER;
ALTER TABLE applications ADD COLUMN notify_failed_at TEXT;
