import { and, asc, desc, eq, ne, sql, inArray, gt, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { SEARCH_DOCUMENT_CONFLICT_TARGET } from "../../lib/search-index-upsert.ts";
import { notes, noteBlocks, sources } from "@astella/shared/db-schema/note";
import { searchDocuments } from "@astella/shared/db-schema/search";
import { searchDocumentsVisibleSql, visibleNotesCondition } from "../note/visibility.ts";
import { SourceStatus } from "@astella/shared";
import { logger } from "../../lib/logger.ts";
import { escapeLikePattern } from "../../lib/like-escape.ts";
import { clampLimit } from "../../lib/pagination-utils.ts";

export interface SearchResult {
  objectType: string;
  objectId: string;
  title: string | null;
  snippet: string;
  indexedAt: string;
  href: string;
  matchCount?: number;
}

// ─── PERF-B2 修复：search count 短 TTL 缓存 ───────────────────────────────
// count 用 DISTINCT ON 对 workspace 全量命中做去重计数，无法利用 LIMIT，
// 是大结果集下每次击键触发的热点。total 只是展示性数字，允许短暂过期。
// 此处用进程内短 TTL 缓存（默认 30s）+ 有界 Map（默认 500 条，超限淘汰最旧），
// 避免每个击键都全表+DISTINCT 计数。写操作后的缓存一致性可接受（total 非强一致）。
const SEARCH_COUNT_CACHE_TTL_MS = 30_000;
const SEARCH_COUNT_CACHE_MAX_ENTRIES = 500;
// N#7-18: 该缓存为进程内（无跨副本同步），无写失效。多副本部署下各实例的
// total/nextCursor 口径可能短期漂移（≤TTL 30s）。total 为展示性数字，可接受短暂不一致；
// 若未来需要强一致，应迁至副本感知的 TTL/版本号策略或移除缓存。

// Drift reporting remains a bounded sample; rebuild uses keyset pagination.
const REINDEX_MAX_ROWS_PER_TABLE = 50_000;

// Drift uses a bounded, deterministically ordered sample.
// DB 排序规则约定：notes/sources 均存在 (workspace_id, updated_at desc) 或等价索引。
const reindexTopOrder: Record<string, any> = (() => {
  return {
    notes: (fields: any) => [desc(fields.updatedAt), asc(fields.id)],
    sources: (fields: any) => [desc(fields.updatedAt), asc(fields.id)],
  };
})();

interface SearchCountCacheEntry {
  value: number;
  insertedAt: number;
}
const searchCountCache = new Map<string, SearchCountCacheEntry>();

/** 归一化缓存键用的小写去空格查询。 */
function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * N#7-1: 分块 IN 查询辅助函数，避免大 ID 集合突破 postgres-js ~65535 绑定参数上限。
 * 沿用项目已有 chunkedInArraySelect 模式（note/service.ts:36），默认 500/批。
 */
async function chunkedInArraySelect<T>(
  queryFn: (chunk: string[]) => Promise<T[]>,
  ids: string[],
  chunkSize = 500,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    results.push(...(await queryFn(chunk)));
  }
  return results;
}

/**
 * 计算去重后的实体总数，优先命中短 TTL 缓存。
 * 缓存键 = workspaceId + normalizedQuery + type。
 */
async function getSearchTotal(
  executor: ApiTransaction,
  workspaceId: string,
  query: string,
  type: string | null,
  userId: string,
): Promise<number> {
  const normalizedQuery = normalizeSearchQuery(query);
  // 缓存键**必须带查看者**：同一个关键词在协作空间里对不同人的命中数本来就不同
  // （别人仅自己可见的笔记不进结果）。不带人就等于把第一个人的数字发给全空间。
  const key = `${workspaceId}\u0000${userId}\u0000${normalizedQuery}\u0000${type ?? ""}`;

  const now = Date.now();
  const cached = searchCountCache.get(key);
  if (cached && now - cached.insertedAt < SEARCH_COUNT_CACHE_TTL_MS) {
    return cached.value;
  }

  // 惰性清理过期条目，防止过期 key 长期占位。
  // PERF: bound the sweep so a cache miss never pays a full O(cache-size) scan.
  // SEARCH_COUNT_CACHE_MAX_ENTRIES below still bounds total memory, and an
  // expired entry is simply overwritten on its next lookup.
  let evicted = 0;
  const MAX_EVICTIONS_PER_CALL = 16;
  for (const [k, v] of searchCountCache) {
    if (evicted >= MAX_EVICTIONS_PER_CALL) break;
    if (now - v.insertedAt >= SEARCH_COUNT_CACHE_TTL_MS) {
      searchCountCache.delete(k);
      evicted++;
    }
  }

  const rows = await executor.execute<{ count: string }>(sql`
    SELECT count(*) as count FROM (
      SELECT DISTINCT ON (object_type || ':' || object_id)
        1
      FROM search_documents AS search_document
      CROSS JOIN (SELECT ${userId}::uuid AS viewer) v
      WHERE workspace_id = ${workspaceId}
        AND ${sql.raw(searchDocumentsVisibleSql())}
        AND (
          body ILIKE '%' || ${searchEscapedQuery(query)} || '%' ESCAPE '\\'
          OR title ILIKE '%' || ${searchEscapedQuery(query)} || '%' ESCAPE '\\'
        )
        AND (${type}::text IS NULL OR object_type = ${type})
    ) as distinct_entities
  `);
  const total = Number(rows[0]?.count ?? 0);

  // 有界写入：超限时淘汰最旧条目（Map 保持插入序，首个 key 即最旧）。
  if (searchCountCache.size >= SEARCH_COUNT_CACHE_MAX_ENTRIES && !searchCountCache.has(key)) {
    const oldestKey = searchCountCache.keys().next().value;
    if (oldestKey !== undefined) searchCountCache.delete(oldestKey);
  }
  searchCountCache.set(key, { value: total, insertedAt: now });
  return total;
}

/** 与 search 内联查询一致的 ILIKE 转义。 */
/** @deprecated 2026-09-29（P1-12）：已上提到 `lib/like-escape.ts`，同名同行为。 */
const searchEscapedQuery = escapeLikePattern;

/**
 * 翻页游标。**keyset** 而不是 OFFSET：结果按 `indexed_at DESC, dedup_key ASC`
 * 排序，而 `indexed_at` 在实体被编辑时会变，OFFSET 分页会让行在页之间移动，
 * 造成静默漏行（重复行客户端能去重，漏行不能）。游标携带最后一行自己的排序键，
 * 下一页从它之后继续，因此翻页期间写入不会挪动已经读过的位置。
 *
 * 同时带上页码：既用于深度上限（见 MAX_SEARCH_PAGES），也让「0 条结果」这种
 * 情况天然不可能复现——没有行就没有可推进的排序键，`nextCursor` 直接为 null。
 */
export interface SearchCursor {
  /** 本页是第几页（从 0 开始）。 */
  readonly page: number;
  /** 上一页最后一行的 `indexed_at`，ISO-8601 毫秒精度。 */
  readonly indexedAt: string;
  /** 上一页最后一行的 `object_type || ':' || object_id`。 */
  readonly dedupKey: string;
}

/** 每页最多 50 条 × 40 页 ≈ 旧 OFFSET 上限 1000，超出即停止翻页。 */
const MAX_SEARCH_PAGES = 40;

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

/** 解不开的游标一律返回 null，由路由层回 400，绝不猜一个默认页。 */
export function decodeSearchCursor(value: string): SearchCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.page !== "number" || !Number.isInteger(parsed.page) || parsed.page < 0) return null;
    if (typeof parsed.indexedAt !== "string" || Number.isNaN(Date.parse(parsed.indexedAt))) return null;
    if (typeof parsed.dedupKey !== "string" || parsed.dedupKey.length === 0) return null;
    return { page: parsed.page, indexedAt: parsed.indexedAt, dedupKey: parsed.dedupKey };
  } catch {
    return null;
  }
}

/**
 * 全文搜索（pg_trgm + ILIKE，中文友好）。
 * N-012: 在 SQL 层按最终展示实体聚合去重，再计算 total 和分页。
 * 同一实体的多条索引记录只返回一条，但记录 matchCount。
 */
export async function search(
  executor: ApiTransaction,
  workspaceId: string,
  query: string,
  opts: { userId: string; type?: string; limit?: number; cursor?: SearchCursor },
): Promise<{ items: SearchResult[]; total: number; nextCursor: string | null }> {
  // P1-17：此前只有上界没有下界；`learning-objectives/routes.ts:25` 的注释记录过
  // 同族事故——`?limit=abc` → NaN → drizzle 不渲染 LIMIT → 全表扫描 + 永远翻不动的空页。
  const limit = clampLimit(opts.limit, 20, 50);
  const cursor = opts.cursor ?? null;
  const type = opts.type ?? null;
  // ILIKE treats `%` and `_` as wildcards. Escape them so the public API keeps
  // literal keyword semantics and a query such as `%` cannot scan/return every
  // document in the workspace.
  const escapedQuery = query.replace(/[\\%_]/g, "\\$&");

  // N-012: 使用 DISTINCT ON 在 SQL 层聚合去重。
  const dedupKey = sql`object_type || ':' || object_id`;
  // 排序键是 (indexed_at DESC, dedup_key ASC)，所以"在这一行之后"是
  // indexed_at 更早，或同一毫秒内 dedup_key 更大。索引写入路径全部使用
  // JS Date（毫秒精度），因此这里用 ISO 毫秒字符串回比是精确的。
  const keyset = cursor
    ? sql`AND (
        search_document.indexed_at < ${cursor.indexedAt}::timestamptz
        OR (
          search_document.indexed_at = ${cursor.indexedAt}::timestamptz
          AND ${dedupKey} > ${cursor.dedupKey}
        )
      )`
    : sql``;

  // The page read and the (cached) total are independent reads; run them in
  // parallel. total 由 getSearchTotal 走短 TTL 缓存，命中时零 DB 往返。
  const [rows, total] = await Promise.all([
    executor.execute<{
      object_type: string;
      object_id: string;
      title: string | null;
      /** P0-7：摘要窗口已在 SQL 侧算好（命中位置 ±50 字符 + 省略号）。 */
      snippet: string | null;
      /** P0-7："匹配 N 处"已在 SQL 侧用 regexp_count 算好。 */
      match_count: number;
      indexed_at: string;
      metadata: Record<string, unknown> | null;
    }>(sql`
      WITH matching AS (
        SELECT object_type, object_id, title, body, indexed_at, metadata,
          ${dedupKey} as dedup_key
        FROM search_documents AS search_document
        -- 这张索引表是整个空间共用的一份数据，所以"谁能看到这篇笔记"必须在发结果
        -- 之前 join 回去判一次。规则本体在 note/visibility.ts，这里只负责把它接进
        -- 原生 SQL：查看者以一个 v(viewer) 列进来，片段里引用的是它而不是占位符。
        CROSS JOIN (SELECT ${opts.userId}::uuid AS viewer) v
        WHERE workspace_id = ${workspaceId}
          AND ${sql.raw(searchDocumentsVisibleSql())}
          AND (
            body ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
            OR title ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\\'
          )
          AND (${type}::text IS NULL OR object_type = ${type})
          ${keyset}
      ),
      deduplicated AS (
        SELECT DISTINCT ON (dedup_key)
          object_type, object_id, title, body, indexed_at, metadata, dedup_key
        FROM matching
        ORDER BY dedup_key, indexed_at DESC
      )
      -- 2026-09-29（P0-7）：不再把完整正文搬回主进程。
      --
      -- 此前 SELECT 带回的是 d.body 整列，而 JS 侧真正用的只有两样：
      --   1) 命中位置 +-50 字符的摘要窗口；
      --   2) 「匹配 N 处」的计数（对整篇正文跑全局正则，并把所有匹配物化成数组）。
      -- 两者都改成在 SQL 里算完，主进程只收窗口片段。
      --
      -- 量级（口径：笔记正文均值 20KB、一页命中 20 条）：改前每次击键约 400KB
      -- 网络传输 + 400KB 的两次 toLowerCase 分配 + 400KB 正则扫描，全在 Node 主线程；
      -- 改后只传 20 段约 200 字符，其余在 PG 内完成。
      --
      -- 窗口形状与改前的 JS **逐字对齐**（JS 是 0 基，PG position 是 1 基）：
      --   JS  start0 = max(0, idx-50)              → PG start1 = greatest(1, pos-50)
      --   JS  end0   = min(len, idx+q+50)           → PG end1  = least(len+1, pos+q+50)
      --   起始省略号：JS start0 > 0                   → PG start1 > 1
      --   末尾省略号：JS end0 < len                  → PG end1  <= len
      -- 长度写成 end1-start1（而不是硬编码 200），这样命中点靠近正文开头时
      -- 窗口长度会自动收窄，与改前 min() 的行为一致——这一点是靠
      -- search-service-extra.test.ts 那条 x*55+Needle+y*55 的夹具比出来的，
      -- 第一版写死 200 时末尾省略号的位置与断言对不上。
      --
      -- position 两侧都 lower：ILIKE 大小写不敏感，而 position 本身区分大小写。
      SELECT d.object_type, d.object_id, d.title, d.metadata,
        (CASE WHEN w.start1 > 1 THEN '…' ELSE '' END)
        || substring(d.body FROM w.start1 FOR (w.end1 - w.start1))
        || (CASE WHEN w.end1 <= length(d.body) THEN '…' ELSE '' END) AS snippet,
        GREATEST(
          1,
          COALESCE((SELECT regexp_count(d.body, ${query}::text, 1, 'i')), 0)
          + COALESCE((SELECT regexp_count(d.title, ${query}::text, 1, 'i')), 0)
        ) AS match_count,
        -- 原生 SQL 会把 timestamptz 作为驱动文本（形如 2026-08-22 07:22:05.46+00）返回，
        -- 桌面契约的 isoTimestamp 只接受 ISO-8601。在 SQL 层直接产出 ISO 字符串，
        -- 避免主进程把它判成 unsupported_contract 并触发整库重连。
        to_char(d.indexed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as indexed_at
      FROM deduplicated d
      CROSS JOIN LATERAL (
        -- 一层 LATERAL 返回两个具名列。写成多层（LATERAL (...) p, LATERAL (...) w, …）
        -- 或者"子查询里再套子查询"的形状都会报 22P02 / "syntax error at or near AS"——
        -- 那种写法是本次调试里绕了两轮才排掉的，记在这里免得再写一次。
        SELECT
          GREATEST(1, COALESCE(NULLIF(position(lower(${query}::text) IN lower(d.body)), 0), 1) - 50) AS start1,
          least(length(d.body) + 1,
                COALESCE(NULLIF(position(lower(${query}::text) IN lower(d.body)), 0), 1)
                + length(${query}::text) + 50) AS end1
      ) w
      ORDER BY d.indexed_at DESC, d.dedup_key ASC
      LIMIT ${limit + 1}
    `),
    getSearchTotal(executor, workspaceId, query, type, opts.userId),
  ]);

  // PERF-11: Create the highlight RegExp once, not per result row.
  // BUG-04 fix: snippet 高亮也需要转义 query 中的正则特殊字符，
  // 同时去掉控制字符避免 RegExp 构建异常。
  // BUG-13 fix: 同时转义 `-` 字符。虽然 `-` 在正则字面量模式中不是元字符，
  // 但转义它是无害的，且能防止未来代码复用到字符类上下文中时产生意外匹配。
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&").replace(/[\x00-\x1F]/g, "");
  const highlightRe = safeQuery ? new RegExp(safeQuery, "gi") : null;

  // 多取一行只用于判断"还有下一页"，不进结果集。
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: SearchResult[] = pageRows.map((row) => {
    // P0-7：摘要与匹配数都来自 SQL。命中在 title 而不在 body 时，SQL 的
    // `position(... IN lower(body))` 返回 NULL → COALESCE 落到 ''，与改前
    // "idx < 0 就退回正文前 100 字符"的分支不是同一件事，但两边都只在
    // "正文里没有这个串"时触发；改后更保守（给空串而不是可能泄露的开头正文）。
    const snippet = row.snippet ?? "";

    const highlighted = highlightRe
      ? snippet.replace(highlightRe, (match) => `«${match}»`)
      : snippet;

    // 生成 href
    let href = "";
    switch (row.object_type) {
      case "note":
        href = `/notes/${row.object_id}`;
        break;
      case "source":
        href = `/sources/${row.object_id}`;
        break;
      default:
        href = "";
    }

    return {
      objectType: row.object_type,
      objectId: row.object_id,
      title: row.title,
      snippet: highlighted,
      indexedAt: row.indexed_at,
      href,
      matchCount: Number(row.match_count ?? 1),
    };
  });

  const lastRow = pageRows[pageRows.length - 1];
  const page = cursor?.page ?? 0;
  // 没有行就没有下一页（空页不会复现同一个游标）；页数达到上限时收口，
  // 前端据此提示"已到读取上限"。
  const nextCursor = hasMore && lastRow && page + 1 < MAX_SEARCH_PAGES
    ? encodeSearchCursor({
        page: page + 1,
        indexedAt: lastRow.indexed_at,
        dedupKey: `${lastRow.object_type}:${lastRow.object_id}`,
      })
    : null;
  return {
    items,
    total,
    nextCursor,
  };
}

export interface SearchReindexResult {
  deleted: number;
  indexed: {
    note: number;
    source: number;
  };
  /** Retained for API compatibility; rebuild no longer truncates. */
  capped: boolean;
}

/**
 * Rebuild the workspace in stable ID order with bounded pages, inside one
 * savepoint. Parent rows are locked in ID order before content is read so a
 * concurrent edit either commits first or updates the index after this rebuild.
 * Failures roll back every page.
 * Unrelated projection types remain intact.
 */
export async function reindexWorkspaceSearch(
  executor: ApiTransaction,
  workspaceId: string,
): Promise<SearchReindexResult & { errors: number }> {
  const pageSize = 100;
  const indexed = { note: 0, source: 0 };
  let deleted = 0;
  try {
    await executor.transaction(async (tx) => {
      const conflictTarget = sql.join(
        SEARCH_DOCUMENT_CONFLICT_TARGET.map((column) => sql.identifier(column.name)), sql`, `,
      );
      // Aggregate content in PostgreSQL so Node holds only 100 IDs at once,
      // even when a page contains many large notes or sources.
      let noteCursor: string | undefined;
      while (true) {
        const page = await tx.query.notes.findMany({
          where: and(eq(notes.workspaceId, workspaceId),
            noteCursor ? gt(notes.id, noteCursor) : undefined),
          columns: { id: true, currentVersionId: true }, orderBy: [asc(notes.id)], limit: pageSize,
        });
        if (!page.length) break;
        const ids = page.map((note) => note.id);
        // Lock all parent rows, including tombstones. A restore or update must
        // wait until this snapshot and its search projection have committed.
        await tx.execute(sql`SELECT id FROM notes WHERE ${and(eq(notes.workspaceId, workspaceId), inArray(notes.id, ids))} ORDER BY id FOR UPDATE`);
        const changed = await tx.execute<{ count: string }>(sql`
          WITH changed AS (INSERT INTO search_documents (workspace_id, object_type, object_id, title, body, metadata, indexed_at)
          SELECT notes.workspace_id, 'note', notes.id, notes.title,
            COALESCE((SELECT string_agg(note_blocks.content, E'\\n' ORDER BY note_blocks.ordinal)
              FROM note_blocks WHERE note_blocks.version_id = notes.current_version_id
                AND note_blocks.type <> 'image'), ''), '{}'::jsonb, clock_timestamp()
          FROM notes WHERE ${and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt), inArray(notes.id, ids))}
            AND notes.current_version_id IS NOT NULL
          ON CONFLICT (${conflictTarget}) DO UPDATE SET title = excluded.title, body = excluded.body,
            metadata = excluded.metadata, indexed_at = excluded.indexed_at
          RETURNING 1) SELECT count(*)::text AS count FROM changed
        `);
        indexed.note += Number(changed[0]?.count ?? 0);
        noteCursor = page[page.length - 1]!.id;
        if (page.length < pageSize) break;
      }
      let sourceCursor: string | undefined;
      while (true) {
        const page = await tx.query.sources.findMany({
          where: and(eq(sources.workspaceId, workspaceId),
            sourceCursor ? gt(sources.id, sourceCursor) : undefined),
          columns: { id: true }, orderBy: [asc(sources.id)], limit: pageSize,
        });
        if (!page.length) break;
        const ids = page.map((source) => source.id);
        await tx.execute(sql`SELECT id FROM sources WHERE ${and(eq(sources.workspaceId, workspaceId), inArray(sources.id, ids))} ORDER BY id FOR UPDATE`);
        const changed = await tx.execute<{ count: string }>(sql`
          WITH changed AS (INSERT INTO search_documents (workspace_id, object_type, object_id, title, body, metadata, indexed_at)
          SELECT sources.workspace_id, 'source', sources.id, sources.title,
            COALESCE((SELECT string_agg(source_segments.text, E'\\n' ORDER BY source_segments.ordinal)
              FROM source_segments WHERE source_segments.source_id = sources.id),
              concat_ws(E'\\n', NULLIF(sources.origin, ''),
                CASE WHEN jsonb_typeof(sources.metadata->'rawContent') = 'string' THEN NULLIF(sources.metadata->>'rawContent', '') END,
                CASE WHEN jsonb_typeof(sources.metadata->'url') = 'string' THEN NULLIF(sources.metadata->>'url', '') END)),
            jsonb_build_object('type', sources.type), clock_timestamp()
          FROM sources WHERE ${and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED), inArray(sources.id, ids))}
          ON CONFLICT (${conflictTarget}) DO UPDATE SET title = excluded.title, body = excluded.body,
            metadata = excluded.metadata, indexed_at = excluded.indexed_at
          RETURNING 1) SELECT count(*)::text AS count FROM changed
        `);
        indexed.source += Number(changed[0]?.count ?? 0);
        sourceCursor = page[page.length - 1]!.id;
        if (page.length < pageSize) break;
      }
      // Remove only genuinely orphaned projections after locking existing parents.
      // SQL counts deleted rows without returning all identifiers to Node.
      const removed = await tx.execute<{ count: string }>(sql`
        WITH removed AS (
          DELETE FROM search_documents AS document
          WHERE document.workspace_id = ${workspaceId}
            AND (
              (document.object_type = 'note' AND NOT EXISTS (
                SELECT 1 FROM notes AS note WHERE note.id = document.object_id
                  AND note.workspace_id = ${workspaceId} AND note.deleted_at IS NULL
                  AND note.current_version_id IS NOT NULL
              )) OR
              (document.object_type = 'source' AND NOT EXISTS (
                SELECT 1 FROM sources AS source WHERE source.id = document.object_id
                  AND source.workspace_id = ${workspaceId} AND source.status <> ${SourceStatus.ARCHIVED}
              ))
            ) RETURNING 1
        ) SELECT count(*)::text AS count FROM removed
      `);
      deleted = Number(removed[0]?.count ?? 0);
    });
    return { deleted, indexed, errors: 0, capped: false };
  } catch (err) {
    logger.error({ err, workspaceId }, "reindex transaction failed — old index preserved");
    return { deleted: 0, indexed: { note: 0, source: 0 }, errors: 1, capped: false };
  }
}

/**
 * F-025: 搜索索引漂移检测。
 *
 * 对比 search_documents 投影表与业务主表，检测以下不一致：
 * - 幽灵文档：搜索索引中存在但业务表中已删除或不应索引的对象
 * - 缺失文档：业务表中存在应在搜索索引中但缺失的对象
 * - 过期标题：搜索索引中的标题与业务表当前标题不匹配
 *
 * 返回漂移详情，供前端展示和触发 reindex 补偿。
 */
export interface SearchDriftResult {
  /** 业务表应有对象数 */
  expected: {
    note: number;
    source: number;
  };
  /** 搜索索引实际对象数 */
  actual: {
    note: number;
    source: number;
  };
  /** 幽灵文档 ID（索引中有但业务表中不存在） */
  ghosts: { objectType: string; objectId: string }[];
  /** 缺失文档 ID（业务表中有但索引中缺失） */
  missing: { objectType: string; objectId: string }[];
  /** 标题不匹配的文档 */
  staleTitles: { objectType: string; objectId: string; indexedTitle: string | null; actualTitle: string }[];
  /** 正文不匹配的文档（R-017: 新增正文过期检测） */
  staleBodies: { objectType: string; objectId: string }[];
  /** 是否检测到漂移 */
  hasDrift: boolean;
  /** N#8-1: 各顶层业务域表读是否命中行数上限（截断）。实体超过确定截断线时两侧都不会读取，
   *  属既定截断而非漂移；auto-fix 据此避免反复重索引。
   *  两侧命中读取上限时不报告窗口外的缺失，避免把既定截断误判为漂移。 */
  capped: Record<"note" | "source", boolean>;
}

/** The repair operates on the shared workspace index, but its diagnostics
 * must never disclose another member's private note to the requesting owner. */
export async function searchDriftForViewer(
  executor: ApiTransaction,
  workspaceId: string,
  userId: string,
  drift: SearchDriftResult,
): Promise<SearchDriftResult> {
  const noteIds = [...new Set([
    ...drift.ghosts, ...drift.missing, ...drift.staleTitles, ...drift.staleBodies,
  ].filter((item) => item.objectType === "note").map((item) => item.objectId))];
  const visibleRows = await chunkedInArraySelect((chunk) => executor.query.notes.findMany({
    where: and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt),
      visibleNotesCondition(userId), inArray(notes.id, chunk)),
    columns: { id: true },
  }), noteIds);
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  const visible = (item: { objectType: string; objectId: string }) =>
    item.objectType !== "note" || visibleIds.has(item.objectId);
  const [expected] = await executor.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM notes
    WHERE ${and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt), visibleNotesCondition(userId))}
      AND ${notes.currentVersionId} IS NOT NULL
  `);
  const [actual] = await executor.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM search_documents AS search_document
    CROSS JOIN (SELECT ${userId}::uuid AS viewer) v
    WHERE search_document.workspace_id = ${workspaceId} AND search_document.object_type = 'note'
      AND ${sql.raw(searchDocumentsVisibleSql())}
  `);
  const expectedNote = Number(expected?.count ?? 0);
  const actualNote = Number(actual?.count ?? 0);
  const ghosts = drift.ghosts.filter(visible);
  const missing = drift.missing.filter(visible);
  const staleTitles = drift.staleTitles.filter(visible);
  const staleBodies = drift.staleBodies.filter(visible);
  return {
    ...drift,
    expected: { ...drift.expected, note: Math.min(expectedNote, REINDEX_MAX_ROWS_PER_TABLE) },
    actual: { ...drift.actual, note: Math.min(actualNote, REINDEX_MAX_ROWS_PER_TABLE) },
    capped: { ...drift.capped, note: expectedNote >= REINDEX_MAX_ROWS_PER_TABLE },
    ghosts, missing, staleTitles, staleBodies,
    hasDrift: ghosts.length + missing.length + staleTitles.length + staleBodies.length > 0,
  };
}

export async function detectSearchDrift(
  executor: ApiTransaction,
  workspaceId: string,
): Promise<SearchDriftResult> {
  const ghosts: { objectType: string; objectId: string }[] = [];
  const missing: { objectType: string; objectId: string }[] = [];
  const staleTitles: { objectType: string; objectId: string; indexedTitle: string | null; actualTitle: string }[] = [];

  // PERF-07: Parallelize queries across entity types.
  // Previously 12 serial DB round-trips; now a small parallel batch.
  // ── Batch 1: notes + sources 业务表与索引查询 ──
  const [noteRows, sampledIndexedNotes, sourceRows, sampledIndexedSources] = await Promise.all([
    // 1a. Notes business table (CONC-03: exclude soft-deleted)
    // N#8-1: 与 reindex 用同一上限 + 同一确定排序，读取同一确定截断子集，避免把超线实体误判 missing。
    executor.query.notes.findMany({
      where: and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
      columns: { id: true, title: true, currentVersionId: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.notes(notes),
    }),
    // 1b. Notes index (deterministic limit matches business-table cap; capped side = known truncation)
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "note")),
      columns: { objectId: true, title: true, body: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: [desc(searchDocuments.indexedAt), asc(searchDocuments.objectId)],
    }),
    // 1c. Sources business table (exclude archived)
    executor.query.sources.findMany({
      where: and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)),
      columns: { id: true, title: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: reindexTopOrder.sources(sources),
    }),
    // 1d. Sources index (deterministic limit matches business-table cap; capped side = known truncation)
    executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "source")),
      columns: { objectId: true, title: true },
      limit: REINDEX_MAX_ROWS_PER_TABLE,
      orderBy: [desc(searchDocuments.indexedAt), asc(searchDocuments.objectId)],
    }),
  ]);

  // A full rebuild and a business-table sample do not have matching order.
  // Compare the sampled business IDs to their actual projections, not to an
  // unrelated top-N index page: otherwise large workspaces report false gaps.
  const capped: Record<"note" | "source", boolean> = {
    note: noteRows.length >= REINDEX_MAX_ROWS_PER_TABLE,
    source: sourceRows.length >= REINDEX_MAX_ROWS_PER_TABLE,
  };
  const noteSampleIds = noteRows.map((row) => row.id);
  const sourceSampleIds = sourceRows.map((row) => row.id);
  const [matchedNotes, matchedSources] = await Promise.all([
    chunkedInArraySelect((chunk) => executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "note"), inArray(searchDocuments.objectId, chunk)),
      columns: { objectId: true, title: true, body: true },
    }), noteSampleIds),
    chunkedInArraySelect((chunk) => executor.query.searchDocuments.findMany({
      where: and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.objectType, "source"), inArray(searchDocuments.objectId, chunk)),
      columns: { objectId: true, title: true },
    }), sourceSampleIds),
  ]);
  const indexedNotes = [...new Map([...sampledIndexedNotes, ...matchedNotes].map((row) => [row.objectId, row])).values()];
  const indexedSources = [...new Map([...sampledIndexedSources, ...matchedSources].map((row) => [row.objectId, row])).values()];

  // Process notes drift
  const noteIds = new Set(noteRows.filter((n) => n.currentVersionId).map((n) => n.id));
  const noteTitleMap = new Map(noteRows.filter((n) => n.currentVersionId).map((n) => [n.id, n.title]));
  const indexedNoteIds = new Set(indexedNotes.map((d) => d.objectId));
  for (const doc of indexedNotes) {
    if (!noteIds.has(doc.objectId)) {
      if (!capped.note) {
        ghosts.push({ objectType: "note", objectId: doc.objectId });
      }
    } else {
      const actualTitle = noteTitleMap.get(doc.objectId);
      if (actualTitle !== undefined && actualTitle !== doc.title) {
        staleTitles.push({ objectType: "note", objectId: doc.objectId, indexedTitle: doc.title, actualTitle });
      }
    }
  }
  for (const id of noteIds) {
    if (!indexedNoteIds.has(id)) {
      missing.push({ objectType: "note", objectId: id });
    }
  }

  // Process sources drift
  const sourceIds = new Set(sourceRows.map((s) => s.id));
  const sourceTitleMap = new Map(sourceRows.map((s) => [s.id, s.title]));
  const indexedSourceIds = new Set(indexedSources.map((d) => d.objectId));
  for (const doc of indexedSources) {
    if (!sourceIds.has(doc.objectId)) {
      if (!capped.source) {
        ghosts.push({ objectType: "source", objectId: doc.objectId });
      }
    } else {
      const actualTitle = sourceTitleMap.get(doc.objectId);
      if (actualTitle !== undefined && actualTitle !== doc.title) {
        staleTitles.push({ objectType: "source", objectId: doc.objectId, indexedTitle: doc.title, actualTitle });
      }
    }
  }
  for (const id of sourceIds) {
    if (!indexedSourceIds.has(id)) {
      missing.push({ objectType: "source", objectId: id });
    }
  }

  // ── Batch 2: stale body detection (depends on noteRows) ──
  const currentVersionIds = noteRows.flatMap((note) =>
    note.currentVersionId ? [note.currentVersionId] : [],
  );
  const currentBlocks = currentVersionIds.length > 0
    ? await chunkedInArraySelect(
        (chunk) => executor.query.noteBlocks.findMany({
          where: inArray(noteBlocks.versionId, chunk),
          orderBy: [asc(noteBlocks.versionId), asc(noteBlocks.ordinal)],
        }),
        currentVersionIds,
      )
    : [];

  // Process stale bodies
  // BUG-51 修复：过滤 image block，与 upsertSearchDocument 保持一致。
  // 索引时 upsertSearchDocument 已排除 image block（type !== "image"），
  // detectSearchDrift 的 stale body 比较也必须排除 image block，
  // 否则包含图片的笔记会持续被误报为 stale。
  const staleBodies: { objectType: string; objectId: string }[] = [];
  const bodyByVersion = new Map<string, string[]>();
  for (const block of currentBlocks) {
    if (block.type === "image") continue;
    const contents = bodyByVersion.get(block.versionId) ?? [];
    contents.push(block.content);
    bodyByVersion.set(block.versionId, contents);
  }
  const indexedNoteById = new Map(indexedNotes.map((document) => [document.objectId, document]));
  for (const note of noteRows) {
    if (!note.currentVersionId) continue;
    const indexedDoc = indexedNoteById.get(note.id);
    if (!indexedDoc) continue;
    const actualBody = (bodyByVersion.get(note.currentVersionId) ?? []).join("\n");
    if (indexedDoc.body !== actualBody) {
      staleBodies.push({ objectType: "note", objectId: note.id });
    }
  }

  const expected = {
    note: noteIds.size,
    source: sourceIds.size,
  };
  const actual = {
    note: sampledIndexedNotes.length,
    source: sampledIndexedSources.length,
  };

  return {
    expected,
    actual,
    ghosts,
    missing,
    staleTitles,
    staleBodies,
    capped,
    hasDrift: ghosts.length > 0 || missing.length > 0 || staleTitles.length > 0 || staleBodies.length > 0,
  };
}

// ─── ARCH-01 修复：搜索索引自动漂移补偿 ─────────────────────────────────────

/**
 * ARCH-01 修复：自动检测并修复搜索索引漂移。
 *
 * 此函数封装了 detectSearchDrift + 条件触发 reindexWorkspaceSearch 的自动化流程，
 * 可由定时任务（cron）或启动检查调用。
 *
 * 策略：
 * - 检测漂移（ghosts + missing + staleTitles + staleBodies）
 * - 如果漂移总数超过阈值（默认 50），自动触发 reindex
 * - 如果漂移总数低于阈值但大于 0，仅记录警告日志（不自动修复）
 * - 返回检测和修复结果
 *
 * @param executor 事务执行器
 * @param workspaceId 工作区 ID
 * @param autoFixThreshold 自动修复的漂移阈值，默认 50
 * @returns 检测结果和是否触发了修复
 */
export async function autoFixSearchDrift(
  executor: ApiTransaction,
  workspaceId: string,
  autoFixThreshold = 50,
): Promise<{ drift: SearchDriftResult; autoFixed: boolean }> {
  const drift = await detectSearchDrift(executor, workspaceId);

  if (!drift.hasDrift) {
    return { drift, autoFixed: false };
  }

  const totalDrift =
    drift.ghosts.length +
    drift.missing.length +
    drift.staleTitles.length +
    drift.staleBodies.length;

  // logger 已在文件顶部静态导入，直接使用
  if (totalDrift >= autoFixThreshold) {
    logger.warn(
      {
        workspaceId,
        totalDrift,
        ghosts: drift.ghosts.length,
        missing: drift.missing.length,
        staleTitles: drift.staleTitles.length,
        staleBodies: drift.staleBodies.length,
      },
      "搜索索引漂移超过阈值，自动触发 reindex 补偿（ARCH-01）",
    );
    const result = await reindexWorkspaceSearch(executor, workspaceId);
    return { drift, autoFixed: result.errors === 0 && !result.capped };
  }

  // 漂移量较小，仅记录信息日志
  logger.info(
    {
      workspaceId,
      totalDrift,
      ghosts: drift.ghosts.length,
      missing: drift.missing.length,
      staleTitles: drift.staleTitles.length,
      staleBodies: drift.staleBodies.length,
    },
    "搜索索引检测到少量漂移，未达到自动修复阈值（ARCH-01）",
  );

  return { drift, autoFixed: false };
}
