-- 0284 —— 轮次里的教学产物 `note_learning_round_teachings`（39d W4-6 刀一）。
--
-- 为什么有这张表：轮次（0282）只有"这一轮想弄懂什么"与计划（0283），
-- **教学本身没有落点**——解释与示例如果只活在对话框或渲染层，就既不能回放，
-- 也不能回答"这条解释是按哪一版正文生成的"（D3 §5 的冻结语义：快照哈希变了
-- 就不复用旧产物）。D4 的隔离展示面（动态产物）将来也挂在这张表的产物行上。
--
-- 每一行记六件事：
--   - `ordinal`：轮内序号（1 起，轮内唯一）。它就是"这一轮的第几条教学内容"，
--     与内核任务的幂等键（`round:{id}:explain:{snapshotHash}:{ordinal}`）同源；
--   - `kind`：今天只有 `explanation` 一档。压成一个布尔"是不是解释"会把
--     将来按知识形态选的表达方式（§6.1）挤成一个字段；
--   - `content`：结构化正文（`roundTeachingContentV1`：explanation＋可选 example）；
--   - `source_block_ordinals`：这条解释引用的正文块**在快照里的位置**（依据引用
--     要能点开定位到那一块，而不是只给一句"根据笔记"）；
--   - `snapshot_hash`：生成时那一版正文的哈希（D3 §5：哈希变了就不复用旧产物）。
--     轮次行上的 `source_content_hash` 是不可改写的（0282 的触发器），这里再记一份
--     是**生成时刻**的凭据：回放与审计问的是"这条解释按哪一版做的"；
--   - `driving_question_revision`：生成时本轮问题的第几版（用户改写问题后，
--     同一轮里必须能重新生成，而不是复用旧问题下的那条）；
--   - `kernel_task_ref`：内核任务/尝试的引用（回放与审计用）。确定性 provider
--     这一天它可以为 NULL——"没有走过内核任务"与"走过但没记"是两件事，
--     故意不用空字符串冒充。
--
-- **不存"好不好／掌握度"**（§6.7 同禁）：这一层不是评估，解释不判分
-- （W4-3 ⑥ 的 A 否决案：拿笔记原文当标准答案＝把复述当能力判定）。
--
-- 只追加（触发器照 0283 的形状：挡 UPDATE/DELETE，带 `app.allow_history_mutation`
-- 绕行口子）。**没有把 (round_id, kind, driving_question_revision, snapshot_hash)
-- 做成唯一索引**：§16.3 的「换解释」将来要在同一个问题下落第二条；重复请求的
-- "不重付"由服务层预读（同快照同问题 ⇒ 直接回既有那条）与内核检查点负责，
-- 不靠一条会挡住产品选择的唯一约束。
--
-- RLS 与 0282/0283 同形（ENABLE + FORCE，纯 (workspace_id, user_id) GUC 匹配，
-- 无 worker 旁路——D1 §6.5 对轮次族一律不给 worker 开跨租户读）。
--
-- 存量：**无**。这是新表。

CREATE TABLE public.note_learning_round_teachings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES public.note_learning_rounds(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  kind text NOT NULL,
  content jsonb NOT NULL,
  source_block_ordinals integer[] NOT NULL DEFAULT '{}',
  snapshot_hash text NOT NULL,
  driving_question_revision integer NOT NULL,
  kernel_task_ref text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT nlrt_ordinal_chk CHECK (ordinal >= 1),
  CONSTRAINT nlrt_kind_chk CHECK (kind IN ('explanation')),
  CONSTRAINT nlrt_content_json_chk CHECK (jsonb_typeof(content) = 'object'),
  -- 与合同同宽（8..128）：`note_versions.content_hash` 今天的主形状是 32 位 md5，
  -- 写成 64 会把每一篇真实笔记挡在轮次外面（0282 那条注释记过同一件事）。
  CONSTRAINT nlrt_snapshot_hash_chk CHECK (char_length(snapshot_hash) BETWEEN 8 AND 128),
  CONSTRAINT nlrt_dq_revision_chk CHECK (driving_question_revision >= 1),
  -- 依据块的上界：一块一段，一节课的解释引不到 200 块以上（合同同宽）。
  CONSTRAINT nlrt_source_blocks_len_chk CHECK (coalesce(array_length(source_block_ordinals, 1), 0) <= 200)
);

--> statement-breakpoint

-- 同一轮里第几条教学产物是唯一的；按它读序就是这一轮的教学历史。
CREATE UNIQUE INDEX nlrt_round_ordinal_unique ON public.note_learning_round_teachings
  (round_id, ordinal);

--> statement-breakpoint

-- 出网闸门（W3-2 第三刀）对**读**也要有索引的事这里不掺：这一张表按 round_id
-- 读全量（一轮的教学产物只有几条），`nlrt_round_ordinal_unique` 的左前缀就够。

ALTER TABLE public.note_learning_round_teachings ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE public.note_learning_round_teachings FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

CREATE POLICY nlrt_workspace_user_isolation ON public.note_learning_round_teachings
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

-- 只追加：改与删都拒绝（带绕行口子）。与 0283 独立成函数是同一个理由——
-- 别让两张表共用一段报错文本把"哪张表不可变"说糊。
CREATE OR REPLACE FUNCTION public.prevent_note_learning_round_teaching_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    -- UPDATE 分支返回 NEW（放行修改），DELETE 分支返回 OLD——BEFORE DELETE 里
    -- NEW 是 NULL，返回 NULL 的语义是"跳过这一行"（0283 真踩过：DELETE 0 行且不报错）。
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'note_learning_round_teachings is append-only: % is not allowed (round %, ordinal %)',
    TG_OP, OLD.round_id, OLD.ordinal;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER nlrt_teaching_append_only BEFORE UPDATE OR DELETE ON public.note_learning_round_teachings
  FOR EACH ROW EXECUTE FUNCTION public.prevent_note_learning_round_teaching_mutation();

--> statement-breakpoint

-- 权限写在迁移里（0275 那一课）；roles 步骤会再兜底放宽到 CRUD。
-- "只追加"的家在触发器，不在表权限。
GRANT SELECT, INSERT ON public.note_learning_round_teachings TO astella_api;
GRANT ALL PRIVILEGES ON public.note_learning_round_teachings TO astella_migrator;

--> statement-breakpoint

COMMENT ON TABLE public.note_learning_round_teachings IS
  '轮次里的教学产物（39d W4-6 刀一）。解释与示例按快照生成并只追加；source_block_ordinals 是依据在快照里的定位；snapshot_hash/driving_question_revision 是生成时刻的凭据（D3 §5 冻结语义）；不存掌握度（§6.7）。';
