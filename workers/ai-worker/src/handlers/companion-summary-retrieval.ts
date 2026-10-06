import { sql, type SQL } from "drizzle-orm";
import { extractQueryKeywords } from "./companion-memory-vector.ts";
import { companionHistoryText } from "./companion-dialogue-store.ts";
import { toTextArrayLiteral } from "@ailearn/shared/pg-text-array";

/**
 * 方案 44 §3.2／§8.3：跨会话找回。
 *
 * 当前会话的回放尾部与摘要不归这里管——那些**已经在上下文里**。这个模块回答的是
 * 另一个问题：「我们前几天在**别的**会话里聊过什么」。新会话不默认回放该用户所有
 * 会话的最近 N 条（那是把全部历史塞回窗口，正是 44 要治的病）；它按需检索，并返回
 * **带来源身份**的条目，让她能定位、能补取、能核对。
 *
 * 三条不能破的边界：
 *   - **范围**：只在本工作区、本人名下检索。别的空间或别人的会话永远不进来。
 *   - **来源身份**：每条命中都带 conversationId 与覆盖区间。没有它，模型无法区分
 *     「这段是我现在看到的」与「那段是我们上次说的」，也无法取回原文。
 *   - **同号桶不碰撞**（44 §8.3）：seq 是**每个会话各自的局部序号**，所以取回原文
 *     必须同时给 conversationId——只给 seq 会读到另一个会话的同号消息。
 */

/** 命中条数上限。与记忆检索的 8 同量级，但更小：会话摘要比单条记忆重。 */
export const MAX_PAST_CONVERSATION_HITS = 5;

/** 取回原文时一次最多读多少条消息。 */
export const MAX_PAST_CONVERSATION_MESSAGES = 20;

/** 单条消息进模型的字符上限（与 read_history 的 1,000 对齐）。 */
export const PAST_MESSAGE_MAX_CHARS = 1_000;

/** 取回原文一次最多返回多少字符。 */
export const PAST_MESSAGES_MAX_CHARS = 6_000;

export interface PastConversationScope {
  workspaceId: string;
  userId: string;
}

export interface PastConversationHit {
  conversationId: string;
  title: string;
  keyEvents: string[];
  followUps: string[];
  userPreferences: string[];
  /** 这份摘要**自己**覆盖到的区间；接续链上更早的部分不在这里。 */
  coverageFromSeq: string;
  coverageThroughSeq: string;
  /** 来源哈希：取回原文时用它复核这一段没被改过。 */
  sourceHash: string;
  updatedAt: string;
}

export interface PastConversationMessage {
  seq: string;
  role: "user" | "assistant";
  text: string;
}

export interface PastConversationExcerpt {
  conversationId: string;
  messages: PastConversationMessage[];
  /** 这次实际读到的区间（可能小于请求的区间，受上限约束）。 */
  fromSeq: string | null;
  throughSeq: string | null;
  /** 因上限被截断时为 true——她必须知道后面还有没读。 */
  truncated: boolean;
}

interface Executor {
  execute(query: SQL): Promise<unknown>;
}

function asRows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? result as Array<Record<string, unknown>> : [];
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, max)
    : [];
}

function mapHit(row: Record<string, unknown>): PastConversationHit | null {
  const conversationId = String(row.conversation_id ?? "");
  const coverageFromSeq = row.coverage_from_seq === null || row.coverage_from_seq === undefined
    ? null : String(row.coverage_from_seq);
  const coverageThroughSeq = row.coverage_through_seq === null || row.coverage_through_seq === undefined
    ? null : String(row.coverage_through_seq);
  // 覆盖不完整或没校验过的摘要不作为「找回」结果：它不能定位，也就不能取回。
  if (!conversationId || !coverageFromSeq || !coverageThroughSeq || !row.coverage_source_hash) return null;
  const summary = (typeof row.summary === "object" && row.summary !== null && !Array.isArray(row.summary))
    ? row.summary as Record<string, unknown>
    : {};
  return {
    conversationId,
    title: typeof summary.title === "string" ? summary.title : "",
    keyEvents: stringList(summary.keyEvents, 3),
    followUps: stringList(summary.followUps, 3),
    userPreferences: stringList(summary.userPreferences, 2),
    coverageFromSeq,
    coverageThroughSeq,
    sourceHash: String(row.coverage_source_hash),
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : new Date(0).toISOString(),
  };
}

/**
 * 在**别的**会话里按关键词找回以前聊过的话题。
 *
 * 只认覆盖完整且经过校验的摘要（44 §5.1：结构化覆盖是取回的前提）。当前会话被
 * 排除：它的尾部与摘要已经在上下文里，再给一遍只会重复消耗窗口，还会让模型分不清
 * 哪段是「现在这轮」哪段是「历史」。
 */
export async function searchPastConversationSummaries(
  tx: Executor,
  scope: PastConversationScope,
  input: { query: string; excludeConversationId?: string | null; limit?: number },
): Promise<PastConversationHit[]> {
  const limit = Math.max(1, Math.min(MAX_PAST_CONVERSATION_HITS, input.limit ?? MAX_PAST_CONVERSATION_HITS));
  const keywords = extractQueryKeywords(input.query, 8);
  // 关键词由 extractQueryKeywords 限定在 [\p{L}\p{N}]+ 内，`%`/`_` 进不来，
  // 加通配符不引入 LIKE 注入面（与记忆关键词检索同一条纪律）。
  const patterns = toTextArrayLiteral(keywords.map((keyword) => `%${keyword}%`));
  const keywordFilter = patterns
    ? sql` AND (s.summary::text ILIKE ANY(${patterns}::text[]))`
    : sql``;
  const rows = asRows(await tx.execute(sql`
    SELECT s.conversation_id, s.summary, s.coverage_from_seq::text AS coverage_from_seq,
           s.coverage_through_seq::text AS coverage_through_seq, s.coverage_source_hash,
           s.updated_at
    FROM conversation_summaries s
    -- 方案 44 §3.3：读取侧检查当前有效性。会话消息被改写或删除后，会话的
    -- context_revision 会前进，而这份摘要记下的是**它被验证时**的取值——对不上就
    -- 说明它盖住的那一段已经变了。跨会话找回读的是同一批摘要，只认 status 不认
    -- 修订号，就会把一份来源已经变了的摘要当成「以前聊过什么」讲出来。
    JOIN companion_conversations c
      ON c.id = s.conversation_id AND c.workspace_id = s.workspace_id AND c.user_id = s.user_id
    WHERE s.workspace_id = ${scope.workspaceId}
      AND s.user_id = ${scope.userId}
      AND s.status IN ('candidate', 'confirmed')
      AND s.coverage_from_seq IS NOT NULL
      AND s.coverage_through_seq IS NOT NULL
      AND s.coverage_from_seq <= s.coverage_through_seq
      AND s.coverage_source_hash IS NOT NULL
      AND s.verified_context_revision = c.context_revision
      ${input.excludeConversationId
        ? sql`AND s.conversation_id <> ${input.excludeConversationId}`
        : sql``}
      ${keywordFilter}
    ORDER BY s.coverage_through_seq DESC, s.updated_at DESC
    LIMIT ${limit}
  `));
  return rows.map(mapHit).filter((hit): hit is PastConversationHit => hit !== null);
}

/**
 * 按 conversationId + seq 区间取回**那个会话**的原文。
 *
 * `conversationId` 不是可选参数：seq 是会话内的局部序号，只给 seq 会读到另一个会话
 * 的同号消息（44 §8.3 的验收点）。
 *
 * 返回里带 `truncated`：被上限截断时她必须知道后面还有没读，否则会当成读完了。
 */
export async function readPastConversationMessages(
  tx: Executor,
  scope: PastConversationScope,
  input: { conversationId: string; fromSeq: string; throughSeq?: string | null; limit?: number },
): Promise<PastConversationExcerpt> {
  const empty: PastConversationExcerpt = {
    conversationId: input.conversationId, messages: [], fromSeq: null, throughSeq: null, truncated: false,
  };
  let fromSeq: bigint;
  let throughSeq: bigint;
  try {
    fromSeq = BigInt(input.fromSeq);
    throughSeq = input.throughSeq ? BigInt(input.throughSeq) : fromSeq + BigInt(MAX_PAST_CONVERSATION_MESSAGES) - 1n;
  } catch {
    return empty;
  }
  if (fromSeq <= 0n || throughSeq < fromSeq) return empty;

  const limit = Math.max(1, Math.min(MAX_PAST_CONVERSATION_MESSAGES, input.limit ?? MAX_PAST_CONVERSATION_MESSAGES));
  const rows = asRows(await tx.execute(sql`
    -- m.page_context **不在** companion_messages 上——它在 companion_turn_runs，
    -- 按 user_message_id 回指那一条消息的轮次。直接写 m.page_context 在真库上会报
    -- column m.page_context does not exist（实测），整条「取回原文」链路每次调用都抛。
    -- （这段注释里原来用了反引号包列名——那是 JS 模板字符串的定界符，会把整个
    -- sql 标签提前截断。注释写在 sql 标签里必须避开反引号。）
    -- 写法对齐 readCompanionHistoryRows（companion-dialogue-store）：子查询取该轮次的
    -- selection，没有对应轮次时就是 null——不猜，也不从别处拼。
    SELECT m.id, m.seq::text AS seq, m.role, m.blocks,
           (SELECT jsonb_build_object('selection', coalesce(r.page_context->'selection', r.page_context->'context'->'selection'))
              FROM companion_turn_runs r
             WHERE r.user_message_id = m.id AND m.role = 'user'
             ORDER BY r.created_at DESC LIMIT 1) AS page_context
    FROM companion_messages m
    JOIN companion_conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ${input.conversationId}
      -- 会话本身必须属于本工作区与本人：范围校验落在**会话**上，而不是只落在
      -- 消息上——否则一个猜到的 conversationId 就足以读到别人的对话。
      AND c.workspace_id = ${scope.workspaceId}
      AND c.user_id = ${scope.userId}
      AND m.seq >= ${fromSeq.toString()}::bigint
      AND m.seq <= ${throughSeq.toString()}::bigint
      AND m.role IN ('user', 'assistant')
    ORDER BY m.seq
    LIMIT ${limit + 1}
  `));

  const messages: PastConversationMessage[] = [];
  let chars = 0;
  let truncated = false;
  for (const row of rows.slice(0, limit)) {
    // 正文按与回放同一份投影还原（用户消息带选区/页面上下文），不重新发明一套解析。
    const text = companionHistoryText({
      role: row.role === "assistant" ? "assistant" : "user",
      blocks: row.blocks,
      page_context: row.page_context,
    }).slice(0, PAST_MESSAGE_MAX_CHARS);
    if (messages.length > 0 && chars + text.length > PAST_MESSAGES_MAX_CHARS) {
      truncated = true;
      break;
    }
    messages.push({ seq: String(row.seq), role: row.role === "assistant" ? "assistant" : "user", text });
    chars += text.length;
  }
  // 多取一行就是用来判「还有没有」的：取到了 limit+1 说明被上限挡住。
  if (rows.length > limit) truncated = true;
  return {
    conversationId: input.conversationId,
    messages,
    fromSeq: messages[0]?.seq ?? null,
    throughSeq: messages.at(-1)?.seq ?? null,
    truncated,
  };
}
