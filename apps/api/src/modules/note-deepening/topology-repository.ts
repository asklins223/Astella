/**
 * Star map topology repository (Plan 57 hard cutover, 2026-10-19).
 *
 * The graph is now built from three authoritative tables only:
 * `sources`, `notes`, and the learning-card questions of active cards.
 * The old objective / evidence / run / review assembly is gone — no second
 * read path, no filtering of retired nodes, nothing left to drift.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { noteBlocks, notes, sources } from "@astella/shared/db-schema/note";
import {
  noteLearningCardAttempts,
  noteLearningCardQuestions,
  noteLearningCards,
} from "@astella/shared/db-schema/note-learning-cards";
import { visibleNotesCondition } from "../note/visibility.ts";
import {
  buildNoteReferenceEdgesV3,
  noteLinkBlockContentConditionV3,
} from "./note-link-edges.ts";
import type {
  UnderstandingNodeProjectionV3,
  UnderstandingEdgeProjectionV3,
  NoteDeepeningSnapshotV1,
} from "@astella/shared";

export interface TopologyContext {
  workspaceId: string;
  userId: string;
}

/**
 * ── 拓扑快照单集合上限护栏 ────────────────────────────────────────────────
 *
 * 每个集合共用一个上限；多取一行用于**探测**截断，一旦超限就把
 * `integrity.truncated` 置 true 并如实回报。带 LIMIT 的查询一律加稳定
 * ORDER BY，否则截断点上的行集合会在请求间抖动，而 topologyRevision 是内容
 * 哈希、被 ETag/If-None-Match 消费——行集合抖动会让 304 永远不命中。
 */
export const TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT = 5000;
export const TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT = 50_000;

export function resolveTopologySnapshotCollectionLimit(
  raw: string | undefined = process.env.TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT,
): number {
  const parsed = Number(raw ?? TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT;
  }
  return Math.min(parsed, TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT);
}

interface TopologyTruncationReport {
  truncated: boolean;
  collections: string[];
}

function createTopologyTruncationReport(): TopologyTruncationReport {
  return { truncated: false, collections: [] };
}

function recordTruncation(report: TopologyTruncationReport, collection: string): void {
  report.truncated = true;
  if (!report.collections.includes(collection)) report.collections.push(collection);
}

function boundedCollection<TRow>(
  rows: TRow[],
  collection: string,
  limit: number,
  report: TopologyTruncationReport,
): TRow[] {
  if (rows.length <= limit) return rows;
  recordTruncation(report, collection);
  return rows.slice(0, limit);
}

function boundedIdList(
  ids: string[],
  collection: string,
  limit: number,
  report: TopologyTruncationReport,
): string[] {
  if (ids.length <= limit) return ids;
  recordTruncation(report, collection);
  return [...ids].sort().slice(0, limit);
}

export async function buildTopologySnapshotV3(
  tx: ApiTransaction,
  ctx: TopologyContext,
): Promise<NoteDeepeningSnapshotV1> {
  const nodes: UnderstandingNodeProjectionV3[] = [];
  const edges: UnderstandingEdgeProjectionV3[] = [];
  const collectionLimit = resolveTopologySnapshotCollectionLimit();
  const probeLimit = collectionLimit + 1;
  const truncation = createTopologyTruncationReport();

  // ── Source / Note 节点 ────────────────────────────────────────────────
  const noteRows = boundedCollection(
    await tx
      .select({ id: notes.id, title: notes.title, currentVersionId: notes.currentVersionId, sourceId: notes.sourceId })
      .from(notes)
      .where(and(eq(notes.workspaceId, ctx.workspaceId), visibleNotesCondition(ctx.userId), isNull(notes.deletedAt)))
      .orderBy(notes.id)
      .limit(probeLimit),
    "notes",
    collectionLimit,
    truncation,
  );
  for (const note of noteRows) {
    nodes.push({
      nodeRef: { kind: "note", noteId: note.id },
      label: note.title,
      currentVersionId: note.currentVersionId,
      hasSource: note.sourceId !== null,
    });
  }
  const sourceRows = boundedCollection(
    await tx
      .select({ id: sources.id, title: sources.title, type: sources.type, createdAt: sources.createdAt })
      .from(sources)
      .where(eq(sources.workspaceId, ctx.workspaceId))
      .orderBy(sources.id)
      .limit(probeLimit),
    "sources",
    collectionLimit,
    truncation,
  );
  for (const source of sourceRows) {
    nodes.push({
      nodeRef: { kind: "source", sourceId: source.id },
      label: source.title,
      modality: source.type,
      createdAt: source.createdAt.toISOString(),
    });
  }

  // ── 学习卡题目节点 ────────────────────────────────────────────────────
  // One node per question of an active card on a note this viewer can read.
  // Only the public face is projected; answers/rubrics never enter the graph.
  const activeCardRows = boundedCollection(
    await tx
      .select({ cardId: noteLearningCards.id, noteId: noteLearningCards.noteId })
      .from(noteLearningCards)
      .innerJoin(notes, and(
        eq(notes.id, noteLearningCards.noteId),
        eq(notes.workspaceId, noteLearningCards.workspaceId),
        isNull(notes.deletedAt),
        visibleNotesCondition(ctx.userId),
      ))
      .where(and(
        eq(noteLearningCards.workspaceId, ctx.workspaceId),
        eq(noteLearningCards.status, "active"),
      ))
      .orderBy(noteLearningCards.id)
      .limit(probeLimit),
    "learning_cards",
    collectionLimit,
    truncation,
  );
  if (activeCardRows.length > 0) {
    const cardIds = activeCardRows.map((card) => card.cardId);
    const questionRows = boundedCollection(
      await tx
        .select({
          questionId: noteLearningCardQuestions.id,
          cardId: noteLearningCardQuestions.cardId,
          ordinal: noteLearningCardQuestions.ordinal,
          questionType: noteLearningCardQuestions.questionType,
          stem: noteLearningCardQuestions.stem,
        })
        .from(noteLearningCardQuestions)
        .where(inArray(noteLearningCardQuestions.cardId, cardIds))
        .orderBy(noteLearningCardQuestions.cardId, noteLearningCardQuestions.ordinal)
        .limit(probeLimit),
      "learning_card_questions",
      collectionLimit,
      truncation,
    );
    const attemptAggRows = questionRows.length > 0
      ? await tx
          .select({
            cardId: noteLearningCardAttempts.cardId,
            bestScore: sql<number | null>`max(${noteLearningCardAttempts.score})`,
            bestStars: sql<number | null>`max(${noteLearningCardAttempts.stars})`,
            attemptCount: sql<number>`count(*)::int`,
            lastAttemptAt: sql<Date | string | null>`max(${noteLearningCardAttempts.completedAt})`,
          })
          .from(noteLearningCardAttempts)
          .where(and(
            inArray(noteLearningCardAttempts.cardId, cardIds),
            eq(noteLearningCardAttempts.userId, ctx.userId),
            eq(noteLearningCardAttempts.status, "completed"),
          ))
          .groupBy(noteLearningCardAttempts.cardId)
      : [];
    const aggByCard = new Map(attemptAggRows.map((row) => [row.cardId, row]));
    const noteByCard = new Map(activeCardRows.map((card) => [card.cardId, card.noteId]));
    for (const question of questionRows) {
      const noteId = noteByCard.get(question.cardId);
      if (!noteId) continue;
      const agg = aggByCard.get(question.cardId);
      nodes.push({
        nodeRef: { kind: "card_question", cardId: question.cardId, questionId: question.questionId, noteId },
        label: question.stem,
        questionType: question.questionType,
        ordinal: question.ordinal,
        // Attempt-level stars are the whole-paper result of the card this
        // question belongs to; the card is one paper, so every question shares
        // the same best attempt. Per-question scoring stays in the panel.
        bestStars: agg?.bestStars ?? null,
        bestScore: agg?.bestScore ?? null,
        attemptCount: agg?.attemptCount ?? 0,
        lastAttemptAt: agg?.lastAttemptAt ? new Date(agg.lastAttemptAt).toISOString() : null,
      });
      edges.push({
        edgeId: `note-question-${question.questionId}`,
        kind: "contains_question",
        from: { kind: "note", id: noteId },
        to: { kind: "card_question", id: question.questionId },
        reasonCodes: ["note_learning_card"],
      });
    }
  }

  // ── Source → Note contains_note 边 ─────────────────────────────────────
  for (const note of noteRows) {
    if (note.sourceId) {
      edges.push({
        edgeId: "contains_note-" + note.sourceId + "-" + note.id.slice(0, 8),
        kind: "contains_note",
        from: { kind: "source", id: note.sourceId },
        to: { kind: "note", id: note.id },
        reasonCodes: ["source_note"],
      });
    }
  }

  // ── 正文引用：note → note 的 `references` 边 ──────────────────────────
  const versionIdToNoteId = new Map(
    noteRows
      .filter((note) => note.currentVersionId !== null)
      .map((note) => [note.currentVersionId as string, note.id]),
  );
  const linkVersionIds = boundedIdList(
    [...versionIdToNoteId.keys()],
    "note_link_versions",
    collectionLimit,
    truncation,
  );
  if (linkVersionIds.length > 0) {
    const linkBlocks = boundedCollection(
      await tx
        .select({
          versionId: noteBlocks.versionId,
          type: noteBlocks.type,
          content: noteBlocks.content,
        })
        .from(noteBlocks)
        .where(and(
          eq(noteBlocks.workspaceId, ctx.workspaceId),
          inArray(noteBlocks.versionId, linkVersionIds),
          noteLinkBlockContentConditionV3(noteBlocks.content),
        ))
        .orderBy(noteBlocks.versionId, noteBlocks.ordinal, noteBlocks.id)
        .limit(probeLimit),
      "note_link_blocks",
      collectionLimit,
      truncation,
    );
    edges.push(...buildNoteReferenceEdgesV3({
      blocks: linkBlocks.map((block) => ({
        noteId: versionIdToNoteId.get(block.versionId)!,
        blockType: block.type,
        content: block.content,
      })),
      notes: noteRows.map((note) => ({ id: note.id, title: note.title })),
    }));
  }

  const revisionHash = computeTopologyRevisionV3(nodes, edges);
  if (truncation.truncated) {
    logger.warn(
      {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        collectionLimit,
        truncatedCollections: truncation.collections,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
      "topology snapshot truncated by collection cap",
    );
  }
  return {
    version: 3,
    workspaceId: ctx.workspaceId,
    topologyRevision: "v3-" + revisionHash,
    checkpointToken: "ckpt-v3-" + revisionHash,
    nodes,
    edges,
    continuationToken: null,
    integrity: { truncated: truncation.truncated },
  };
}

function computeTopologyRevisionV3(
  nodes: readonly UnderstandingNodeProjectionV3[],
  edges: readonly UnderstandingEdgeProjectionV3[],
): string {
  const lines = [
    ...nodes.map(topologyNodeIdentity),
    ...edges.map(topologyEdgeIdentity),
  ].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 24);
}

function topologyNodeIdentity(node: UnderstandingNodeProjectionV3): string {
  const ref = node.nodeRef;
  const sourceLink = "hasSource" in node ? String(node.hasSource) : "";
  const stars = "bestStars" in node ? String(node.bestStars ?? "none") : "";
  const id =
    ref.kind === "source" ? ref.sourceId
      : ref.kind === "note" ? ref.noteId
        : ref.questionId;
  return `${ref.kind}|${id}|${sourceLink}|${stars}`;
}

function topologyEdgeIdentity(edge: UnderstandingEdgeProjectionV3): string {
  return `${edge.from.kind}:${edge.from.id}|${edge.kind}|${edge.to.kind}:${edge.to.id}`;
}

// ─── 快照 TTL 缓存 ──────────────────────────────────────────────────────────

const TOPOLOGY_SNAPSHOT_CACHE_MAX_ENTRIES = 64;

type CachedTopologySnapshot = {
  snapshot: NoteDeepeningSnapshotV1;
  expiresAt: number;
};

const topologySnapshotCache = new Map<string, CachedTopologySnapshot>();

export function resolveTopologySnapshotCacheTtlMs(
  raw: string | undefined = process.env.TOPOLOGY_SNAPSHOT_CACHE_MS,
): number {
  if (raw === undefined || raw.trim() === "") return 10_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 10_000;
}

export function resetTopologySnapshotCacheForTests(): void {
  topologySnapshotCache.clear();
}

export function readTopologySnapshotCache(
  ctx: TopologyContext,
): NoteDeepeningSnapshotV1 | null {
  if (resolveTopologySnapshotCacheTtlMs() <= 0) return null;
  const cacheKey = `${ctx.workspaceId}:${ctx.userId}`;
  const hit = topologySnapshotCache.get(cacheKey);
  if (!hit) return null;
  if (hit.expiresAt > Date.now()) return hit.snapshot;
  topologySnapshotCache.delete(cacheKey);
  return null;
}

export function writeTopologySnapshotCache(
  ctx: TopologyContext,
  snapshot: NoteDeepeningSnapshotV1,
): void {
  const ttlMs = resolveTopologySnapshotCacheTtlMs();
  if (ttlMs <= 0) return;
  const cacheKey = `${ctx.workspaceId}:${ctx.userId}`;
  if (topologySnapshotCache.size >= TOPOLOGY_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldestKey = topologySnapshotCache.keys().next().value;
    if (oldestKey !== undefined) topologySnapshotCache.delete(oldestKey);
  }
  topologySnapshotCache.set(cacheKey, { snapshot, expiresAt: Date.now() + ttlMs });
}

export async function buildTopologySnapshotV3Cached(
  tx: ApiTransaction,
  ctx: TopologyContext,
): Promise<NoteDeepeningSnapshotV1> {
  const cached = readTopologySnapshotCache(ctx);
  if (cached) return cached;
  const snapshot = await buildTopologySnapshotV3(tx, ctx);
  writeTopologySnapshotCache(ctx, snapshot);
  return snapshot;
}
