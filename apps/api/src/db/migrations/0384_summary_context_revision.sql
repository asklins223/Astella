-- 方案 44 §3.3：摘要的「读取与提交均检查当前有效性」。
--
-- 背景（44 §2，2026-10-05 按源码核对）：
--   `readConversationSummary` 的注释写着「Read only a **content-verified** summary」，
--   但它只检查 coverage 三列非空——`coverage_source_hash` 一列**从头到尾没有在读路径上
--   被复核过**。于是消息被改写或删除之后，旧摘要照样被注入对话，并用它自己那句
--   「更早那段对话」把已经不存在的内容重新说一遍。
--
-- 提交侧其实有校验（摘要器在提交事务里重算 sourceHash 再比对），缺的是读取侧。
-- 而读取侧不能简单地「每次重算整段哈希」：一份摘要可以覆盖几百条消息，每轮都重读
-- 整段不现实。
--
-- 这里用一个**会话内容修订号**把这件事变成 O(1) 的精确判定：
--   - companion_messages 上的 UPDATE/DELETE 把会话的 context_revision +1；
--   - INSERT（追加）**不**动修订号——追加不会让已经覆盖过的更早区间失效；
--   - 摘要在同一事务里记下它被验证时的修订号；
--   - 读取时对不上就当它失效，而不是拿一份来源已经变了的摘要顶替原文。
--
-- 之所以能这样，是因为核对过源码：生产路径里 companion_messages 只追加
-- （唯一的 DELETE 是连续历史清理，而它同时删掉该会话的摘要）；真正会破坏覆盖关系的
-- 是改写与删除，这两件事由触发器兜住，不必在每个写入点各写一遍。

ALTER TABLE public.companion_conversations
  ADD COLUMN IF NOT EXISTS context_revision bigint NOT NULL DEFAULT 1;

-- 摘要记下「我被验证时，会话的内容修订号是多少」。
ALTER TABLE public.conversation_summaries
  ADD COLUMN IF NOT EXISTS verified_context_revision bigint;

-- 记了修订号的摘要必须带一个正整数；没记的（旧行、纯手工写入）按「未验证」处理，
-- 读取时会被排除——缺判据不等于通过。
ALTER TABLE public.conversation_summaries
  DROP CONSTRAINT IF EXISTS conversation_summaries_verified_revision_positive;
ALTER TABLE public.conversation_summaries
  ADD CONSTRAINT conversation_summaries_verified_revision_positive
  CHECK (verified_context_revision IS NULL OR verified_context_revision >= 1);

-- 改写与删除才让覆盖失效；**追加不动修订号**。
--
-- 追加若也 +1，这份会话的所有摘要会在第一条新消息到达时全部失效，而摘要器是周期
-- 跑的——于是大多数时候注入的会话历史里根本没有摘要，那是对现状的倒退而不是治理。
CREATE OR REPLACE FUNCTION public.astella_bump_conversation_context_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  target := COALESCE(NEW.conversation_id, OLD.conversation_id);
  UPDATE public.companion_conversations
     SET context_revision = context_revision + 1
   WHERE id = target;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS companion_messages_context_revision_update ON public.companion_messages;
CREATE TRIGGER companion_messages_context_revision_update
  AFTER UPDATE OR DELETE ON public.companion_messages
  FOR EACH ROW EXECUTE FUNCTION public.astella_bump_conversation_context_revision();

-- 残留缺口（如实记录，不假装覆盖到了）：**乱序补写**一条落在既有覆盖区间内的消息
-- 不动修订号，因此读取侧不会立刻作废那份摘要。摘要器下一次运行时会在提交事务里重算
-- 整段 sourceHash，届时那一段对不上，结果作废。生产路径目前没有乱序补写（消息只追加，
-- 唯一的 DELETE 是连续历史清理，而它同时删掉该会话的摘要）。

-- 读取路径要按修订号过滤，建一个「已验证且仍然有效」的索引。
CREATE INDEX IF NOT EXISTS conversation_summaries_verified_idx
  ON public.conversation_summaries (workspace_id, user_id, conversation_id, coverage_through_seq DESC)
  WHERE status IN ('candidate', 'confirmed')
    AND verified_context_revision IS NOT NULL
    AND coverage_through_seq IS NOT NULL;
