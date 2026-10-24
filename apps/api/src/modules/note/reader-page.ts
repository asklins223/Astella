import { and, asc, desc, eq, gt, lt, isNull, sql } from "drizzle-orm";
import { notes, noteVersions, noteBlocks } from "@astella/shared/db-schema/note";
import type { ApiTransaction } from "../../db/client.ts";
import { visibleNotesCondition } from "./visibility.ts";
import { projectReaderBlock } from "./reader-projection.ts";

/** 阅读投影只读一个窗口；固定版本、原始段号用于选区/批注，不能重编号。 */
export async function readNotePage(tx: ApiTransaction, scope: { workspaceId: string; userId: string },
  noteId: string, query: { noteVersionId?: string; afterOrdinal?: number; beforeOrdinal?: number; limit: number }) {
  const note = await tx.query.notes.findFirst({ where: and(eq(notes.id, noteId),
    eq(notes.workspaceId, scope.workspaceId), isNull(notes.deletedAt), visibleNotesCondition(scope.userId)) });
  if (!note?.currentVersionId) return null;
  const version = await tx.query.noteVersions.findFirst({ where: and(
    eq(noteVersions.id, query.noteVersionId ?? note.currentVersionId), eq(noteVersions.noteId, noteId)) });
  if (!version) return null;
  const where = and(eq(noteBlocks.workspaceId, scope.workspaceId), eq(noteBlocks.versionId, version.id));
  const rows = await tx.select({ ordinal: noteBlocks.ordinal, type: noteBlocks.type, content: noteBlocks.content })
    .from(noteBlocks).where(and(where, query.afterOrdinal === undefined ? undefined : gt(noteBlocks.ordinal, query.afterOrdinal),
      query.beforeOrdinal === undefined ? undefined : lt(noteBlocks.ordinal, query.beforeOrdinal)))
    .orderBy(query.beforeOrdinal === undefined ? asc(noteBlocks.ordinal) : desc(noteBlocks.ordinal)).limit(query.limit + 1);
  const page = boundedReaderBlocks(rows, query.limit);
  if (query.beforeOrdinal !== undefined) page.blocks.reverse();
  // 仅第一页返回目录与总数。目录没有正文，只取标题，每条最多 200 字。
  const metadata = query.afterOrdinal === undefined && query.beforeOrdinal === undefined ? await tx.select({
    total: sql<number>`count(*)::int`,
    outline: sql<Array<{ ordinal: number; type: string; content: string }>>`coalesce(json_agg(json_build_object(
      'ordinal', ${noteBlocks.ordinal}, 'type', 'heading', 'content', left(${noteBlocks.content}, 200))
      order by ${noteBlocks.ordinal}) filter (where ${noteBlocks.type} = 'heading'), '[]'::json)`,
  }).from(noteBlocks).where(where) : [];
  return { noteId, title: note.title, currentVersion: { versionId: version.id,
    versionNo: version.versionNo, blocks: page.blocks.map(projectReaderBlock) }, reader: {
    nextOrdinal: page.hasMore || query.beforeOrdinal !== undefined ? page.blocks.at(-1)?.ordinal ?? null : null,
    hasEarlierBlocks: query.beforeOrdinal !== undefined ? page.hasMore : query.afterOrdinal !== undefined,
    ...(metadata[0] ? { totalBlockCount: metadata[0].total, outline: metadata[0].outline } : {}),
  } };
}

/** 不切断段落，否则已保存的文字锚点会失效；单独的大段允许独占一页。 */
export function boundedReaderBlocks<T extends { ordinal: number; content: string }>(rows: T[], limit: number, byteLimit = 48_000) {
  const blocks: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(row.content, "utf8");
    if (blocks.length >= limit || (blocks.length > 0 && bytes + size > byteLimit)) break;
    blocks.push(row); bytes += size;
  }
  return { blocks, hasMore: rows.length > blocks.length };
}
