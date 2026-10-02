-- 0360: 记忆作者词表对齐 40 §4.6.8，并让判断记录真的写得进去。
--
-- ## 要修的事实（三个各自独立的死锁）
--
-- 1. `companion_remember_judgment` 的 INSERT 写
--    `source_speaker='companion'` / `source_basis='companion_interpretation'` /
--    `author_type='companion'`，而 0342 与 0336 给这三列各钉了 CHECK，
--    值域都不含这三个值。此后没有任何迁移放宽过它们。
--    → 每一次调用都撞 23514、事务 abort，模型侧只拿到 `outcome_unknown`。
--    判断记录（§4.5.4/§4.5.5）**从未成功落库过一条**。
--
-- 2. §4.6.8 要求 `author/updated_by` 区分
--    user / extractor / companion / maintenance。现役 CHECK 是
--    ('user','model','background')——两个词能对上，一个对不上，
--    一个根本不存在。更糟的是 `companion_procedural_playbooks`
--    （0348）用的是另一套 ('companion','extractor','maintenance')：
--    **同一件事两张表两种词表**，跨表读的人无从判断。
--
-- 3. §4.5.4 要求认识状态能标「已被替代」。现役枚举只有
--    supported / tentative / disputed，没有 superseded——判断被纠正之后
--    只能靠 revisions 表间接表达，读侧拿不到。
--
-- ## 为什么是迁移换词而不是「再放宽两个值」
--
-- 放宽成 ('user','model','background','companion') 能让 INSERT 过，
-- 但 §4.6.8 的四个词仍然落不全，而且两张表的词表继续互相矛盾。
-- 项目尚未上线（AGENTS.md），没有需要兼容的历史数据，
-- 所以这里**换词**并把存量一并迁掉，不留兼容层。
--
--   model      → extractor   （抽取任务从原始事件提出事实记忆）
--   background → maintenance （后台整理/摘要写下的结论）
--   （新增）     companion    （她自己的判断与表达选择）
--
-- ## 附带修掉的一处
--
-- 0342 的 `capture_assistant_memory_item_revision()` 变更检测里
-- **没有 `source_event_ids`**。判断记录只改依据不改正文时 revision 不 bump，
-- 「用户改记忆后再次读取能看到最新 revision」（§4.6.8 / A53）就对判断记录失效。
-- 下面把这个字段补进检测列。

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_author_type_check;
ALTER TABLE public.assistant_memory_item_revisions
  DROP CONSTRAINT IF EXISTS assistant_memory_revisions_author_type_check;

--> statement-breakpoint

-- 存量先迁，再上新约束：顺序反了会在 ADD CONSTRAINT 时当场失败。
UPDATE public.assistant_memory_items SET author_type = 'extractor'   WHERE author_type = 'model';
UPDATE public.assistant_memory_items SET author_type = 'maintenance' WHERE author_type = 'background';
UPDATE public.assistant_memory_item_revisions SET author_type = 'extractor'   WHERE author_type = 'model';
UPDATE public.assistant_memory_item_revisions SET author_type = 'maintenance' WHERE author_type = 'background';

--> statement-breakpoint

-- §4.6.8 的四个作者，一字不多一字不少。
ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_author_type_check
    CHECK (author_type IN ('user', 'extractor', 'companion', 'maintenance'));
ALTER TABLE public.assistant_memory_item_revisions
  ADD CONSTRAINT assistant_memory_revisions_author_type_check
    CHECK (author_type IN ('user', 'extractor', 'companion', 'maintenance'));

--> statement-breakpoint

-- 判断记录的说话者是她自己，依据是「她的解释」而不是「她转述用户说了什么」。
-- 事实记忆那三个值不变，所以「说话者」与「是否用户自述」仍然是两件独立的事
-- （§4.5.4：「来源性质区分用户自述、可观察事件和模型推断」）。
ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_source_speaker_check;
ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_source_basis_check;
ALTER TABLE public.assistant_memory_item_revisions
  DROP CONSTRAINT IF EXISTS assistant_memory_revisions_source_speaker_check;
ALTER TABLE public.assistant_memory_item_revisions
  DROP CONSTRAINT IF EXISTS assistant_memory_revisions_source_basis_check;

--> statement-breakpoint

ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_source_speaker_check
    CHECK (source_speaker IS NULL OR source_speaker IN ('user', 'assistant', 'companion')),
  ADD CONSTRAINT assistant_memory_items_source_basis_check
    CHECK (source_basis IS NULL OR source_basis IN ('direct_statement', 'inferred_from_statement', 'companion_interpretation'));
ALTER TABLE public.assistant_memory_item_revisions
  ADD CONSTRAINT assistant_memory_revisions_source_speaker_check
    CHECK (source_speaker IS NULL OR source_speaker IN ('user', 'assistant', 'companion')),
  ADD CONSTRAINT assistant_memory_revisions_source_basis_check
    CHECK (source_basis IS NULL OR source_basis IN ('direct_statement', 'inferred_from_statement', 'companion_interpretation'));

--> statement-breakpoint

-- §4.5.4：认识状态另标有据、暂定、争议或已被替代。
ALTER TABLE public.assistant_memory_items
  DROP CONSTRAINT IF EXISTS assistant_memory_items_epistemic_status_check;
ALTER TABLE public.assistant_memory_items
  ADD CONSTRAINT assistant_memory_items_epistemic_status_check
    CHECK (epistemic_status IN ('supported', 'tentative', 'disputed', 'superseded'));

--> statement-breakpoint

-- 0336 的作者判定触发器要跟着换词，否则新插入的行又被写回旧词并撞 CHECK。
CREATE OR REPLACE FUNCTION public.prepare_assistant_memory_item_authorship()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.source_type = 'user_stated' OR NEW.user_stated THEN
    NEW.author_type := 'user';
    NEW.author_id := NEW.user_id;
    NEW.epistemic_status := 'supported';
  ELSIF NEW.source_type = 'summary' THEN
    NEW.author_type := 'maintenance';
    NEW.author_id := NULL;
  END IF;
  RETURN NEW;
END
$$;

--> statement-breakpoint

-- 判断记录把依据列成数组（§4.5.4「多条依据」）。只改依据不改正文时，
-- 旧版本不 bump 就等于「这次修订没有发生过」——A53 会失效。
CREATE OR REPLACE FUNCTION public.capture_assistant_memory_item_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.kind,
    NEW.content,
    NEW.source_event_id,
    NEW.source_event_ids,
    NEW.source_session_id,
    NEW.source_speaker,
    NEW.source_basis,
    NEW.applies_when,
    NEW.valid_from,
    NEW.valid_until,
    NEW.user_stated,
    NEW.user_confirmed,
    NEW.importance,
    NEW.confidence,
    NEW.scope,
    NEW.source_type,
    NEW.author_type,
    NEW.author_id,
    NEW.epistemic_status
  ) IS DISTINCT FROM ROW(
    OLD.kind,
    OLD.content,
    OLD.source_event_id,
    OLD.source_event_ids,
    OLD.source_session_id,
    OLD.source_speaker,
    OLD.source_basis,
    OLD.applies_when,
    OLD.valid_from,
    OLD.valid_until,
    OLD.user_stated,
    OLD.user_confirmed,
    OLD.importance,
    OLD.confidence,
    OLD.scope,
    OLD.source_type,
    OLD.author_type,
    OLD.author_id,
    OLD.epistemic_status
  ) THEN
    INSERT INTO public.assistant_memory_item_revisions (
      memory_id,
      workspace_id,
      user_id,
      revision,
      kind,
      content,
      source_event_id,
      source_session_id,
      source_speaker,
      source_basis,
      applies_when,
      valid_from,
      valid_until,
      user_stated,
      user_confirmed,
      importance,
      confidence,
      scope,
      source_type,
      author_type,
      author_id,
      epistemic_status
    ) VALUES (
      OLD.id,
      OLD.workspace_id,
      OLD.user_id,
      OLD.revision,
      OLD.kind,
      OLD.content,
      OLD.source_event_id,
      OLD.source_session_id,
      OLD.source_speaker,
      OLD.source_basis,
      OLD.applies_when,
      OLD.valid_from,
      OLD.valid_until,
      OLD.user_stated,
      OLD.user_confirmed,
      OLD.importance,
      OLD.confidence,
      OLD.scope,
      OLD.source_type,
      OLD.author_type,
      OLD.author_id,
      OLD.epistemic_status
    );
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
  END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.prepare_assistant_memory_item_authorship() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_assistant_memory_item_revision() FROM PUBLIC;