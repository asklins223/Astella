/**
 * 伴星记忆上下文装配（40 §4.6.6）。
 *
 * 生成前注入 resident 正文与 active 目录，两条通道都按**本次路由模型声明的输入预算
 * 整条取舍**：一条要么整条给、要么这一轮不给，没入选的条数随结果报出去。
 * 以前这里是四道各自写一遍的闸门（6 条 / 320 token / 1000 字符 / 1000 字节）加目录
 * 标题与适用条件的两处 clip——同一件事四个数，还会把记忆剪成半句。
 * active 正文仍由显式检索或按 ID 读取工具展开。目录曝光不刷新 last_used_at，
 * 避免把“列出线索”误记为实际使用。
 *
 * grounded_tutor 分支不注入任何长期记忆/人格闲聊内容，防止污染正式学习。
 */

import { sql } from "drizzle-orm";
import { budgetAgentContextRecords, estimateTextTokens } from "@astella/agent-core";
import type { ProviderCapability } from "@astella/shared";
import { companionMemoryContentMaxLength } from "@astella/shared/companion-memory-desktop-contracts";
import type { AgentMemoryContextSourceV1 } from "@astella/shared/agent-contracts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { resolveRouteInputTokens } from "./companion-context-handoff.ts";
import { taskEntityFromPersistedPageContext } from "./companion-task-memory.ts";
import { logger } from "../lib/logger.ts";
import {
  retrieveActiveCompanionMemoryDirectory,
  retrieveResidentCompanionMemories,
  type CompanionMemoryDirectoryEntry,
} from "./companion-memory-vector.ts";
import { recordAgentMethodOffered } from "@astella/agent-host";
import {
  retrievePlaybookViews, type PlaybookCandidateEntry, type PlaybookCatalogEntry,
} from "./companion-playbooks.ts";
import {
  companionMemoryRetrievalModeTotal,
  companionMemoryUsedCount,
} from "../lib/metrics.ts";

export interface ContextMemoryItem {
  memoryId: string;
  revision: number;
  kind: string;
  content: string;
  importance: number;
  pinned: boolean;
  lastUsedAt: string | null;
  userConfirmed: boolean;
  /** 有据 / 待核对 / 有争议 / 已被替代（40 §4.5.4）。 */
  epistemicStatus: string | null;
}

export interface ContextAssemblyResult {
  memorySourceVersions?: { resident: AgentMemoryContextSourceV1[]; directory: AgentMemoryContextSourceV1[] };
  residentMemories: { kind: string; content: string; epistemicStatus?: string | null; userConfirmed?: boolean }[];
  memoryDirectory: CompanionMemoryDirectoryEntry[];
  /** §4.6.10 手册目录：只有标题与触发条件，正文按 id 展开。 */
  playbookCatalog: PlaybookCatalogEntry[];
  /** 方案 50 §16 第 6 步：她自己提炼、还没核对的候选做法（与目录是两条通道）。 */
  playbookCandidates: PlaybookCandidateEntry[];
  /** §4.5.10/§4.6.9 上一次后台整理返回的那段结论；没有就是 null。 */
  organizationSurface: string | null;
  memoryRefs: { memoryId: string; kind: string; content: string }[];
  retrievalMode: "directory" | "disabled";
  usedMemoryIds: string[];
  residentMemoryIds: string[];
  /** 本轮实际带走的字节/token 读数（是**测量**，不是闸门）。 */
  residentTokenEstimate: number;
  residentByteCount: number;
  directoryTokenEstimate: number;
  /**
   * 按声明预算整条取舍后**没入选**的条数：正文与目录各一条通道，各记一笔。
   * 没有这两笔，「她这轮没看到某条记忆」与「那条记忆根本不存在」在数据上分不开。
   */
  residentOmittedCount?: number;
  directoryOmittedCount?: number;
  /** 取舍是按哪个声明容量做的（本次路由模型档案解析出的输入 token）。 */
  memoryCapacityTokens?: number;
}

type Executor = import("@astella/agent-host").AgentSqlExecutor;

/**
 * 引用清单是给界面看的投影（「本轮她用了哪几条记忆」），不是模型输入：
 * 条数与摘要宽度只约束那一格，正文进不进 prompt 由下面的声明预算整条取舍决定。
 */
const MEMORY_REF_MAX = 3;
const MEMORY_REF_CONTENT_MAX = 80;

/**
 * 读上一次后台整理返回的那段结论（§4.5.10 / §4.6.9）。
 *
 * 只在「这一段还没被消费过」的时候返回：surface_at 记的是它**产生**的时间，
 * 所以读一次就把它推后一个标记周期——否则同一句话会在之后每一轮里反复出现，
 * 那正是 §4.5.10 说的「没有值得返回的内容可以为空」的反面。
 */
async function readOrganizationSurface(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
): Promise<string | null> {
  const rows = await tx.execute(sql`
    UPDATE companion_memory_organization_state
       SET surface_at = now()
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND surface IS NOT NULL
       AND (surface_at IS NULL OR surface_at <= now() - interval '7 days')
    RETURNING surface
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] } | null)?.rows ?? []);
  const first = (list as Array<{ surface?: string }>)[0];
  return first?.surface ?? null;
}

/**
 * active 目录：一条**整条**入选或整条不入选，不切标题也不切适用条件。
 *
 * 目录是「有这一条记忆、什么时候用它」的索引，标题剪成半句她就照着半句判断。
 * 条目本身的长度由写入合同管（shared 的 `companionMemoryContentMaxLength` 同时约束
 * 正文与 appliesWhen），这里不写第二份。容量是本次路由模型声明的输入 token；
 * 没入选的条数如实报出去，不静默。
 */
export function budgetCompanionMemoryDirectory(
  entries: readonly CompanionMemoryDirectoryEntry[],
  capacityTokens: number,
): { entries: CompanionMemoryDirectoryEntry[]; tokenEstimate: number; omittedCount: number } {
  const whole = entries.filter(entry => entry.title.trim().length > 0);
  const result = budgetAgentContextRecords(whole, {
    maxTokens: capacityTokens,
    measure: (entry) => {
      const serialized = JSON.stringify(entry);
      return {
        characters: serialized.length,
        bytes: Buffer.byteLength(serialized, "utf8"),
        tokens: estimateTextTokens(serialized),
      };
    },
  });
  return { entries: result.items, tokenEstimate: result.tokens, omittedCount: entries.length - result.items.length };
}

/**
 * 检索并组装上下文。
 *
 * @param tx 已处于 workspace/user RLS 上下文的 worker 事务
 * @param scope 当前 workspace/user
 * @param opts.runId 用于记忆目录曝光日志
 */
export async function assembleCompanionContext(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  input: {
    runId: string;
    groundedTutorContext?: unknown;
    /** Bridge page context（对象或 JSON 字符串），用于推导 currentScope。 */
    pageContext?: unknown;
    /**
     * 关掉手册目录与整理结论。
     *
     * 正式学习（grounded_tutor）与测试会走这条：**证据不足时宁可没有**
     * （§16「事实内容与自然度需要语义评阅」，以及 §11.1「正式学习不注入
     * 记忆/人格」——手册与整理结论属于同一类"陪伴层上下文"）。
     */
    playbooksDisabled?: boolean;
    /**
     * 本次实际路由的模型能力快照。记忆正文与目录的取舍容量由它声明的窗口解析（44 §4.1），
     * 不再各写一份条数/字符/字节闸门。拿不到档案时 `resolveRouteInputTokens` 走
     * agent-core 登记的保守能力同一条解析——仍然是一个声明出来的 token 数。
     */
    modelCapability?: ProviderCapability | null;
    /** 这一轮请求声明的输出上限；缺省由档案声明的最大输出或登记兜底表达。 */
    requestedOutputTokens?: number | null;
  },
): Promise<ContextAssemblyResult> {
  // 正式学习 grounded_tutor 不注入记忆/人格（§11.1）。
  if (input.groundedTutorContext) {
    return {
      residentMemories: [],
      memoryDirectory: [],
      playbookCatalog: [],
      playbookCandidates: [],
      organizationSurface: null,
      memoryRefs: [],
      retrievalMode: "disabled",
      usedMemoryIds: [],
      residentMemoryIds: [],
      residentTokenEstimate: 0,
      residentByteCount: 0,
      directoryTokenEstimate: 0,
      residentOmittedCount: 0,
      directoryOmittedCount: 0,
    };
  }

  // 两条通道各自停在声明容量之内；**完整请求**能不能发出去仍由调用前的
  // `governContextPressure` 计量决定，这里不替它猜一个更小的字符数。
  const capacityTokens = resolveRouteInputTokens(input.modelCapability, input.requestedOutputTokens);
  const taskEntity = taskEntityFromPersistedPageContext(input.pageContext);
  const residentRows = await retrieveResidentCompanionMemories(tx, scope, taskEntity);
  const directoryRows = await retrieveActiveCompanionMemoryDirectory(tx, scope, taskEntity);
  // 正文长度由写入合同声明（shared 的唯一来源），超出那条的旧记录整条不入选并计数——
  // 不是把它剪短：剪过的记忆 she 会照着剪过的话说。
  const items: ContextMemoryItem[] = residentRows.map((item) => ({
    memoryId: item.memoryId,
    revision: item.revision,
    kind: item.kind,
    content: item.content,
    importance: item.importance,
    pinned: item.pinned,
    lastUsedAt: item.lastUsedAt,
    userConfirmed: item.userConfirmed,
    epistemicStatus: item.epistemicStatus,
  })).filter(item => item.content.length <= companionMemoryContentMaxLength);

  // resident 正文与 active 目录是两条独立通道，各自整条取舍；条数由声明容量决定。
  const residentBudget = budgetAgentContextRecords(items, {
    maxTokens: capacityTokens,
    measure: (item) => {
      const bytes = Buffer.byteLength(item.content, "utf8");
      return { characters: item.content.length, bytes, tokens: estimateTextTokens(item.content) };
    },
  });
  const { items: budgetedItems, characters: budgetUsed, tokens: residentTokenEstimate, bytes: residentByteCount } = residentBudget;
  // 「没入选」只有一种读数：取回的行里本轮实际没进 prompt 的都在这一格里——
  // 超出写入合同那条长度线的记录也是整条没进，少算它们就等于把它们说成不存在。
  const residentOmittedCount = residentRows.length - budgetedItems.length;

  const residentMemories = budgetedItems.map((item) => ({
    kind: item.kind,
    content: item.content,
    userConfirmed: item.userConfirmed,
    // 认识状态随正文进上下文：有争议/已替代的条目要标出来，
    // 否则她会把它们当定论复述（§4.5.4 / §4.6.3「停止自动作确定陈述」）。
    epistemicStatus: item.epistemicStatus,
  }));
  const directory = budgetCompanionMemoryDirectory(directoryRows, capacityTokens);

  // §4.6.10：手册目录与记忆目录是两条独立通道——手册讲"怎么协作"，
  // 记忆讲"关于用户的什么"。目录有界（PLAYBOOK_CATALOG_LIMIT），正文不进来。
  // 目录与候选一次取回（同表同事务；判据都在 agent-host 那一条查询里）。
  const playbookViews = input.playbooksDisabled
    ? { catalog: [], candidates: [] }
    : await retrievePlaybookViews(tx, scope);
  const playbooks = playbookViews.catalog;
  const playbookCandidates = playbookViews.candidates;
  // 方案 44 §6.3：目录**被提供**要记一次，且只记一次。
  //
  // 这条以前只在 agent-goal 那条路记（`agent/execution-context.ts`），伴星对话这条路
  // **每轮都把目录渲染进 prompt 却一条都不记**——于是 §6.3 的三阶段漏斗在主要路径上
  // 缺了第一级：`offered` 恒为 0，看起来像「从来没提供过」，实际是**没人在这个调用点记**。
  //
  // 纯函数（`renderPlaybookCatalog` / `selectRelevantMethods`）都有单测，缺的正是
  // 「调用面接线」——所以判据要落在**这张表有没有行**上，不是函数返回值对不对。
  //
  // 去重口径与 agent-goal 那条一致（`sourceKey` 带上下文版本）：同一次提供只留一行，
  // 重复装配不会重复计数。这里用 runId + 目录内容摘要——同一轮重新装配目录不变，
  // 换一轮 runId 变，正好是「提供了一次」的粒度。
  if (playbooks.length > 0) {
    await recordAgentMethodOffered(tx as never, scope, {
      methods: playbooks.map(entry => ({ methodId: entry.playbookId, revision: entry.version })),
      kind: "conversation",
      contextId: input.runId,
      contextRevision: 1,
      sourceKey: `conversation:${input.runId}:offered`,
    }).catch(() => {});
  }
  // §4.5.10/§4.6.9：整理结论「至多一段」，不自动成为对外消息，
  // 只作为带来源的后台产物出现在下一轮上下文里。
  const organizationSurface = input.playbooksDisabled ? null : await readOrganizationSurface(tx as never, scope);
  // 引用只对应本轮正文确实进入 prompt 的 resident 记忆；active 目录项没有被展开，
  // 不能提前显示成“本轮引用了这条记忆”。按 ID 展开时由读工具补入引用。
  const memoryRefs = budgetedItems.slice(0, MEMORY_REF_MAX).map((item) => ({
    memoryId: item.memoryId,
    kind: item.kind,
    content: item.content.slice(0, MEMORY_REF_CONTENT_MAX),
  }));

  const residentIds = budgetedItems.map((item) => item.memoryId);
  const directoryIds = directory.entries.map((item) => item.memoryId);
  const exposedIds = [...new Set([...residentIds, ...directoryIds])];

  // 记录本轮可见的 resident 与目录项数；目录项不被当作已展开正文。
  try {
    companionMemoryRetrievalModeTotal.labels("directory").inc();
    companionMemoryUsedCount.observe(exposedIds.length);
  } catch {
    // metrics 记录失败不影响对话。
  }

  logger.debug(
    {
      runId: input.runId,
      residentMemoryIds: residentIds,
      directoryMemoryIds: directoryIds,
      retrievalMode: "directory",
      residentBudgetUsed: budgetUsed,
      residentTokenEstimate,
      residentByteCount,
      directoryTokenEstimate: directory.tokenEstimate,
      memoryCapacityTokens: capacityTokens,
      residentOmittedCount,
      directoryOmittedCount: directory.omittedCount,
    },
    "companion context assembled",
  );

  return {
    memorySourceVersions: {
      resident: budgetedItems.map(item => ({ memoryId: item.memoryId, revision: item.revision })),
      directory: directory.entries.map(item => ({ memoryId: item.memoryId, revision: item.revision })),
    },
    residentMemories,
    memoryDirectory: directory.entries,
    playbookCatalog: playbooks,
    playbookCandidates,
    organizationSurface,
    memoryRefs,
    retrievalMode: "directory",
    usedMemoryIds: exposedIds,
    residentMemoryIds: residentIds,
    residentTokenEstimate,
    residentByteCount,
    directoryTokenEstimate: directory.tokenEstimate,
    residentOmittedCount,
    directoryOmittedCount: directory.omittedCount,
    memoryCapacityTokens: capacityTokens,
  };
}

/** Best-effort observability runs after prompt context has been read and committed. */
export async function recordCompanionMemoryContextExposure(
  scope: { workspaceId: string; userId: string },
  runId: string,
  context: Pick<ContextAssemblyResult, "residentMemoryIds" | "usedMemoryIds">,
): Promise<void> {
  if (context.usedMemoryIds.length === 0) return;
  try {
    await withWorkerWorkspaceTransaction(scope, async (tx) => {
      if (context.residentMemoryIds.length > 0) {
        // R29/R32：drizzle+postgres-js 数组参数序列化不可靠，使用显式 uuid[] 字面量。
        const residentIdsLiteral = `{${context.residentMemoryIds.join(",")}}`;
        await tx.execute(sql`
          UPDATE assistant_memory_items
             SET last_used_at = now()
           WHERE workspace_id = ${scope.workspaceId}
             AND user_id = ${scope.userId}
             AND id = ANY(${residentIdsLiteral}::uuid[])
        `);
      }
      const exposedIdsLiteral = `{${context.usedMemoryIds.join(",")}}`;
      await tx.execute(sql`
        INSERT INTO memory_usage_log
          (workspace_id, user_id, run_id, memory_ids, retrieval_mode, latency_ms)
        VALUES
          (${scope.workspaceId}, ${scope.userId}, ${runId},
           ${exposedIdsLiteral}::uuid[], 'directory', 0)
      `);
    });
  } catch (error) {
    logger.warn({ err: error, runId }, "companion memory context exposure logging failed");
  }
}
