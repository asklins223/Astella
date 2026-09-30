import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * 搜索投影表（V0.3 引入）。
 * 使用 pg_trgm 扩展 + ILIKE 进行中文友好的全文搜索。
 * 同步写入：Note/Card/Source/Evidence 创建或更新时同步 upsert。
 */
export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    objectType: text("object_type").notNull(), // note | source | objective
    objectId: uuid("object_id").notNull(),
    title: text("title"),
    body: text("body"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceTypeIdx: index("search_documents_workspace_type_idx").on(t.workspaceId, t.objectType),
    objectIdx: uniqueIndex("search_documents_object_idx").on(t.workspaceId, t.objectType, t.objectId),

    // 2026-09-29（P0-8）：排序键索引。search() 的 ORDER BY 是
    // (indexed_at DESC, object_type || ':' || object_id ASC)，此前**没有任何索引
    // 支撑**——trigram GIN 只回答"哪些行命中"，定位完之后仍要对全部命中行做
    // DISTINCT ON + 再排序，而 LIMIT 不约束排序量。列顺序的理由见迁移 0328 注释。
    // 末段是与 `dedup_key`（object_type || ':' || object_id）逐字相同的表达式索引。
    // 实测它**没有**消掉排序节点（规划器选 bitmap+sort；强制 Index Scan 也仍有
    // Sort）——真正的瓶颈是 DISTINCT ON + 外层二次排序的结构，不是索引缺失。
    // 详见迁移 0328 的诚实说明，别把它当成搜索性能已解决。
    sortIdx: index("search_documents_workspace_sortkey_idx")
      .on(t.workspaceId, t.indexedAt.desc(), sql`(${t.objectType} || ':' || ${t.objectId})`),
    bodyTrgmIdx: index("search_documents_body_trgm_idx").using("gin", sql`${t.body} gin_trgm_ops`),
    titleTrgmIdx: index("search_documents_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
  }),
);
