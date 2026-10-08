import { reserveCompanionProviderCall } from "./companion-agent-events.ts";
import { executeAgentGoalTool } from "../agent/companion-tools.ts";
import { executeBasicCapability } from "../agent/basic-capabilities.ts";
import { executeExternalCapability } from "../agent/external-capabilities.ts";
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
import { createHash } from "node:crypto";
import {
  isVisionGatedCompanionTool,
  companionPageLabelV2,
  type CompanionAgentToolDefinitionV1,
} from "@astella/shared";
import { stableStringify, sha256Utf8V1 } from "@astella/shared/content-hash";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import { applyAssistantPersonaEdit, applyAssistantPersonaEdits } from "./companion-persona-self-edit.ts";
import type { SwitchableField } from "@astella/shared/pet-persona-merge";

/**
 * 用户原话存进 `suggestion_pause.reasonCodes` 时能带的最大字数。
 * 上界由 `user_asked:` 前缀（11 字）与 schema 的 100 字上限共同决定：100 - 11 = 89，
 * 这里取 80 留余量。改这个数之前先看那条 schema。
 */
const PAUSE_REASON_MAX_CHARS = 80;
import { createProvider } from "../lib/ai-provider.ts";
import {
  AIDataPolicyDeniedError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveVisionReader,
} from "../lib/governance.ts";
import { getObjectBytes } from "../lib/object-storage.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { companionStepOutputCeiling, noteSearchTerms, parsePageContext, stripProviderControlTokens } from "./companion-dialogue-content.ts";
import { readPastConversationMessages, searchPastConversationSummaries } from "./companion-summary-retrieval.ts";
import { listAgentLongGoals, listAgentMethods } from "@astella/agent-host";
import {
  ageLabel,
  readLearningStats,
  summarizeLearningStats,
  tzSubquery,
  visibleCompanionCardSourceCondition,
  visibleCompanionDueReviewCondition,
} from "./companion-here-and-now.ts";
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
import { conversationInstant } from "./companion-conversation-evidence.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";

/** 工具报错与结果类型已搬到 `companion-tool-result.ts`（先搬状态、再搬方法，见那里）。 */
import {
  CompanionToolError,
  CompanionToolBlockedError,
  CompanionToolUnavailableError,
  type AgentToolExecutionResult,
} from "./companion-tool-result.ts";
import { executeCompanionMemoryTool } from "./companion-memory-tools.ts";



export async function executeReadTool(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  args: Record<string, unknown>,
): Promise<AgentToolExecutionResult> {
  if (["agent_list_goals","agent_list_long_goals"].includes(definition.name)) return executeAgentGoalTool(event, definition.name, args);
  // 外发政策门禁。工具面本来已经把受管工具摘掉了（见 resolveAllCompanionAgentTools），
  // 这里再拦一次是因为**工具名是模型给的**：不复核就等于"下发面没列出来"这件事
  // 只是运气好，而不是一个保证。判定只看服务端解析出的约束，不看模型自述。
  if (isVisionGatedCompanionTool(definition.name) && event.constraints.visionEnabled !== true) {
    throw new CompanionToolBlockedError(VISION_EGRESS_DENIED_MESSAGE);
  }
  switch (definition.name) {
    case "agent_read_public_document": {
      const userTexts = [event.read.userText, ...event.read.recentMessages.filter(message => message.role === "user").slice(-3).map(message => message.text)];
      const value = await executeExternalCapability({ workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        { name: definition.name, arguments: args }, userTexts, event.ctx.signal);
      return { value, safeSummary: value.truncated ? "已读取公开文档的一部分，来源与覆盖范围已保留" : "已读取公开文档，来源与正文已核对" };
    }
    case "agent_calculate": {
      const result=executeBasicCapability({name:definition.name,arguments:args});
      return {value:result,safeSummary:`计算结果：${result.value}`};
    }
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
    // 跨会话找回（方案 44 §3.2／§8.3）。两步：给 conversationId 就取回那一段原文，
    // 只给 query 就在别的会话里检索。两个分支共用一次事务与同一套范围校验。
    case "companion_recall_past_conversation": {
      const conversationId = typeof args.conversationId === "string" ? args.conversationId : null;
      const fromSeq = typeof args.fromSeq === "number" ? args.fromSeq : null;
      const query = String(args.query ?? "").trim().slice(0, 120);
      if (conversationId && fromSeq === null) {
        // 只给会话 id 不给起点，就退回复检索：拿 id 去猜内容正是这个工具禁止的做法。
        return {
          value: { hits: [], error: "取回原文必须同时给出 conversationId 与 fromSeq（来自上一步的覆盖区间）。" },
          safeSummary: "取回原文缺少起始序号，已改为按关键词检索",
        };
      }
      return await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          if (conversationId && fromSeq !== null) {
            const excerpt = await readPastConversationMessages(
              tx,
              { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
              { conversationId, fromSeq: String(fromSeq) },
            );
            return {
              value: { ...excerpt },
              safeSummary: excerpt.messages.length > 0
                ? `已取回 ${excerpt.messages.length} 条更早会话的原文`
                : "那一段没有可取回的消息",
            };
          }
          const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
          const hits = await searchPastConversationSummaries(
            tx, scope, { query, excludeConversationId: event.read.conversationId ?? null },
          );
          // 44 §3.2：跨会话连续性由「可检索历史、有效记忆、方法与目标快照」**共同**
          // 提供。只给会话摘要等于漏掉另两条——上次定下的做法（方法）与正在进行的目标，
          // 恰恰是用户最容易「你怎么又忘了」的那两样。两边都已经是本人范围的窄口读取，
          // 这里只是把它们摆到同一个结果里，而不是再造一条检索通道。
          const [methods, goals] = await Promise.all([
            listAgentMethods(tx as never, scope, true).catch(() => []),
            listAgentLongGoals(tx as never, scope, { query }).catch(() => ({ version: 1 as const, items: [], nextCursor: null })),
          ]);
          return {
            value: {
              hits,
              searchScope: { kind: "other_conversations", excludedConversationId: event.read.conversationId,
                coverage: "indexed_summaries_methods_and_goals" },
              // 方法目录只给标题与触发条件：正文按 id+revision 另行展开（companion_read_playbook）。
              methods: methods.map((method) => ({
                methodId: method.methodId,
                revision: method.revision,
                title: method.title,
                appliesWhen: method.appliesWhen,
              })),
              goals: goals.items.map((goal) => ({
                memoryId: goal.ref.memoryId,
                revision: goal.ref.revision,
                content: goal.content.slice(0, 200),
                appliesWhen: goal.appliesWhen,
                taskCount: goal.taskCount,
              })),
            },
            safeSummary: hits.length + methods.length + goals.items.length > 0
              ? `找到 ${hits.length} 段更早的对话、${methods.length} 条做法、${goals.items.length} 个长期目标`
              : "更早的记录里没有找到相关内容",
          };
        },
      );
    }
    case "companion_read_history": {
      const limit = typeof args.limit === "number" ? Math.min(20, Math.max(1, args.limit)) : 10;
      const fromSeq = typeof args.fromSeq === "number" ? args.fromSeq : null;
      // 取回入口（44 §5.5）：带 fromSeq 就是去读**这一轮没读到的**那一段原文。
      // 范围校验落在会话与本人上——这条路径读的是真实历史，不是上下文里的转述。
      if (fromSeq !== null) {
        return await withWorkerWorkspaceTransaction(
          { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
          async (tx) => {
            const excerpt = await readPastConversationMessages(
              tx,
              { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
              { conversationId: event.read.conversationId, fromSeq: String(fromSeq), limit },
            );
            return {
              value: { ...excerpt },
              safeSummary: excerpt.messages.length > 0
                ? `已取回第 ${excerpt.fromSeq} 条起的 ${excerpt.messages.length} 条原文`
                : "那一段没有可取回的消息",
            };
          },
        );
      }
      const history = event.read.recentMessages.slice(-limit).map((message) => ({
        seq: message.seq ?? null,
        role: message.role,
        text: message.text,
        createdAt: conversationInstant(message.createdAt),
      }));
      return { value: { messages: history,
        source: { kind: "current_conversation_tail", conversationId: event.read.conversationId,
          timestampMeaning: "message_creation_not_narrated_event", observedAt: event.read.conversationClock?.observedAt ?? null,
          timezone: event.read.conversationClock?.timezone ?? null },
      }, safeSummary: `已读取 ${history.length} 条对话历史` };
    }
        case "companion_read_memory":
    case "companion_recall_memory":
    case "companion_read_playbook":
    case "companion_read_diary":
      // 函数体已搬到 companion-memory-tools.ts（按域切，见那里）。
      return executeCompanionMemoryTool(event, definition, args);
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
            SELECT c.card_id, c.objective_id, c.front->>'cue' AS cue,
                   c.front->>'prompt' AS prompt,
                   c.public_summary AS summary, c.knowledge_form AS form
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
            front,
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
              summary: card.summary?.slice(0, 600) ?? null,
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
          startOffset: typeof args.startOffset === "number" ? args.startOffset : 0,
          maxChars: NOTE_READ_MAX_CHARS,
        }),
      );
      if (!note) throw new CompanionToolError("这个空间里没有这篇笔记");
      const page = note.page;
      const { truncated, nextStartOrdinal, nextStartOffset } = note;
      // 原文由服务端带出，不让模型转抄：她复述一遍就成了"引用"，而用户没法知道
      // 哪几个字是她改写的。这一块就是她读到的那几行，标题与时间跟着走。
      const quoted = page.body.slice(0, 1_200);
      return {
        value: {
          // 游标与版本跟正文一起返回；块内续读不跳过尚未读取的内容。
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
          ...(nextStartOrdinal !== null ? { nextStartOrdinal, nextStartOffset: nextStartOffset ?? 0 } : {}),
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
          startOffset: typeof args.startOffset === "number" ? args.startOffset : 0,
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
      const { truncated, nextStartOrdinal, nextStartOffset } = source;
      const quoted = page.body.slice(0, 1_200);
      return {
        value: {
          // 与正文一起返回完整续读位置。
          title: source.title,
          ...(source.origin ? { origin: source.origin } : {}),
          startOrdinal,
          ...(page.endOrdinal !== null ? { endOrdinal: page.endOrdinal } : {}),
          totalBlocks: source.totalSegments,
          truncated,
          ...(nextStartOrdinal !== null ? { nextStartOrdinal, nextStartOffset: nextStartOffset ?? 0 } : {}),
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
      // 2026-10-06 识图路由：主模型声明能看图就用主模型，否则用专门的识图模型；
      // 都没有就不看（绝不回落给看不见的模型）。
      const reader = resolveVisionReader(govCtx);
      if (!reader) {
        throw new CompanionToolUnavailableError("现在没有能看图的模型，这张图我看不了。");
      }
      const visionProvider = createGovernedProvider(
        createProvider(reader.providerName, reader.providerConfig),
        // 出网治理门在这里是**真的**门：多模态消息会被认成 image_content，政策
        // 半路被改（这一轮开始时还开着、执行图的时候关了）也会在这一步被拦下。
        govCtx,
        event.ctx.workspaceId,
        // jobId 是 ai_audit_log.job_id —— 与本 handler 其它审计行同一口径（job 的
        // id，不是 run 的 id）。这一列当前没有外键，填错不会炸库，只会让成本/合规
        // 记录按 job 聚合时对不上号。
        // `image_content` 与 `companion-daily-summary-image.ts` 同口径：这一次外发
        // 的是图片字节，不声明类别时审计行的类别列是空的——设置页"带出去的内容"
        // 对这条永远是空的，而它恰恰是最该被看见的一次外发。
        {
          userId: event.read.userId,
          operation: "companion_read_image",
          reserveCall: () => reserveCompanionProviderCall(event),
          jobId: event.ctx.id,
          dataCategories: ["image_content"],
        },
      );
      const systemPrompt = "你是看图的那双眼睛，替一个学习助手转述图里的内容。"
        + "只说图上确实看得见的东西：文字按原文抄（公式、表格、代码用 markdown 保持结构），"
        + "流程/结构类图先说清是什么再逐项列出。看不清、被截掉、图上没有的一律直说看不清，"
        + "绝不猜、不用常识补、不编内容。直接说内容，不要开场白。";
      const generationParameters = {
        maxTokens: companionStepOutputCeiling(visionProvider),
        temperature: 0.2,
        responseFormat: "text" as const,
        model: visionProvider.visionModelId,
      };
      const inputSnapshotHash = sha256Utf8V1(stableStringify({
        taskVersion: 1,
        runId: event.read.runId,
        userMessageId: event.read.userMessageId,
        objectKey: asset.object_key,
        mimeType: asset.mime_type,
        imageSha256: createHash("sha256").update(bytes).digest("hex"),
        question,
        systemPrompt,
        modelId: visionProvider.visionModelId,
        promptVersion: visionProvider.promptVersion,
        generationParameters,
      }));
      let content: string;
      try {
        const output = await runWorkerAiTask({
          job: event.ctx,
          userId: event.read.userId,
          taskId: "companion_read_image",
          taskVersion: 1,
          idempotencyKey: `companion-read-image:${event.read.runId}:${event.read.userMessageId}:${inputSnapshotHash}`,
          inputSnapshotRef: {
            kind: "task",
            id: `${event.read.runId}:read-image`,
            hash: inputSnapshotHash,
          },
          input: { question, mimeType: asset.mime_type, bytes },
          modelId: visionProvider.visionModelId,
          promptVersion: `${visionProvider.promptVersion}:companion-read-image-v1`,
          resourceClass: "interactive_ai",
          timeoutMs: resolveProviderCallTimeout("companion_agent"),
          execute: async (request, signal) => {
            const result = await visionProvider.chatCompletion(
              [
                { role: "system", content: systemPrompt },
                {
                  role: "user",
                  content: [
                    { type: "text", text: `问题：${request.question}` },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:${request.mimeType};base64,${request.bytes.toString("base64")}`,
                        detail: "high",
                      },
                    },
                  ],
                },
              ],
              generationParameters,
              signal,
            );
            return {
              ok: true,
              output: String(result.content ?? ""),
              promptTokens: result.usage?.promptTokens ?? undefined,
              completionTokens: result.usage?.completionTokens ?? undefined,
            };
          },
        });
        content = output;
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
      const description = stripProviderControlTokens(content).trim();
      if (!description) throw new CompanionToolError("看过这张图了，但没读出任何内容");
      return {
        value: {
          question,
          description,
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
  if (["agent_start_goal", "agent_revise_goal", "agent_control_goal"].includes(definition.name))
    return executeAgentGoalTool(event, definition.name, args);
  switch (definition.name) {
    // 模型自改**表达层**（40 §4.8.4）。
    //
    // 与上面 set_activeness 走同一条账号级路径（companion_persona_profiles），
    // 差别只有两处，都是合同要求的：
    //  1. 写的是 `speakingStyle`，**不是** name —— 用户指定的名字她改不了；
    //  2. 版本行的 author 是 `assistant_tool`、reason 是她自己给的理由，
    //     用户在人格页能看到这一条是谁在什么时候改的（§4.8.4「记录作者、范围和依据」）。
    case "companion_revise_own_style": {
      const speakingStyle = String(args.speakingStyle).slice(0, 400);
      const reason = String(args.reason).slice(0, 120);
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => applyAssistantPersonaEdit(tx, event.read.userId, "speakingStyle", speakingStyle, reason),
      );
      if (outcome.kind === "conflict") throw new CompanionToolError("人格档案刚刚被改过，这次没有改动，请重新看一眼");
      if (outcome.kind === "unchanged") {
        return {
          value: { changed: false },
          safeSummary: "说话方式本来就是这样，没改动",
        };
      }
      return {
        value: { changed: true },
        // 明说生效时点：§4.8.4「模型自改在下一次会话建立时生效」。
        safeSummary: "换了一种说话方式；下一次尚未开始的对话会用上",
      };
    }
    /**
     * 改自己的性格标签（「慵懒/贪吃/爱摸鱼」那一行）。
     *
     * 与改语气同一条通路、同一套边界，差别只有改的字段：名字仍然不可改，
     * 版本行的作者与理由照旧记在她名下，用户在人格页能看见是谁动的。
     */
    case "companion_revise_own_tags": {
      const tags = (Array.isArray(args.personalityTags) ? args.personalityTags : [])
        .map((tag) => String(tag).trim().slice(0, 20))
        .filter((tag) => tag.length > 0)
        .slice(0, 8);
      if (tags.length === 0) throw new CompanionToolError("没有给出有效的性格标签");
      const reason = String(args.reason ?? "换一组性格标签").slice(0, 120);
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => applyAssistantPersonaEdit(tx, event.read.userId, "personalityTags", tags, reason),
      );
      if (outcome.kind === "conflict") throw new CompanionToolError("人格档案刚刚被改过，这次没有改动，请重新看一眼");
      if (outcome.kind === "unchanged") {
        return { value: { changed: false }, safeSummary: "性格标签本来就是这样，没改动" };
      }
      return { value: { changed: true }, safeSummary: `换成了${tags.join("、")}；下一次尚未开始的对话会用上` };
    }
    /**
     * 40 §8.2：用户说「今天别催我学习」⇒ 记下**本地日**；说「可以了」⇒ 清掉。
     *
     * 关键在**本地日由服务端算**：模型算时区一定算错（差 8 小时那种），
     * 所以工具只收 `today` / `resume` 两个词，具体是哪一天按账号时区落库。
     * 错成「从现在起 24 小时」的话，用户 23:50 说的那句话会压到明天下午——
     * 而他要的是压到今晚 24 点。
     *
     * 只改**主动推荐**这一路。已授权的安排不在这一行的可达范围里：
     * 它们由各自的到期提醒持有，这里既不读也不写（§8.2「不会取消已授权安排」）。
     */
    case "companion_pause_learning_suggestions": {
      const scope = String(args.scope);
      /**
       * ⚠️ 长度是**算出来**的，不是随手取的。
       *
       * `companionSuggestionPauseSchema` 是 `.strict()` 的，`reasonCodes` 单项上限
       * **100**。我们写的是 `user_asked:<原话>`，前缀 11 字，所以原话超过 **89**
       * 字就会让整份 `suggestion_pause` 过不了校验——而它挂在**账号读写**那条路上，
       * 于是用户说一句长点的话，整个伴星设置面板都跟着打不开。
       *
       * 这里切到 80，留 9 字余量：前缀将来若变长，也不会再悄悄越界。
       */
      const reason = String(args.reason).slice(0, PAUSE_REASON_MAX_CHARS);
      const { userCompanionAccountState } = await import("@astella/shared/db-schema/companion");
      const { eq, sql: rawSql } = await import("drizzle-orm");
      const { localDateIn } = await import("@astella/shared/companion-proactive-quota");
      const now = new Date();
      // 时区：账号设置里没单独存这一列，所以按环境给的账号时区算。
      // 拿不到就退回 UTC（见 localDateIn 的注释：算错一天的代价是"少催一次"）。
      const timezone = process.env.COMPANION_ACCOUNT_TIMEZONE ?? null;
      const localDate = localDateIn(timezone, now);
      // 这张表**只按 user_id** 定位（没有 workspace 列），所以 where 里只有它。
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx: WorkerTransaction) => tx
          .update(userCompanionAccountState)
          .set({
            suggestionPause: scope === "today"
              ? { paused: true, localDate, timezone: timezone ?? undefined, reasonCodes: [`user_asked:${reason}`] }
              : { paused: false, localDate: undefined, timezone: undefined },
            revision: rawSql`${userCompanionAccountState.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(userCompanionAccountState.userId, event.read.userId))
          .returning({ userId: userCompanionAccountState.userId }),
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new CompanionToolError("没找到你的账号伴星设置，这次没有改动");
      }
      return {
        value: { scope, localDate },
        // 明说到什么时候：用户要能预测她什么时候会再催。
        safeSummary: scope === "today"
          ? "今天不再主动推荐学习；你自己约好的提醒不受影响"
          : "已恢复正常，会按原来的安排来",
      };
    }
    case "companion_set_activeness": {
      const activeness = String(args.activeness);
      const label = activeness === "quiet" ? "安静" : activeness === "active" ? "活跃" : "适中";
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => applyAssistantPersonaEdit(
          tx, event.read.userId, "activeness", activeness,
          "Changed by an explicitly requested companion setting.",
        ),
      );
      if (outcome.kind === "conflict") throw new CompanionToolError("人格档案刚刚被改过，这次没有改动，请重新看一眼");
      if (outcome.kind === "unchanged") {
        return {
          value: { activeness, changed: false },
          safeSummary: `活跃度本来就有「${label}」这一档，没改动`,
        };
      }
      return { value: { activeness, changed: true }, safeSummary: `已把伴星活跃度设为「${label}」，下一次尚未开始的调用会使用新设置` };
    }
        case "companion_save_memory":
    case "companion_revise_memory":
    case "companion_move_memory":
    case "companion_remember_judgment":
    case "companion_forget_memory":
      // 函数体已搬到 companion-memory-tools.ts（按域切，见那里）。
      return executeCompanionMemoryTool(event, definition, args);
    case "companion_set_boundary": {
      // 只合并显式给出的键，不动其它边界。已开始的调用继续使用
      // 启动时固定的人格版本；下一次尚未开始的调用才会读到这次修改。
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
      // 改了等于没改的那些键不进 edits：让它们在下面如实说"本来就是这样"，
      // 而不是占一个版本号再假装动过。
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const current = await tx.execute<{ profile: unknown }>(sql`
            SELECT profile FROM companion_persona_profiles
            WHERE user_id = ${event.read.userId}
            LIMIT 1
            FOR UPDATE
          `);
          const row = (Array.isArray(current) ? current : [])[0];
          const before = (typeof row?.profile === "object" && row.profile !== null && !Array.isArray(row.profile)
            ? ((row.profile as Record<string, unknown>).boundaries as Record<string, unknown> | undefined) ?? {}
            : {});
          const { changed, unchangedKeys } = partitionPersonaPatch(before, patch);
          if (Object.keys(changed).length === 0) {
            return { boundaries: before, changed, unchangedKeys } as const;
          }
          const result = await applyAssistantPersonaEdits(
            tx,
            event.read.userId,
            Object.entries(changed).map(([key, value]) => ({ field: `boundaries.${key}` as SwitchableField, value })),
            "Changed by an explicitly requested companion setting.",
          );
          if (result.kind === "conflict") return null;
          return { boundaries: result.profile.boundaries ?? {}, changed, unchangedKeys } as const;
        },
      );
      if (!outcome) throw new CompanionToolError("人格档案刚刚被改过，这次没有改动，请重新看一眼");
      const parts: string[] = [];
      if (Object.keys(outcome.changed).length > 0) {
        parts.push(`已调整边界：${describe(outcome.changed).join("、")}`);
        parts.push("新边界会用于下一次尚未开始的调用");
      }
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
