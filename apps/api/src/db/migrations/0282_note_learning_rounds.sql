-- 0282 —— 轮次实体 `note_learning_rounds`（39d W4-5 第一刀；施工单是 D1 §6 那七条）。
--
-- 改之前的事实：一次"从开始到收尾"的学习活动今天只有 `learning_runs` 那一台**单题机器**
-- （锁答→暴露→评估→提交→交接调度，12 值 phase，30..180 秒预算写在 schema 上）。
-- PRD §3.2/§3.3/§5.5 说的"一轮笔记学习"（本轮问题、计划与修订、可恢复暂停、终态原因、
-- 跨轮聚合的归属点）在任何表上都没有落点——D1 §0 的结论是它是 `learning_runs` 的
-- **外层容器**，不是第六个 goal，也不是第二套状态机。
--
-- 这张表只承载 D1 §3.1–3.4 交给轮次的那几件事实，七条数据约束逐条落地：
--  1. **部分唯一索引**（§6.1）：同 `(workspace_id, user_id, note_id)` 至多一条
--     `phase IN ('active','paused')`——"同一篇默认只有一个进行中或暂停的旅程"由索引兜住，
--     不靠应用层先查后写。§3.1 那句"要另开一轮必须先封存旧轮"因此是物理性的。
--  2. **归属不可变**（§6.2）：`nlr_ownership_immutable` 触发器挡掉对三件套的 UPDATE；
--     需要换笔记 = 新建轮次，不是搬迁。
--  3. **`revision` 单调**（§6.3）：状态与计划修订**共用这一个**计数器（所以这里没有
--     `plan_revision` 那种第二列——两个计数器迟早分叉），DB 侧再挡一次倒退，
--     CAS 写在服务层。
--  4. **快照引用不可变**（§6.4）：轮次**只引用**内容快照，不内联正文副本。三件按 D3 §0
--     实测到的既有锚点接，不新造一张快照表：`note_version_id`（哪一版）＋
--     `source_content_hash`（整篇那一层，值来自 `note_versions.content_hash`）＋
--     `evidence_snapshot_ids`（这一轮用了哪几段摘录，锚点在 `evidence_snapshots_v2`，
--     块级/来源级哈希与不可变副本各自已经在那两张表上）。D3 明确禁止"只存
--     `noteVersionId`"，所以哈希与摘录集合是必填列的一部分，不是可省的备注。
--  5. **RLS**（§6.5）：ENABLE + FORCE，谓词是纯 `(workspace_id, user_id)` GUC 匹配。
--     **这里没有 `CURRENT_USER = 'ailearn_worker'` 那一条旁路**（learning_runs 有），
--     因为 D1 §6.5 写死了"轮次与学习线都不给 worker 开跨租户读"；连带也不给
--     `ailearn_worker` 任何 GRANT——今天它没有读需求，将来有需求要走一次独立决定。
--  6. **不建空行**（§6.6）：这张表没有默认行、也没有"每篇笔记一条"的唯一约束；
--     服务侧第一次产生轮次时才建（与 39 §8.5 同取向）。
--  7. **轮次不存聚合结论**（§6.7）：表上**没有**任何"当前掌握度/亮度/百分比/未解决缺口"
--     字段——那些是投影，从轮次与观察现算。将来谁想加，先改 D1。
--
-- 三项预算（D1 §3.2「maxModelCalls / maxWallClockSeconds / maxTasks 缺一不可」）是
-- **NOT NULL 且没有 DEFAULT**：§18.4 把起点值列为"试用前冻结"项，本文件不替它编一个数。
-- 于是每一条 INSERT 都必须显式带三份预算——这正是想要的效果：没有预算的轮次建不出来。
--
-- 存量：**无**。这是新表。dev/alpha 库按 AGENTS.md 可重建，不背兼容包袱。

CREATE TABLE public.note_learning_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note_id uuid NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  phase text NOT NULL DEFAULT 'active',
  outcome text,
  driving_question text NOT NULL,
  driving_question_source text NOT NULL,
  driving_question_revision integer NOT NULL DEFAULT 1,
  note_version_id uuid NOT NULL REFERENCES public.note_versions(id) ON DELETE CASCADE,
  source_content_hash text NOT NULL,
  evidence_snapshot_ids uuid[] NOT NULL DEFAULT '{}',
  max_model_calls integer NOT NULL,
  max_wall_clock_seconds integer NOT NULL,
  max_tasks integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  paused_at timestamp with time zone,
  resumed_at timestamp with time zone,
  closed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT nlr_phase_chk CHECK (phase IN ('active', 'paused', 'closed')),
  CONSTRAINT nlr_outcome_chk CHECK (outcome IS NULL OR outcome IN (
    'completed', 'partial', 'superseded', 'system_failure'
  )),
  -- D1 §3.3：`closed` 是终态且必带原因；反过来"有原因/有关闭时间"也只可能出现在终态。
  -- 写成双向 `=`，是为了让"偷偷写一个 outcome 但还没收尾"这种状态根本表达不出来。
  CONSTRAINT nlr_closed_needs_outcome_chk CHECK ((phase = 'closed') = (outcome IS NOT NULL)),
  CONSTRAINT nlr_closed_needs_closed_at_chk CHECK ((phase = 'closed') = (closed_at IS NOT NULL)),
  -- 「可改写」是 §3.3 的产品要求，所以来源必须是三档之一：系统建议的／用户改过的／
  -- 用户自己写的。压成布尔位就分不出"她改了"和"她没动"。
  CONSTRAINT nlr_question_source_chk CHECK (driving_question_source IN (
    'suggested', 'user_rewritten', 'user_authored'
  )),
  CONSTRAINT nlr_question_len_chk CHECK (char_length(driving_question) BETWEEN 1 AND 500),
  CONSTRAINT nlr_question_rev_chk CHECK (driving_question_revision >= 1),
  CONSTRAINT nlr_revision_chk CHECK (revision >= 1),
  CONSTRAINT nlr_budget_model_calls_chk CHECK (max_model_calls >= 0),
  CONSTRAINT nlr_budget_wall_clock_chk CHECK (max_wall_clock_seconds >= 0),
  CONSTRAINT nlr_budget_tasks_chk CHECK (max_tasks >= 0),
  CONSTRAINT nlr_source_hash_chk CHECK (char_length(source_content_hash) = 64)
);

--> statement-breakpoint

-- D1 §6.1 的原话形状：部分唯一索引，不是普通索引加一句应用层判空。
CREATE UNIQUE INDEX nlr_ws_user_note_open_unique ON public.note_learning_rounds
  (workspace_id, user_id, note_id)
  WHERE phase IN ('active', 'paused');

--> statement-breakpoint

-- 结果页与完整历史按（笔记, 本人）分页读（§5.6）；这一条与上面那条唯一索引不重复——
-- 唯一索引只盖住未完成的两档，历史是全档倒序。
CREATE INDEX nlr_ws_user_note_created_idx ON public.note_learning_rounds
  (workspace_id, user_id, note_id, created_at DESC);

--> statement-breakpoint

ALTER TABLE public.note_learning_rounds ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.note_learning_rounds FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- 与 learning_runs 同形，但**去掉 worker 那一支**（D1 §6.5）。
CREATE POLICY nlr_workspace_user_isolation ON public.note_learning_rounds
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING ((
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ))
  WITH CHECK ((
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ));

--> statement-breakpoint

-- 权限写在迁移里（0275 那一课：`roles.sql` 按 ALL TABLES 授，只覆盖建表在它之前的库；
-- 增量迁移不补 GRANT，症状是运行期 permission denied）。
-- worker 一侧**故意一句都不给**。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_learning_rounds TO ailearn_api;
GRANT ALL PRIVILEGES ON public.note_learning_rounds TO ailearn_migrator;

--> statement-breakpoint

-- 归属三件套不可变（§6.2）。`app.allow_history_mutation` 那道绕行口子沿用 0180 的形状：
-- 生产链路永不设置它，只有集测清理与显式维护脚本能用。
CREATE OR REPLACE FUNCTION public.prevent_note_learning_round_ownership_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.note_id IS DISTINCT FROM OLD.note_id
     OR NEW.note_version_id IS DISTINCT FROM OLD.note_version_id
     OR NEW.source_content_hash IS DISTINCT FROM OLD.source_content_hash THEN
    RAISE EXCEPTION
      'note_learning_rounds identity is immutable: ownership and the frozen content reference cannot be rewritten (% on %)',
      TG_OP, TG_TABLE_NAME;
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'note_learning_rounds revision must move forward (old=%, new=%)',
      OLD.revision, NEW.revision;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER nlr_identity_immutable BEFORE UPDATE ON public.note_learning_rounds
  FOR EACH ROW EXECUTE FUNCTION public.prevent_note_learning_round_ownership_mutation();

--> statement-breakpoint

COMMENT ON TABLE public.note_learning_rounds IS
  '一轮笔记学习（D1 §3、§6；39d W4-5）。learning_runs 的外层容器：本轮问题／计划与修订共用 revision／可恢复暂停／终态原因。不存任何聚合结论，不内联正文副本（只引用 note_version_id + source_content_hash + evidence_snapshot_ids）。';

--> statement-breakpoint

-- 注意这条是 `COMMENT ON INDEX` 不是 `COMMENT ON CONSTRAINT`：`CREATE UNIQUE INDEX`
-- 建出来的是索引对象，PG 里没有同名的 constraint 对象（写成 CONSTRAINT 会在迁移里
-- 当场失败：constraint "nlr_ws_user_note_open_unique" for table ... does not exist）。
COMMENT ON INDEX nlr_ws_user_note_open_unique IS
  'D1 §6.1：同一 (workspace, user, note) 至多一条未完成轮次。要另开一轮必须先封存旧轮，由这条索引兜住而不是应用层先查后写。';
