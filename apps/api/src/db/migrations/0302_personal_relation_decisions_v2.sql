-- 0302 —— **本人对建议关系**的确认／隐藏（39d W5-6 刀七；39 §11.3、§16.20）。
--
-- §11.3 的三句：
--  "模型推测的前置、相似或应用关系先作为**待确认建议**，不自动成为实线或影响正式掌握"
--  "用户可**纠正或隐藏**建议关系；关系修改**不伪造过去的学习事实**"
--  "用户确认**首先只影响本人的学习视图**；写入共享关系需具备**材料编辑权**并明确作用范围，
--   **不能让只读成员的确认修改公共知识结构**"
--
-- 今天星图里有什么：`learning_objective_revisions_v2.relations` 是一列 jsonb
-- （`[{objectiveId, relation}]`），`topology-repository.ts:718` 把它读成 `relates_to` 展示边。
-- **没有**"这条是模型推测、待确认"与"这条是已确认"的分层，**也没有**任何一张按人存
-- 确认结果的地方——所以 §11.3 后两句今天**无处执行**。
--
-- 为什么另立一张表，而不是给 `relations` jsonb 加一个 `confirmedBy`：
--  1. 那列是**公共材料血缘**，随目标修订一起定版。把它变成"某个人确认过"就是把个人数据
--     烧进公共快照——正是 §11.3「不能让只读成员的确认修改公共知识结构」要禁止的。
--  2. §11.3 明写"关系修改**不伪造过去的学习事实**"：确认一条关系**不是**一次学习表现，
--     所以它不该落进任何证据表、也不该推进任何安排。这一条由服务层不写那些表来保证。
--  3. 一个人可以确认 A→B 同时隐藏 B→A；方向不同就是不同的行。
--
-- §11.3「关系修改**不伪造过去的学习事实**」在这一列族上的形状是"确认一次关系**不是**一次
-- 学习表现"：所以这张表里不许出现 `observedCount` / `performanceScore` / `reviewedAt`
-- 那一类列。**这一条没有用 CHECK 兜底**——`CHECK (true)` 挡不住任何人加列，写一条
-- 读起来像守卫、实际什么都不拦的约束比不写更糟（下一个加列的人会以为已经拦住了）。
-- 真正拦它的是 `personal-relation-decisions.test.ts` 里的列名守卫：那张表多出任何
-- 一个"表现类"列就红。

CREATE TABLE public.personal_relation_decisions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- §11.3「首先只影响本人的学习视图」：键里必须带 user_id，否则一个人的确认会改掉别人的。
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid REFERENCES public.notes(id) ON DELETE CASCADE,
  -- 边的两端。方向不同就是不同的行（确认 A→B 与隐藏 B→A 可以同时存在）。
  from_objective_id uuid NOT NULL,
  to_objective_id uuid NOT NULL,
  -- 关系本身：`relates_to`（展示语义关系）/ `prerequisite`（理解时需要）/
  -- `explains`（用于解释）/ `contrasts`（可对比）。§11.3 要求这四类分开表达。
  relation text NOT NULL,
  -- confirmed / dismissed（"隐藏建议关系"）。**只有这两种**：没有"第三种"——
  -- 没表态就是不写这一行，而不是写一个 `pending` 状态，那会让"还没看"与"看过并保留"
  -- 在读侧长得一样。
  decision text NOT NULL,
  -- 确认那一刻的依据（模型给的理由 / 来源块）。dismissed 允许为空。
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prd_v2_relation_chk CHECK (relation IN ('relates_to', 'prerequisite', 'explains', 'contrasts')),
  CONSTRAINT prd_v2_decision_chk CHECK (decision IN ('confirmed', 'dismissed')),
  -- 自环不是关系，是数据错误。
  CONSTRAINT prd_v2_no_self_loop_chk CHECK (from_objective_id <> to_objective_id)
);

COMMENT ON TABLE public.personal_relation_decisions_v2 IS
  '39 §11.3：本人对一条建议关系的确认／隐藏；只影响本人视图，不写公共 relations、不伪造学习事实、不进证据表与复习安排';

--> statement-breakpoint

-- 同一个人对**同一条边、同一种关系、同一种表态**至多一行。
-- 改主意走 UPDATE（把 confirmed 翻成 dismissed 或反过来），不是插第二行——
-- 否则读侧要自己判"哪一行更新"，而那正是 §11.3「用户可纠正」想避免的分叉。
CREATE UNIQUE INDEX IF NOT EXISTS prd_v2_ws_user_edge_relation_idx
  ON public.personal_relation_decisions_v2 (workspace_id, user_id, from_objective_id, to_objective_id, relation);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS prd_v2_ws_user_note_idx
  ON public.personal_relation_decisions_v2 (workspace_id, user_id, note_id)
  WHERE note_id IS NOT NULL;

--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['personal_relation_decisions_v2'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_user_isolation ON public.%I
    $p$, t, t);
    -- 与 0300 同一支、不给 worker：这一行是"某个人对某条关系的看法"，
    -- 伴星没有代读别人看法的理由。
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

GRANT SELECT, INSERT, UPDATE, DELETE ON public.personal_relation_decisions_v2 TO astella_api;
GRANT ALL ON public.personal_relation_decisions_v2 TO astella_migrator;
