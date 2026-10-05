/**
 * 40 §7 发现簿的服务层。
 *
 * ## 三条这里的实现要保住的不变量
 *
 *  1. **共用身份**：同一份内容（kind + source + sourceId）在笔记旁与发现簿里
 *     只有一行。所以重复收藏是**幂等**的（不报错、不再插一行），批注与可见性
 *     的改动在两处同步——因为它们本来就是同一行。
 *
 *  2. **取消收藏不删原始内容**：取消走 `visible=false`。这里**没有**任何一处
 *     删 `source` 那一侧的东西，也没有 DELETE 掉本表。误写成级联的后果是
 *     一次点击永久毁掉一篇日记，而界面上看不出任何异常。
 *
 *  3. **私人内容默认不跨空间、跨成员**：写入时不带 visibility 就是 private；
 *     而 `space` / `study` 都要显式传，且 `study` 受数量上限约束。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  COMPANION_DISCOVERY_SOURCES,
  STUDY_TRACE_LIMIT,
  companionDiscoveryEntryV1Schema,
  evaluateDiscoveryEntry,
  onSourceLost,
  type CompanionDiscoveryEntryV1,
  type CompanionDiscoveryKind,
  type CompanionDiscoverySource,
  type CompanionDiscoveryVisibility,
} from "@ailearn/shared/companion-discovery-contracts";
import { companionDiscoveryEntries } from "@ailearn/shared/db-schema/companion-memory";
import type { ApiTransaction } from "../../../db/client.ts";

export interface DiscoveryScope {
  workspaceId: string;
  userId: string;
}

/** 一次收藏请求。visibility 缺省即 private（§7）。 */
export interface CollectInput {
  kind: CompanionDiscoveryKind;
  source: CompanionDiscoverySource;
  sourceId: string;
  author: "user" | "assistant";
  body: string;
  annotation?: string | null;
  visibility?: CompanionDiscoveryVisibility;
}

export type CollectOutcome =
  | { status: "collected"; entry: CompanionDiscoveryEntryV1 }
  /** 已经收藏过：按**同一份**正文更新，不新增行。 */
  | { status: "already_collected"; entry: CompanionDiscoveryEntryV1 }
  | { status: "rejected"; reason: string };

/**
 * ⚠️ 裸 SQL 回来的行是**列名原样**（`created_at` / `source_id`），
 * 不是 drizzle 的 camelCase 形状。
 *
 * 这里曾经按 `$inferSelect` 读 `row.createdAt` —— 那是**类型上的谎**：`row`
 * 来自 `tx.execute(sql\`...\`)`，运行时根本没有那个键，于是收藏在真库上稳定 500
 * （`Cannot read properties of undefined (reading 'toISOString')`）。
 *
 * 静态测试抓不到，是因为那批用例用的是**只记录 SQL 文本的假 tx**，
 * 从来没有真的产出过一行。所以这条类型不再假装自己是 drizzle 的行。
 */
/**
 * 两种来源、两种形状：
 *  - 裸 `tx.execute(sql\`… RETURNING *\`)` → **列名原样**（`created_at`）
 *  - drizzle 的 `.returning()`            → camelCase（`createdAt`）
 *
 * 所以这里两种都读。写死其中一种时，那一半的调用方会安静地读到 undefined。
 */
type DiscoveryRow = {
  id: string; kind: string; source: string; author: string; body: string;
  annotation: string | null; visibility: string; masked: boolean;
  source_id?: string; created_at?: Date | string; updated_at?: Date | string;
  sourceId?: string; createdAt?: Date | string; updatedAt?: Date | string;
};

/** 日期容两种形态：pg 给 Date，某些驱动给字符串。 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toContract(row: DiscoveryRow): CompanionDiscoveryEntryV1 {
  return companionDiscoveryEntryV1Schema.parse({
    entryId: row.id,
    kind: row.kind,
    source: row.source,
    sourceId: row.source_id ?? row.sourceId ?? "",
    author: row.author,
    body: row.body,
    annotation: row.annotation,
    // 被遮蔽的行不进簿子：它的来源已经不可访问了，留着只会显示一段
    // 用户点不回去的引文（§7「能回到原内容」）。
    visibility: row.masked ? "private" : row.visibility,
    createdAt: toIso(row.created_at ?? row.createdAt ?? new Date(0)),
    updatedAt: toIso(row.updated_at ?? row.updatedAt ?? new Date(0)),
  });
}

/** 簿子页里当前有几条书房可见（用于上限判定）。 */
async function studyVisibleCount(executor: ApiTransaction, scope: DiscoveryScope): Promise<number> {
  const rows = await executor.execute<{ n: string }>(sql`
    SELECT count(*)::int AS n FROM companion_discovery_entries
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND visibility = 'study' AND visible AND NOT masked
  `);
  return Number((Array.isArray(rows) ? rows : [])[0]?.n ?? 0);
}

/**
 * 收藏一条。
 *
 * 幂等：同一份内容第二次收藏走 UPDATE 而不是再插一行——那一行是**笔记旁与
 * 发现簿共用的**，多插一行会让"取消收藏同步"变成只取消其中一条。
 */
export async function collectEntry(
  executor: ApiTransaction,
  scope: DiscoveryScope,
  input: CollectInput,
): Promise<CollectOutcome> {
  const kind = input.kind;
  const source = input.source;
  if (!COMPANION_DISCOVERY_SOURCES.includes(source)) {
    return { status: "rejected", reason: `unknown_source:${source}` };
  }
  const existing = await executor.execute<{ id: string }>(sql`
    SELECT id FROM companion_discovery_entries
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND kind = ${kind} AND source = ${source} AND source_id = ${input.sourceId}
    LIMIT 1
  `);
  const existingId = (Array.isArray(existing) ? existing : [])[0]?.id;

  // 上限只在**要新露出来**时判：已经可见的那条再收藏一次不该被自己的上限挡住。
  const wantsStudy = (input.visibility ?? "private") === "study" && !existingId;
  const gate = evaluateDiscoveryEntry({
    kind,
    author: input.author,
    source,
    ownerId: scope.userId,
    actorId: scope.userId,
    studyVisibleCount: await studyVisibleCount(executor, scope),
    wantStudyVisible: wantsStudy,
  });
  if (!gate.allow) return { status: "rejected", reason: gate.reason };

  // A stale diary page must not bring deleted/revoked excerpts back by
  // collecting again. Paragraph identity also binds the published revision.
  if (source === "diary") {
    const target = /^(\d{4}-\d{2}-\d{2})(?::v([1-9]\d*):b\d+:p\d+)?$/.exec(input.sourceId);
    const date = target ? new Date(`${target[1]}T00:00:00Z`) : null;
    if (!target || !date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== target[1]) return { status: "rejected", reason: "source_unavailable" };
    const diaries = await executor.execute<{ revision: number }>(sql`
      SELECT revision FROM companion_daily_summaries
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND date = ${target[1]} AND status = 'generated' AND deleted_at IS NULL
      LIMIT 1
    `);
    const diary = (Array.isArray(diaries) ? diaries : [])[0];
    if (!diary || target[2] && diary.revision !== Number(target[2])) return { status: "rejected", reason: "source_unavailable" };
  }

  const rows = existingId
    ? await executor.execute(sql`
        UPDATE companion_discovery_entries
        SET visible = true, masked = false,
            body = ${input.body},
            annotation = CASE WHEN ${input.annotation !== undefined} THEN ${input.annotation ?? null} ELSE annotation END,
            visibility = CASE WHEN ${input.visibility !== undefined} THEN ${input.visibility ?? "private"} ELSE visibility END,
            updated_at = now()
        WHERE id = ${existingId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        RETURNING *
      `)
    : await executor.execute(sql`
        INSERT INTO companion_discovery_entries
          (workspace_id, user_id, kind, source, source_id, author, body, annotation, visibility)
        VALUES (${scope.workspaceId}, ${scope.userId}, ${kind}, ${source}, ${input.sourceId},
                ${input.author}, ${input.body}, ${input.annotation ?? null}, ${input.visibility ?? "private"})
        RETURNING *
      `);

  const row = (Array.isArray(rows) ? rows : [])[0] as DiscoveryRow | undefined;
  if (!row) return { status: "rejected", reason: "write_conflict" };
  return { status: existingId ? "already_collected" : "collected", entry: toContract(row) };
}

/**
 * 取消收藏。
 *
 * 只置 `visible=false`，**不动 `source` 那一侧，也不动本表的行**。函数名里没有
 * "delete"就是给下一个人看的：这里没有级联，删不得。
 */
export async function uncollectEntry(
  executor: ApiTransaction,
  scope: DiscoveryScope,
  input: { kind: CompanionDiscoveryKind; source: CompanionDiscoverySource; sourceId: string },
): Promise<{ status: "uncollected" | "not_collected" }> {
  const rows = await executor.execute<{ id: string }>(sql`
    UPDATE companion_discovery_entries
    SET visible = false, updated_at = now()
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND kind = ${input.kind} AND source = ${input.source} AND source_id = ${input.sourceId}
    RETURNING id
  `);
  return { status: (Array.isArray(rows) ? rows : []).length > 0 ? "uncollected" : "not_collected" };
}

/** 改批注。与正文分两处写：编辑批注不改写原文（§7）。 */
export async function annotateEntry(
  executor: ApiTransaction,
  scope: DiscoveryScope,
  input: { entryId: string; annotation: string | null },
): Promise<{ status: "annotated" | "not_found" }> {
  const rows = await executor.execute<{ id: string }>(sql`
    UPDATE companion_discovery_entries
    SET annotation = ${input.annotation}, updated_at = now()
    WHERE id = ${input.entryId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    RETURNING id
  `);
  return { status: (Array.isArray(rows) ? rows : []).length > 0 ? "annotated" : "not_found" };
}

/** 簿子页。没有收藏就是一个空数组——§7「没有收藏时保持清爽，不生成假内容」。 */
export async function listEntries(
  executor: ApiTransaction,
  scope: DiscoveryScope,
): Promise<{ entries: CompanionDiscoveryEntryV1[]; studyVisible: CompanionDiscoveryEntryV1[] }> {
  const rows = await executor.execute(sql`
    SELECT * FROM companion_discovery_entries
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND visible AND NOT masked
    ORDER BY created_at DESC
  `);
  const entries = (Array.isArray(rows) ? rows : []).map((row) => toContract(row as DiscoveryRow));
  return {
    entries,
    // 书房只露少量（§7），且这里再钳一次：即使数据库触发器被绕过，
    // 上层也拿不到第七条。
    studyVisible: entries.filter((e) => e.visibility === "study").slice(0, STUDY_TRACE_LIMIT),
  };
}

/** 某一份内容在簿子里的状态（笔记旁那一侧用它显示"已收藏"）。 */
export async function collectionState(
  executor: ApiTransaction,
  scope: DiscoveryScope,
  input: { kind: CompanionDiscoveryKind; source: CompanionDiscoverySource; sourceId: string },
): Promise<{ collected: boolean; entryId: string | null; annotation: string | null }> {
  const rows = await executor.execute<{ id: string; annotation: string | null; visible: boolean; masked: boolean }>(sql`
    SELECT id, annotation, visible, masked FROM companion_discovery_entries
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND kind = ${input.kind} AND source = ${input.source} AND source_id = ${input.sourceId}
    LIMIT 1
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  if (!row) return { collected: false, entryId: null, annotation: null };
  return {
    collected: row.visible && !row.masked,
    entryId: row.id,
    annotation: row.annotation,
  };
}

/**
 * 来源被撤权或删除之后，把指向它的收藏**遮蔽**。
 *
 * 遮蔽而不是删行（§7「撤权或删除后缩略图、引文和预览同样处理」）：
 * 删掉就看不出"这里曾经有过"，而簿子会因此少一条用户记得的东西。
 */
export async function maskEntriesForSource(
  executor: ApiTransaction,
  scope: DiscoveryScope,
  input: { source: CompanionDiscoverySource; sourceId: string },
): Promise<{ masked: number; action: "mask_entry" }> {
  const rows = await executor.execute<{ id: string }>(sql`
    UPDATE companion_discovery_entries
    SET masked = true, updated_at = now()
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND source = ${input.source} AND source_id = ${input.sourceId} AND NOT masked
    RETURNING id
  `);
  return { masked: (Array.isArray(rows) ? rows : []).length, action: onSourceLost() };
}

/**
 * 来源恢复访问 ⇒ 把 `maskEntriesForSource` 遮蔽的行放回来。
 *
 * 遮蔽与恢复**必须成对**。只遮不恢复的后果很具体：用户删掉一条记忆又撤回，
 * 发现簿里那条就永远不再显示——而他明明已经把它找回来了。
 */
export async function unmaskEntriesForSource(
  executor: ApiTransaction,
  scope: DiscoveryScope,
  input: { source: CompanionDiscoverySource; sourceId: string },
): Promise<{ unmasked: number }> {
  const rows = await executor.execute<{ id: string }>(sql`
    UPDATE companion_discovery_entries
    SET masked = false, updated_at = now()
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND source = ${input.source} AND source_id = ${input.sourceId} AND masked
    RETURNING id
  `);
  return { unmasked: (Array.isArray(rows) ? rows : []).length };
}

/** 让 drizzle 认得这张表（构建期引用，避免被 tree-shake 掉）。 */
export const discoveryTable = companionDiscoveryEntries;
export const discoveryScopeWhere = (scope: DiscoveryScope, source: string) =>
  and(eq(companionDiscoveryEntries.workspaceId, scope.workspaceId), sql`${source}`);
export { desc };
