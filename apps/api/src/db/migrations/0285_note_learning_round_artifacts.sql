-- 0285 —— 轮次的动态产物 `note_learning_round_artifacts`（39d W4-6 刀五）。
--
-- 为什么有这张表：隔着这一刀之前，全仓**没有任何生产写入方**会写
-- `<userData>/artifacts/<id>.html`——桌面主进程已经会读它并喂给 sandbox iframe
-- （`apps/desktop-client/src/main/index.ts` 的 `artifactSourcePath`），但"产物从哪来"
-- 那一格是空的。D4 §8 的隔离展示面要的是**一条教学产物带一份整份 HTML**：
-- 它由服务端生成、由主进程按 id 取整份（不套 JSON 信封）后落盘，frame 再从既定
-- 协议读（HTML 只走一次网络与一次落盘，渲染层拿不到 HTML）。
--
-- 每一行记六件事：
--   - `kind`：今天只有 `dynamic_explanation` 一档（与教学产物表的 `kind` 分开记：
--     按知识形态选的表达方式是后续刀，届时这里会长出别的值，而教学产物那一张的
--     分档不必跟着动）；
--   - `html`：**整份文档内容**（D4 §8：超配额是"整份拒绝"，任何半份 HTML 在 frame
--     里只会画成怪东西）。上界 524288 **与 D4 §8 的 512 KiB 同宽**，口径是字符长度
--     （桌面那一侧按字节再量一次，两边都要有）；
--   - `snapshot_hash`：生成时那一版正文的哈希（D3 §5 冻结语义，与 0284 同宽 8..128）；
--   - `round_id` / `workspace_id` / `user_id`：归属三件（RLS 策略两列 + 轮次级联）。
--
-- 挂回去的引用是 `note_learning_round_teachings.artifact_id`（本迁移末尾 ALTER）：
-- **没有动态版本就是 NULL**（D4 §6.2 那一档："动态失败不冒充教学失败"，文字解释照旧
-- 在 `content` 里，界面照旧要能读能练）。
--
-- 只追加（触发器照 0283/0284 的形状：挡 UPDATE/DELETE，带 `app.allow_history_mutation`
-- 绕行口子、`COALESCE(NEW, OLD)`）。**没有把 round_id 做成唯一索引**：同一轮将来可以
-- 有多份动态版本（换解释、换表达方式），唯一性不在这里表达。
--
-- RLS 与 0282/0283/0284 同形（ENABLE + FORCE，纯 (workspace_id, user_id) GUC 匹配，
-- 无 worker 旁路——D1 §6.5 对轮次族一律不给 worker 开跨租户读）。
--
-- 存量：**无**。这是新表。

CREATE TABLE public.note_learning_round_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES public.note_learning_rounds(id) ON DELETE CASCADE,
  kind text NOT NULL,
  html text NOT NULL,
  snapshot_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT nlra_kind_chk CHECK (kind IN ('dynamic_explanation')),
  -- 与 D4 §8 的 512 KiB 同宽（口径：字符长度。桌面按字节再量一次，两边都要有）。
  CONSTRAINT nlra_html_len_chk CHECK (char_length(html) BETWEEN 1 AND 524288),
  -- 与合同同宽（8..128）：`note_versions.content_hash` 今天的主形状是 32 位 md5，
  -- 写成 64 会把每一篇真实笔记挡在外面（0282/0284 那条注释记过同一件事）。
  CONSTRAINT nlra_snapshot_hash_chk CHECK (char_length(snapshot_hash) BETWEEN 8 AND 128)
);

--> statement-breakpoint

-- 按轮次读这一轮的产物（重放与审计；也是 `round_id` 外键级联删除的走法）。
-- 「按 id 取整份」那条读走主键，不需要第二把索引。
CREATE INDEX nlra_round_created_idx ON public.note_learning_round_artifacts
  (round_id, created_at);

--> statement-breakpoint

ALTER TABLE public.note_learning_round_artifacts ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.note_learning_round_artifacts FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY nlra_workspace_user_isolation ON public.note_learning_round_artifacts
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

-- 只追加：改与删都拒绝（带绕行口子）。与 0283/0284 独立成函数是同一个理由——
-- 别让几张表共用一段报错文本把"哪张表不可变"说糊。
CREATE OR REPLACE FUNCTION public.prevent_note_learning_round_artifact_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    -- UPDATE 分支返回 NEW（放行修改），DELETE 分支返回 OLD——BEFORE DELETE 里
    -- NEW 是 NULL，返回 NULL 的语义是"跳过这一行"（0283 真踩过：DELETE 0 行且不报错）。
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'note_learning_round_artifacts is append-only: % is not allowed (round %, artifact %)',
    TG_OP, OLD.round_id, OLD.id;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER nlra_artifact_append_only BEFORE UPDATE OR DELETE ON public.note_learning_round_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_note_learning_round_artifact_mutation();

--> statement-breakpoint

-- 权限写在迁移里（0275 那一课）；roles 步骤会再兜底放宽到 CRUD。
-- "只追加"的家在触发器，不在表权限。
GRANT SELECT, INSERT ON public.note_learning_round_artifacts TO astella_api;
GRANT ALL PRIVILEGES ON public.note_learning_round_artifacts TO astella_migrator;

--> statement-breakpoint

COMMENT ON TABLE public.note_learning_round_artifacts IS
  '轮次的动态产物（39d W4-6 刀五 / D4 §8）。整份自包含 HTML（≤512 KiB，超配额整份拒绝），由 GET /v2/note-learning-round-artifacts/:id 原样交出、桌面主进程落盘；只追加；kind 今天只有 dynamic_explanation。';

--> statement-breakpoint

-- 教学产物行指回它自己的那份动态产物（可空：没有动态版本就是 NULL）。
--
-- 下一刀的人会问：`note_learning_round_teachings` 不是只追加吗，怎么还能加列？
-- 因为那条触发器是 **BEFORE UPDATE OR DELETE … FOR EACH ROW**——它拦的是"行级改/删"，
-- `ALTER TABLE` 是 DDL，不产生行事件，所以加列不受它影响（这条注释就是为这个问题写的）。
--
-- 外键用默认的 NO ACTION（不是 RESTRICT）：删轮次时 `round_id` 会级联删掉两侧的行，
-- RESTRICT 会在级联半途就报错，NO ACTION 在语句末尾才核，那时引用行已经一起没了。
ALTER TABLE public.note_learning_round_teachings
  ADD COLUMN IF NOT EXISTS artifact_id uuid REFERENCES public.note_learning_round_artifacts(id);

--> statement-breakpoint

COMMENT ON COLUMN public.note_learning_round_teachings.artifact_id IS
  '这一条教学产物的动态版本（D4 §8）。NULL = 没有动态版本，不是失败：文字解释照旧在 content 里。';
