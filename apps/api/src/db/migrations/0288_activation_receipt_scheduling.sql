-- 0288 —— 激活回执带上"复习授权"的结果（39d W7-2 第二半；裁定 B 见 §19 同日那行）。
--
-- 「保存并开启复习」是一颗**组合命令**：保存 + 建立/关联唯一那条回访安排 + 同一份回执。
-- 组合命令要经得起"客户端没收到响应再来一次"，靠的是 `card_activation_receipts_v2`
-- 里存下来的那份回执原样交回（advisory lock + 按 (workspace_id, idempotency_key) 回读）。
-- 所以授权的结果**必须落在回执上**——否则重放交回的回执比第一次少一格，界面上就出现
-- "同一件事两次读数不一样"。
--
-- 为什么是**新列**而不是塞进 `mappings`：那张表按列存 `mappings` / `lifecycle_results`，
-- 每一列的形状各自对应一份合同；把排期塞进映射里等于让"映射"这个词同时指两件事，
-- 下一个人读 `mappings` 时不知道里面还藏着调度。
--
-- **可空且不加 NOT NULL / DEFAULT**：历史回执行没有这一格。合同侧因此写成 `.optional()`
-- ——加必填会让旧回执在重放时当场解析失败（"加必填字段先数在途行"那一族）。

ALTER TABLE public.card_activation_receipts_v2
  ADD COLUMN IF NOT EXISTS scheduling jsonb;

COMMENT ON COLUMN public.card_activation_receipts_v2.scheduling IS
  '「保存并开启复习」那一发建立/关联到的安排：每个目标一条 {objectiveId, scheduleId, nextReviewAt, created}；NULL = 这一发没有要授权（只保存到卡组）或改列前的历史行';
