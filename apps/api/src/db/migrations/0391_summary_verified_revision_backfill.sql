-- 补上 0384 漏掉的回填：既有摘要的 `verified_context_revision` 一直是 NULL，
-- 于是读取侧的 `s.verified_context_revision = c.context_revision` 对它们**恒不成立**
-- （NULL = 1 的结果是 NULL，不是 true），`conversation_summaries_verified_idx`
-- 这个部分索引的 `IS NOT NULL` 条件也把它们排除在外。
--
-- ## 这是怎么被发现的
--
-- 2026-10-06 真窗口验证：问伴星「我们之前聊过什么？」，它答
-- 「**早先别的会话里没检索到记录**」。但库里明明有一个 727 条消息、15 份摘要的会话。
-- 查下去才发现**全部 16 份摘要的 verified_context_revision 都是 NULL**——
-- 0384 加了列和触发器，却**没有回填既有行**，于是 0384 之前写下的每一份摘要
-- 都静默地再也读不到了。单测和真库测试都没抓到它，因为它们的夹具都是**新建**摘要
-- （走写入侧，会带上修订号），没有一条走「0384 之前就存在的摘要」这条路径。
--
-- ## 为什么只回填 `context_revision = 1` 的那些
--
-- `context_revision` 的默认值是 **1**，只在 `companion_messages` 发生 UPDATE/DELETE 时 +1。
-- 所以：
--
--   - 会话停在 1  → **从未发生过消息改写或删除**，摘要所依据的那段内容不可能被作废，
--                   回填到当前修订号是**可证明安全**的；
--   - 会话 > 1    → 无法判断摘要是「改写之前」还是「改写之后」写的，**不回填**，
--                   让它继续保持不可读（宁可少读，不可错读）。
--
-- 换句话说：这条迁移**不做猜测**，只把能证明的那部分救回来。剩下的用
-- `SELECT` 留在下面的注释里，谁要处理可以按同样的口径单独判断。
--
-- 残留缺口（如实记录）：修订号 > 1 的会话，其既有摘要仍然读不到。它们需要
-- 重新摘要一次才能恢复——那要花模型调用，属于运维决定，不在本迁移里自动做。

UPDATE public.conversation_summaries AS s
SET verified_context_revision = c.context_revision
FROM public.companion_conversations AS c
WHERE s.conversation_id = c.id
  AND s.verified_context_revision IS NULL
  AND c.context_revision = 1;

-- 核对用（不改变结果）：
--   SELECT c.context_revision, count(*)
--   FROM conversation_summaries s JOIN companion_conversations c ON c.id = s.conversation_id
--   WHERE s.verified_context_revision IS NULL
--   GROUP BY 1;
-- 上面这个查询返回的行，就是本条迁移**没有**救回来的那部分。
