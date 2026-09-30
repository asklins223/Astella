import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { type ApiTransaction } from "../../db/client.ts";
import { noteVersions } from "@ailearn/shared/db-schema/note";
import { noteOverviews } from "@ailearn/shared/db-schema/note-overviews";
import { noteRecallRecords } from "@ailearn/shared/db-schema/note-recalls";
import { noteAnnotations } from "@ailearn/shared/db-schema/note-annotations";
import { noteLearningArtifacts } from "@ailearn/shared/db-schema/note-learning-artifacts";
import { noteExpansions } from "@ailearn/shared/db-schema/note-expansions";
import {
  noteShelfStageV1,
  type NoteShelfLearningFactsV1,
  type NoteShelfStateV1,
} from "@ailearn/shared/note-shelf-state-contracts";

const NO_FACTS: NoteShelfLearningFactsV1 = {
  overviewCount: 0,
  overviewVersionNumber: null,
  recallCount: 0,
  lastRecallSelfReport: null,
  annotationCount: 0,
  artifactCount: 0,
  expansionCount: 0,
  latestVersionNumber: null,
  latestAt: null,
};

type ShelfNote = { id: string; currentVersionId: string | null; hasBody: boolean };

/** 一次聚合的统一形状：每篇笔记被数了几次、最近什么时候、痕迹停在第几版。 */
type Aggregate = {
  noteId: string;
  count: number;
  latestAt: Date | string | null;
  latestVersionNo: number | null;
};

/**
 * 时间戳归一化。
 *
 * `max(created_at)` 的返回值**不保证是 Date**：聚合表达式丢掉了列的类型 OID，
 * postgres.js 拿不到 OID 时按字符串回传。实测 `row.latestAt.toISOString()` 在真实的
 * `note_recall_records` 上抛 `value.toISOString is not a function`（note-shelf-state
 * 集成档的回想那条用例就是这么红的）。所以两种形状都收。
 */
const iso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

/**
 * 笔记架上每一行的「了解状态」纸签。
 *
 ## 为什么这一段存在
 *
 41 §5 之后有一件事必须说清楚：**看过、想过、问过、从它长出过新笔记，是四件不同的
 事**。而列表此前一个学习事实都不带——用户只能靠标题猜哪篇读过。那不是"没有状态"，
 是"状态没被读出来"。
 *
 ## 三条边界
 *
 1. **本人痕迹按 userId 取，关系按 workspaceId 取。** 速看、回想、批注、互动讲解
    都是本人的学习痕迹；协作空间里别人不该看到我回想过哪篇，更不该看到我自述
    「没想起来」。`note_expansions` 是既成的双向关系，双方都看得见，所以按空间取，
    在内存里并到 source 与 expanded **两侧**——从别处长出来的笔记同样"长出过新笔记"。
 2. **只数落过库的。** 后台跑完但没打开的候选不在这些表里，自然不会冒充「学过」。
 3. **一次批量，五条聚合查询。** 列表是分页的；按行发请求会在 100 篇的页面上放大成
    500 次往返。这里按 noteIds 一次性取回。
 */
export async function noteShelfStatesByNoteId(
  executor: ApiTransaction,
  input: { workspaceId: string; userId: string; notes: readonly ShelfNote[] },
): Promise<Map<string, NoteShelfStateV1>> {
  const states = new Map<string, NoteShelfStateV1>();
  if (input.notes.length === 0) return states;
  const noteIds = input.notes.map((row) => row.id);
  const noteIdSet = new Set(noteIds);
  const scoped = { workspaceId: input.workspaceId, userId: input.userId };

  // 痕迹记在**不可变版本**上，所以要把 noteVersionId 翻回人话里的版本号。
  // 否则「这篇后来改过」没法说——用户只会看到几个记不住含义的 uuid。
  const currentVersionNo = new Map<string, number>();
  const currentVersionIds = input.notes
    .map((row) => row.currentVersionId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (currentVersionIds.length > 0) {
    const rows = await executor
      .select({ id: noteVersions.id, versionNo: noteVersions.versionNo })
      .from(noteVersions)
      .where(and(
        eq(noteVersions.workspaceId, scoped.workspaceId),
        inArray(noteVersions.id, currentVersionIds),
      ));
    for (const row of rows) currentVersionNo.set(row.id, row.versionNo);
  }

  const factsByNote = new Map<string, NoteShelfLearningFactsV1>();
  const slot = (noteId: string): NoteShelfLearningFactsV1 => {
    const existing = factsByNote.get(noteId);
    if (existing) return existing;
    const fresh = { ...NO_FACTS };
    factsByNote.set(noteId, fresh);
    return fresh;
  };

  /**
   * 把一条聚合并进 facts。
   *
   `latestVersionNumber` 取**最大**版本号而不是"最近一次"那一条的版本号：这里要回答的
   是「我学过的东西，最远覆盖到第几版」，取最大值才是那个答案的下界。改过版之后
   `currentVersion > latestVersionNumber` 才会如实成立。
   */
  const merge = (rows: readonly Aggregate[], apply: (entry: NoteShelfLearningFactsV1, row: Aggregate) => void): void => {
    for (const row of rows) {
      if (!noteIdSet.has(row.noteId)) continue;
      const entry = slot(row.noteId);
      apply(entry, row);
      const at = iso(row.latestAt);
      if (at && (!entry.latestAt || Date.parse(at) > Date.parse(entry.latestAt))) entry.latestAt = at;
      if (row.latestVersionNo !== null
        && (entry.latestVersionNumber === null || row.latestVersionNo > entry.latestVersionNumber)) {
        entry.latestVersionNumber = row.latestVersionNo;
      }
    }
  };

  const overviewRows = await executor
    .select({
      noteId: noteOverviews.noteId,
      count: sql<number>`count(*)::int`,
      latestAt: sql<Date | string | null>`max(${noteOverviews.createdAt})`,
      latestVersionNo: sql<number | null>`max(${noteVersions.versionNo})`,
    })
    .from(noteOverviews)
    .innerJoin(noteVersions, eq(noteVersions.id, noteOverviews.noteVersionId))
    .where(and(
      eq(noteOverviews.workspaceId, scoped.workspaceId),
      eq(noteOverviews.userId, scoped.userId),
      inArray(noteOverviews.noteId, noteIds),
    ))
    .groupBy(noteOverviews.noteId);
  merge(overviewRows, (entry, row) => {
    entry.overviewCount = row.count;
    entry.overviewVersionNumber = row.latestVersionNo;
  });

  const recallRows = await executor
    .select({
      noteId: noteRecallRecords.noteId,
      count: sql<number>`count(*)::int`,
      latestAt: sql<Date | string | null>`max(${noteRecallRecords.createdAt})`,
      latestVersionNo: sql<number | null>`max(${noteVersions.versionNo})`,
    })
    .from(noteRecallRecords)
    .innerJoin(noteVersions, eq(noteVersions.id, noteRecallRecords.noteVersionId))
    .where(and(
      eq(noteRecallRecords.workspaceId, scoped.workspaceId),
      eq(noteRecallRecords.userId, scoped.userId),
      inArray(noteRecallRecords.noteId, noteIds),
    ))
    .groupBy(noteRecallRecords.noteId);
  merge(recallRows, (entry, row) => { entry.recallCount = row.count; });

  // 自述可能为 null（只翻了原文、没自述）。这里取**最近一次说出口的**那一行，
 // 按 `reportedAt` 排——在有自述的行上它才是非空的。`distinctOn` 是一行一次，
  // 不在这里做第二次按篇聚合。
  const selfReportRows = await executor
    .selectDistinctOn([noteRecallRecords.noteId])
    .from(noteRecallRecords)
    .where(and(
      eq(noteRecallRecords.workspaceId, scoped.workspaceId),
      eq(noteRecallRecords.userId, scoped.userId),
      isNotNull(noteRecallRecords.selfReport),
      isNotNull(noteRecallRecords.reportedAt),
      inArray(noteRecallRecords.noteId, noteIds),
    ))
    .orderBy(desc(noteRecallRecords.noteId), desc(noteRecallRecords.reportedAt));
  for (const row of selfReportRows) {
    if (noteIdSet.has(row.noteId)) slot(row.noteId).lastRecallSelfReport = row.selfReport;
  }

  const annotationRows = await executor
    .select({
      noteId: noteAnnotations.noteId,
      count: sql<number>`count(*)::int`,
      latestAt: sql<Date | string | null>`max(${noteAnnotations.createdAt})`,
      latestVersionNo: sql<number | null>`max(${noteVersions.versionNo})`,
    })
    .from(noteAnnotations)
    .innerJoin(noteVersions, eq(noteVersions.id, noteAnnotations.noteVersionId))
    .where(and(
      eq(noteAnnotations.workspaceId, scoped.workspaceId),
      eq(noteAnnotations.userId, scoped.userId),
      inArray(noteAnnotations.noteId, noteIds),
    ))
    .groupBy(noteAnnotations.noteId);
  merge(annotationRows, (entry, row) => { entry.annotationCount = row.count; });

  const artifactRows = await executor
    .select({
      noteId: noteLearningArtifacts.noteId,
      count: sql<number>`count(*)::int`,
      latestAt: sql<Date | string | null>`max(${noteLearningArtifacts.createdAt})`,
      latestVersionNo: sql<number | null>`max(${noteVersions.versionNo})`,
    })
    .from(noteLearningArtifacts)
    .innerJoin(noteVersions, eq(noteVersions.id, noteLearningArtifacts.noteVersionId))
    .where(and(
      eq(noteLearningArtifacts.workspaceId, scoped.workspaceId),
      eq(noteLearningArtifacts.userId, scoped.userId),
      inArray(noteLearningArtifacts.noteId, noteIds),
    ))
    .groupBy(noteLearningArtifacts.noteId);
  merge(artifactRows, (entry, row) => { entry.artifactCount = row.count; });

  // `note_expansions` 记的是既成的双向关系（这篇长出了那篇）。两侧都要算，所以查询
  // 条件是 or——只按 source 查的话，"从别处长出来的这篇"永远拿不到"长出过新笔记"。
  // 未确认的草稿在 `note_expansion_tasks` 里，不在这里：草稿不是「学过」。
  const expansionRows = await executor
    .select({
      sourceNoteId: noteExpansions.sourceNoteId,
      expandedNoteId: noteExpansions.expandedNoteId,
      sourceVersionNo: sql<number | null>`max(${noteVersions.versionNo})`,
      latestAt: sql<Date | string | null>`max(${noteExpansions.createdAt})`,
    })
    .from(noteExpansions)
    .innerJoin(noteVersions, eq(noteVersions.id, noteExpansions.sourceNoteVersionId))
    .where(and(
      eq(noteExpansions.workspaceId, scoped.workspaceId),
      or(
        inArray(noteExpansions.sourceNoteId, noteIds),
        inArray(noteExpansions.expandedNoteId, noteIds),
      ),
    ))
    .groupBy(noteExpansions.sourceNoteId, noteExpansions.expandedNoteId);
  for (const row of expansionRows) {
    // 一条关系给两侧各记一次；版本号只记到 source 侧——expanded 侧那篇的版本是
    // 它自己的事，把它算进"痕迹停在哪"会得到一个跨篇的假版本比较。
    for (const side of [row.sourceNoteId, row.expandedNoteId] as const) {
      if (!noteIdSet.has(side)) continue;
      const entry = slot(side);
      entry.expansionCount += 1;
      const at = iso(row.latestAt);
      if (at && (!entry.latestAt || Date.parse(at) > Date.parse(entry.latestAt))) entry.latestAt = at;
    }
    if (noteIdSet.has(row.sourceNoteId) && row.sourceVersionNo !== null) {
      const entry = slot(row.sourceNoteId);
      if (entry.latestVersionNumber === null || row.sourceVersionNo > entry.latestVersionNumber) {
        entry.latestVersionNumber = row.sourceVersionNo;
      }
    }
  }

  for (const row of input.notes) {
    const facts = factsByNote.get(row.id) ?? { ...NO_FACTS };
    const now = row.currentVersionId ? currentVersionNo.get(row.currentVersionId) ?? null : null;
    states.set(row.id, {
      facts,
      stage: noteShelfStageV1({ hasBody: row.hasBody, facts }),
      // 痕迹停在比当前版本旧的某一版上，就说明这篇后来又改过。这不是说痕迹作废了，
      // 而是说「你看过的那一版」和「现在这一版」不是同一篇。
      editedAfterLearning: facts.latestVersionNumber !== null
        && now !== null
        && facts.latestVersionNumber < now,
    });
  }
  return states;
}
