-- 0347: 判断记录（40 §4.5.5 / §4.5.4，验收 A29 / A67）。
--
-- ## 要解决什么
--
-- 合同 §4.5.4：「事实记忆由抽取任务从原始事件提出；判断由对话模型或后台整理提出。
-- 前者仍可能记反说话者，后者仍可能误解用户。**工具成功只证明『这条记录被保存』，
-- 不能证明其内容真实。**」
--
-- §4.5.5：「`remember_judgment` 用于当轮记下一个可见事件上的解释或表达选择……
-- **不能假称复原了当时未记录的内心过程。**」
--
-- 此前只有**事实**一种记忆：五种 kind 全是关于用户的事实，author_type 也是
-- 从 source_type 推出来的。于是她「怎么想」这件事没有任何落脚点——
-- 要么不记（那她每次都从零开始理解同一件事），要么混进事实记忆里
-- （而 A67 明说「不能由成功回执证明真」，混进去就是让用户以为那是事实）。
--
-- ## 四件事
--
-- 1. `source_event_ids text[]`：判断的依据**可能有多条**，事实记忆那一列
--    （source_event_id，单值）表达不了。§4.5.4 把 `source_event_ids` 列为必备字段。
-- 2. `judgment` 这个 kind：她对**一件事**的解释/表达选择。
-- 3. 判断**必须**落在证据上：无来源的用户判断不能写成长期记录（§4.5.5）。
--    用 CHECK 把它钉在数据库里，而不是靠调用方自觉。
-- 4. 永远**不能**变成用户事实：`user_stated` 对判断恒为 false，
--    且 §4.5.5「模型不通过判断接口绕过事实记忆的准入、期限或跨空间限制」。

--> statement-breakpoint

-- ① 判断的依据可能是多条事件
ALTER TABLE public.assistant_memory_items
  ADD COLUMN source_event_ids text[];

COMMENT ON COLUMN public.assistant_memory_items.source_event_ids IS
  '判断记录的依据事件（可多条）。事实记忆继续用单值的 source_event_id。';

--> statement-breakpoint

-- ② 新增 judgment kind
ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT assistant_memory_items_kind_check;

ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_kind_check CHECK (kind IN (
    'preference', 'goal', 'learning_context', 'interaction_note', 'episodic', 'judgment'
  ));

-- 抑制表与 kind 枚举同源（0330 建的），必须一起放开，否则
-- 「忘掉一条判断」会撞 CHECK 报错——而 A29 明确要求判断也能删除。
ALTER TABLE public.assistant_memory_source_suppressions
  DROP CONSTRAINT assistant_memory_source_suppressions_kind_check;

ALTER TABLE public.assistant_memory_source_suppressions
  ADD CONSTRAINT assistant_memory_source_suppressions_kind_check CHECK (kind IN (
    'preference', 'goal', 'learning_context', 'interaction_note', 'episodic', 'judgment'
  ));

--> statement-breakpoint

-- ③④ 判断的硬约束：必须有依据、永远不是用户自述、认识状态必须显式。
-- 这三条用 CHECK 钉在**数据库**里，而不是靠调用方自觉：
-- 它们是「判断不能变成用户事实」这条产品承诺的机械部分。
ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_judgment_shape_check CHECK (
    kind <> 'judgment'
    OR (
      -- §4.5.5：「无来源的用户判断不能写成长期记录」
      source_event_ids IS NOT NULL
      AND array_length(source_event_ids, 1) >= 1
      -- 判断永远不是"用户说的"，所以永远不能标成用户自述
      AND user_stated = false
      -- §4.5.4：认识状态（supported / tentative / disputed）必须显式给
      AND epistemic_status IN ('supported', 'tentative', 'disputed')
      -- §4.6.4：只改陪伴记录，不写学习事实 —— 判断永不跨空间
      AND scope <> 'global'
    )
  );

--> statement-breakpoint

-- 认识状态枚举与 0336 同源，补一条 CHECK 让它可查。
ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_epistemic_status_check;

ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_epistemic_status_check
  CHECK (epistemic_status IN ('supported', 'tentative', 'disputed'));

--> statement-breakpoint

CREATE INDEX assistant_memory_items_source_event_ids_idx
  ON public.assistant_memory_items USING gin (source_event_ids);

--> statement-breakpoint

-- 判断只属于本人所在空间（§4.5.4：「按 (workspace_id, user_id) 私有隔离」）。
-- 上面的 CHECK 已经挡住 scope='global'；这里再挡一次跨空间携带，
-- 与全局记忆扇出函数的行为对齐。
CREATE OR REPLACE FUNCTION public.ailearn_block_judgment_global_fanout()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind = 'judgment' AND NEW.scope = 'global' THEN
    RAISE EXCEPTION 'judgment memories must stay workspace-scoped (40 §4.5.4)';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint

CREATE TRIGGER assistant_memory_judgment_scope_guard
  BEFORE INSERT OR UPDATE ON public.assistant_memory_items
  FOR EACH ROW EXECUTE FUNCTION public.ailearn_block_judgment_global_fanout();