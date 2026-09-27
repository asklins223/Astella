-- 0300 —— **只对本人可见**的目标绑定（39d W5-6 刀四；39 §4.2、§16.20）。
--
-- §4.2 的原话是："目标的可确认材料身份与本人的计划/观察分开。只读成员可引用已有适用目标，
-- 或**建立只对本人可见的目标绑定**；**不能为了获得稳定 ID 要求公共编辑权**。"
-- §16.20 把它变成验收："学习不需要公共编辑权"。
--
-- 为什么需要一张新表，而不是往 `learning_objective_origins_v2` 上加一列 user_id：
-- 那张表是**空间共用**的（只按 workspace RLS）。一个只读成员把自己的学习路线写进去，
-- 另一位成员打开同一篇就会看到一条他没写过的目标——那正是 §4.2「只对本人可见」要禁止的，
-- 也是 §14.4「每个人的学习位置为个人数据」。给共用表加 user_id 则是把它变成两件事：
-- 一张"公共材料血缘"表和一张"个人计划"表共用同一批列与同一套约束，而它们的**唯一性口径
-- 本来就不同**（公共按 (revision, noteVersion) 唯一，个人按 (人, 那一条计划) 唯一）。
-- 分成两张表，"只读成员不碰公共血缘"就不必靠调用方记得传对参数来保证。
--
-- 身份怎么"可确认"（§4.2「只在目标与修订可确认一致后关联已有个人记录」）：
-- 这一条**不在本迁移里**：要判"这个人的计划就是那个公共目标"，需要 semantic fingerprint
-- 与 revision 两边都对得上，那是 0234 那套口径的事。本表只存
-- `linked_objective_id`（可空）与链接时的判据快照（`link_evidence`），链接由服务层判、
-- 判据不成立就留空——**宁可先不链接，也不要把两条不同的目标说成同一条**。
--
-- 隔离：RLS 按 (workspace_id, user_id) 两列，与 0296 争议表同一支。别人的绑定读不到，
-- 也不被本人的状态影响（§14.4）。

CREATE TABLE public.personal_objective_bindings_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- 本人的计划就是本人的数据：键里必须带 user_id，否则撤一个人的不会只撤他的。
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 来源笔记。**只要求读得到，不要求是本人写的**——这是 §4.2 那句"不能为了获得稳定 ID
  -- 要求公共编辑权"的数据面形状；读权限那一半由服务层按 `visibleNotesCondition` 判。
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  -- 计划所依据的那一版正文（§4.2「本人写正文时」那条冻结语义的轻量版）。
  note_version_id uuid NOT NULL REFERENCES public.note_versions(id) ON DELETE CASCADE,
  -- 本人写下的那句话。**不是公共目标**：不进星图公共关系、不进制卡材料。
  objective_statement text NOT NULL,
  knowledge_form text NOT NULL DEFAULT 'concept',
  concept_label text,
  -- 后来真的出现了可确认的公共目标时，链接到这里（可空，见头注那段"不猜"）。
  linked_objective_id uuid,
  -- 链接那一刻的判据快照：指纹 + revision + 依据。判据变了要能看出来链接是不是还成立。
  link_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- active / superseded（本人自己写的计划被他自己改掉）/ released（主动撤下，不是删）
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text,

  CONSTRAINT pob_v2_statement_chk CHECK (length(objective_statement) > 0),
  CONSTRAINT pob_v2_form_chk CHECK (knowledge_form IN (
    'comparison', 'procedure', 'boundary', 'sequence', 'fact', 'definition',
    'relationship', 'causal_model', 'application_rule'
  )),
  CONSTRAINT pob_v2_status_chk CHECK (status IN ('active', 'superseded', 'released')),
  -- 链接与判据快照必须同时有或同时没有：只有 id 没有判据，链接就不可复核。
  CONSTRAINT pob_v2_link_shape_chk CHECK (
    (linked_objective_id IS NULL AND link_evidence = '{}'::jsonb)
    OR (linked_objective_id IS NOT NULL AND link_evidence <> '{}'::jsonb)
  ),
  -- §4.2「只对本人可见」：同一个人对同一篇同一版**至多一条**活着的计划。
  -- 换一版正文 = 另一条计划（那是新的输入，不是把旧的悄悄改掉）。
  CONSTRAINT pob_v2_release_chk CHECK (released_at IS NULL OR released_at >= created_at)
);

COMMENT ON TABLE public.personal_objective_bindings_v2 IS
  '39 §4.2/§16.20：只读成员为共享笔记建立、只对本人可见的目标绑定；不写公共血缘、不要求公共编辑权';

--> statement-breakpoint

-- 活着的那一份至多一条（部分唯一）。与 0295/0287 同一形状：终态行留历史。
CREATE UNIQUE INDEX IF NOT EXISTS pob_v2_ws_user_note_version_live_idx
  ON public.personal_objective_bindings_v2 (workspace_id, user_id, note_id, note_version_id)
  WHERE released_at IS NULL AND status = 'active';

--> statement-breakpoint

-- 读侧"这个人在这篇上写过什么"是唯一入口，按 (workspace, user) 收。
CREATE INDEX IF NOT EXISTS pob_v2_ws_user_created_idx
  ON public.personal_objective_bindings_v2 (workspace_id, user_id, created_at);

--> statement-breakpoint

-- 撤下与列表的入口。
CREATE INDEX IF NOT EXISTS pob_v2_ws_user_status_idx
  ON public.personal_objective_bindings_v2 (workspace_id, user_id, status, created_at);

--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['personal_objective_bindings_v2'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_user_isolation ON public.%I
    $p$, t, t);
    -- 不给 `CURRENT_USER = 'ailearn_worker'` 那一支：这张表的每一行都是"某个人自己的计划"，
    -- worker 没有读取理由（伴星也不该代读别人的计划）。要看，走本人的会话上下文。
    EXECUTE format($p$
      CREATE POLICY %I_workspace_user_isolation
        ON public.%I AS PERMISSIVE FOR ALL
        USING (
          workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
          AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        )
        WITH CHECK (
          workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
          AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
        )
    $p$, t, t);
  END LOOP;
END $$;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.personal_objective_bindings_v2 TO ailearn_api;
GRANT ALL ON public.personal_objective_bindings_v2 TO ailearn_migrator;
