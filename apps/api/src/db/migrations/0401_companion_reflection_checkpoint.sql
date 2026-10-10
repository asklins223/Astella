-- 0401: 反思的模型输出检查点与「治理拒绝」这个结论码（方案 50 §9.2 / §12.2）。
--
-- ## 为什么要单独一张检查点表
--
-- 反思与日记校订走同一个执行内核（`runAiTask`）：**响应先落检查点，副作用后提交**。
-- 少了这一格，"模型已经答过了但 worker 在这中间断了"就只能重跑一次模型——
-- 多花一次钱是小事，重跑得出另一份结论、于是同一段相处留下两版人格才是大事。
-- 键里带 job / task / task_version / 输入快照哈希三条，换策略版本既不默默复用旧产物，
-- 也不默默重跑已完成的那一步。
--
-- ## 为什么 `governance_denied` 要单独立一个码
--
-- §12.2 要求诊断能分辨「预算/治理拒绝」与「来源不足」。用户没授权外发时，
-- 这一轮反思**根本没有向模型发过任何东西**；把它记成 `insufficient_input`
-- 就等于让排查的人以为"素材不够"，而真实原因是同意状态。多一个枚举值比少一行日志便宜。

ALTER TABLE public.companion_reflections
  DROP CONSTRAINT IF EXISTS companion_reflections_decision_check;

--> statement-breakpoint

ALTER TABLE public.companion_reflections
  ADD CONSTRAINT companion_reflections_decision_check
  CHECK (decision IN ('queued', 'running', 'trigger_none', 'insufficient_input', 'no_change',
                      'proposed', 'committed', 'source_invalid', 'protocol_failed',
                      'commit_conflict', 'lease_lost', 'governance_denied'));

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_reflection_checkpoints (
  job_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  task_version integer NOT NULL,
  input_snapshot_hash text NOT NULL,
  output jsonb NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  -- 固定的是这次回顾**当时看到的那一版人格**：中途人格被改过时，旧检查点不能拿来提交。
  persona_profile_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_reflection_checkpoints_key_unique
    UNIQUE (job_id, task_id, task_version, input_snapshot_hash)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_reflection_checkpoints_user_created_idx
  ON public.companion_reflection_checkpoints (user_id, created_at);

--> statement-breakpoint

ALTER TABLE public.companion_reflection_checkpoints ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.companion_reflection_checkpoints FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY companion_reflection_checkpoints_user_isolation
  ON public.companion_reflection_checkpoints FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_reflection_checkpoints TO astella_worker;

--> statement-breakpoint

GRANT SELECT ON public.companion_reflection_checkpoints TO astella_api

--> statement-breakpoint

--> statement-breakpoint

-- 派生关系要能区分「读过」与「这条结论点名引用的」。
-- 只按读过的全部依据判有效性会判错：一段相处里六句话都被读过，而自我描述只引用了
-- 其中一句——删掉任何一句都不该让那一版失去依据，只有引用那一句被删才算。
ALTER TABLE public.companion_reflection_sources
  DROP CONSTRAINT IF EXISTS companion_reflection_sources_relation_check;

--> statement-breakpoint

ALTER TABLE public.companion_reflection_sources
  ADD CONSTRAINT companion_reflection_sources_relation_check
  CHECK (relation IN ('read', 'cited', 'produced'));

--> statement-breakpoint

-- 检查点随账号一起清除：`user_id` 的 FK 带 ON DELETE CASCADE，
-- 所以"删了这个人的一切"不会留下一份还能被迟到任务捡回来的旧输出。

-- 派生来源的种类要能说出"这次回顾产出了一条合作方法"。
-- 方法（`companion_procedural_playbooks`）与记忆、人格版本是三种不同的东西，
-- 撤回时走的核对也不同，合成一类就会在删方法时漏掉它的来源边。
ALTER TABLE public.companion_reflection_sources
  DROP CONSTRAINT IF EXISTS companion_reflection_sources_kind_check;

--> statement-breakpoint

ALTER TABLE public.companion_reflection_sources
  ADD CONSTRAINT companion_reflection_sources_kind_check
  CHECK (source_kind IN ('user_message', 'assistant_message', 'memory',
                         'tool_receipt', 'persona_revision', 'method'));

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'companion_reflection_checkpoints'
       AND column_name = 'persona_profile_revision'
  ) THEN
    RAISE EXCEPTION 'companion reflection checkpoints do not pin the persona version';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companion_reflections_decision_check'
  ) THEN
    RAISE EXCEPTION 'companion reflection decision codes are not constrained';
  END IF;
END;
$$;
