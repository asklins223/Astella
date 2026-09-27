-- 0298 —— 轮次动态产物的**失败**留痕 `note_learning_round_artifact_failures`（39d W4-6 刀五·失败侧）。
--
-- 为什么需要这张表（§16.4 验收第一句「动态交付失败记录保留」）：
--  1. 失败今天只进 `routes.ts` 的 `req.log.error({ scope: "note-round-artifact" })`。日志不是
--     学习事实：进程一重启就没了，历史页与试用分析都读不到，所以"这一版的动态讲解为什么
--     没生成"事后**无从回答**——而 §18.3 明确把"内容可教学／动画成功／评分可判断"分成
--     三件分别统计，前两件没有数据面就只能靠人回忆。
--  2. **失败不得污染成功那一侧**。0285 `note_learning_round_artifacts` 只会有成功行，
--     而 `note_learning_round_teachings.artifact_id` 留空表示"没有动态版本"——那是一个
--     **状态**（D4 §6.2「动态失败不冒充教学失败」，文字解释照旧在 `content` 里）。本表
--     记的是**事件**：同一个教学条目先失败一次、重试成功，那一次失败仍要在。
--  3. 所以**没有**把失败做成 0285 上一列状态位：状态位只能留最后一次，重试成功会把原因
--     抹掉，而"曾经失败过"正是排查与试用统计要的那一半。
--
-- 记什么：
--   - `stage`：**哪一步**没成。`build` = 确定性构建（空内容／超配额）；`persist` = 产物行
--     没落库（连接、约束、权限）。分两档是因为处置不同——build 那一档换一次输入也照样
--     失败（材料本身没有可上屏的东西），persist 那一档是基础设施问题、值得单独计数。
--   - `reason`：`stage` 各自的两/一档，**穷举**（与 `GAP_OUTCOME_CLASS_V1` 同一形状：
--     新增一档而不同步 CHECK，就会让它静默落进某个默认类，而"这是哪一类失败"是这张表
--     的全部意义）。`detail` 是人读的那一句，**上限 500** 且不保证是结构化信息。
--   - `snapshot_hash`：生成时刻那一版正文的哈希（与 0284/0285 同宽 8..128）。失败也要
--     记它，否则"当时是哪一版材料"答不出来，而材料变了正是 0285 那条整份拒绝的常见原因。
--   - `teaching_id`：**可空**。产物是在教学行插入**之前**构建的，构建失败时那一行还不存在
--     ——所以第一类失败记不到教学条目上。留空而不是猜一个；读侧据此知道"这是一次没能归到
--     具体讲解的失败"。重试失败（教学行已存在）时它非空。
--
-- 只追加（触发器照 0283/0284/0285 的形状，带 `app.allow_history_mutation` 绕行口子）。
-- **不建唯一索引**：`teaching_id` 上可以有任意多行——用户可以重试（§6.2「用户可重试」），
-- 每次失败都是一件独立的事，把它们折叠成一行就等于把重试次数抹掉。
--
-- RLS 与 0282/0283/0284/0285 同形（ENABLE + FORCE，纯 (workspace_id, user_id) GUC 匹配，
-- 无 worker 旁路——D1 §6.5 对轮次族一律不给 worker 开跨租户读）。
--
-- 存量：**无**。这是新表。

CREATE TABLE public.note_learning_round_artifact_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES public.note_learning_rounds(id) ON DELETE CASCADE,
  -- 可空：产物在教学行落库之前构建，构建失败时那一行还不存在（头注第 4 条）。
  teaching_id uuid REFERENCES public.note_learning_round_teachings(id) ON DELETE CASCADE,
  stage text NOT NULL,
  reason text NOT NULL,
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 500),
  snapshot_hash text NOT NULL CHECK (char_length(snapshot_hash) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- stage × reason 的合法组合穷举。写成 CHECK 而不是两列各自的 IN：两列各自合法但组合
  -- 不存在（例如 stage=persist 而 reason=over_quota）是那种只有一条用例能撞上的形状，
  -- 而"为什么会这样"永远查不到。
  CONSTRAINT nlraf_stage_reason_chk CHECK (
    (stage = 'build'    AND reason IN ('empty', 'over_quota'))
    OR (stage = 'persist' AND reason = 'persist_failed')
  )
);

COMMENT ON TABLE public.note_learning_round_artifact_failures IS
  '39 §16.4「动态交付失败记录保留」：D4 §6.2 下失败不冒充教学失败，成功行在 0285，这张表记那件独立的事';

COMMENT ON COLUMN public.note_learning_round_artifact_failures.teaching_id IS
  'NULL = 产物构建时教学行尚未落库（build 类失败）；非空 = 某一条具体讲解的动态版本没能落库';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS nlraf_round_idx
  ON public.note_learning_round_artifact_failures (workspace_id, user_id, round_id, created_at, id);

CREATE INDEX IF NOT EXISTS nlraf_teaching_idx
  ON public.note_learning_round_artifact_failures (teaching_id)
  WHERE teaching_id IS NOT NULL;

--> statement-breakpoint

ALTER TABLE public.note_learning_round_artifact_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_learning_round_artifact_failures FORCE ROW LEVEL SECURITY;

CREATE POLICY nlraf_owner ON public.note_learning_round_artifact_failures FOR ALL TO PUBLIC
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM public.note_learning_rounds r
      WHERE r.id = round_id
        AND r.workspace_id = note_learning_round_artifact_failures.workspace_id
        AND r.user_id = note_learning_round_artifact_failures.user_id));

--> statement-breakpoint

CREATE FUNCTION public.guard_note_learning_round_artifact_failure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'artifact failure is append-only';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER nlraf_append_only BEFORE UPDATE OR DELETE ON public.note_learning_round_artifact_failures
  FOR EACH ROW EXECUTE FUNCTION public.guard_note_learning_round_artifact_failure();

--> statement-breakpoint

GRANT SELECT, INSERT ON public.note_learning_round_artifact_failures TO ailearn_api;
GRANT ALL ON public.note_learning_round_artifact_failures TO ailearn_migrator;
