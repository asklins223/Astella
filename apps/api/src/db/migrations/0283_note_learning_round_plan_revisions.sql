-- 0283 —— 轮次计划的追加式修订 `note_learning_round_plan_revisions`（39d W4-5 第三刀）。
--
-- 改之前的事实：轮次行（0282）上只有 `driving_question` 与那个**状态与计划共用**的
-- `revision` 计数器（D1 §6.3），计划本体没有任何落点。D3 §5 的要求是：「计划调整
-- **保留理由与版本**，历史记录**实际走过的内容**，不能覆盖最初计划并伪装从未变更」，
-- 落地形状是**追加式**：「计划是追加式修订（每次调整记一条：理由、时间、变更前后），
-- 不是覆盖写」。所以这里是一张**只插不改不删**的子表，不在轮次行上放一个会被
-- 覆写的 `plan` 列。
--
-- 每一版计划记四件事（D3 §5 逐字对应）：
--   - `plan`：计划本体（`roundPlanV1` 合同：问题在轮次行上，不在这里重复；步骤、
--     预计量级、结束条件。§4.3「试用默认可从 2–4 个相关要点起步」是产品初始参数，
--     合同只定 1..8 的硬边界，不替试用冻结起点值）；
--   - `reason`：为什么改（1..500 字，必填——没有理由的计划修订不落库）；
--   - `created_at`：时间；
--   - 「变更前后」：前一版就是上一行（按 `plan_ordinal` 读序），不重复存两份；
--     `round_revision` 记写入时那个共用计数器的值（D1 §6.3：计划修订随写随推进
--     轮次 revision），pause/resume 等不改计划的写动作**不**产生新计划行——
--     所以 `round_revision` 在这张表里不连续，那是设计（状态变化与计划变化可区分）。
--
-- 只追加由触发器保证：挡 UPDATE/DELETE（沿用 `app.allow_history_mutation`
-- 绕行口子，生产链路永不设置它，集测清理与显式维护脚本能用）。迁移内对
-- `ailearn_api` 只授 SELECT/INSERT，但仓库的 roles 步骤（迁移后 `apply_roles`，
-- 与 CI fresh-migrations 同序）会把新表权限放宽到 ALL——所以"只追加"这个
-- 不变量的家在**触发器**，不在表权限（0180 的共用触发器同一道理）。
--
-- RLS 与 0282 同形（ENABLE + FORCE，纯 (workspace_id, user_id) GUC 匹配，
-- 无 worker 旁路——D1 §6.5 对轮次族一律不给 worker 开跨租户读）。
--
-- 存量：**无**。这是新表。

CREATE TABLE public.note_learning_round_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES public.note_learning_rounds(id) ON DELETE CASCADE,
  plan_ordinal integer NOT NULL,
  round_revision integer NOT NULL,
  plan jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT nlpr_ordinal_chk CHECK (plan_ordinal >= 1),
  CONSTRAINT nlpr_round_revision_chk CHECK (round_revision >= 1),
  CONSTRAINT nlpr_reason_len_chk CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT nlpr_plan_json_chk CHECK (jsonb_typeof(plan) = 'object')
);

--> statement-breakpoint

-- 同一轮里第几版计划是唯一的；按它读序就是「最初 → 现在」的完整历史。
CREATE UNIQUE INDEX nlpr_round_ordinal_unique ON public.note_learning_round_plan_revisions
  (round_id, plan_ordinal);

--> statement-breakpoint

ALTER TABLE public.note_learning_round_plan_revisions ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.note_learning_round_plan_revisions FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY nlpr_workspace_user_isolation ON public.note_learning_round_plan_revisions
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

-- 只追加：改与删都拒绝（带绕行口子）。0275 的 `prevent_immutable_v2_row_mutation`
-- 是同一形状；这里独立成函数是因为 rejecting 语义写在名字里，别让两张表共用一段
-- 报错文本把「哪张表不可变」说糊。
CREATE OR REPLACE FUNCTION public.prevent_note_learning_round_plan_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    -- UPDATE 分支返回 NEW（放行修改），DELETE 分支返回 OLD（放行删除）——
    -- BEFORE DELETE 里 NEW 是 NULL，而 BEFORE 触发器返回 NULL 的语义是"跳过
    -- 这一行"：写成 RETURN NEW 会把绕行口子变成静默取消删除（实测：DELETE 0 行、
    -- 不报错）。0180 的共用版本用的就是 COALESCE(NEW, OLD)。
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'note_learning_round_plan_revisions is append-only: % is not allowed (round %, plan ordinal %)',
    TG_OP, OLD.round_id, OLD.plan_ordinal;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER nlpr_plan_append_only BEFORE UPDATE OR DELETE ON public.note_learning_round_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_note_learning_round_plan_mutation();

--> statement-breakpoint

-- 权限写在迁移里（0275 那一课）；roles 步骤会再兜底放宽。追加式的最终防线
-- 是上面的触发器——绕行口子只对显式维护路径有效。
GRANT SELECT, INSERT ON public.note_learning_round_plan_revisions TO ailearn_api;
GRANT ALL PRIVILEGES ON public.note_learning_round_plan_revisions TO ailearn_migrator;

--> statement-breakpoint

COMMENT ON TABLE public.note_learning_round_plan_revisions IS
  '轮次计划的追加式修订（D3 §5 / 39d W4-5 第三刀）。每一版计划记理由、时间与本体；前一版即上一行。只插不改不删（触发器 + 无 UPDATE/DELETE 权限）；计划变更推进轮次共享 revision（D1 §6.3），pause/resume 不产生计划行。';
