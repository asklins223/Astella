/**
 * 真桌宠记忆向量检索（22-real-desktop-pet-memory-context-prd-tdd.md §9.2/§12.5）。
 *
 * - vector 模式：pgvector cosine + importance/pinned/freshness/user_confirmed 加权；
 * - keyword fallback：embedding provider 不可用/无 ready embedding 时按内容关键词 +
 *   importance/pinned/updated_at 排序；
 * - 不阻塞对话；检索失败一律回退 keyword，绝不让记忆召回拖垮回复。
 */

import { sql } from "drizzle-orm";
import { toTextArrayLiteral } from "@ailearn/shared/pg-text-array";
import type { CompanionTaskEntityRef } from "./companion-task-memory.ts";
import { logger } from "../lib/logger.ts";

export interface RetrievedMemory {
  memoryId: string;
  kind: string;
  content: string;
  budgetTier: "resident" | "active" | "archived";
  revision: number;
  importance: number;
  pinned: boolean;
  lastUsedAt: string | null;
  userConfirmed: boolean;
  /** 有据 / 待核对 / 有争议 / 已被替代（40 §4.5.4）。 */
  epistemicStatus: string | null;
}

export interface CompanionMemoryDirectoryEntry {
  memoryId: string;
  kind: string;
  /** Short label derived from the first sentence; the full body stays out of the directory. */
  title: string;
  appliesWhen: string | null;
  validFrom: string | null;
  validUntil: string | null;
  revision: number;
  /** 认识状态随目录一起给：争议/已替代的条目不能在正文里被当定论复述。 */
  epistemicStatus: string | null;
}

export interface CompanionMemoryReadResult extends CompanionMemoryDirectoryEntry {
  content: string;
}

export interface MemoryRetrievalResult {
  items: RetrievedMemory[];
  mode: "vector" | "keyword_fallback";
  latencyMs: number;
}

export interface EmbeddingProviderLike {
  readonly id: string;
  readonly embeddingModelId: string;
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

type Executor = { execute(query: unknown): Promise<unknown> };
type MemoryBudgetSearchTier = "active" | "archived";

/** Only active/archived records are keyword-searchable; resident has its own bounded read. */
function memoryBudgetTierClause(tier: MemoryBudgetSearchTier, alias: "" | "m.") {
  const column = sql.raw(`${alias}budget_tier`);
  return tier === "archived"
    ? sql`AND ${column} = 'archived'`
    : sql`AND ${column} = 'active'`;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function isMemoryVectorEnabled(): boolean {
  return process.env.COMPANION_MEMORY_VECTOR_V1 === "true";
}

/**
 * 向量检索开关。
 *
 * 导出给编排层：调用方需要据此决定"是否值得在事务外先算查询向量"
 * （embedding 是外部 HTTP 调用，不能发生在 RLS 事务内）。
 */
export function isCompanionMemoryVectorEnabled(): boolean {
  return isMemoryVectorEnabled();
}

/**
 * §2.4.3 keyword fallback 的关键词提取。
 *
 * 之前直接把 ≤1000 字符的整段查询塞进 `content ILIKE '%<全文>%'`——模式比
 * content（≤200 字）还长，永远匹配不到，降级检索形同虚设。
 *
 * 提取策略（复审修订：中文无词边界，整段既匹配不到也粒度过粗）：
 * - 拉丁/数字子串 ≥2 字符整体保留（截断到 30），混排 token 如 "light反应" 拆开；
 * - Han 连续段 ≤4 字整体保留；>4 字切重叠 bigram（无分词器条件下召回率最高的
 *   子串单位，如"今天我们聊聊光合作用吧"→ 含"光合"/"作用"等 bigram）；
 * - bigram 超出剩余预算时做**头尾采样**（前半 + 后半）：中文句子的语义重心常在
 *   句尾宾语（"……重点突破有机化学"），按位置顺序截断会恰好丢掉它；
 * - 去重、总量封顶（默认 12），控制 ILIKE ANY 模式规模。
 */
export function extractQueryKeywords(query: string, maxKeywords = 12): string[] {
  const keywords: string[] = [];
  const push = (kw: string): boolean => {
    if (!keywords.includes(kw)) keywords.push(kw);
    return keywords.length < maxKeywords;
  };
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const raw of tokens) {
    if (keywords.length >= maxKeywords) break;
    for (const latin of raw.match(/[A-Za-z0-9]+/g) ?? []) {
      if (latin.length >= 2 && !push(latin.slice(0, 30))) break;
    }
    for (const han of raw.match(/\p{Script=Han}+/gu) ?? []) {
      let grams: string[];
      if (han.length <= 4) {
        grams = [han];
      } else {
        grams = [];
        for (let i = 0; i + 2 <= han.length; i++) grams.push(han.slice(i, i + 2));
        // 头尾采样：超预算时保前半 + 后半 bigram，避免丢句尾语义重心。
        const remaining = maxKeywords - keywords.length;
        if (remaining <= 0) break;
        if (grams.length > remaining) {
          const head = Math.ceil(remaining / 2);
          grams = [
            ...grams.slice(0, head),
            ...grams.slice(grams.length - (remaining - head)),
          ];
        }
      }
      for (const gram of grams) {
        if (!push(gram)) break;
      }
      if (keywords.length >= maxKeywords) break;
    }
  }
  return keywords;
}

/**
 * `toTextArrayLiteral` 已下沉到 `@ailearn/shared/pg-text-array`（API 侧的日记遮蔽
 * 读路径要同一份实现）。这里转出是为了不打断既有的调用方与测试导入。
 */
export { toTextArrayLiteral } from "@ailearn/shared/pg-text-array";
function mapMemoryRow(row: Record<string, unknown>): RetrievedMemory {
  return {
    memoryId: String(row.id ?? row.memory_id ?? ""),
    kind: String(row.kind ?? ""),
    // §9.4：写入端已统一限制 ≤200 字（extractor/summarizer/daily-summary）。
    // 此处保留 slice 作为防御性上限，防止历史残留数据或手动写入的超长内容进入 prompt。
    content: String(row.content ?? "").slice(0, 200),
    budgetTier: row.budget_tier === "resident" || row.budget_tier === "archived"
      ? row.budget_tier
      : "active",
    revision: Number(row.revision ?? 1),
    importance: Number(row.importance ?? 0.5),
    pinned: Boolean(row.pinned),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    userConfirmed: Boolean(row.user_confirmed),
    epistemicStatus: typeof row.epistemic_status === "string" ? row.epistemic_status : null,
  };
}

/** Resident memories are injected without semantic search, but remain subject to task-scope visibility. */
export async function retrieveResidentCompanionMemories(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  taskEntity: CompanionTaskEntityRef | null = null,
): Promise<RetrievedMemory[]> {
  const result = await tx.execute(sql`
    SELECT id, kind, content, budget_tier, revision, importance, pinned, last_used_at, user_confirmed, epistemic_status
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND budget_tier = 'resident'
       AND deleted_at IS NULL
       AND dismissed_at IS NULL
       AND candidate = false
       AND archived_at IS NULL
       AND (valid_from IS NULL OR valid_from <= now())
       AND (valid_until IS NULL OR valid_until > now())
       ${taskScopeVisibility(taskEntity, scope, "")}
     ORDER BY pinned DESC, importance DESC, updated_at DESC, id ASC
     LIMIT 6
  `);
  return rowsOf<Record<string, unknown>>(result).map(mapMemoryRow);
}

function memoryDirectoryTitle(content: unknown): string {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  const firstSentence = normalized.split(/(?<=[。.!?！？])\s*/u, 1)[0] ?? normalized;
  return firstSentence.slice(0, 72);
}

function mapMemoryDirectoryRow(row: Record<string, unknown>): CompanionMemoryDirectoryEntry {
  return {
    memoryId: String(row.id ?? row.memory_id ?? ""),
    kind: String(row.kind ?? ""),
    title: memoryDirectoryTitle(row.content),
    appliesWhen: typeof row.applies_when === "string" ? row.applies_when : null,
    validFrom: row.valid_from == null ? null : String(row.valid_from),
    validUntil: row.valid_until == null ? null : String(row.valid_until),
    revision: Number(row.revision ?? 1),
    epistemicStatus: typeof row.epistemic_status === "string" ? row.epistemic_status : null,
  };
}

/** Return a bounded candidate set for the active-memory directory, without exposing full bodies. */
export async function retrieveActiveCompanionMemoryDirectory(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  taskEntity: CompanionTaskEntityRef | null = null,
): Promise<CompanionMemoryDirectoryEntry[]> {
  const result = await tx.execute(sql`
    SELECT id, kind, content, applies_when, valid_from, valid_until, revision, epistemic_status
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND budget_tier = 'active'
       AND deleted_at IS NULL
       AND dismissed_at IS NULL
       AND candidate = false
       AND archived_at IS NULL
       AND (valid_from IS NULL OR valid_from <= now())
       AND (valid_until IS NULL OR valid_until > now())
       ${taskScopeVisibility(taskEntity, scope, "")}
     ORDER BY pinned DESC, importance DESC, updated_at DESC, id ASC
     LIMIT 64
  `);
  return rowsOf<Record<string, unknown>>(result).map(mapMemoryDirectoryRow);
}

/** Expand one active directory entry only when its exact current revision is requested. */
export async function readActiveCompanionMemoryById(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  taskEntity: CompanionTaskEntityRef | null,
  memoryId: string,
  expectedRevision: number,
): Promise<CompanionMemoryReadResult | null> {
  const result = await tx.execute(sql`
    SELECT id, kind, content, applies_when, valid_from, valid_until, revision, epistemic_status
      FROM assistant_memory_items
     WHERE id = ${memoryId}::uuid
       AND workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND revision = ${expectedRevision}
       AND budget_tier = 'active'
       AND deleted_at IS NULL
       AND dismissed_at IS NULL
       AND candidate = false
       AND archived_at IS NULL
       AND (valid_from IS NULL OR valid_from <= now())
       AND (valid_until IS NULL OR valid_until > now())
       ${taskScopeVisibility(taskEntity, scope, "")}
     LIMIT 1
  `);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  if (!row) return null;
  return {
    ...mapMemoryDirectoryRow(row),
    content: String(row.content ?? "").slice(0, 200),
  };
}

export interface KeywordRetrievalOptions {
  /**
   * 只召回"在这个 embedding 模型下没有 ready 向量"的条目。
   * 向量检索路径用它做**并集补召回**（方案 29 §9.9），不再只当降级路径用。
   */
  onlyMissingEmbeddingForModel?: string;
  /** Archived content is searchable only when the caller explicitly asks for it. */
  budgetTier?: MemoryBudgetSearchTier;
}

/**
 * 向量结果与「向量看不见」的补召回结果按 id 去重合并，向量侧优先（相关度更高）。
 * 补召回侧本身已排除掉向量可返回的行，去重只是防止两侧边界条件漂移时重复注入同一条记忆。
 */
function mergeUniqueMemories(primary: RetrievedMemory[], extra: RetrievedMemory[]): RetrievedMemory[] {
  const seen = new Set(primary.map((item) => item.memoryId));
  const merged = [...primary];
  for (const item of extra) {
    if (seen.has(item.memoryId)) continue;
    seen.add(item.memoryId);
    merged.push(item);
  }
  return merged;
}

/** 关键词降级检索：不依赖 embedding provider。
 *  §2.4.3：按关键词匹配 + importance/pinned/updated_at 规则排序。
 *  §9.2.2：scope 过滤与向量检索一致——workspace / global / 当前 scope 均可召回。 */
/**
 * scope='task' 行的可见性谓词（39d W6-2 / 39b C8）。
 *
 * 改前：`scope = ${taskEntity}`——任何 task 页的召回都看得见**所有** task 行，
 * "这一轮的临时状态"会漏进"那一轮"。现在 task 行必须与**当前任务身份**在
 * `memory_links` 上有绑定（entity_type/entity_id 相等且未 orphaned）才可见；
 * 当前上下文推不出身份（taskEntity=null）⇒ 一条 task 行都看不见。
 * workspace/global 两档不受影响。
 */
function taskScopeVisibility(
  taskEntity: CompanionTaskEntityRef | null,
  scope: { workspaceId: string; userId: string },
  columnPrefix: "" | "m.",
): ReturnType<typeof sql> {
  // 列前缀必须 raw：普通插值会被 drizzle 参数化成 `$3scope`（非法 SQL，
  // 集测当场抓到）。前缀只有 "" / "m." 两个已知值，raw 是安全的。
  // 另一个坑（同一次集测抓到）：外层 id 不能写裸 `id`——子查询里它先解析成
  // memory_links 自己的主键，`ml.memory_id = ml.id` 永远不匹配。外层列必须
  // 全限定（keyword 路径无别名 ⇒ assistant_memory_items.，vector 路径 ⇒ m.）。
  const prefix = sql.raw(columnPrefix === "" ? "assistant_memory_items." : columnPrefix);
  if (!taskEntity) {
    return sql` AND (${prefix}scope = 'workspace' OR ${prefix}scope = 'global' OR FALSE)`;
  }
  return sql` AND (
    ${prefix}scope = 'workspace' OR ${prefix}scope = 'global'
    OR (
      ${prefix}scope = 'task'
      AND EXISTS (
        SELECT 1 FROM memory_links ml
        WHERE ml.memory_id = ${prefix}id
          AND ml.entity_type = ${taskEntity.entityType}
          AND ml.entity_id = ${taskEntity.entityId}
          AND ml.orphaned = false
          AND ml.workspace_id = ${scope.workspaceId}
          AND ml.user_id = ${scope.userId}
      )
    )
  )`;
}

export async function retrieveCompanionMemoriesKeyword(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  query: string,
  topK = 8,
  taskEntity: CompanionTaskEntityRef | null = null,
  opts: KeywordRetrievalOptions = {},
): Promise<MemoryRetrievalResult> {
  const startedAt = performance.now();
  /**
   * 「向量检索看不见这批行」的补召回过滤（方案 29 §9.9）。
   *
   * 判据必须与向量主查询**逐条取反**：向量侧要求
   * `embedding_status='ready'` 且存在 `model_revision` 命中的向量行，
   * 于是"看不见"= 二者任一不满足。少一条都会让某类记忆两边都不负责。
   */
  const missingEmbeddingFilter = opts.onlyMissingEmbeddingForModel
    ? sql`AND (embedding_status <> 'ready'
             OR NOT EXISTS (
               SELECT 1 FROM assistant_memory_embeddings e
               WHERE e.memory_id = assistant_memory_items.id
                 AND e.model_revision = ${opts.onlyMissingEmbeddingForModel}
             ))`
    : sql``;
  const budgetTierFilter = memoryBudgetTierClause(opts.budgetTier ?? "active", "");
  // 修复（2026-08-19 审查）：此前把 ≤1000 字符整段查询塞进 `ILIKE '%<全文>%'`，
  // 模式比 content（≤200 字）还长，几乎永远匹配不到，降级检索形同虚设。
  // 改为提取关键词做 ILIKE ANY。
  //
  // 再修（2026-09-20，方案 29 §9.9）：**上面那次修复其实还是坏的**。
  // `extractQueryKeywords` 产出的是裸子串（`复习`、`光合`），而 LIKE 模式**不带 `%`
  // 就是全等比较**——`'习惯在图书馆三楼复习' ILIKE '复习'` 为假。于是 keyword 路径
  // 从来没匹配上过任何东西，这也解释了 memory_usage_log 为什么 290 行清一色
  // retrieval_mode='vector'：降级路径形同虚设的第二种形态。
  // 现在 content 走 `%子串%`，kind 保持全等（它是枚举名，子串匹配反而会误命中，
  // 比如关键词 "goal" 会命中 "learning_context" 里的片段）。
  // 关键词本身由 `extractQueryKeywords` 限定在 `[\p{L}\p{N}]+` 内，`%`/`_` 进不来，
  // 因此加通配符不引入 LIKE 注入面。
  const keywords = extractQueryKeywords(query);
  const contentPatternsLiteral = keywords.length > 0
    ? toTextArrayLiteral(keywords.map((keyword) => `%${keyword}%`))
    : null;
  const kindLiteral = keywords.length > 0 ? toTextArrayLiteral(keywords) : null;
  const keywordFilter = contentPatternsLiteral && kindLiteral
    ? sql` AND (content ILIKE ANY(${contentPatternsLiteral}::text[]) OR kind ILIKE ANY(${kindLiteral}::text[]))`
    : sql``;
  const result = await tx.execute(sql`
    SELECT id, kind, content, budget_tier, revision, importance, pinned, last_used_at, user_confirmed
    FROM assistant_memory_items
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND deleted_at IS NULL
      -- 「忽略」必须真的生效：dismissMemory 写了 dismissed_at，但两条召回路径此前
      -- 都不看这一位（doc 34 L14）——用户明确忽略过的事，下一轮照样被提升成
      -- 正式记忆并注入提示词。
      AND dismissed_at IS NULL
      AND candidate = false
      ${budgetTierFilter}
      AND archived_at IS NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_until IS NULL OR valid_until > now())
      ${taskScopeVisibility(taskEntity, scope, "")}
      ${missingEmbeddingFilter}
      ${keywordFilter}
    ORDER BY pinned DESC, importance DESC, updated_at DESC
    LIMIT ${topK}
  `);
  const items = rowsOf<Record<string, unknown>>(result).map(mapMemoryRow);
  return { items, mode: "keyword_fallback", latencyMs: Math.round(performance.now() - startedAt) };
}

/** 向量检索：pgvector cosine + 排序公式（§9.2.2/§12.5）。 */
export async function retrieveCompanionMemoriesVector(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  query: string,
  provider: EmbeddingProviderLike,
  topK = 8,
  taskEntity: CompanionTaskEntityRef | null = null,
  /**
   * 事务外通过 worker AI task 预计算的查询向量。
   * 缺省或 null 时走关键词降级，不在持有 RLS 事务时调用 provider。
  */
  precomputedEmbedding?: number[] | null,
  budgetTier: MemoryBudgetSearchTier = "active",
): Promise<MemoryRetrievalResult> {
  const startedAt = performance.now();
  const budgetTierFilter = memoryBudgetTierClause(budgetTier, "m.");
  const vector = precomputedEmbedding;
  if (!vector || vector.length === 0) {
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, taskEntity, { budgetTier });
  }
  const queryVec = JSON.stringify(vector);
  try {
    const result = await tx.execute(sql`
      SELECT m.id, m.kind, m.content, m.budget_tier, m.revision,
             m.importance, m.pinned, m.last_used_at, m.user_confirmed,
             1 - (e.embedding <=> ${queryVec}::vector) AS similarity,
             CASE
               WHEN m.last_used_at IS NULL THEN 0.5
               WHEN m.last_used_at > now() - interval '1 day' THEN 1.0
               WHEN m.last_used_at > now() - interval '7 days' THEN 0.8
               WHEN m.last_used_at > now() - interval '30 days' THEN 0.6
               WHEN m.last_used_at > now() - interval '90 days' THEN 0.4
               ELSE 0.2
             END AS freshness
      FROM assistant_memory_items m
      JOIN assistant_memory_embeddings e ON e.memory_id = m.id
      WHERE m.workspace_id = ${scope.workspaceId}
        AND m.user_id = ${scope.userId}
        AND m.deleted_at IS NULL
        -- 与关键词降级路径同一句判据：被忽略过的记忆不参与召回（doc 34 L14）。
        AND m.dismissed_at IS NULL
        AND m.candidate = false
        ${budgetTierFilter}
        AND m.archived_at IS NULL
        AND (m.valid_from IS NULL OR m.valid_from <= now())
        AND (m.valid_until IS NULL OR m.valid_until > now())
        AND m.embedding_status = 'ready'
        ${taskScopeVisibility(taskEntity, scope, "m.")}
        -- AI P1（2026-09-15 审计）：只比较**同一向量空间**的向量。此前不校验
        -- e.model_revision，换过 embedding 模型（如 bge-m3 1024 维 → 别的 1536 维
        -- 模型，或同维不同模型）后，旧向量会与新查询向量一起参与 <=> 计算——维度
        -- 不同时直接抛错、同维不同模型时余弦相似度毫无意义（静默给出错误召回）。
        -- 以查询向量所属模型为基准过滤，未重建的记忆不再参与相似度（其
        -- embedding_status 仍可在重建任务中被重算）。
        AND e.model_revision = ${provider.embeddingModelId}
      ORDER BY
        (1 - (e.embedding <=> ${queryVec}::vector))
        * (0.4 + 0.6 * m.importance)
        * CASE WHEN m.pinned THEN 1.2 ELSE 1 END
        * CASE WHEN m.user_confirmed THEN 1 ELSE 0.8 END
        * CASE
            WHEN m.last_used_at IS NULL THEN 0.5
            WHEN m.last_used_at > now() - interval '1 day' THEN 1.0
            WHEN m.last_used_at > now() - interval '7 days' THEN 0.8
            WHEN m.last_used_at > now() - interval '30 days' THEN 0.6
            WHEN m.last_used_at > now() - interval '90 days' THEN 0.4
            ELSE 0.2
          END DESC
      LIMIT ${topK}
    `);
    const vectorItems = rowsOf<Record<string, unknown>>(result).map(mapMemoryRow);
    // **并集补召回**（方案 29 §9.9，抱怨 #3「写了记不住」的真根因）。
    //
    // 旧行为是"向量返回空 → 探测有没有 ready → 没有才降级 keyword"。这个设计漏掉了
    // 最常见的一种状态：用户**已经有**若干 ready 向量，而刚写下的那条还在
    // pending（实测 21 条活记忆里只有 6 条有向量）。此时主查询非空 → 不降级 →
    // 新记忆结构性隐身。活体复现：12:55 写进「习惯在图书馆三楼复习」，
    // 12:56 问「我平时在哪儿复习」她答"记忆里没这条"。
    //
    // 现在无条件再跑一次 keyword，但**只取向量侧看不见的行**（缺 ready 向量的那些），
    // 与向量结果按 id 去重合并。它同时取代了原来的 hasReady 探测：用户一条向量都没有时，
    // 所有行都算"向量看不见"，补召回自然等价于全量 keyword 降级，不必再单独探一次。
    const supplement = await retrieveCompanionMemoriesKeyword(
      tx,
      scope,
      query,
      topK,
      taskEntity,
      { onlyMissingEmbeddingForModel: provider.embeddingModelId, budgetTier },
    );
    const items = mergeUniqueMemories(vectorItems, supplement.items).slice(0, topK);
    return {
      items,
      mode: vectorItems.length > 0 ? "vector" : "keyword_fallback",
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    // pgvector 查询失败（扩展/索引/类型问题）不阻塞对话，降级 keyword。
    logger.warn({ err: error }, "companion memory vector retrieval failed, falling back to keyword");
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, taskEntity, { budgetTier });
  }
}

/** 统一入口：优先向量，失败/未开启降级 keyword。 */
export async function retrieveCompanionMemories(
  tx: Executor,
  scope: { workspaceId: string; userId: string },
  query: string,
  opts: {
    topK?: number;
    provider?: EmbeddingProviderLike | null;
    /** 当前任务身份（39b C8）：有它 task 行才按绑定可见，没有则 task 行不可见。 */
    taskEntity?: CompanionTaskEntityRef | null;
    signal?: AbortSignal;
    /**
     * 事务外预计算的查询向量：
     * - `undefined`：没有预计算向量，直接降级关键词；
   * - `null`：已尝试但失败——直接降级 keyword，不在事务内重试外部调用。
     */
    precomputedEmbedding?: number[] | null;
    /** Search archived records only on an explicit user request. */
    budgetTier?: MemoryBudgetSearchTier;
  } = {},
): Promise<MemoryRetrievalResult> {
  const topK = opts.topK ?? 8;
  const taskEntity = opts.taskEntity ?? null;
  const budgetTier = opts.budgetTier ?? "active";
  if (!isMemoryVectorEnabled() || !opts.provider) {
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, taskEntity, { budgetTier });
  }
  if (opts.precomputedEmbedding === null) {
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, taskEntity, { budgetTier });
  }
  if (opts.precomputedEmbedding === undefined) {
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, taskEntity, { budgetTier });
  }
  try {
    return await retrieveCompanionMemoriesVector(
      tx,
      scope,
      query,
      opts.provider,
      topK,
      taskEntity,
      opts.precomputedEmbedding,
      budgetTier,
    );
  } catch (error) {
    logger.warn({ err: error }, "companion memory retrieval failed, using keyword fallback");
    return retrieveCompanionMemoriesKeyword(tx, scope, query, topK, taskEntity, { budgetTier });
  }
}
