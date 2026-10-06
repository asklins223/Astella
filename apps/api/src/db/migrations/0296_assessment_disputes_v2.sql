-- 0296 —— 学习判定的「争议与更正」数据面（39d W5-5；39 §14.2、§9.6、§16.11、§16.22、§16.25）。
--
-- 这批是**先有事实、没有出口**的那一类欠账：§14.2 早就写明"用户可以报告'解释不对'
-- '题目有问题''我的意思被误解'""更正以新的有理由记录表达，不重写历史原回答"，
-- 而全仓没有任何一处能接这句话——`learning_assessments` 一旦落成终态就只有
-- `report_hash` 一个可追溯入口，用户不同意时既无处记录，也没有任何不重写历史的改法。
--
-- 为什么是两张表（详见 packages/shared/src/db-schema/assessment-disputes.ts 头注）：
--  1. 争议行可变（受理 → 复核 → 收尾），更正行**只追加**。合成一张表，要保留更正
--     历史就只能反复改写状态列——那正是 §14.2 禁止的形状。
--  2. §16.25 要把「系统误判更正」与「用户补答」分开计数，两者依据不同（前者是同一份
--     原回答，后者是用户后来补的作答）。两行两表让"混算"在查询层就不可能发生。
--
-- 三条被写进数据库、而不是只写在服务层的规则：
--  * `recheck_count <= 1` —— §16.22「争议不形成死循环」。判据在
--    `decideDisputeRecheckV2`（为了给出可念的理由），这一列是为了让绕过服务层的
--    写路径也被挡下：只留判据时一次重试就能多跑一轮模型，只留 CHECK 时调用方拿不到
--    能翻成 409 的原因。
--  * `assessment_disputes_v2_assessment_unique_idx`（**无条件**）—— §14.2 给"仍有争议"
--    的出口是"可结束并将该项暂不安排"，**不是**"再开一次"。写成 `WHERE closed_at IS NULL`
--    就等于允许对同一次判定反复开新轮次，那正是要挡的循环。要再争就换一次作答，
--    那条路由 `assessment_corrections_v2.user_supplement` 覆盖。
--  * `assessment_corrections_v2_dispute_unique_idx` —— 同一次更正消费两次，界面上会显示
--    成两次表现，也就是 §9.6 禁止的"重复消费同一日程"。
--
-- 「结束并暂不安排」**不新建机制**：复用 0295 的 `objective_review_holds_v2`
-- （§9.1 规则表行 2 把它定义为优先于笔记与卡片授权的持续排除），并借它已有的
-- "连带撤下此刻已排着的那一条待办"行为。
--
-- 隔离：§14.4「每个人的作答……为个人数据」——RLS 按 (workspace_id, user_id)；
-- 另一位成员读不到这条记录，也不被它影响。沿用 0116 那份 policy 的形状，包括
-- `CURRENT_USER = 'astella_worker'` 那一支（worker 侧的结算要读"这次判定有没有活争议"）。

CREATE TABLE public.assessment_disputes_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 被质疑的那一次判定。级联删：判定没了，争议也就没有对象。
  assessment_id uuid NOT NULL REFERENCES public.learning_assessments(id) ON DELETE CASCADE,
  -- 原答案（不可变产物）。§14.2「争议记录关联原产物和版本」，所以版本是**冻结**的两列
  -- 而不是 join 出来的现值：产物行日后被 supersede，争议仍要指向当时那一版。
  artifact_id uuid NOT NULL REFERENCES public.learning_artifacts(id) ON DELETE CASCADE,
  artifact_revision integer NOT NULL,
  artifact_payload_hash text NOT NULL,
  -- 受影响的目标（可空：那次观察没挂目标时就判不出来）。"暂不安排"按它生效。
  objective_id uuid,
  review_dimension text NOT NULL DEFAULT '',
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  statement text NOT NULL,
  -- §14.2「用户提出争议后，可补充说明」；**不重开**已落库的复核。
  supplement text,
  recheck_outcome text,
  recheck_reason text,
  recheck_report_hash text,
  recheck_count integer NOT NULL DEFAULT 0,
  correction_applied_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT adv2_kind_chk CHECK (kind IN ('explanation_faulty', 'item_faulty', 'misunderstood', 'misjudged')),
  CONSTRAINT adv2_status_chk CHECK (status IN ('open', 'recheck_upheld', 'recheck_corrected', 'recheck_undetermined', 'closed_held')),
  -- §16.22 的硬闸：至多一次重新检查。
  CONSTRAINT adv2_recheck_once_chk CHECK (recheck_count <= 1),
  -- 分成两条而不是一条：失败形状不同。「open 却带结论」是有结论没走状态；
  -- 「带结论但 recheck_count=0」会让 §16.22 的闸门统计失真（读数恒 0，像从没复核过）。
  CONSTRAINT adv2_open_no_outcome_chk CHECK (status <> 'open' OR (recheck_outcome IS NULL AND recheck_count = 0)),
  CONSTRAINT adv2_rechecked_has_outcome_chk CHECK (
    recheck_count = 0 OR (recheck_outcome IS NOT NULL AND recheck_report_hash IS NOT NULL AND recheck_reason IS NOT NULL)
  ),
  CONSTRAINT adv2_outcome_chk CHECK (recheck_outcome IS NULL OR recheck_outcome IN ('upheld', 'corrected', 'undetermined')),
  CONSTRAINT adv2_corrected_has_reason_chk CHECK (status <> 'recheck_corrected' OR recheck_outcome = 'corrected'),
  CONSTRAINT adv2_statement_chk CHECK (length(statement) > 0),
  CONSTRAINT adv2_revision_chk CHECK (artifact_revision >= 1)
);

COMMENT ON TABLE public.assessment_disputes_v2 IS
  '39 §14.2：本人对某一次判定提出的争议；关联原产物与冻结版本，一个判定至多一份，复核至多一次（§16.22）';

--> statement-breakpoint

-- 无条件部分：带 `WHERE closed_at IS NULL` 就等于允许关掉后对同一次判定再开一轮。
CREATE UNIQUE INDEX IF NOT EXISTS assessment_disputes_v2_assessment_unique_idx
  ON public.assessment_disputes_v2 (assessment_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assessment_disputes_v2_ws_user_idx
  ON public.assessment_disputes_v2 (workspace_id, user_id, created_at);

--> statement-breakpoint

-- "这个目标现在有没有活争议"是结算那一发唯一要问的问题（判据二
-- `decideDisputedObservationV2` 的入参），所以单独给它一条按目标的索引。
CREATE INDEX IF NOT EXISTS assessment_disputes_v2_objective_idx
  ON public.assessment_disputes_v2 (workspace_id, user_id, objective_id);

--> statement-breakpoint

CREATE TABLE public.assessment_corrections_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dispute_id uuid NOT NULL REFERENCES public.assessment_disputes_v2(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL REFERENCES public.learning_assessments(id) ON DELETE CASCADE,
  kind text NOT NULL,
  -- §14.2 更正必须是"有理由"的。
  reason text NOT NULL,
  -- `user_supplement` 必填（§16.25「记录补充后的表现」要指得出是哪一次表现）；
  -- `system_misjudgment` 恒为 null——它依据的仍是**同一份**原回答，另挂一次作答
  -- 会让两档在数据上长得一样。
  supplement_artifact_id uuid REFERENCES public.learning_artifacts(id) ON DELETE SET NULL,
  -- 原判逐条结果快照。**不改** learning_assessments.rubric_results（§14.2 不重写历史）。
  superseded_rubric_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  corrected_rubric_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT acv2_kind_chk CHECK (kind IN ('system_misjudgment', 'user_supplement')),
  -- §16.25 两档的形状差异在数据面上钉住：补答必挂一次新作答，系统误判必不挂。
  CONSTRAINT acv2_supplement_shape_chk CHECK (
    (kind = 'user_supplement' AND supplement_artifact_id IS NOT NULL)
    OR (kind = 'system_misjudgment' AND supplement_artifact_id IS NULL)
  ),
  CONSTRAINT acv2_reason_chk CHECK (length(reason) > 0)
);

COMMENT ON TABLE public.assessment_corrections_v2 IS
  '39 §14.2/§16.25：只追加的更正记录；一次争议至多一条，不覆盖也不倒算第一次回答';

--> statement-breakpoint

-- 同一次更正消费两次 = 界面上两次表现 = §9.6 禁止的"重复消费同一日程"。
CREATE UNIQUE INDEX IF NOT EXISTS assessment_corrections_v2_dispute_unique_idx
  ON public.assessment_corrections_v2 (dispute_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assessment_corrections_v2_ws_user_idx
  ON public.assessment_corrections_v2 (workspace_id, user_id, created_at);

--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['assessment_disputes_v2', 'assessment_corrections_v2'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS %I_workspace_user_isolation ON public.%I
    $p$, t, t);
    -- 与 0116 同一形状：worker 侧要读"这次判定有没有活争议"（判据二的入参），
    -- 所以保留 `CURRENT_USER = 'astella_worker'` 那一支；API 侧一律按会话身份。
    EXECUTE format($p$
      CREATE POLICY %I_workspace_user_isolation
        ON public.%I AS PERMISSIVE FOR ALL
        USING (
          CURRENT_USER = 'astella_worker'
          OR (
            workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
            AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          )
        )
        WITH CHECK (
          CURRENT_USER = 'astella_worker'
          OR (
            workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
            AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
          )
        )
    $p$, t, t);
  END LOOP;
END $$;

--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_disputes_v2 TO astella_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_corrections_v2 TO astella_api;
GRANT ALL ON public.assessment_disputes_v2 TO astella_migrator;
GRANT ALL ON public.assessment_corrections_v2 TO astella_migrator;
