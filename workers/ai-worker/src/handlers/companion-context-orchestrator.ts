/**
 * 伴星记忆上下文装配（40 §4.6.6）。
 *
 * 生成前只注入少量 resident 正文与有界 active 目录；active 正文由显式检索或按 ID
 * 读取工具展开。目录曝光不刷新 last_used_at，避免把“列出线索”误记为实际使用。
 *
 * grounded_tutor 分支不注入任何长期记忆/人格闲聊内容，防止污染正式学习。
 */

import { sql } from "drizzle-orm";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { taskEntityFromPersistedPageContext } from "./companion-task-memory.ts";
import { logger } from "../lib/logger.ts";
import {
  retrieveActiveCompanionMemoryDirectory,
  retrieveResidentCompanionMemories,
  type CompanionMemoryDirectoryEntry,
} from "./companion-memory-vector.ts";
import { retrievePlaybookCatalog, type PlaybookCatalogEntry } from "./companion-playbooks.ts";
import {
  companionMemoryRetrievalModeTotal,
  companionMemoryUsedCount,
} from "../lib/metrics.ts";

export interface ContextMemoryItem {
  memoryId: string;
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
  residentMemories: { kind: string; content: string; epistemicStatus?: string | null; userConfirmed?: boolean }[];
  memoryDirectory: CompanionMemoryDirectoryEntry[];
  /** §4.6.10 手册目录：只有标题与触发条件，正文按 id 展开。 */
  playbookCatalog: PlaybookCatalogEntry[];
  /** §4.5.10/§4.6.9 上一次后台整理返回的那段结论；没有就是 null。 */
  organizationSurface: string | null;
  memoryRefs: { memoryId: string; kind: string; content: string }[];
  retrievalMode: "directory" | "disabled";
  usedMemoryIds: string[];
  residentMemoryIds: string[];
  residentTokenEstimate: number;
  residentByteCount: number;
  directoryTokenEstimate: number;
}

type Executor = { execute(query: unknown): Promise<unknown> };

const MEMORY_REF_MAX = 3;
const MEMORY_REF_CONTENT_MAX = 80;
const MEMORY_CONTENT_MAX = 200;
const RESIDENT_MEMORY_MAX_COUNT = 6;
const RESIDENT_MEMORY_TOKEN_BUDGET = 320;
const RESIDENT_MEMORY_BYTE_BUDGET = 1000;
const RESIDENT_MEMORY_CHAR_BUDGET = 1000;
const MEMORY_DIRECTORY_MAX_COUNT = 12;
const MEMORY_DIRECTORY_TOKEN_BUDGET = 1024;

function estimateDirectoryTokens(entry: CompanionMemoryDirectoryEntry): number {
  // 使用 UTF-8 字节的一半作保守估算：对中文高于常见 tokenizer 的字符成本，
  // 对 UUID 与拉丁文本也留余量；此值用于硬预算，不伪称模型 tokenizer 的精确计数。
  return Math.ceil(Buffer.byteLength(JSON.stringify(entry), "utf8") / 2);
}

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

export function budgetCompanionMemoryDirectory(
  entries: CompanionMemoryDirectoryEntry[],
): { entries: CompanionMemoryDirectoryEntry[]; tokenEstimate: number } {
  let tokenEstimate = 0;
  const budgeted: CompanionMemoryDirectoryEntry[] = [];
  for (const entry of entries) {
    if (budgeted.length >= MEMORY_DIRECTORY_MAX_COUNT) break;
    const bounded: CompanionMemoryDirectoryEntry = {
      ...entry,
      title: entry.title.trim().slice(0, 56),
      appliesWhen: entry.appliesWhen?.trim().slice(0, 64) || null,
    };
    if (!bounded.title) continue;
    const estimate = estimateDirectoryTokens(bounded);
    if (tokenEstimate + estimate > MEMORY_DIRECTORY_TOKEN_BUDGET) continue;
    budgeted.push(bounded);
    tokenEstimate += estimate;
  }
  return { entries: budgeted, tokenEstimate };
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
  },
): Promise<ContextAssemblyResult> {
  // 正式学习 grounded_tutor 不注入记忆/人格（§11.1）。
  if (input.groundedTutorContext) {
    return {
      residentMemories: [],
      memoryDirectory: [],
      playbookCatalog: [],
      organizationSurface: null,
      memoryRefs: [],
      retrievalMode: "disabled",
      usedMemoryIds: [],
      residentMemoryIds: [],
      residentTokenEstimate: 0,
      residentByteCount: 0,
      directoryTokenEstimate: 0,
    };
  }

  const taskEntity = taskEntityFromPersistedPageContext(input.pageContext);
  const residentRows = await retrieveResidentCompanionMemories(tx, scope, taskEntity);
  const directoryRows = await retrieveActiveCompanionMemoryDirectory(tx, scope, taskEntity);
  const items: ContextMemoryItem[] = residentRows.map((item) => ({
    memoryId: item.memoryId,
    kind: item.kind,
    content: item.content.slice(0, MEMORY_CONTENT_MAX),
    importance: item.importance,
    pinned: item.pinned,
    lastUsedAt: item.lastUsedAt,
    userConfirmed: item.userConfirmed,
    epistemicStatus: item.epistemicStatus,
  }));

  // Resident 正文独立占预算；active 目录使用自己的 token/条数预算。
  let budgetUsed = 0;
  let residentTokenEstimate = 0;
  let residentByteCount = 0;
  const budgetedItems: typeof items = [];
  for (const item of items) {
    if (budgetedItems.length >= RESIDENT_MEMORY_MAX_COUNT) break;
    const byteCount = Buffer.byteLength(item.content, "utf8");
    const tokenEstimate = Math.ceil(byteCount / 3);
    if (
      budgetUsed + item.content.length > RESIDENT_MEMORY_CHAR_BUDGET
      || residentByteCount + byteCount > RESIDENT_MEMORY_BYTE_BUDGET
      || residentTokenEstimate + tokenEstimate > RESIDENT_MEMORY_TOKEN_BUDGET
    ) continue;
    budgetedItems.push(item);
    budgetUsed += item.content.length;
    residentByteCount += byteCount;
    residentTokenEstimate += tokenEstimate;
  }

  const residentMemories = budgetedItems.map((item) => ({
    kind: item.kind,
    content: item.content,
    userConfirmed: item.userConfirmed,
    // 认识状态随正文进上下文：有争议/已替代的条目要标出来，
    // 否则她会把它们当定论复述（§4.5.4 / §4.6.3「停止自动作确定陈述」）。
    epistemicStatus: item.epistemicStatus,
  }));
  const directory = budgetCompanionMemoryDirectory(directoryRows);

  // §4.6.10：手册目录与记忆目录是两条独立通道——手册讲"怎么协作"，
  // 记忆讲"关于用户的什么"。目录有界（PLAYBOOK_CATALOG_LIMIT），正文不进来。
  const playbooks = input.playbooksDisabled
    ? []
    : await retrievePlaybookCatalog(tx as never, scope);
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
    },
    "companion context assembled",
  );

  return {
    residentMemories,
    memoryDirectory: directory.entries,
    playbookCatalog: playbooks,
    organizationSurface,
    memoryRefs,
    retrievalMode: "directory",
    usedMemoryIds: exposedIds,
    residentMemoryIds: residentIds,
    residentTokenEstimate,
    residentByteCount,
    directoryTokenEstimate: directory.tokenEstimate,
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
