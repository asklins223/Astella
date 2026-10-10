-- 0400: 伴星成长的持久化 —— 提案身份、反思记录与有类型的派生来源（方案 50 §8.3 / §9.3）。
--
-- ## 为什么一次迁移带三样东西
--
-- 1. **提案身份**（版本行上的 `proposal_kind` / `proposal_id`）
--    `author='assistant_tool'` 只说明正文归她，答不出「这一版出自哪一次提议」。少了这一层，
--    上一轮**没被采用**的排队会被下一轮（或另一个空间的后台反思）当成自己的底稿继续改——
--    两条互不相干的建议合成一版，而用户只提过一次要求（§4 新增并发风险）。
--
-- 2. **反思记录**（`companion_reflections`）
--    执行状态仍然由 `jobs` / attempt / checkpoint 持有，这张表只记「这一次回顾看了哪一段、
--    按哪一版人格看的、结论是什么、留下了哪一版待生效」。没有它，"她改了人格"与
--    "她回顾过但觉得不值得改"在库里长得一样，§12.2 要求分辨的那些结果码就无处可记。
--    它**不**再管一份 running/lease 状态机——那是现役 job 的职责。
--
-- 3. **有类型的派生来源**（`companion_reflection_sources`）
--    撤回要能顺着关系走：原文被删 → 依赖它的经验停用 → 由该来源支持的人格修改取消 pending
--    或生成修订（§9.4）。只有一张表的话，"这次反思读过什么"与"这次反思产出了什么"会混在
--    一起，递进核对就没法只挑一边。
--
-- 新增列都可空、无回填：旧档案与旧版本行按原设定读取，不会被这次迁移制造成"成长过一版"。

ALTER TABLE public.companion_persona_profile_versions
  ADD COLUMN IF NOT EXISTS proposal_kind text,
  ADD COLUMN IF NOT EXISTS proposal_id text;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.companion_persona_profile_versions
    ADD CONSTRAINT companion_persona_profile_versions_proposal_kind_check
    CHECK (proposal_kind IS NULL OR proposal_kind IN ('assistant_tool', 'assistant_reflection'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE public.companion_persona_profile_versions
    ADD CONSTRAINT companion_persona_profile_versions_proposal_pair_check
    CHECK (proposal_kind IS NULL OR (proposal_kind IS NOT NULL AND proposal_id IS NOT NULL));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_persona_profile_versions_proposal_idx
  ON public.companion_persona_profile_versions (user_id, proposal_kind, proposal_id);

--> statement-breakpoint

COMMENT ON COLUMN public.companion_persona_profile_versions.proposal_id IS
  '哪一次提议排下了这一版：前台是 run_id，后台是 reflection_id。不同提案的未采用排队'
  '不互为改稿底稿（方案 50 §9.3）；NULL 表示来源不明的历史版本，不参与延续判断。';

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  job_id uuid,
  trigger_kind text NOT NULL,
  input_from_seq bigint NOT NULL,
  input_to_seq bigint NOT NULL,
  input_fingerprint text NOT NULL,
  dedupe_key text NOT NULL,
  strategy_version text NOT NULL,
  baseline_persona_revision integer NOT NULL,
  decision text NOT NULL DEFAULT 'queued',
  decision_summary text,
  pending_persona_revision integer,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_reflections_trigger_kind_check
    CHECK (trigger_kind IN ('exchange_segment')),
  CONSTRAINT companion_reflections_decision_check
    CHECK (decision IN ('queued', 'running', 'trigger_none', 'insufficient_input', 'no_change',
                        'proposed', 'committed', 'source_invalid', 'protocol_failed',
                        'commit_conflict', 'lease_lost')),
  CONSTRAINT companion_reflections_watermark_order_check
    CHECK (input_to_seq > input_from_seq),
  CONSTRAINT companion_reflections_summary_size_check
    CHECK (decision_summary IS NULL OR length(decision_summary) <= 300)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_reflections_dedupe_unique
  ON public.companion_reflections (user_id, dedupe_key);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_reflections_conversation_watermark_idx
  ON public.companion_reflections (conversation_id, input_to_seq DESC);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_reflections_account_open_idx
  ON public.companion_reflections (user_id, created_at)
  WHERE decision IN ('queued', 'running');

--> statement-breakpoint

COMMENT ON TABLE public.companion_reflections IS
  '一次有界后台反思的输入水位与结论（方案 50 §8.3）。执行状态归 jobs/attempt/checkpoint；'
  '本表只记读了哪一段、按哪一版人格、决定码与产出的版本引用。'
  'decision_summary 是脱敏短句，不放模型隐藏推理，也不放用户原文。';

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.companion_reflection_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reflection_id uuid NOT NULL REFERENCES public.companion_reflections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  relation text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_revision text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_reflection_sources_relation_check
    CHECK (relation IN ('read', 'produced')),
  CONSTRAINT companion_reflection_sources_kind_check
    CHECK (source_kind IN ('user_message', 'assistant_message', 'memory',
                           'tool_receipt', 'persona_revision'))
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS companion_reflection_sources_edge_unique
  ON public.companion_reflection_sources (reflection_id, relation, source_kind, source_id, source_revision);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS companion_reflection_sources_target_idx
  ON public.companion_reflection_sources (user_id, source_kind, source_id);

--> statement-breakpoint

COMMENT ON TABLE public.companion_reflection_sources IS
  '有类型的派生关系：read = 这次反思读过的依据；produced = 这次反思产出的记忆/方法/人格版本。'
  '来源删除与撤回沿 read 边递进核对，迟到任务不能靠 produced 边把已撤销的内容放回上下文。';

--> statement-breakpoint

ALTER TABLE public.companion_reflections ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.companion_reflections FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY companion_reflections_user_isolation
  ON public.companion_reflections FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)

--> statement-breakpoint

ALTER TABLE public.companion_reflection_sources ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.companion_reflection_sources FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY companion_reflection_sources_user_isolation
  ON public.companion_reflection_sources FOR ALL
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_reflections TO astella_api;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_reflection_sources TO astella_api;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_reflections TO astella_worker;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companion_reflection_sources TO astella_worker

--> statement-breakpoint

-- worker 只能投白名单里的类型（0182 起这条策略就是那道闸）；反思接进现役队列就要登记。
DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard" ON public.jobs;

--> statement-breakpoint

CREATE POLICY "worker_type_allowlist_insert_guard"
  ON public.jobs
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    CURRENT_USER = 'astella_worker'::name
    AND "type" IN (
      'companion_agent', 'companion_memory_extract', 'companion_summarizer',
      'companion_daily_summary', 'companion_memory_organize', 'companion_reflection'
    )
  )

--> statement-breakpoint

-- 反思的门槛数字住在这里，判据实现住在 worker 的 companion-reflection-gate.ts。
-- 两处写同一个数会漂移，所以由 0400 的迁移测试断言它们与 TS 常量一致
-- （沿用 0361 那条已经生效的做法）。
CREATE OR REPLACE FUNCTION public.astella_companion_reflection_thresholds()
RETURNS TABLE (min_user_messages bigint, min_assistant_messages bigint,
               min_interval_hours int, max_open_per_account int)
LANGUAGE sql
STABLE
AS $$
  SELECT 3::bigint, 2::bigint, 24::int, 3::int;
$$;

--> statement-breakpoint

-- 挑出「值得回顾」的会话段落并投 job。
--
-- 门槛是**结构性**的，不是语义判断：这一段里至少有 3 条用户发言和 2 条她已交付的回复，
-- 也就是说真的来回过。什么算纠正、什么经验值得留下，交给那次有模型的回顾去判
-- （它可以答 no_change）。用关键词去猜"这是不是一次反馈"正是方案 50 §3 不收的那类启发式。
--
-- 三条闸门：
--   * 水位：从上一条反思的 input_to_seq 往后看，同一段不重复回顾；
--   * 间隔：同一会话 24h 内最多一次，低频用户靠段落累计而不是靠定时器；
--   * 积压：同一账号最多 3 条未处理，超了就等上一批走完（§9.2 的「记录 backlog」）。
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_reflection()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_thresholds record;
  v_inserted integer := 0;
  v_row record;
BEGIN
  SELECT * INTO v_thresholds FROM public.astella_companion_reflection_thresholds();

  FOR v_row IN
    WITH watermark AS (
      SELECT conversation_id, max(input_to_seq) AS last_seq, max(created_at) AS last_at
        FROM public.companion_reflections
       GROUP BY conversation_id
    ),
    open_count AS (
      SELECT user_id, count(*)::int AS open
        FROM public.companion_reflections
       WHERE decision IN ('queued', 'running')
       GROUP BY user_id
    ),
    segment AS (
      SELECT c.id AS conversation_id,
             c.workspace_id,
             c.user_id,
             COALESCE(w.last_seq, 0) AS from_seq,
             max(m.seq) AS to_seq,
             count(*) FILTER (WHERE m.role = 'user') AS user_count,
             count(*) FILTER (WHERE m.role = 'assistant') AS assistant_count
        FROM public.companion_conversations c
        JOIN public.companion_messages m ON m.conversation_id = c.id
        LEFT JOIN watermark w ON w.conversation_id = c.id
       WHERE c.status = 'active'
         AND m.seq > COALESCE(w.last_seq, 0)
       GROUP BY c.id, c.workspace_id, c.user_id, w.last_seq
      HAVING count(*) FILTER (WHERE m.role = 'user') >= v_thresholds.min_user_messages
         AND count(*) FILTER (WHERE m.role = 'assistant') >= v_thresholds.min_assistant_messages
    )
    SELECT s.conversation_id, s.workspace_id, s.user_id, s.from_seq, s.to_seq
      FROM segment s
      LEFT JOIN watermark w ON w.conversation_id = s.conversation_id
      LEFT JOIN open_count o ON o.user_id = s.user_id
     WHERE (w.last_at IS NULL OR w.last_at <= now() - make_interval(hours => v_thresholds.min_interval_hours))
       AND COALESCE(o.open, 0) < v_thresholds.max_open_per_account
       -- 段落必须真的结束在一条她已交付的回复之后：末尾是用户还在说话时不回顾。
       AND EXISTS (
         SELECT 1 FROM public.companion_messages last
          WHERE last.conversation_id = s.conversation_id
            AND last.seq = s.to_seq AND last.role = 'assistant'
       )
       -- 同一段不落两次（幂等键含水位，这里是提前退出省一次 INSERT）。
       AND NOT EXISTS (
         SELECT 1 FROM public.jobs j
          WHERE j.workspace_id = s.workspace_id
            AND j.type = 'companion_reflection'
            AND j.idempotency_key = 'companion-reflection:' || s.conversation_id::text || ':' || s.to_seq::text
       )
  LOOP
    INSERT INTO public.jobs
      (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
    VALUES (
      'companion_reflection',
      v_row.workspace_id,
      v_row.user_id,
      jsonb_build_object(
        'userId', v_row.user_id::text,
        'workspaceId', v_row.workspace_id::text,
        'conversationId', v_row.conversation_id::text,
        'fromSeq', v_row.from_seq,
        'toSeq', v_row.to_seq
      ),
      'pending', 30, 'maintenance',
      'companion-reflection:' || v_row.conversation_id::text || ':' || v_row.to_seq::text
    )
    ON CONFLICT (workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING;
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_enqueue_companion_reflection() FROM PUBLIC;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_companion_reflection_thresholds() FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.astella_enqueue_companion_reflection() TO astella_worker;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.astella_companion_reflection_thresholds() TO astella_worker

--> statement-breakpoint

-- 约束与函数真的落上了吗（沿用 0355 的自检做法）：迁移被裁剪、被手工改过，
-- 或在旧库上重跑时，这里当场炸，而不是等到第一次反思写不进队列才发现。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'companion_persona_profile_versions'
       AND column_name = 'proposal_kind'
  ) THEN
    RAISE EXCEPTION 'companion persona proposal identity columns are missing';
  END IF;
  IF to_regclass('public.companion_reflections') IS NULL
    OR to_regclass('public.companion_reflection_sources') IS NULL THEN
    RAISE EXCEPTION 'companion reflection tables are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companion_reflections_watermark_order_check'
  ) THEN
    RAISE EXCEPTION 'companion reflection watermark ordering is not enforced';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
      JOIN pg_class rel ON rel.oid = pol.polrelid
     WHERE rel.relname = 'companion_reflections'
       AND pol.polname = 'companion_reflections_user_isolation'
  ) THEN
    RAISE EXCEPTION 'companion reflections have no user isolation policy';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'astella_enqueue_companion_reflection'
  ) THEN
    RAISE EXCEPTION 'companion reflection enqueue function is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polname = 'worker_type_allowlist_insert_guard'
  ) THEN
    RAISE EXCEPTION 'worker job type allowlist policy is missing';
  END IF;
END;
$$;
