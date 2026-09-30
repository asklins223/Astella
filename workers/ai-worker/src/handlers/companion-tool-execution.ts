/**
 * 伴星 agent 的**工具执行**（2026-09-30 拆出，B2）。
 *
 * ## 为什么拆
 *
 * `companion-agent-runtime.ts` 原本把四类东西挤在一起：步进规划
 * （`companion-step-plan.ts`）、读工具（`companion-read-tools.ts`）、
 * 事件持久化（`companion-agent-events.ts`）、以及本文件。
 *
 * 本文件是「拿到一个工具名和参数 → 按那张账本决定能不能跑 → 跑 → 给出
 * `value` / `safeSummary` / `route`」。它不决定跑哪一步、不写事件、不读内容。
 *
 * 分开的理由是**它有自己的纪律**：`companion-tool-executor-ledger.test.ts`
 * 那张表逐条记着「每个 `*Id` 参数落到哪张表的哪一列」，而那张表的判据扫的是
 * **执行体**。执行体与步进规划、事件写入挤在一个文件里时，「改一段规划逻辑」
 * 会顺带改到那张表盯着的文本。
 *
 * ## 这一段是**照搬**的
 *
 * 账本分支、错误句、SQL 一个字没改。
 */

import { sql } from "drizzle-orm";
import {
  isVisionGatedCompanionTool,
  companionPageLabelV2,
  type CompanionAgentToolDefinitionV1,
  type CompanionContentBlockV1,
} from "@ailearn/shared";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { createEmbeddingProvider, createProvider, type AIProvider } from "../lib/ai-provider.ts";
import {
  AIDataPolicyDeniedError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { getObjectBytes } from "../lib/object-storage.ts";
import { noteSearchTerms, parsePageContext, stripProviderControlTokens } from "./companion-dialogue-content.ts";
import {
  ageLabel,
  readLearningStats,
  summarizeLearningStats,
  tzSubquery,
  visibleCompanionCardSourceCondition,
  visibleCompanionDueReviewCondition,
} from "./companion-here-and-now.ts";
import { retrieveCompanionMemories } from "./companion-memory-vector.ts";
import { taskEntityFromPersistedPageContext } from "./companion-task-memory.ts";
import {
  NOTE_READ_MAX_CHARS,
  READ_IMAGE_MAX_RAW_BYTES,
  SITE_IMAGE_URL_PREFIX,
  VISION_EGRESS_DENIED_MESSAGE,
  currentPageToolResult,
  findNoteImageAsset,
  loadNoteReadPage,
  loadSourceReadPage,
  missingImageMessage,
  readLatestPageContextRow,
  sourceNotReadyNote,
  taskQueueToolResult,
  type ActivityRow,
  type AgentEventContext,
  type DueReviewRow,
  type NoteSearchRow,
  type TaskQueueRow,
} from "./companion-read-tools.ts";
import { partitionPersonaPatch } from "./companion-step-plan.ts";
import type { EmbeddingProviderLike } from "../lib/ai-provider.ts";

/** 工具报错分两级：能被用户看见的，与必须停在工具面的。 */
export class CompanionToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionToolError";
  }
}

export class CompanionToolBlockedError extends CompanionToolError {
  constructor(message: string) {
    super(message);
    this.name = "CompanionToolBlockedError";
  }
}

export interface AgentToolExecutionResult {
  value: Record<string, unknown>;
  safeSummary: string;
  resultRef?: string;
  route?: Record<string, unknown>;
  /** 跳转块上给人看的那句（"打开《消防疏散》"）。缺省回落到工具描述。 */
  routeLabel?: string;
  /** 工具顺手带出的其它富块（读出来的原文 = quote）。与 route 生成的 nav 一起落进消息。 */
  blocks?: CompanionContentBlockV1[];
}



export async function executeReadTool(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  args: Record<string, unknown>,
): Promise<AgentToolExecutionResult> {
  // 外发政策门禁。工具面本来已经把受管工具摘掉了（见 resolveAllCompanionAgentTools），
  // 这里再拦一次是因为**工具名是模型给的**：不复核就等于"下发面没列出来"这件事
  // 只是运气好，而不是一个保证。判定只看服务端解析出的约束，不看模型自述。
  if (isVisionGatedCompanionTool(definition.name) && event.constraints.visionEnabled !== true) {
    throw new CompanionToolBlockedError(VISION_EGRESS_DENIED_MESSAGE);
  }
  switch (definition.name) {
    case "companion_read_context": {
      const page = parsePageContext(event.read.pageContext);
      const result = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{ id: string; phase: string; active_task_id: string | null }>(sql`
            SELECT id, phase, active_task_id
            FROM learning_runs
            WHERE workspace_id = ${event.ctx.workspaceId}
              AND user_id = ${event.read.userId}
              AND phase IN ('preparing', 'active', 'assessing', 'checkpoint', 'committing', 'paused')
            ORDER BY updated_at DESC, id
            LIMIT 1
          `);
          const current = rows[0];
          return {
            pageKind: typeof page?.pageKind === "string" ? page.pageKind : null,
            groundedTutorAvailable: event.read.groundedTutorContext !== null,
            currentLearningRun: current
              ? { runId: current.id, phase: current.phase, taskId: current.active_task_id }
              : null,
          };
        },
      );
      return { value: result, safeSummary: "已读取当前学习上下文" };
    }
    case "companion_read_current_page": {
      const row = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => readLatestPageContextRow(tx, {
          workspaceId: event.ctx.workspaceId,
          userId: event.read.userId,
        }),
      );
      return currentPageToolResult(row);
    }
    case "companion_read_history": {
      const limit = typeof args.limit === "number" ? Math.min(20, Math.max(1, args.limit)) : 10;
      const history = event.read.recentMessages.slice(-limit).map((message) => ({
        role: message.role,
        text: message.text.slice(0, 1_000),
      }));
      return { value: { messages: history }, safeSummary: `已读取 ${history.length} 条对话历史` };
    }
    case "companion_recall_memory": {
      // 与被删掉的 companion_read_memory 的区别就是这条工具存在的理由：
      // read_memory 返回的是**本轮已经注入 prompt 的那一份**，调一次等于把看过的
      // 东西再看一遍（她以为在"回忆"，实际什么都没查到）。这里做真检索并排除已注入项。
      const query = String(args.query).trim().slice(0, 200);
      const limit = typeof args.limit === "number" ? Math.min(8, Math.max(1, args.limit)) : 5;
      // 查询向量必须在开事务**之前**算：retrieveCompanionMemories 的约定是
      // precomputedEmbedding=null 表示"已试过且失败 → 直接降级 keyword"，
      // 绝不在事务里重试外部调用（事务被网络调用占住是另一类稳定性事故）。
      let provider: EmbeddingProviderLike | null = null;
      try {
        provider = await createEmbeddingProvider();
      } catch {
        provider = null;
      }
      let queryEmbedding: number[] | null = null;
      if (provider) {
        try {
          queryEmbedding = await provider.embed(query, event.ctx.signal);
        } catch {
          queryEmbedding = null;
        }
      }
      const retrieval = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => retrieveCompanionMemories(tx, {
          workspaceId: event.ctx.workspaceId,
          userId: event.read.userId,
        }, query, {
          topK: limit * 2,
          provider,
          precomputedEmbedding: queryEmbedding,
          // 任务记忆按身份可见（39b C8）：本轮落在学习页/卡页时，绑定到这个
          // run/card 的 task 记忆才可见；普通页推不出身份，task 行一概不可见。
          taskEntity: taskEntityFromPersistedPageContext(event.read.pageContext),
        }),
      );
      const alreadyShown = new Set(event.read.activeMemories.map((memory) => memory.content));
      const memories = retrieval.items
        .filter((item) => !alreadyShown.has(item.content))
        .slice(0, limit)
        .map((item) => ({
          // memoryId 必须回传：companion_forget_memory 的参数就是它。漏了这条，
          // 她只能凭空编一个 uuid（实机 2026-09-21 编出 5e0a2b1c-3d4f-…），
          // 于是"忘掉"永远失败——而失败原因是"找不到"，看起来像她记错了。
          memoryId: item.memoryId,
          kind: item.kind,
          content: item.content.slice(0, 200),
          userConfirmed: item.userConfirmed,
        }));
      return {
        value: { memories, retrievalMode: retrieval.mode },
        safeSummary: memories.length > 0
          ? `又翻到 ${memories.length} 条相关记忆`
          : "没有翻到比当前上下文更多的记忆",
      };
    }
    case "companion_list_recent_activity": {
      const days = typeof args.days === "number" ? Math.min(30, Math.max(1, args.days)) : 7;
      const window = sql`now() - (${days} * interval '1 day')`;
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => tx.execute<ActivityRow>(sql`
          SELECT 'note' AS kind, n.title AS label,
                 (EXTRACT(EPOCH FROM (now() - n.updated_at)) / 60)::int AS age_minutes
          FROM notes n
          WHERE n.workspace_id = ${event.ctx.workspaceId}
            AND n.deleted_at IS NULL AND n.updated_at > ${window}
          UNION ALL
          SELECT 'review', coalesce(nullif(c.front->>'cue', ''), '一张卡片'),
                 (EXTRACT(EPOCH FROM (now() - s.last_review_at)) / 60)::int
          FROM review_schedules s
          LEFT JOIN learning_cards_v2 c ON c.card_id = s.subject_id AND c.workspace_id = s.workspace_id
          WHERE s.workspace_id = ${event.ctx.workspaceId} AND s.user_id = ${event.read.userId}
            AND s.status = 'completed' AND s.last_review_at > ${window}
          UNION ALL
          SELECT 'card', coalesce(nullif(c2.front->>'cue', ''), '新卡片'),
                 (EXTRACT(EPOCH FROM (now() - c2.created_at)) / 60)::int
          FROM learning_cards_v2 c2
          WHERE c2.workspace_id = ${event.ctx.workspaceId} AND c2.created_at > ${window}
          UNION ALL
          SELECT 'reminder', r.text,
                 (EXTRACT(EPOCH FROM (now() - r.fired_at)) / 60)::int
          FROM companion_reminders r
          WHERE r.workspace_id = ${event.ctx.workspaceId} AND r.user_id = ${event.read.userId}
            AND r.status = 'fired' AND r.fired_at > ${window}
          ORDER BY age_minutes
          LIMIT 12
        `),
      );
      const activity = rows.map((row) => ({
        kind: row.kind,
        label: String(row.label ?? "").slice(0, 60),
        when: ageLabel(Math.max(0, Number(row.age_minutes))),
      }));
      return {
        value: { activity },
        safeSummary: activity.length > 0
          ? `最近 ${days} 天有 ${activity.length} 条动态`
          : `最近 ${days} 天没有记录到动态`,
      };
    }
    case "companion_open_card": {
      const cardId = String(args.cardId);
      const card = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{
            card_id: string; objective_id: string; cue: string | null;
            prompt: string | null; summary: string | null; form: string | null;
          }>(sql`
            SELECT c.card_id, c.objective_id, left(c.front->>'cue', 300) AS cue,
                   left(c.front->>'prompt', 280) AS prompt,
                   left(c.public_summary, 300) AS summary, c.knowledge_form AS form
            FROM learning_cards_v2 c
            -- 到期列表递过来的那个 id 是 review_schedules.subject_id，而它按方案 20
            -- §29.4 的别名规则**存的是 objectiveId**（subject_type 却叫 'card'）。
            -- 只按 card_id 查的话她永远打不开：实测 23 个 subject_id 里 19 个是 objectiveId。
            -- 两个键一次查掉，精确命中卡片时排前面。
            WHERE c.workspace_id = ${event.ctx.workspaceId}
              AND c.lifecycle = 'active'
              AND (c.card_id = ${cardId} OR c.objective_id = ${cardId})
              AND ${visibleCompanionCardSourceCondition(event.read.userId)}
            ORDER BY (c.card_id = ${cardId}) DESC
            LIMIT 1
          `);
          return rows[0] ?? null;
        },
      );
      if (!card) throw new CompanionToolError("这个空间里没有这张学习卡");
      const route = { kind: "card", cardId: card.card_id, objectiveId: card.objective_id };
      const front = [card.cue, card.prompt].filter((part): part is string => Boolean(part?.trim())).join(" — ");
      const cardTitle = (card.cue ?? "").trim();
      return {
        // 题面必须**同时**进 value：只进 blocks 的话，块渲染给用户看了，
        // 她自己却看不见那段文字（实机 2026-09-21 Y 轮：card 块落库成功，
        // 她紧接着说"题面的具体文字我这边读不到——卡片只是帮你定位打开了"）。
        // 那不是谦虚，是事实：喂回给模型的 data 里当时只有 route。
        value: {
          route,
          card: {
            cardId: card.card_id,
            front: front.slice(0, 600),
            summary: card.summary,
            knowledgeForm: card.form,
          },
        },
        route,
        routeLabel: cardTitle ? `打开卡片「${cardTitle}」` : "打开这张卡片",
        // 卡片内容作为独立块带出（§4.8）：题面由服务端给，不让她转抄——转抄一遍
        // 就成了"她复述的卡片"，用户分不清哪几个字是原文。
        blocks: front.length > 0
          ? [{
              type: "card" as const,
              // 用查回来的真 card_id：传进来的那个可能是 objectiveId（见上面的别名规则），
              // 而块里的 cardId 是客户端跳转的落点，合同只校验"是不是 uuid"，不会替我认错。
              cardId: card.card_id,
              front: front.slice(0, 600),
              summary: card.summary,
              knowledgeForm: card.form,
            }]
          : [],
        safeSummary: "已定位到学习卡片",
      };
    }
    case "companion_search_notes": {
      const query = String(args.query).trim().slice(0, 120);
      const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, args.limit)) : 5;
      const terms = noteSearchTerms(query);
      if (terms.length === 0) {
        // 检索词被剥成空（模型只给了空格或纯标点）时**不能**放一个 `%%` 进去——
        // 那会命中库里所有笔记，然后被她当成"这些都相关"念出来。
        return { value: { notes: [] }, safeSummary: "检索词是空的，我需要先知道要搜什么" };
      }
      // 每个词都得命中（标题或正文），不是整串子串相等。实机 2026-09-22 真人轮：
      // 她按摘要里的名字搜《欧姆定律生成验收》，用的检索词是"欧姆定律 生成验收"
      // （中间一个空格），整串 `%…%` 在这篇笔记的标题里匹配不上 → 工具回"没有找到"，
      // 而这篇笔记在库里、没删。假阴性的代价不是"少一条结果"，是她据此说"库里没这篇"。
      const termConditions = terms.map((term) => sql`
        (n.title ILIKE ${`%${term}%`} OR EXISTS (
          SELECT 1 FROM note_blocks nb
          WHERE nb.version_id = n.current_version_id
            AND nb.content ILIKE ${`%${term}%`}
        ))`);
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => tx.execute<NoteSearchRow>(sql`
          SELECT n.id::text AS id,
                 n.title,
                 (EXTRACT(EPOCH FROM (now() - n.updated_at)) / 60)::int AS age_minutes,
                 left(coalesce(b.snippet, ''), 160) AS snippet
          FROM notes n
          LEFT JOIN LATERAL (
            SELECT string_agg(nb.content, ' ') AS snippet
            FROM note_blocks nb
            WHERE nb.version_id = n.current_version_id
              AND nb.content ILIKE ${`%${terms[0]}%`}
          ) b ON true
          WHERE n.workspace_id = ${event.ctx.workspaceId}
            AND n.deleted_at IS NULL
            AND ${sql.join(termConditions, sql` AND `)}
          ORDER BY n.updated_at DESC
          LIMIT ${limit}
        `),
      );
      const notesFound = rows.map((row) => ({
        noteId: row.id,
        title: row.title,
        updated: ageLabel(Number(row.age_minutes)),
        ...(row.snippet ? { matched: row.snippet } : {}),
      }));
      return {
        value: { notes: notesFound },
        safeSummary: notesFound.length > 0
          ? `找到 ${notesFound.length} 篇相关笔记`
          : `没有找到与「${query.slice(0, 20)}」相关的笔记`,
      };
    }
    case "companion_read_note": {
      const noteId = String(args.noteId);
      const noteVersionId = typeof args.noteVersionId === "string" ? args.noteVersionId : undefined;
      // 分页续读（39d W6-2 / 39b C5）：startOrdinal 是上一页给的 nextStartOrdinal；
      // 不给就从第一块读起。改前是"整篇聚合 → 静默截前 3000 字"，只有 truncated
      // 标记没有出路——"解释最后一节"从此读不到。
      const startOrdinal = typeof args.startOrdinal === "number"
        && Number.isInteger(args.startOrdinal) && args.startOrdinal >= 1
        ? args.startOrdinal
        : 1;
      const note = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => loadNoteReadPage(tx, {
          workspaceId: event.ctx.workspaceId,
          userId: event.read.userId,
          noteId,
          ...(noteVersionId ? { noteVersionId } : {}),
          startOrdinal,
          maxChars: NOTE_READ_MAX_CHARS,
        }),
      );
      if (!note) throw new CompanionToolError("这个空间里没有这篇笔记");
      const page = note.page;
      const { truncated, nextStartOrdinal } = note;
      // 原文由服务端带出，不让模型转抄：她复述一遍就成了"引用"，而用户没法知道
      // 哪几个字是她改写的。这一块就是她读到的那几行，标题与时间跟着走。
      const quoted = page.body.slice(0, 1_200);
      return {
        value: {
          // 分页元数据排在 body **之前**：工具结果整包会被 maxOutputChars(4000)
          // 截尾，而 body 上限 3000 字——nextStartOrdinal 是续读的唯一出路，
          // 被截掉她就会把"这一页"当成"全文"。
          imageCount: note.imageTotal,
          ...(note.imageIds.length > 0 ? { imageAssetIds: note.imageIds } : {}),
          // 有图却看不了时，先把"正文里没有图片标记 ≠ 这篇没有图"讲明（她读的是
          // note_blocks，图是另一张表里的资源，所以她"照实读正文"仍会推出错误结论），
          // 再给她出路。不这样写，她的下一句就是"我看看这张图"——而工具面上根本没有
          // 那个工具（政策关着时不下发），答应一件做不到的事正是抱怨 #9 最难堪的形状。
          ...(note.imageTotal > 0 && event.constraints.visionEnabled !== true
            ? {
                imageNote: `这篇另有 ${note.imageTotal} 张图，图不在正文里（正文没有图片标记不代表没有图）。`
                  + "图片外发未开启，这些图看不了。用户问起就照实说，并告诉他设置里的「允许发送图片内容」开关；"
                  + "不要说「我看看」，也不要凭标题猜图里有什么。",
              }
            : {}),
          title: note.title,
          updated: ageLabel(Number(note.ageMinutes)),
          version: note.versionId,
          startOrdinal,
          ...(page.endOrdinal !== null ? { endOrdinal: page.endOrdinal } : {}),
          totalBlocks: note.totalBlocks,
          truncated,
          ...(nextStartOrdinal !== null ? { nextStartOrdinal } : {}),
          ...(page.blockTextTruncated ? { blockTextTruncated: true } : {}),
          body: page.body,
        },
        blocks: quoted.length > 0
          ? [{
              type: "quote" as const,
              label: `《${note.title.slice(0, 28)}》· ${ageLabel(Number(note.ageMinutes))}`,
              text: quoted + (page.body.length > quoted.length ? "…" : ""),
            }]
          : [],
        safeSummary: `已读出笔记《${note.title.slice(0, 24)}》`
          + `（${page.endOrdinal !== null ? `第 ${startOrdinal}–${page.endOrdinal} 块，共 ${note.totalBlocks} 块` : "无正文"}`
          + `，${page.body.length} 字${note.imageTotal > 0 ? `，另附 ${note.imageTotal} 张图` : ""}）`,
      };
    }
    case "companion_read_source": {
      const sourceId = String(args.sourceId);
      const startOrdinal = typeof args.startOrdinal === "number"
        && Number.isInteger(args.startOrdinal) && args.startOrdinal >= 1
        ? args.startOrdinal
        : 1;
      const source = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => loadSourceReadPage(tx, {
          workspaceId: event.ctx.workspaceId,
          sourceId,
          startOrdinal,
          maxChars: NOTE_READ_MAX_CHARS,
        }),
      );
      if (!source) throw new CompanionToolError("这个空间里没有这份来源");
      if (source.page === null) {
        return {
          value: {
            title: source.title,
            status: source.status,
            note: sourceNotReadyNote(source.status),
          },
          safeSummary: `来源《${source.title.slice(0, 24)}》还没解析好（${source.status}），正文读不到`,
        };
      }
      const page = source.page;
      const { truncated, nextStartOrdinal } = source;
      const quoted = page.body.slice(0, 1_200);
      return {
        value: {
          // 同 read_note：分页元数据在 body 之前，maxOutputChars 截尾不吞续读指针。
          title: source.title,
          ...(source.origin ? { origin: source.origin } : {}),
          startOrdinal,
          ...(page.endOrdinal !== null ? { endOrdinal: page.endOrdinal } : {}),
          totalBlocks: source.totalSegments,
          truncated,
          ...(nextStartOrdinal !== null ? { nextStartOrdinal } : {}),
          ...(page.blockTextTruncated ? { blockTextTruncated: true } : {}),
          body: page.body,
        },
        blocks: quoted.length > 0
          ? [{
              type: "quote" as const,
              label: `来源《${source.title.slice(0, 28)}》`,
              text: quoted + (page.body.length > quoted.length ? "…" : ""),
            }]
          : [],
        safeSummary: `已读出来源《${source.title.slice(0, 24)}》`
          + `（${page.endOrdinal !== null ? `第 ${startOrdinal}–${page.endOrdinal} 段，共 ${source.totalSegments} 段` : "无正文"}，${page.body.length} 字）`,
      };
    }
    case "companion_read_image": {
      const assetId = typeof args.assetId === "string" && args.assetId ? args.assetId : null;
      const noteId = typeof args.noteId === "string" && args.noteId ? args.noteId : null;
      if (!assetId && !noteId) {
        throw new CompanionToolError(
          "我还不知道要看哪一张图。跟我说说是哪篇笔记里的，或者第几张。",
        );
      }
      const { asset } = await findNoteImageAsset(event, { assetId, noteId, position: 1 });
      if (!asset) throw new CompanionToolError(missingImageMessage(assetId));
      if (asset.byte_size > READ_IMAGE_MAX_RAW_BYTES) {
        throw new CompanionToolError(
          `这张图有 ${(asset.byte_size / 1_000_000).toFixed(1)}MB，太大发不出去，换张小一点的截图才看得了`,
        );
      }
      const bytes = await getObjectBytes(asset.object_key, READ_IMAGE_MAX_RAW_BYTES);
      const question = typeof args.question === "string" && args.question.trim()
        ? args.question.trim().slice(0, 200)
        : "图里写了什么、画了什么";
      const govCtx = await resolveAIGovernanceContext(event.ctx.workspaceId, event.read.userId);
      const visionRes = resolveProviderForTask(govCtx, "analyze_image");
      const visionProvider = createGovernedProvider(
        createProvider(visionRes.providerName, visionRes.providerConfig),
        // 出网治理门在这里是**真的**门：多模态消息会被认成 image_content，政策
        // 半路被改（这一轮开始时还开着、执行图的时候关了）也会在这一步被拦下。
        govCtx,
        event.ctx.workspaceId,
        // jobId 是 ai_audit_log.job_id —— 与本 handler 其它审计行同一口径（job 的
        // id，不是 run 的 id）。这一列当前没有外键，填错不会炸库，只会让成本/合规
        // 记录按 job 聚合时对不上号。
        { userId: event.read.userId, operation: "companion_read_image", jobId: event.ctx.id },
      );
      let result: Awaited<ReturnType<AIProvider["chatCompletion"]>>;
      try {
        result = await visionProvider.chatCompletion(
          [
            {
              role: "system",
              content: "你是看图的那双眼睛，替一个学习助手转述图里的内容。"
                + "只说图上确实看得见的东西：文字按原文抄（公式、表格、代码用 markdown 保持结构），"
                + "流程/结构类图先说清是什么再逐项列出。看不清、被截掉、图上没有的一律直说看不清，"
                + "绝不猜、不用常识补、不编内容。直接说内容，不要开场白。",
            },
            {
              role: "user",
              content: [
                { type: "text", text: `问题：${question}` },
                {
                  type: "image_url",
                  image_url: { url: `data:${asset.mime_type};base64,${bytes.toString("base64")}`, detail: "high" },
                },
              ],
            },
          ],
          { maxTokens: 1_500, temperature: 0.2, responseFormat: "text", model: visionProvider.visionModelId },
          event.ctx.signal,
        );
      } catch (error) {
        // 政策在这一轮进行中才被关闭（她开始时还能看，取字节的这几秒里用户拧了开关）：
        // 治理层会直接拒发，这时给她同一句人话，而不是"工具执行失败，请稍后再试"。
        if (error instanceof AIDataPolicyDeniedError) {
          throw new CompanionToolBlockedError(VISION_EGRESS_DENIED_MESSAGE);
        }
        throw error;
      }
      // 供应商会把自己的分词控制符吐进内容里（实机 2026-09-21 探针：视觉槽位对
      // "几种颜色"回答 `<|begin_of_box|>1<|end_of_box|>`）。这一段是**数据**——
      // 她会把里面的字转述给用户、TTS 也会念，控制符留着就是"1"变成一串标记。
      const description = stripProviderControlTokens(String(result.content ?? "")).trim();
      if (!description) throw new CompanionToolError("看过这张图了，但没读出任何内容");
      return {
        value: {
          question,
          description: description.slice(0, 3_000),
          size: `${asset.width}×${asset.height}`,
          ...(asset.note_title ? { inNote: asset.note_title.slice(0, 40) } : {}),
        },
        safeSummary: `已看过那张图（${asset.width}×${asset.height}，${description.length} 字描述）`,
      };
    }
    case "companion_show_image": {
      const assetId = typeof args.assetId === "string" && args.assetId ? args.assetId : null;
      const noteId = typeof args.noteId === "string" && args.noteId ? args.noteId : null;
      const position = typeof args.position === "number" ? Math.min(20, Math.max(1, Math.floor(args.position))) : 1;
      if (!assetId && !noteId) {
        throw new CompanionToolError(
          "我还不知道要给你摆哪一张图。说一下是哪篇笔记里的第几张就行。",
        );
      }
      // 这条**不读字节、不出境**，所以不受 sendImageContent 管：图片外发关着时，
      // "把那张图给我看"照样办得成。把它错并到读图那档里，就是我最初设计读图时
      // 差点做的事——一个开关关掉两件不同的能力。
      const { asset, noteTotal } = await findNoteImageAsset(event, { assetId, noteId, position });
      if (!asset) {
        throw new CompanionToolError(
          noteTotal > 0
            ? `那篇笔记一共只有 ${noteTotal} 张图，没有第 ${position} 张`
            : missingImageMessage(assetId),
        );
      }
      const label = `${asset.note_title ? `《${asset.note_title.slice(0, 24)}》` : "那张图"} · 第 ${position} 张`;
      return {
        value: {
          url: `${SITE_IMAGE_URL_PREFIX}${asset.object_key}`,
          label,
          size: `${asset.width}×${asset.height}`,
        },
        blocks: [{
          type: "image" as const,
          url: `${SITE_IMAGE_URL_PREFIX}${asset.object_key}`,
          label: label.slice(0, 80),
        }],
        safeSummary: `已把那张图放到对话里（${asset.width}×${asset.height}）`,
      };
    }
    case "companion_open_note": {
      const noteId = String(args.noteId);
      const found = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => tx.execute<{ title: string }>(sql`
          SELECT title FROM notes
          WHERE id = ${noteId}::uuid
            AND workspace_id = ${event.ctx.workspaceId}
            AND deleted_at IS NULL
          LIMIT 1
        `),
      );
      const note = (Array.isArray(found) ? found : [])[0];
      if (!note) throw new CompanionToolError("这个空间里没有这篇笔记");
      const route = { kind: "note", noteId };
      return {
        value: { route },
        route,
        routeLabel: `打开《${note.title.slice(0, 24)}》`,
        safeSummary: `已定位到笔记《${note.title.slice(0, 24)}》`,
      };
    }
    case "companion_open_page": {
      const page = String(args.page);
      // 与 allowedMainRouteV2Schema 对齐的无参页面；带实体的（note/card/learning_run）
      // 各有专门工具去做归属校验，这里不接受 id，避免"任意 UUID 构造导航 route"。
      const route = { kind: page };
      const label = companionPageLabelV2(page);
      return {
        value: { route },
        route,
        routeLabel: `去${label}`,
        safeSummary: `已定位到${label}页面`,
      };
    }
    case "companion_get_learning_stats": {
      // 取数与环境块共用同一份（`readLearningStats`）：她答话的口径和"用户问到学习数据
      // 时先注入的真值"必须是同一个数，两处各写一份迟早会分叉。
      const stats = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => readLearningStats(tx, {
          workspaceId: event.ctx.workspaceId,
          userId: event.read.userId,
        }),
      );
      // 摊成字面量：工具合同要的是 `Record<string, unknown>`，接口没有隐式索引签名。
      const value = { ...stats };
      return {
        value,
        safeSummary: summarizeLearningStats(stats),
      };
    }
    case "companion_list_task_queue": {
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => tx.execute<TaskQueueRow>(sql`
          SELECT t.id::text AS task_id,
                 t.sequence,
                 t.status,
                 coalesce(nullif(t.target_summary, ''), left(t.prompt, 60)) AS label,
                 r.phase AS run_phase,
                 t.run_id::text AS run_id
          FROM learning_tasks t
          JOIN learning_runs r ON r.id = t.run_id
          WHERE t.workspace_id = ${event.ctx.workspaceId}
            AND t.user_id = ${event.read.userId}
            AND r.phase IN ('preparing', 'active', 'assessing', 'checkpoint', 'committing', 'paused')
            AND t.status IN ('pending', 'presented', 'in_progress')
          ORDER BY r.updated_at DESC, t.sequence
          LIMIT 12
        `),
      );
      return taskQueueToolResult(rows);
    }
    case "companion_list_due_reviews": {
      // 这一份列表与 `companion_get_learning_stats` 的到期数、以及首页的"待复习"必须是
      // **同一个集合**：以前这里比统计多一层"卡的来源笔记要对本人可见"，于是会出现
      // "她说 2 项、点进队列有 3 条"（清单比数还短，说不过去）。判据统一到队列那一条。
      const limit = typeof args.limit === "number" ? Math.min(20, Math.max(1, args.limit)) : 8;
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => tx.execute<DueReviewRow>(sql`
          SELECT s.id::text AS schedule_id,
                 s.subject_id::text AS objective_id,
                 c.card_id::text AS card_id,
                 coalesce(nullif(c.front->>'cue', ''), '这条复习还没有生成卡片') AS title,
                 (EXTRACT(EPOCH FROM (now() - coalesce(s.user_deferred_until, s.next_review_at))) / 3600)::int AS overdue_hours
          FROM review_schedules s
          JOIN learning_objectives_v2 o
            ON o.objective_id = s.subject_id AND o.workspace_id = s.workspace_id AND o.lifecycle = 'active'
          JOIN learning_cards_v2 c
            ON c.objective_id = s.subject_id AND c.workspace_id = s.workspace_id AND c.lifecycle = 'active'
          WHERE s.workspace_id = ${event.ctx.workspaceId}
            AND s.user_id = ${event.read.userId}
            AND s.status = 'pending'
            AND s.next_review_at <= now()
            AND (s.user_deferred_until IS NULL OR s.user_deferred_until <= now())
            AND ${visibleCompanionDueReviewCondition()}
          ORDER BY s.next_review_at
          LIMIT ${limit}
        `),
      );
      const due = rows.map((row) => ({
        scheduleId: row.schedule_id,
        // 只给她一个可以直接用的 id，并把"有没有卡"说出来：以前给的是 scheduleId
        // （她拿不到卡片 id），后来给的其实是 objectiveId（open_card 只认 card_id，
        // 永远 not_found）。现在 open_card 两个键都查，这里给哪个都不会炸，
        // 但有卡时给 card 自己的 id，跳过去落点更准。
        cardId: row.card_id ?? row.objective_id,
        hasCard: row.card_id !== null,
        title: String(row.title).slice(0, 60),
        overdueHours: Math.max(0, Number(row.overdue_hours)),
      }));
      return {
        value: { dueReviews: due },
        safeSummary: due.length > 0
          ? `${due.length} 项复习已到期（其中 ${due.filter((item) => item.hasCard).length} 项有卡片）`
          : "目前没有到期的复习",
      };
    }
    case "companion_list_reminders": {
      // 回给用户本地钟面时间而不是 UTC ISO：她要照着这个数说"你答应我的事"。
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => tx.execute<{
          id: string; text: string; fire_at_local: string; in_hours: string | null;
        }>(sql`
          SELECT id::text AS id,
                 text,
                 to_char(fire_at AT TIME ZONE ${tzSubquery(event.read.userId)},
                         'YYYY-MM-DD HH24:MI') AS fire_at_local,
                 EXTRACT(EPOCH FROM (fire_at - now())) / 3600 AS in_hours
          FROM companion_reminders
          WHERE workspace_id = ${event.ctx.workspaceId}
            AND user_id = ${event.read.userId}
            AND status = 'pending'
          ORDER BY fire_at
          LIMIT 10
        `),
      );
      const reminders = rows.map((row) => ({
        reminderId: row.id,
        text: row.text,
        fireAtLocal: row.fire_at_local,
        inHours: Math.round(Number(row.in_hours) * 10) / 10,
      }));
      return {
        value: { reminders },
        safeSummary: reminders.length > 0
          ? `还有 ${reminders.length} 条待兑现的提醒`
          : "目前没有待兑现的提醒",
      };
    }
    case "companion_render_diagram": {
      // 呈现类：不查库、不写库，只是把她给的结构变成一块交给客户端（§4.8）。
      // 参数已经过 zod 校验（2–8 步、长度上限），这里只做一次防御性截断。
      const title = String(args.title).trim().slice(0, 60);
      const steps = (args.steps as Array<{ label: string; detail?: string }>).slice(0, 8)
        .map((step) => ({
          label: String(step.label).trim().slice(0, 40),
          ...(step.detail ? { detail: String(step.detail).trim().slice(0, 80) } : {}),
        }))
        .filter((step) => step.label.length > 0);
      if (steps.length < 2) throw new CompanionToolError("流程图至少需要两个步骤");
      return {
        value: { title, steps },
        blocks: [{ type: "diagram" as const, title, steps }],
        safeSummary: `已画出 ${steps.length} 步流程图`,
      };
    }
    default:
      throw new CompanionToolError("这一步不是读取操作，不该走读取那条路");
  }
}

/**
 * auto-set / auto-fill 工具的直执行器（2026-09-19 权限分级对齐原设计）。
 *
 * 只服务两类调用：① full 档预授权（requiresConfirmation=false 直达这里）；
 * ② guided 档的可逆低风险工具走提案确认后……不会走到这里——确认后由
 * API 的 proposal decision 链路执行。所以此处的每个 case 都必须是
 * 可逆、低风险、服务端一次 SQL 能完成的最小写入，且参数已在注册表
 * schema 校验过。新增 case 前先确认工具仍是 reversible_low。
 *
 * 与 executeReadTool 同样的安全边界：workspace + user 归属谓词、
 * withWorkerWorkspaceTransaction 的 RLS 上下文、失败抛 CompanionToolError
 * （message 会进 SSE/模型上下文，必须可安全展示）。
 */
export async function executeDirectTool(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  args: Record<string, unknown>,
): Promise<AgentToolExecutionResult> {
  switch (definition.name) {
    case "companion_set_activeness": {
      const activeness = String(args.activeness);
      const label = activeness === "quiet" ? "安静" : activeness === "active" ? "活跃" : "适中";
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const current = await tx.execute<{ activeness: string }>(sql`
            SELECT activeness FROM pet_profiles
            WHERE workspace_id = ${event.ctx.workspaceId} AND user_id = ${event.read.userId}
            LIMIT 1
          `);
          const row = (Array.isArray(current) ? current : [])[0];
          if (!row) return "missing" as const;
          // 已经是这样了就不写 revision，也不给她一个"已设为"的成功摘要。
          if (row.activeness === activeness) return "unchanged" as const;
          const rows = await tx.execute<{ id: string }>(sql`
            UPDATE pet_profiles
            SET activeness = ${activeness}, revision = revision + 1, updated_at = now()
            WHERE workspace_id = ${event.ctx.workspaceId}
              AND user_id = ${event.read.userId}
            RETURNING id
          `);
          return rows.length > 0 ? ("changed" as const) : ("missing" as const);
        },
      );
      if (outcome === "missing") throw new CompanionToolError("没找到你这台的伴星档案，这次没有改动");
      if (outcome === "unchanged") {
        return {
          value: { activeness, changed: false },
          safeSummary: `活跃度本来就有「${label}」这一档，没改动`,
        };
      }
      return { value: { activeness, changed: true }, safeSummary: `已把伴星活跃度设为「${label}」` };
    }
    case "companion_save_memory": {
      // 写入口径对齐 API memory-service.upsertMemory 的"用户明确陈述"路径：
      // user_stated/user_confirmed=true、candidate=false、embedding_status='pending'
      // （embedding 流水线随后补向量）。≤200 字的截断在参数 schema 已做，这里防御性再截一次。
      // 与 API 的差异：不做 markMemoryConflictIfSimilar 相似冲突标记（v1 接受，冲突
      // 由记忆中心的冲突检查兜底）。
      const kind = String(args.kind);
      const content = String(args.content).slice(0, 200);
      const inserted = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{ id: string }>(sql`
            INSERT INTO assistant_memory_items
              (workspace_id, user_id, kind, content, user_stated, user_confirmed,
               candidate, importance, confidence, scope, source_type, pinned, embedding_status)
            VALUES
              (${event.ctx.workspaceId}, ${event.read.userId}, ${kind}, ${content},
               true, true, false, 0.8, 0.9, 'workspace', 'user_stated', false, 'pending')
            RETURNING id
          `);
          return rows[0];
        },
      );
      return {
        value: { memoryId: inserted?.id ?? null, kind },
        safeSummary: `已记住（${content.slice(0, 60)}${content.length > 60 ? "…" : ""}）`,
      };
    }
    case "companion_forget_memory": {
      // 软删（deleted_at）：星图/记忆中心的既有语义就是按 deleted_at 过滤，
      // 硬删会把历史一起抹掉。免二次确认的理由与 cancel_reminder 同：
      // 用户此刻正明确说"别记着这个"。
      const memoryId = String(args.memoryId);
      const forgotten = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{ kind: string; content: string }>(sql`
            UPDATE assistant_memory_items
               SET deleted_at = now(), updated_at = now()
             WHERE id = ${memoryId}::uuid
               AND workspace_id = ${event.ctx.workspaceId}
               AND user_id = ${event.read.userId}
               AND deleted_at IS NULL
            RETURNING kind, left(content, 60) AS content
          `);
          return (Array.isArray(rows) ? rows : [])[0] ?? null;
        },
      );
      if (!forgotten) {
        // 这句会**同时**上屏（safeSummary）并回进模型上下文，所以两个读者都要顾到：
        // 屏上这句只说"没找到"；"该先 recall 再删、不许凭印象猜 id"那条指引写在工具自己的
        // 描述里（`companion-agent-registry.ts:144`），每一次请求都带着，比写在错误里更稳。
        throw new CompanionToolError(
          "那一条记忆我没找到，可能它已经不在了。想删哪条的话，先提醒我是哪回的事。",
        );
      }
      return {
        value: { memoryId },
        safeSummary: `已忘掉（${forgotten.content}）`,
      };
    }
    case "companion_set_boundary": {
      // 只合并显式给出的键（jsonb `||`），不动其它边界；boundaries 就是念头管线
      // 与 renderPersonaBehaviour 读的那一列，所以改完立刻对两条链路生效。
      const patch: Record<string, boolean | string> = {};
      for (const key of ["allowPlayful", "allowNudgeLearning", "allowVoiceTags"] as const) {
        if (typeof args[key] === "boolean") patch[key] = args[key] as boolean;
      }
      if (typeof args.catchphrase === "string") patch.catchphrase = args.catchphrase.slice(0, 30);
      if (Object.keys(patch).length === 0) throw new CompanionToolError("没有要调整的边界项");
      const labels: Record<string, string> = {
        allowPlayful: "玩趣",
        allowNudgeLearning: "催学习",
        allowVoiceTags: "语音情绪标签",
        catchphrase: "口头禅",
      };
      const describe = (entries: Record<string, string | boolean>) => Object.entries(entries)
        .map(([key, value]) => `${labels[key]}=${typeof value === "boolean" ? (value ? "可以" : "不要") : value}`);
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const current = await tx.execute<{ boundaries: Record<string, unknown> | null }>(sql`
            SELECT boundaries FROM pet_profiles
            WHERE workspace_id = ${event.ctx.workspaceId} AND user_id = ${event.read.userId}
            LIMIT 1
          `);
          const row = (Array.isArray(current) ? current : [])[0];
          if (!row) return null;
          const before = row.boundaries ?? {};
          const { changed, unchangedKeys } = partitionPersonaPatch(before, patch);
          if (Object.keys(changed).length === 0) {
            return { boundaries: before, changed: {}, unchangedKeys } as const;
          }
          const rows = await tx.execute<{ boundaries: Record<string, unknown> | null }>(sql`
            UPDATE pet_profiles
               SET boundaries = coalesce(boundaries, '{}'::jsonb) || ${JSON.stringify(changed)}::jsonb,
                   revision = revision + 1, updated_at = now()
             WHERE workspace_id = ${event.ctx.workspaceId} AND user_id = ${event.read.userId}
             RETURNING boundaries
          `);
          const after = (Array.isArray(rows) ? rows : [])[0];
          if (!after) return null;
          return { boundaries: after.boundaries ?? {}, changed, unchangedKeys } as const;
        },
      );
      if (!outcome) throw new CompanionToolError("没找到你这台的伴星档案，这次没有改动");
      const parts: string[] = [];
      if (Object.keys(outcome.changed).length > 0) parts.push(`已调整边界：${describe(outcome.changed).join("、")}`);
      // 用户没点名要改的项、或改了等于没改的项，都如实说"本来就是这样"，
      // 不给"这一轮发生了什么"留下第二个版本。
      if (outcome.unchangedKeys.length > 0) {
        parts.push(`本来就是这样、没动的：${outcome.unchangedKeys.map((key) => labels[key] ?? key).join("、")}`);
      }
      return {
        value: { boundaries: outcome.boundaries, changed: Object.keys(outcome.changed) },
        safeSummary: parts.join("；"),
      };
    }
    case "companion_schedule_reminder": {
      const text = String(args.text).slice(0, 200);
      // 39d W5-6 刀三（§16.13）：模型说这条提醒是在说哪篇笔记时，把那个 noteId 记下来。
      // 兑现闸据此在共享撤回后不再投递（迁移 0299）。**服务端校验它**：模型可能给
      // 一篇他此刻读不到的笔记，或者干脆编一个 id——那两种都要在这里挡掉，
      // 否则就是"我给了一条指向受保护内容的提醒"当成合法的。读不到就当没传
      // （落 NULL），**不报错**：用户要的是一句提醒，不是被权限问题拦住。
      const noteId = typeof args.noteId === "string" ? args.noteId : null;
      // "YYYY-MM-DD HH:MM"[:SS] → 该用户时区的挂钟时间 → UTC 绝对时刻。
      // 时区算术全交给 Postgres（AT TIME ZONE 对 timestamp 恰好产出 timestamptz）：
      // 模型给的"明早九点"如果被按 UTC 解释，提醒会差八个小时——那是这条能力
      // 最刺眼的失效方式。
      const local = String(args.fireAtLocal).trim().replace("T", " ");
      const created = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          let subjectNoteId: string | null = null;
          if (noteId) {
            const visible = await tx.execute<{ id: string }>(sql`
              SELECT id::text AS id FROM notes
               WHERE id = ${noteId}::uuid
                 AND workspace_id = ${event.ctx.workspaceId}
                 AND deleted_at IS NULL
                 AND (share_scope = 'shared' OR created_by = ${event.read.userId})
               LIMIT 1
            `);
            subjectNoteId = (Array.isArray(visible) ? visible : [])[0]?.id ?? null;
          }
          const rows = await tx.execute<{ id: string; fire_at_local: string; in_minutes: number }>(sql`
            INSERT INTO companion_reminders (workspace_id, user_id, text, fire_at, note_id)
            VALUES (
              ${event.ctx.workspaceId},
              ${event.read.userId},
              ${text},
              (${local}::timestamp AT TIME ZONE ${tzSubquery(event.read.userId)}),
              ${subjectNoteId}::uuid
            )
            RETURNING id::text AS id,
                      to_char(fire_at AT TIME ZONE ${tzSubquery(event.read.userId)},
                              'MM-DD HH24:MI') AS fire_at_local,
                      (EXTRACT(EPOCH FROM (fire_at - now())) / 60)::int AS in_minutes
          `);
          return (Array.isArray(rows) ? rows : [])[0] ?? null;
        },
      );
      if (!created) throw new CompanionToolError("提醒没能记下，这次没有改动任何东西");
      if (created.in_minutes < 0) {
        // 已经过去的时刻：把刚插的那行作废掉再报错，否则会留下一条永不兑现的
        // pending（兑现函数只认 fire_at <= now()，它会被立刻当作 missed 烧掉，
        // 但dedupe/列表里会看见一条噪音）。
        await withWorkerWorkspaceTransaction(
          { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
          async (tx) => tx.execute(sql`
            UPDATE companion_reminders SET status = 'cancelled', updated_at = now()
            WHERE id = ${created.id}::uuid
          `),
        );
        throw new CompanionToolError(`提醒时间 ${created.fire_at_local} 已经过去了`);
      }
      return {
        value: { reminderId: created.id, fireAtLocal: created.fire_at_local },
        safeSummary: `已安排提醒：${created.fire_at_local}「${text.slice(0, 40)}」`,
      };
    }
    case "companion_cancel_reminder": {
      const reminderId = typeof args.reminderId === "string" ? args.reminderId : null;
      const cancelled = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          // 无 id 时取消最近的一条——"那个提醒不用了"通常指的就是下一个。
          const rows = reminderId
            ? await tx.execute<{ id: string; text: string }>(sql`
              UPDATE companion_reminders SET status = 'cancelled', updated_at = now()
              WHERE workspace_id = ${event.ctx.workspaceId}
                AND user_id = ${event.read.userId}
                AND status = 'pending'
                AND id = ${reminderId}::uuid
              RETURNING id::text AS id, text
            `)
            : await tx.execute<{ id: string; text: string }>(sql`
              UPDATE companion_reminders SET status = 'cancelled', updated_at = now()
              WHERE id = (
                SELECT c.id FROM companion_reminders c
                WHERE c.workspace_id = ${event.ctx.workspaceId}
                  AND c.user_id = ${event.read.userId}
                  AND c.status = 'pending'
                ORDER BY c.fire_at
                LIMIT 1
                FOR UPDATE SKIP LOCKED
              )
              RETURNING id::text AS id, text
            `);
          return (Array.isArray(rows) ? rows : [])[0] ?? null;
        },
      );
      if (!cancelled) throw new CompanionToolError("没有可取消的提醒");
      return {
        value: { reminderId: cancelled.id },
        safeSummary: `已取消提醒「${cancelled.text.slice(0, 40)}」`,
      };
    }
    case "companion_focus_graph": {
      // 参数名就是它真正打的那一列（`learning_objectives_v2.objective_id`），不再叫
      // `keyPointId`（2026-09-24，39d W2-1）：库里 `key_point_id` 是**另一个 id-space**
      // （`validation_assistance_exposures.key_point_id → card_key_points.id`），用别名
      // 跨两张表读起来像是在查 key point，实际查的是 objective。
      // 与 companion_open_card 同等的归属校验——只做 UUID 格式校验会让模型用任意 UUID
      // 构造前端导航 route。
      const objectiveId = String(args.objectiveId);
      const exists = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute(sql`
            SELECT objective_id FROM learning_objectives_v2
            WHERE objective_id = ${objectiveId}
              AND workspace_id = ${event.ctx.workspaceId}
              AND lifecycle = 'active'
            LIMIT 1
          `);
          return rows.length > 0;
        },
      );
      if (!exists) throw new CompanionToolError("这个空间里没有这个学习目标");
      const route = {
        kind: "star_map",
        // 这里是唯一一处跨边界改名：`DesktopRouteV1.star_map` 的字段名仍是
        // `keyPointId`（客户端路由契约，不在 W2-1 的授权范围内），值取自 objectiveId。
        keyPointId: objectiveId,
        lens: String(args.lens),
      };
      return {
        value: { route },
        route,
        routeLabel: "在星图里看这个知识点",
        safeSummary: "已聚焦知识图谱节点",
      };
    }
    default:
      // 这句会当 `safeSummary` 上屏（渲染层原样取用），所以写给用户而不是工程师：
      // 走到这里=full 档预授权想直接执行，但这条动作的执行体在 API 侧的提案确认那条路上
      // （见 companion-tool-executor-ledger.test.ts 那张表），此处什么都不该改。
      throw new CompanionToolError("这一步我这边还做不了，先停住，没有改动任何东西");
  }
}