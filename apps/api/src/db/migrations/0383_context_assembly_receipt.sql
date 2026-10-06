-- 方案 44 §3.3／§5.5：这次调用**实际**纳入与排除了哪些条目，以及完整请求的预算读数。
--
-- 背景（44 §2，2026-10-05 按源码核对）：
--   `composeAgentContext` 早已产出逐条准入回执（included / empty / budget_omitted），
--   但伴星链路只把它 `logger.info` 掉。后果有两处：
--     - `budget_omitted` 永远只存在于日志，无法回答「这轮她到底没看到什么」；
--     - 完整请求的预算判定（P vs B_hard / T / G）同样只进日志，于是「窗口放大后
--       触发变少」和「预算从来没接上」在数据上长得一模一样。
--
-- 这两列把回执落到 run 上：纳入/排除的条目与字符、判定结果与触发线口径、实际模型路由。
-- 只记条目 id、状态与数字，不记内容。
ALTER TABLE public.companion_turn_runs
  ADD COLUMN IF NOT EXISTS context_assembly_receipt jsonb,
  ADD COLUMN IF NOT EXISTS context_pressure jsonb;

CREATE INDEX IF NOT EXISTS companion_turn_runs_context_pressure_idx
  ON public.companion_turn_runs (workspace_id, conversation_id, created_at DESC)
  WHERE context_pressure IS NOT NULL;
