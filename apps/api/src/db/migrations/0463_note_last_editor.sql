-- 最近编辑者来自实际正文落盘，旧数据保持 NULL，避免把作者冒充为最近编辑者。
ALTER TABLE notes ADD COLUMN IF NOT EXISTS last_edited_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE notes ADD COLUMN IF NOT EXISTS last_edited_at timestamptz;
