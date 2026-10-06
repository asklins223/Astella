-- 方案 44 §3.3／§6.4：遗忘要传递到派生经验，旧摘要不得恢复被遗忘的内容。
--
-- 背景（44 §2 核对到的缺口）：摘要器会写一条 episodic 记忆，`source_event_id` 是
-- `summary:<conversationId>:<runId>`——方向是「摘要 → 记忆」。但**没有反向引用**。
-- 于是用户遗忘/停用那条记忆之后，那份摘要仍然每轮注入同样的内容：
-- 用户的遗忘被摘要一句一句地undo掉了。
--
-- 手册那一侧早就处理了这件事（0374 的 `astella_propagate_playbook_evidence_change`：
-- 记忆被纠正/停用/遗忘 → 手册标争议）。摘要与记忆是同一种派生关系，却漏了这一侧。
--
-- 这里补上：摘要记下它派生出哪条记忆，那条记忆失效时把摘要置为 `stale`。
-- `stale` 不在读取侧认领的 `('candidate','confirmed')` 里，所以它立刻不再被注入——
-- 不是「还注入但打个折扣」，而是真的不再出现。
ALTER TABLE public.conversation_summaries
  ADD COLUMN IF NOT EXISTS derived_memory_id uuid;

-- 记忆侧失效 → 摘要失效。
CREATE OR REPLACE FUNCTION public.astella_invalidate_summary_on_derived_memory_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.conversation_summaries s
     SET status = 'stale', updated_at = now()
   WHERE s.derived_memory_id = COALESCE(NEW.id, OLD.id)
     AND s.workspace_id = COALESCE(NEW.workspace_id, OLD.workspace_id)
     AND s.user_id = COALESCE(NEW.user_id, OLD.user_id)
     -- 用户**自己**记下的、或仍有效的那条记忆不该反过来打掉摘要：
     -- 只有被遗忘/停用/纠正（含正文改动与升版）才算数。
     AND (
       TG_OP = 'DELETE'
       OR NEW.deleted_at IS NOT NULL
       OR NEW.dismissed_at IS NOT NULL
       OR NEW.archived_at IS NOT NULL
       OR NEW.revision <> OLD.revision
       OR NEW.content <> OLD.content
       OR NEW.epistemic_status IN ('disputed', 'superseded')
     )
     AND s.status <> 'stale';
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS assistant_memory_summary_invalidate ON public.assistant_memory_items;
CREATE TRIGGER assistant_memory_summary_invalidate
  AFTER UPDATE OR DELETE ON public.assistant_memory_items
  FOR EACH ROW EXECUTE FUNCTION public.astella_invalidate_summary_on_derived_memory_change();

CREATE INDEX IF NOT EXISTS conversation_summaries_derived_memory_idx
  ON public.conversation_summaries (derived_memory_id)
  WHERE derived_memory_id IS NOT NULL;

-- 这一列原先**没有**任何取值约束（0170 建表时只有 NOT NULL DEFAULT）。这里第一次加上，
-- 取值集合不是猜的，是从两处读出来的事实凑齐的：
--   - 'candidate'：摘要器唯一会写入的值（companion-summarizer 的 INSERT）；
--   - 'confirmed' / 'rejected'：读取侧认领的状态，漏掉哪一个会让那份摘要凭空消失；
--   - 'stale'：上面那个触发器写的。
-- 判据在 plan44-…-migration.test.ts：它核对「写入过的值」与「读取认领的值」都在集合里。
-- 加约束的目的很具体：一个拼错的 status 会让摘要**静默**变得不可见——读侧认不出来，
-- 界面上也不报错，只表现为「她怎么忘了那件事」。
ALTER TABLE public.conversation_summaries
  DROP CONSTRAINT IF EXISTS conversation_summaries_status_check;
ALTER TABLE public.conversation_summaries
  ADD CONSTRAINT conversation_summaries_status_check
  CHECK (status IN ('candidate', 'confirmed', 'rejected', 'stale'));
