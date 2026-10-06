-- 方案 44 §5.4 后半：压缩的失败冷却与无进展状态。
--
-- 压缩是一次**有界**尝试。失败以后如果什么都不记，下一轮同一个请求会原样再触发一次——
-- 每轮白折一次、白等一次，而情况一点没变（44 §5.4「同一失败输入不能每轮重新触发」）。
--
-- 键绑定 **(会话, 来源哈希, 模型路由)** 三样：
--   - 换会话 → 另一段历史，上一次的失败对它不成立；
--   - 来源哈希变了 → 摘要或消息已重算，之前那次失败针对的是旧输入；
--   - 换了模型 → 同一请求在另一个窗口下可能根本装得下，不该继承上一位的冷却。
--
-- 只记计数、最后一次原因与时间、最后一次的输入 token 数——不记内容，也不记原文。
CREATE TABLE IF NOT EXISTS public.agent_context_compaction_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  -- 来源版本：摘要的 coverage_source_hash，或消息范围的哈希。
  source_hash char(64) NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  no_progress_streak integer NOT NULL DEFAULT 0,
  last_reason text,
  last_input_tokens bigint,
  last_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_context_compaction_state_attempts_check CHECK (attempts >= 0),
  CONSTRAINT agent_context_compaction_state_streak_check CHECK (no_progress_streak >= 0)
);

-- 同一份失败输入只有一行；并发的两次尝试不会各插一行把计数抹平。
CREATE UNIQUE INDEX IF NOT EXISTS agent_context_compaction_state_key
  ON public.agent_context_compaction_state
    (workspace_id, user_id, conversation_id, source_hash, provider_id, model_id);

-- 按会话清理：连续历史清理删掉摘要与消息时，这份状态也必须一起消失，
-- 否则新会话会继承一段根本没有对应来源的冷却历史。
CREATE INDEX IF NOT EXISTS agent_context_compaction_state_conversation_idx
  ON public.agent_context_compaction_state (workspace_id, user_id, conversation_id);

ALTER TABLE public.agent_context_compaction_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_context_compaction_state_user_isolation ON public.agent_context_compaction_state;
CREATE POLICY agent_context_compaction_state_user_isolation ON public.agent_context_compaction_state FOR ALL
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
     AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_context_compaction_state TO ailearn_worker;
