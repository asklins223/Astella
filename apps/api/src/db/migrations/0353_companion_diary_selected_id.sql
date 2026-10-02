-- 0353: 记住日记这一篇是从哪一段成稿的（PRD 40 §5.7.5 / §13 A56）。
--
-- 迁移前 companion_daily_summaries 只存 selection_reason——**理由的文字**。
-- 于是 A56 说的「正文与选中 ID 一致」没有任何可核对的东西：她选了哪一段只活在
-- 选材步骤的检查点里，成稿那一行只留了一句她自己写的理由。事后无法判断
-- 正文写的是不是她选的那一段，于是这道验收只能靠"再问她一次"。
--
-- 存的是候选 id（不是素材行 id）：选择步骤的输出就是它，成稿只拿选中片段，
-- 两者之间没有第二次改写，因此这一个字符串就是「正文 ↔ 选中片段」的连接键。
--
-- 长度与 companion_diary_selectionSchema.selected_id 同宽（max 80）：写入端
-- 按同一上限收，这里是最后一道数据库侧的闸，不是第二处真相。

ALTER TABLE public.companion_daily_summaries
  ADD COLUMN selected_id text
    CHECK (selected_id IS NULL OR char_length(selected_id) <= 80);

--> statement-breakpoint

COMMENT ON COLUMN public.companion_daily_summaries.selected_id IS
  '选择步骤选中的候选 id；selected_id IS NULL = 她没有选出片段（§5.7.5 允许 null）。旧行为 NULL。';