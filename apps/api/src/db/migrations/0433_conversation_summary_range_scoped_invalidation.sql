-- 0433: 摘要失效判定按**它覆盖的那一段**，不再整会合一刀切。
--
-- 为什么要动这一处（2026-10-14 按开发库真实会话核对）：0384 把「这条摘要还有效吗」
-- 做成会话级修订号的**等值比较**，于是任意一条消息被改写或删除，这个会话**所有**更早
-- 的摘要一起永久读不到。真实数据：那份 565 条的会话改过 3 次消息（context_revision=4），
-- 15 份摘要里 13 份 stamped 1，读取侧一句都不给——她拿到的是「只盖到 440」的一块摘要，
-- 而 1–439 那一大段在 prompt 里连「没读过」这句话都没有。摘要器提交时已经按区间重算
-- sourceHash 复核过（`commitRevision !== contextRevision` 那道围栏还在），读侧没必要
-- 拿会合一刀切当精确判定。
--
-- 改法沿用仓库里已经成立的形状：触发器往下调用一支 SECURITY DEFINER 函数，由函数属主
-- 落库（同 0431 的补偿入队、0426 的手记归档）。触发器那一层不查 session 用户的 EXECUTE，
-- **它调用出去的普通函数照查**，所以 GRANT 要同时给 api 与 worker，并在 roles.sql
-- 那三份成对清单里各加一行——只写迁移会在下一次 role-grants 重跑时被抹掉。

ALTER TABLE public.conversation_summaries
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;

--> statement-breakpoint

-- 只有覆盖区间真被碰到的那几份作废；追加、以及区间外的改写都不动它。
CREATE OR REPLACE FUNCTION public.astella_invalidate_covered_conversation_summaries(
  p_conversation_id uuid,
  p_seq bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_stamped integer;
BEGIN
  UPDATE public.conversation_summaries
     SET invalidated_at = now()
   WHERE conversation_id = p_conversation_id
     AND invalidated_at IS NULL
     AND p_seq BETWEEN coverage_from_seq AND coverage_through_seq;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  RETURN v_stamped;
END;
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_invalidate_covered_conversation_summaries(uuid, bigint) FROM PUBLIC;

--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.astella_invalidate_covered_conversation_summaries(uuid, bigint) TO astella_api, astella_worker;

--> statement-breakpoint

-- 会话修订号照旧前进（提交侧那道在途围栏依赖它），顺带按 seq 点名作废被碰到的摘要。
CREATE OR REPLACE FUNCTION public.astella_bump_conversation_context_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
  changed_seq bigint;
BEGIN
  target := COALESCE(NEW.conversation_id, OLD.conversation_id);
  changed_seq := COALESCE(NEW.seq, OLD.seq);
  UPDATE public.companion_conversations
     SET context_revision = context_revision + 1
   WHERE id = target;
  PERFORM public.astella_invalidate_covered_conversation_summaries(target, changed_seq);
  RETURN COALESCE(NEW, OLD);
END;
$$;

--> statement-breakpoint

-- 回填能证明的那一半：区间里有一条消息在这份摘要写下去之后被改写过，那它盖的
-- 已经不是原文了。删除的旧行没留下 seq 痕迹，那一份无从证明，按有效处理——
-- 反过来做等于把整段历史再判一次死刑，而读侧现在会如实报出没盖住的区间。
UPDATE public.conversation_summaries s
   SET invalidated_at = now()
 WHERE s.invalidated_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.companion_messages m
      WHERE m.conversation_id = s.conversation_id
        AND m.edited_at IS NOT NULL
        AND m.edited_at > s.created_at
        AND m.seq BETWEEN s.coverage_from_seq AND s.coverage_through_seq
   );

--> statement-breakpoint

-- 读侧现在按 `invalidated_at IS NULL` + 覆盖区间取，建对应的部分索引。
CREATE INDEX IF NOT EXISTS conversation_summaries_readable_idx
  ON public.conversation_summaries (conversation_id, coverage_through_seq DESC)
  WHERE status IN ('candidate', 'confirmed')
    AND invalidated_at IS NULL
    AND coverage_from_seq IS NOT NULL
    AND coverage_through_seq IS NOT NULL;
