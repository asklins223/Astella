-- 方案 44 §5：压缩结论的覆盖链、原子提交围栏与覆盖清单。
--
-- 背景（44 §2／§5.2，2026-10-05 按源码核对）：
--   - 摘要器读取**一段**旧历史，不把上一份摘要作为递增输入，于是新摘要默认代表
--     「全部更早历史」——实际上只代表它自己读过的那一段，更早的约束会被静默丢掉；
--   - 读取端只按 coverage_through_seq 取**最新一份**摘要，局部摘要会把更早的索引挤掉；
--   - 提交是 ON CONFLICT DO UPDATE，没有父版本比较，迟到的结果可以覆盖新指针。
--
-- 这次补的只是这三件事需要的存储，不引入用户级滚动摘要表：
--   parent_summary_id        —— 这份摘要接续的是哪一份（接续链，不是覆盖全部历史）
--   revision                 —— 同一来源键上的版本号，用于提交前的父版本比较
--   coverage_manifest        —— 结构化覆盖清单（跨来源 span / 未覆盖区间 / 取回入口）
--   compaction_policy_version —— 压缩策略版本；策略变了旧幂等键不可复用
ALTER TABLE public.conversation_summaries
  ADD COLUMN IF NOT EXISTS parent_summary_id uuid
    REFERENCES public.conversation_summaries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS coverage_manifest jsonb,
  ADD COLUMN IF NOT EXISTS compaction_policy_version text;

-- 同一份摘要不能自称接续自己：接续链必须严格向前，且不能成环。
ALTER TABLE public.conversation_summaries
  DROP CONSTRAINT IF EXISTS conversation_summaries_parent_not_self;
ALTER TABLE public.conversation_summaries
  ADD CONSTRAINT conversation_summaries_parent_not_self
  CHECK (parent_summary_id IS NULL OR parent_summary_id <> id);

ALTER TABLE public.conversation_summaries
  DROP CONSTRAINT IF EXISTS conversation_summaries_revision_positive;
ALTER TABLE public.conversation_summaries
  ADD CONSTRAINT conversation_summaries_revision_positive CHECK (revision >= 1);

-- 接续链回溯：读取端沿 parent 找真正的覆盖起点，而不是只取最新一份局部摘要。
CREATE INDEX IF NOT EXISTS conversation_summaries_parent_idx
  ON public.conversation_summaries (workspace_id, user_id, conversation_id, parent_summary_id);

-- 覆盖清单只在有值时可用于取回闭合判断。
CREATE INDEX IF NOT EXISTS conversation_summaries_manifest_idx
  ON public.conversation_summaries (workspace_id, user_id, conversation_id)
  WHERE coverage_manifest IS NOT NULL;
