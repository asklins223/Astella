import { arrangeCompanionAttention } from "@astella/agent-host";
import { executeCompanionParticipationTool } from "./companion-participation-tools.ts";
import { executeCompanionWriteAnnotation } from "../note/companion-annotation-authoring.ts";
import { reviewedTargetMatches } from "../agent/companion-reviewed-target.ts";
import { AgentStoreError, listCompanionSelfNotes, writeCompanionSelfNote } from "@astella/agent-host";
import { reserveCompanionProviderCall } from "../agent/companion-agent-events.ts";
import { executeAgentGoalTool } from "../../agent/companion-tools.ts";
import { executeBasicCapability } from "../../agent/basic-capabilities.ts";
import { executeExternalCapability } from "../../agent/external-capabilities.ts";
import { executeWebSearch, webSearchCitationBlocks } from "../../agent/web-search.ts";
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
import {isVisionGatedCompanionTool,
  companionPageLabelV2,
  type CompanionAgentToolDefinitionV1,
  PAST_MESSAGES_PAGE_TARGET_CHARS,
  COMPANION_CARD_BLOCK_PREVIEW_MAX_CHARS,
  companionOperationArguments,
  companionOperationName,
} from "@astella/shared";
import { stableStringify, sha256Utf8V1 } from "@astella/shared/content-hash";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../../db.ts";
import { applyAssistantPersonaEdit, applyAssistantPersonaEdits } from "../memory/companion-persona-self-edit.ts";
import type { SwitchableField } from "@astella/shared/pet-persona-merge";

/**
 * 用户原话存进 `suggestion_pause.reasonCodes` 时能带的最大字数。
 * 上界由 `user_asked:` 前缀（11 字）与 schema 的 100 字上限共同决定：100 - 11 = 89，
 * 这里取 80 留余量。改这个数之前先看那条 schema。
 */
const PAUSE_REASON_MAX_CHARS = 80;
import { createProvider } from "../../lib/ai-provider.ts";
import {
  AIDataPolicyDeniedError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveVisionReader,
} from "../../lib/governance.ts";
import { getObjectBytes } from "../../lib/object-storage.ts";
import { resolveProviderCallTimeout } from "../../lib/handler-timeout-config.ts";
import { companionStepOutputCeiling, noteSearchTerms, parsePageContext, stripProviderControlTokens } from "../turn/companion-dialogue-content.ts";
import { readPastConversationMessages, searchPastConversationSummaries, searchPastConversationMessages,
  MAX_PAST_CONVERSATION_HITS } from "../context/companion-summary-retrieval.ts";
import { companionMemoryMutationLockKey } from "@astella/shared/db-schema/assistant-memory";
import { listAgentLongGoals, listAgentMethods } from "@astella/agent-host";
import {
  ageLabel,
  readLearningStats,
  summarizeLearningStats,
  tzSubquery,
} from "../proactive/companion-here-and-now.ts";
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
  type ActivityRow,
  type AgentEventContext,
  type NoteSearchRow,
} from "./companion-read-tools.ts";
import { partitionPersonaPatch } from "../turn/companion-step-plan.ts";
import { companionConversationTimeEvidence, conversationInstant } from "../turn/companion-conversation-evidence.ts";
import { runWorkerAiTask } from "../note/worker-ai-task.ts";

/** 工具报错与结果类型已搬到 `companion-tool-result.ts`（先搬状态、再搬方法，见那里）。 */
import {
  CompanionToolError,
  CompanionToolBlockedError,
  CompanionToolNotExecutedError,
  CompanionToolUnavailableError,
  type AgentToolExecutionResult,
} from "./companion-tool-result.ts";
import { executeCompanionMemoryTool } from "./companion-memory-tools.ts";
import { executeCompanionCreateNote } from "../note/companion-note-authoring.ts";
import { executeCompanionNoteEdit } from "../note/companion-note-edit.ts";
import { executeCompanionShareNote } from "../note/companion-note-share.ts";
import { executeCompanionLearningDiscoveryTool } from "../note/companion-learning-discovery.ts";



/** Own writes recheck the frozen account epoch while holding the same lock as clear. */
async function withAutonomousWriteTransaction<T>(event: AgentEventContext, write: (tx: WorkerTransaction) => Promise<T>): Promise<T> {
  return withWorkerWorkspaceTransaction({ workspaceId: event.ctx.workspaceId, userId: event.read.userId }, async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${companionMemoryMutationLockKey(event.read.userId)},0))`);
    const [authority] = await tx.execute<{ epoch: number; allowed: boolean }>(sql`
      SELECT * FROM astella_companion_reflection_authority(${event.read.userId}::uuid,
        ${event.ctx.workspaceId}::uuid,${event.read.conversationId}::uuid)`);
    if (!authority?.allowed || Number(authority.epoch) !== event.read.accountEpoch)
      throw new CompanionToolBlockedError("这轮的账号或记忆状态已变化，没有沿旧内容写回。");
    return write(tx);
  });
}

/** Internal background capabilities keep their own keys; the model-facing
 * domain tool is translated to the operation above before reaching here. */
const INTERNAL_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  "goals.read.list": "agent_list_goals",
  "goals.read.list_long": "agent_list_long_goals",
  "goals.write.start": "agent_start_goal",
  "goals.write.revise": "agent_revise_goal",
  "goals.write.control": "agent_control_goal",
  "observe.calculate": "agent_calculate",
  "web.search": "agent_web_search",
  "web.read_document": "agent_read_public_document",
});


export async function executeReadTool(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  args: Record<string, unknown>,
): Promise<AgentToolExecutionResult> {
  if (false) return executeAgentGoalTool(event, "", args);
  // 外发政策门禁。工具面本来已经把受管工具摘掉了（见 resolveAllCompanionAgentTools），
  // 这里再拦一次是因为**工具名是模型给的**：不复核就等于"下发面没列出来"这件事
  // 只是运气好，而不是一个保证。判定只看服务端解析出的约束，不看模型自述。
  if (event.constraints?.noteLibraryReadEnabled === false
    && ["notes.read.search", "notes.read.cards", "notes.read.read", "companion_recommend_learning"].includes(definition.name)) {
    throw new CompanionToolBlockedError("你这轮要求不读取笔记库和学习卡资料，我不会搜索或读取库内学习内容。");
  }
  if (isVisionGatedCompanionTool(definition.name) && event.constraints.visionEnabled !== true) {
    throw new CompanionToolBlockedError(VISION_EGRESS_DENIED_MESSAGE);
  }
  switch (definition.name) {
    case "goals.read.list":
    case "goals.read.list_long":
      return executeAgentGoalTool(event, INTERNAL_CAPABILITY[definition.name]!, args);
    case "companion_persona_read":
    case "companion_observe":
    case "companion_visual":
    case "companion_goals_read":
    case "companion_memory_read":
    case "companion_attention_read":
    case "companion_notes_read":
    case "companion_open":
    case "companion_web": {
      const operation = companionOperationName({ name: definition.name, arguments: args });
      if (operation === definition.name) throw new CompanionToolError("没有说明要执行哪一类动作。");
      if (operation === "web.search" && event.constraints.webSearchEnabled !== true) {
        throw new CompanionToolUnavailableError("这轮没有开启联网搜索；继续回答，但无法联网核实。");
      }
      return executeReadTool(event, { ...definition, name: operation },
        companionOperationArguments(operation, args));
    }
    case "attention.read.participation":
      return executeCompanionParticipationTool(event, definition.name, args);
    case "persona.read.identity": {
      const document = event.read.petProfile?.selfDescription ?? "";
      const offset = Number(args.offset ?? 0), end = Math.min(document.length, offset + Number(args.maxChars ?? 16_000));
      return { value: { revision: event.read.personaProfileRevision, document: document.slice(offset, end),
        offset, nextOffset: end, totalChars: document.length, truncated: end < document.length },
        safeSummary: "已读取本轮固定的身份文档。" };
    }
    case "persona.read.self_notes": {
      const items = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId }, tx => listCompanionSelfNotes(tx,
          { workspaceId: event.ctx.workspaceId, userId: event.read.userId }, { key: args.key as string | undefined,
            includeArchived: args.includeArchived === true, offset: Number(args.offset ?? 0), limit: args.key ? 1 : 20 }));
      return { value: { items: args.key ? items : items.map(({body: _body, ...note}) => note) },
        safeSummary: args.key ? "已展开自己的记事。" : "已读取自己的记事目录。" };
    }
    case "web.search": {
      const value = await executeWebSearch({ workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        args as Parameters<typeof executeWebSearch>[1], event.ctx.signal);
      return { value, resultRef: JSON.stringify(value), blocks: webSearchCitationBlocks(value), safeSummary: value.status === "succeeded"
        ? `搜索到 ${value.sources.length} 个网页`
        : value.reason === "quota_exhausted" ? "搜索额度不足，已暂时停用联网搜索；继续回答，但无法联网核实"
          : "本次联网搜索不可用；继续回答，但无法联网核实" };
    }
    case "web.read_document": {
      // 窗口里**所有**用户说过的话都算授权依据：只认最近 3 条时，用户四轮前贴过的链接
      // 会被判成"没给过"，她会去要一个已经给过的东西。窗口本身已由声明预算收边。
      const userTexts = [event.read.userText,
        ...event.read.recentMessages.filter(message => message.role === "user").map(message => message.text)];
      const value = await executeExternalCapability({ workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        { name: INTERNAL_CAPABILITY[definition.name] ?? definition.name, arguments: args }, userTexts, event.ctx.signal);
      return { value, safeSummary: ("truncated" in value && value.truncated) ? "已读取公开文档的一部分，来源与覆盖范围已保留" : "已读取公开文档，来源与正文已核对" };
    }
    case "observe.calculate": {
      try {
        const result=executeBasicCapability({name:INTERNAL_CAPABILITY[definition.name] ?? definition.name,arguments:args});
        return {value:result,safeSummary:`计算结果：${result.value}`};
      } catch (error) {
        // The model needs the real parse/evaluation reason to correct the
        // expression; a generic "failed" sends it into another blind retry.
        throw new CompanionToolError(`计算没有执行：${error instanceof Error ? error.message : "表达式无法解析"}`);
      }
    }
    case "companion_load_tools":
      // Surface expansion is stateful and owned by the agent loop; if this
      // branch is ever reached outside it, return an honest no-op instead of
      // falling through to "no direct executor".
      return { value: { groups: [], note: "工具组装载由当前回合的 agent 运行时处理" },
        safeSummary: "工具组装载由运行时处理" };
    case "observe.context": {
      const page = parsePageContext(event.read.pageContext);
      return {
        value: {
          pageKind: typeof page?.pageKind === "string" ? page.pageKind : null,
        },
        safeSummary: "已读取当前学习上下文",
      };
    }
    case "observe.current_page": {
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
    case "memory.read.past_conversation": {
      const conversationId = typeof args.conversationId === "string" ? args.conversationId : null;
      const fromSeq = typeof args.fromSeq === "number" ? args.fromSeq : null;
      // 不再剪搜索词：剪掉的那半句会悄悄改掉搜出来的东西（与 companion_search_notes 同一条口径）。
      const query = String(args.query ?? "").trim();
      if (conversationId && fromSeq === null) {
        // 只给会话 id 不给起点，就退回复检索：拿 id 去猜内容正是这个工具禁止的做法。
        return {
          value: { hits: [], error: "取回原文必须同时给出 conversationId 与 fromSeq（来自上一步的覆盖区间）。" },
          safeSummary: "取回原文缺少起始序号，尚未检索",
        };
      }
      return await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          if (conversationId && fromSeq !== null) {
            const excerpt = await readPastConversationMessages(
              tx,
              { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
              { conversationId, fromSeq: String(fromSeq), clock: event.read.conversationClock },
            );
            return {
              value: { ...excerpt },
              safeSummary: excerpt.messages.length > 0
                ? `已取回 ${excerpt.messages.length} 条更早会话的原文`
                : "那一段没有可取回的消息",
            };
          }
          const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
          // 44 §3.2：跨会话连续性由「可检索历史、有效记忆、方法与目标快照」**共同**
          // 提供。只给会话摘要等于漏掉另两条——上次定下的做法（方法）与正在进行的目标，
          // 恰恰是用户最容易「你怎么又忘了」的那两样。两边都已经是本人范围的窄口读取，
          // 这里只是把它们摆到同一个结果里，而不是再造一条检索通道。
          const limit = Math.max(1, Math.min(MAX_PAST_CONVERSATION_HITS, typeof args.limit === "number" ? args.limit : 3));
          const searchInput = { query, excludeConversationId: event.read.conversationId ?? null, limit,
            clock: event.read.conversationClock };
          const [summaryResult, transcriptResult, methodResult, goalResult] = await Promise.allSettled([
            searchPastConversationSummaries(tx, scope, searchInput),
            searchPastConversationMessages(tx, scope, searchInput),
            listAgentMethods(tx as never, scope, true),
            listAgentLongGoals(tx as never, scope, { query }),
          ]);
          const summaries = summaryResult.status === "fulfilled" ? summaryResult.value : [];
          const transcripts = transcriptResult.status === "fulfilled" ? transcriptResult.value : [];
          const methods = methodResult.status === "fulfilled" ? methodResult.value : [];
          const goals = goalResult.status === "fulfilled" ? goalResult.value.items : [];
          // Exact source locators remain usable before a background summary
          // exists. Do not spend the result limit twice on the same source span.
          const hits = [...transcripts, ...summaries.filter(summary => !transcripts.some(hit =>
            hit.conversationId === summary.conversationId && BigInt(hit.matchedSeq) >= BigInt(summary.coverageFromSeq)
              && BigInt(hit.matchedSeq) <= BigInt(summary.coverageThroughSeq)))
            .map(summary => ({ ...summary, sourceKind: "summary" as const, fromSeq: summary.coverageFromSeq }))].slice(0, limit);
          const sourceStatus = {
            transcripts: transcriptResult.status === "fulfilled" ? "searched" : "unavailable",
            summaries: summaryResult.status === "fulfilled" ? "searched" : "unavailable",
            methods: methodResult.status === "fulfilled" ? "searched" : "unavailable",
            goals: goalResult.status === "fulfilled" ? "searched" : "unavailable",
          };
          const partial = Object.values(sourceStatus).includes("unavailable");
          return {
            value: {
              hits,
              searchScope: { kind: "other_conversations", excludedConversationId: event.read.conversationId,
                coverage: "transcripts_valid_summaries_methods_and_goals", exhaustive: false, sourceStatus },
              // 方法目录只给标题与触发条件：正文按 id+revision 另行展开（companion_read_playbook）。
              methods: methods.map((method) => ({
                methodId: method.methodId,
                revision: method.revision,
                title: method.title,
                appliesWhen: method.appliesWhen,
              })),
              goals: goals.map((goal) => ({
                memoryId: goal.ref.memoryId,
                revision: goal.ref.revision,
                content: goal.content,
                appliesWhen: goal.appliesWhen,
                taskCount: goal.taskCount,
              })),
            },
            safeSummary: partial ? "部分历史来源暂时未能查询，已返回可用的检索结果"
              : hits.length + methods.length + goals.length > 0
              ? `找到 ${hits.length} 段更早的对话、${methods.length} 条做法、${goals.length} 个长期目标`
              : "本次检索没有匹配到相关内容",
          };
        },
      );
    }
    case "observe.history": {
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
              { conversationId: event.read.conversationId, fromSeq: String(fromSeq), limit, clock: event.read.conversationClock },
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
      // 尾部这一支以前把窗口里的消息**整把**返回，一条字符预算都没有：assistant 的单条
      // 正文上限是 20 万字（`COMPANION_REPLY_MAX_CHARS`），20 条就是它的好几倍，而能力面上
      // 写的是默认 4,000。两头都不说真话。现在按与取回原文同一份预算分页，规则也同一份——
      // **一条消息要么整条给，要么这一轮不给**，剩下的用 `nextFromSeq` 接着读。
      const window = event.read.recentMessages.slice(-limit);
      const taken: typeof window = [];
      let chars = 0;
      let skipped: typeof window[number] | null = null;
      for (const message of window) {
        if (taken.length > 0 && chars + message.text.length > PAST_MESSAGES_PAGE_TARGET_CHARS) {
          skipped = message;
          break;
        }
        taken.push(message);
        chars += message.text.length;
      }
      const time = companionConversationTimeEvidence(event.read.conversationClock);
      const history = taken.map((message, index) => ({ seq: message.seq ?? null, role: message.role,
        text: message.text, createdAt: conversationInstant(message.createdAt), replyStatus: message.replyStatus ?? null,
        time: time.stamp(message.createdAt, window[index - 1]?.createdAt) }));
      const truncated = skipped !== null;
      return { value: { messages: history, truncated,
        nextFromSeq: skipped?.seq ?? null,
        source: { kind: "current_conversation_tail", conversationId: event.read.conversationId,
          timestampMeaning: "message_creation_not_narrated_event", observedAt: event.read.conversationClock?.observedAt ?? null,
          timezone: event.read.conversationClock?.timezone ?? null },
      }, safeSummary: truncated
        ? `已读取 ${history.length} 条对话历史，还有后续记录可继续查看`
        : `已读取 ${history.length} 条对话历史` };
    }
    case "memory.read.read":
    case "memory.read.recall":
    case "memory.read.playbook":
    case "memory.read.diary":
      // 函数体已搬到 companion-memory-tools.ts（按域切，见那里）。
      return executeCompanionMemoryTool(event, definition, args);
    case "observe.activity": {
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
          SELECT 'card', '学习卡《' || n.title || '》',
                 (EXTRACT(EPOCH FROM (now() - c.created_at)) / 60)::int
          FROM note_learning_cards c
          JOIN notes n ON n.id = c.note_id
          WHERE c.workspace_id = ${event.ctx.workspaceId} AND c.created_at > ${window}
            AND n.deleted_at IS NULL
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
    case "open.card": {
      const cardId = String(args.cardId);
      const card = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{
            card_id: string; note_id: string; stem: string | null;
          }>(sql`
            SELECT c.id AS card_id, c.note_id,
                   (SELECT stem FROM note_learning_card_questions
                    WHERE card_id = c.id ORDER BY ordinal LIMIT 1) AS stem
            FROM note_learning_cards c
            JOIN notes n ON n.id = c.note_id AND n.deleted_at IS NULL
            WHERE c.workspace_id = ${event.ctx.workspaceId}
              AND c.status = 'active'
              AND (n.share_scope = 'shared' OR n.created_by = ${event.read.userId})
              AND c.id = ${cardId}
            LIMIT 1
          `);
          return rows[0] ?? null;
        },
      );
      if (!card) throw new CompanionToolError("这个空间里没有这张学习卡");
      const route = { kind: "card", cardId: card.card_id, noteId: card.note_id };
      const front = String(card.stem ?? "").trim();
      const cardTitle = front;
      return {
        // 题面必须**同时**进 value：只进 blocks 的话，块渲染给用户看了，
        // 她自己却看不见那段文字（实机 2026-09-21 Y 轮：card 块落库成功，
        // 她紧接着说"题面的具体文字我这边读不到——卡片只是帮你定位打开了"）。
        // 那不是谦虚，是事实：喂回给模型的 data 里当时只有 route。
        value: {
          route,
          card: {
            cardId: card.card_id,
            noteId: card.note_id,
            front,
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
              // 纸上这一段是展示预览，长度由卡片块合同那一个源定；整份题面在上面的 value 里，
              // 所以她能读到的一切都在，块只是摆在纸面上的那一截。
              front: front.slice(0, COMPANION_CARD_BLOCK_PREVIEW_MAX_CHARS),
              summary: null,
              knowledgeForm: null,
            }]
          : [],
        safeSummary: "已定位到学习卡片",
      };
    }
    case "notes.read.search": {
      // 不再把搜索词剪到 120 字：她写长了一点，被裁掉的那半句会悄悄改掉搜出来的东西。
      const query = String(args.query ?? "").trim();
      const recent = args.order === "updated";
      const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, args.limit)) : 5;
      const terms = noteSearchTerms(query);
      const anyMatch = args.match === "any";
      if (terms.length === 0 && !recent) {
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
      const matches = termConditions.length > 0
        ? sql.join(termConditions, anyMatch ? sql` OR ` : sql` AND `) : sql`TRUE`;
      const ordering = recent ? sql`n.updated_at DESC,n.id`
        : sql`(${sql.join(termConditions.map(condition => sql`CASE WHEN ${condition} THEN 1 ELSE 0 END`), sql` + `)}) DESC,n.updated_at DESC,n.id`;
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
              AND ${terms.length > 0 ? sql`nb.content ILIKE ${`%${terms[0]}%`}` : sql`TRUE`}
          ) b ON true
          WHERE n.workspace_id = ${event.ctx.workspaceId}
            AND n.deleted_at IS NULL
            AND (n.share_scope='shared' OR n.created_by=${event.read.userId})
            AND (${matches})
          ORDER BY ${ordering}
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
          ? recent ? `已找到最近更新的 ${notesFound.length} 篇笔记` : `找到 ${notesFound.length} 篇${anyMatch ? "可核对的" : "相关"}笔记`
          : recent && terms.length === 0 ? "当前书房没有可读取的笔记" : `没有找到与「${query.slice(0, 20)}」相关的笔记`,
      };
    }
    case "notes.read.cards":
    case "companion_recommend_learning":
      return executeCompanionLearningDiscoveryTool(event, definition.name, args);
    case "notes.read.read": {
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
          maxChars: typeof args.maxChars === "number" ? args.maxChars : NOTE_READ_MAX_CHARS,
        }),
      );
      if (!note) throw new CompanionToolError("这个空间里没有这篇笔记");
      const page = note.page;
      const { truncated, nextStartOrdinal, nextStartOffset } = note;
      const includeBlocks = args.includeBlocks === true;
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
          // Normal reading needs one copy of the text. Full editing needs the
          // semantic blocks; returning both doubled a 20k-character read.
          ...(includeBlocks ? { blocks: page.blocks } : { body: page.body }),
        },
        resultRef: JSON.stringify({ kind: "note_read", noteId, noteVersionId: note.versionId }),
        blocks: quoted.length > 0
          ? [{
              type: "quote" as const,
              label: `《${note.title.slice(0, 28)}》· ${ageLabel(Number(note.ageMinutes))}`,
              text: quoted + (page.body.length > quoted.length ? "…" : ""),
              sourceRef: { kind: "note" as const, noteId, noteVersionId: note.versionId, blockOrdinal: startOrdinal },
            }]
          : [],
        safeSummary: `已读出笔记《${note.title.slice(0, 24)}》`
          + `（${page.endOrdinal !== null ? `第 ${startOrdinal}–${page.endOrdinal} 块，共 ${note.totalBlocks} 块` : "无正文"}`
          + `，${page.body.length} 字${note.imageTotal > 0 ? `，另附 ${note.imageTotal} 张图` : ""}）`,
      };
    }
    case "notes.read.source": {
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
              sourceRef: { kind: "source" as const, sourceId, segmentOrdinal: startOrdinal },
            }]
          : [],
        safeSummary: `已读出来源《${source.title.slice(0, 24)}》`
          + `（${page.endOrdinal !== null ? `第 ${startOrdinal}–${page.endOrdinal} 段，共 ${source.totalSegments} 段` : "无正文"}，${page.body.length} 字）`,
      };
    }
    case "visual.read_image": {
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
        ? args.question.trim()
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
          operation: "visual.read_image",
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
          taskId: "visual.read_image",
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
    case "visual.show_image": {
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
    case "open.note": {
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
    case "open.page": {
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
    case "observe.stats": {
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
    case "attention.read.reminders": {
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
    case "visual.diagram": {
      // 呈现类：不查库、不写库，只是把她给的结构变成一块交给客户端（§4.8）。
      // 参数已校验；所有步骤和补充说明完整交给客户端。
      const title = String(args.title).trim();
      const steps = (args.steps as Array<{ label: string; detail?: string }>)
        .map((step) => ({
          label: String(step.label).trim(),
          ...(step.detail ? { detail: String(step.detail).trim() } : {}),
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

/** Flat aliases carry no `action`; the shared map owns which action each stands for. */

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
  signal?: AbortSignal,
  toolCallId?: string,
): Promise<AgentToolExecutionResult> {
  if (false) return executeAgentGoalTool(event, "", args);
  switch (definition.name) {
    case "goals.write.start":
    case "goals.write.revise":
    case "goals.write.control":
      return executeAgentGoalTool(event, INTERNAL_CAPABILITY[definition.name]!, args);
    case "companion_persona_write":
    case "companion_goals_write":
    case "companion_memory_write":
    case "companion_attention_write":
    case "companion_say":
    case "companion_notes_write": {
      const operation = companionOperationName({ name: definition.name, arguments: args });
      if (operation === definition.name) throw new CompanionToolError("没有说明要执行哪一类动作。");
      const operationArgs = operation === "goals.write.control"
        ? { ...companionOperationArguments(operation, args), action: args.control }
        : companionOperationArguments(operation, args);
      return executeDirectTool(event, { ...definition, name: operation }, operationArgs, signal, toolCallId);
    }
    // Flat aliases carry no `action`; their declared mapping is the action.
    case "companion_self_note_write":
    case "companion_memory_forget":
    case "companion_goal_start":
    case "companion_memory_save": {
      const operation = companionOperationName({ name: definition.name, arguments: args });
      if (operation === definition.name) throw new CompanionToolError("这项能力没有对应的执行动作。");
      return executeDirectTool(event, { ...definition, name: operation },
        companionOperationArguments(operation, args), signal, toolCallId);
    }
    case "attention.write.save_participation":
    case "attention.write.arrange":
    case "say.publish":
    case "say.finish_participation":
      return executeCompanionParticipationTool(event, definition.name, args, toolCallId);
    case "notes.write.annotate": {
      if (!toolCallId) throw new CompanionToolError("解释写入缺少执行身份，没有重复保存。");
      return executeCompanionWriteAnnotation(event, args, signal, toolCallId);
    }
    case "notes.write.create": {
      if (!toolCallId) throw new CompanionToolError("创建笔记缺少这轮的执行记录，没有重复保存。");
      return executeCompanionCreateNote(event, args, signal, toolCallId);
    }
    case "notes.write.edit": {
      if (!toolCallId) throw new CompanionToolError("正文编辑缺少这轮的执行记录，请重新发送要求。");
      return executeCompanionNoteEdit(event, toolCallId, signal);
    }
    // 「共享给空间」/「取消共享」（2026-10-09 补的能力）。与正文编辑同一形状：
    // worker 不写 `notes`（0395 起就没有那个权限，而可见性一变要跟着刷新目标索引里的
    // 公开标题，那条规则只住在服务层一处），派发给 API 的 `companion-share-dispatch`。
    case "notes.write.share": {
      if (!toolCallId) throw new CompanionToolError("共享缺少这轮的执行记录，请重新发送要求。");
      return executeCompanionShareNote(event, toolCallId, signal);
    }
    // 模型自改**表达层**（40 §4.8.4）。
    //
    // 与上面 set_activeness 走同一条账号级路径（companion_persona_profiles），
    // 差别只有两处，都是合同要求的：
    //  1. 写的是 `speakingStyle`，**不是** name —— 用户指定的名字她改不了；
    //  2. 版本行的 author 是 `assistant_tool`、reason 是她自己给的理由，
    //     用户在人格页能看到这一条是谁在什么时候改的（§4.8.4「记录作者、范围和依据」）。
    case "persona.write.self_note":
    case "attention.write.schedule_wake": {
      const note = await withAutonomousWriteTransaction(event, async tx => {
          const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
          if (definition.name === "attention.write.schedule_wake") {
            const [current] = await listCompanionSelfNotes(tx, scope, { key: String(args.key), includeArchived: true });
            if (!current) throw new CompanionToolError("先写下或读取这条自己的记事，再安排重评。");
            const saved = await writeCompanionSelfNote(tx, scope, { key: current.key, expectedRevision: Number(args.expectedRevision),
              title: current.title, body: current.body, tier: current.tier, nextReviewAt: null,
              expiresAt: current.expiresAt, reason: String(args.reason) });
            const key = `self:${saved.key}`.slice(0,120);
            const [prior] = await tx.execute<{ revision: number }>(sql`SELECT revision FROM companion_attention_plans
              WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND entry_key=${key}`);
            const attention = await arrangeCompanionAttention(tx, scope, { key, expectedRevision: prior?.revision ?? 0,
              intent: `接着推进自己的记事「${saved.title}」。${String(args.reason)}`, topics: [], nextReviewAt: args.at as string | null,
              expiresAt: saved.expiresAt, preferenceRevision: null, selfNote: { key: saved.key, revision: saved.revision },
              state: args.at ? "active" : "completed" }, { conversationId: event.read.conversationId, runId: event.read.runId });
            return { ...saved, nextReviewAt: attention.attention.nextReviewAt };
          }
          const raw = args as unknown as import("@astella/shared").CompanionSelfNoteWriteV1;
          // The model only has to say what she wants to remember. Key, tier,
          // revision and reason are host bookkeeping, not content.
          const title = (raw.title ?? "").trim() || raw.body.trim().slice(0, 24);
          const key = (raw.key ?? "").trim() || `own-${sha256Utf8V1(title).slice(0, 12)}`;
          const [existing] = await listCompanionSelfNotes(tx, scope, { key, includeArchived: true });
          const input = { ...raw, key, title, tier: raw.tier ?? "active",
            expectedRevision: raw.expectedRevision ?? existing?.revision ?? 0,
            reason: (raw.reason ?? "").trim() || "自己想留下这件事" };
          const saved = await writeCompanionSelfNote(tx, scope, { ...input, nextReviewAt: null });
          if (input.nextReviewAt) {
            const key = `self:${saved.key}`.slice(0,120);
            const [prior] = await tx.execute<{ revision: number }>(sql`SELECT revision FROM companion_attention_plans
              WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND entry_key=${key}`);
            await arrangeCompanionAttention(tx, scope, { key, expectedRevision: prior?.revision ?? 0,
              intent: `接着推进自己的记事「${saved.title}」。${input.reason}`, topics: [], nextReviewAt: input.nextReviewAt,
              expiresAt: saved.expiresAt, preferenceRevision: null, selfNote: { key: saved.key, revision: saved.revision }, state: "active" },
              { conversationId: event.read.conversationId, runId: event.read.runId });
          }
          return { ...saved, nextReviewAt: input.nextReviewAt ?? null };
        }).catch(error => {
          if (error instanceof AgentStoreError) throw new CompanionToolError(error.message);
          throw error;
        });
      return { value: note, resultRef: JSON.stringify({selfNote:{key:note.key,revision:note.revision}}),
        safeSummary: "自己的记事已保存；内部重评安排不需要用户确认。" };
    }
    case "persona.write.identity": {
      const outcome = await withAutonomousWriteTransaction(event,
        tx => applyAssistantPersonaEdit(tx, event.read.userId, "selfDescription", args.document, String(args.reason),
          { stage: true, sourceWorkspaceId: event.ctx.workspaceId,
            expectedRevision: event.read.personaProfileRevision,
            proposal: { kind: "assistant_tool", proposalId: event.read.runId } }),
      );
      if (outcome.kind === "conflict") throw new CompanionToolError("身份文档已有新版本，先核对再修订。");
      return { value: { changed: outcome.kind === "changed" },
        safeSummary: outcome.kind === "changed" ? "身份文档已保存，下一轮自动采用，无需确认。" : "身份文档没有实质变化。" };
    }
    case "persona.write.style": {
      const speakingStyle = String(args.speakingStyle).slice(0, 400);
      const reason = String(args.reason).slice(0, 120);
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => applyAssistantPersonaEdit(tx, event.read.userId, "speakingStyle", speakingStyle, reason,
          { stage: true, sourceWorkspaceId: event.ctx.workspaceId,
            expectedRevision: event.read.personaProfileRevision,
            proposal: { kind: "assistant_tool", proposalId: event.read.runId } }),
      );
      if (outcome.kind === "conflict") throw new CompanionToolError("人格档案刚刚被改过，这次没有改动，请重新看一眼");
      if (outcome.kind === "unchanged") {
        return {
          value: { changed: false },
          safeSummary: "这项说话方式与现有设定相同，没有新增修订",
        };
      }
      return {
        value: { changed: true },
        safeSummary: "已保存新的说话方式；从下一轮你发来的消息起使用",
      };
    }
    /**
     * 改自己的性格标签（「慵懒/贪吃/爱摸鱼」那一行）。
     *
     * 与改语气同一条通路、同一套边界，差别只有改的字段：名字仍然不可改，
     * 版本行的作者与理由照旧记在她名下，用户在人格页能看见是谁动的。
     */
    case "persona.write.tags": {
      const tags = (Array.isArray(args.personalityTags) ? args.personalityTags : [])
        .map((tag) => String(tag).trim().slice(0, 20))
        .filter((tag) => tag.length > 0)
        .slice(0, 8);
      if (tags.length === 0) throw new CompanionToolError("没有给出有效的性格标签");
      const reason = String(args.reason ?? "换一组性格标签").slice(0, 120);
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => applyAssistantPersonaEdit(tx, event.read.userId, "personalityTags", tags, reason,
          { stage: true, sourceWorkspaceId: event.ctx.workspaceId,
            expectedRevision: event.read.personaProfileRevision,
            proposal: { kind: "assistant_tool", proposalId: event.read.runId } }),
      );
      if (outcome.kind === "conflict") throw new CompanionToolError("人格档案刚刚被改过，这次没有改动，请重新看一眼");
      if (outcome.kind === "unchanged") {
        return { value: { changed: false }, safeSummary: "这组性格标签与现有设定相同，没有新增修订" };
      }
      return { value: { changed: true }, safeSummary: `已保存${tags.join("、")}；从下一轮你发来的消息起使用` };
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
    case "attention.write.pause": {
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
    case "persona.write.activeness": {
      const activeness = String(args.activeness);
      const label = activeness === "quiet" ? "安静" : activeness === "active" ? "活跃" : "适中";
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => applyAssistantPersonaEdit(
          tx, event.read.userId, "activeness", activeness,
          "Changed by an explicitly requested companion setting.",
          { sourceWorkspaceId: event.ctx.workspaceId, proposal: { kind: "assistant_tool", proposalId: event.read.runId } },
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
    case "memory.write.save":
    case "memory.write.revise":
    case "memory.write.move":
    case "memory.write.judgment":
    case "memory.write.forget":
      // 函数体已搬到 companion-memory-tools.ts（按域切，见那里）。
      return executeCompanionMemoryTool(event, definition, args, toolCallId);
    case "persona.write.boundary": {
      // 只合并显式给出的键，不动其它边界。已开始的调用继续使用
      // 启动时固定的人格版本；下一次尚未开始的调用才会读到这次修改。
      const patch: Record<string, boolean | string> = {};
      for (const key of ["allowPlayful", "allowNudgeLearning", "allowVoiceTags"] as const) {
        if (typeof args[key] === "boolean") patch[key] = args[key] as boolean;
      }
      if (typeof args.catchphrase === "string") patch.catchphrase = args.catchphrase.slice(0, 30);
      // An empty boundary call is a malformed request, not a failed action.
      if (Object.keys(patch).length === 0) throw new CompanionToolNotExecutedError("没有要调整的边界项");
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
            { sourceWorkspaceId: event.ctx.workspaceId, proposal: { kind: "assistant_tool", proposalId: event.read.runId } },
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
    case "attention.write.schedule_reminder": {
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
    case "attention.write.cancel_reminder": {
      const reminderId = String(args.reminderId);
      const cancelled = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{ id: string; text: string }>(sql`
            UPDATE companion_reminders SET status = 'cancelled', updated_at = now()
            WHERE workspace_id = ${event.ctx.workspaceId} AND user_id = ${event.read.userId}
              AND status = 'pending' AND id = ${reminderId}::uuid
              AND ${reviewedTargetMatches(event, toolCallId, sql`jsonb_build_object('text',text,'fireAt',fire_at::text)`)}
            RETURNING id::text AS id, text
          `);
          return rows[0] ?? null;
        },
      );
      if (!cancelled) throw new CompanionToolError("提醒已经变化或不再可取消，请重新查看");
      return {
        value: { reminderId: cancelled.id },
        safeSummary: `已取消提醒「${cancelled.text.slice(0, 40)}」`,
      };
    }
    default:
      // 这句会当 `safeSummary` 上屏（渲染层原样取用），所以写给用户而不是工程师：
      // 走到这里=full 档预授权想直接执行，但这条动作的执行体在 API 侧的提案确认那条路上
      // （见 companion-tool-executor-ledger.test.ts 那张表），此处什么都不该改。
      throw new CompanionToolError("这一步我这边还做不了，先停住，没有改动任何东西");
  }
}
