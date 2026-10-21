/**
 * Star map topology contract (Plan 57, 2026-10-19).
 *
 * After the hard cutover the map shows exactly three things: sources, notes,
 * and the questions of each note's learning card. The old objective / evidence
 * nodes and their semantic edges are gone with the chain that produced them —
 * there is no compatibility alias, so a client that still asks for them gets a
 * parse failure instead of silently drawing retired data.
 */
import { z } from "zod";
import { noteLearningQuestionTypeV1Schema } from "./note-deepening-v3-contracts.ts";

export const understandingNodeKindV3Schema = z.enum([
  "source",
  "note",
  "card_question",
]);
export type UnderstandingNodeKindV3 = z.infer<
  typeof understandingNodeKindV3Schema
>;

export const understandingEdgeKindV3Schema = z.enum([
  "contains_note", // source → note（来源包含笔记）
  "contains_question", // note → card_question（笔记的学习卡题目）
  "references", // note → note（正文里写了库内链接，见 note-link-edges.ts）
]);
export type UnderstandingEdgeKindV3 = z.infer<
  typeof understandingEdgeKindV3Schema
>;

export const understandingNodeRefV3Schema = z.strictObject({
  kind: understandingNodeKindV3Schema,
  id: z.string().uuid(),
});
export type UnderstandingNodeRefV3 = z.infer<
  typeof understandingNodeRefV3Schema
>;

export const sourceNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("source"),
    sourceId: z.string().uuid(),
  }),
  label: z.string().min(1).max(500),
  modality: z.string().min(1).max(50),
  createdAt: z.string().datetime({ offset: true }),
});

export const noteNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("note"),
    noteId: z.string().uuid(),
  }),
  label: z.string().min(1).max(500),
  /** 尚未保存过正文的笔记没有版本；不能用 noteId 伪装成版本 id。 */
  currentVersionId: z.string().uuid().nullable(),
  /** 该笔记是否由某个来源收录而来（即 `notes.source_id` 非空）。 */
  hasSource: z.boolean(),
});

/**
 * A learning-card question is the map's smallest star. It carries only the
 * public face (stem, type, best stars) plus the note it belongs to;
 * answers/rubrics never enter the graph.
 */
export const cardQuestionNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("card_question"),
    cardId: z.string().uuid(),
    questionId: z.string().uuid(),
    noteId: z.string().uuid(),
  }),
  label: z.string().min(1).max(500),
  questionType: noteLearningQuestionTypeV1Schema,
  ordinal: z.number().int().min(0),
  bestStars: z.number().int().min(0).max(5).nullable(),
  bestScore: z.number().int().min(0).max(100).nullable(),
  attemptCount: z.number().int().min(0),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
});

export const understandingNodeProjectionV3Schema = z.union([
  sourceNodeProjectionV3Schema,
  noteNodeProjectionV3Schema,
  cardQuestionNodeProjectionV3Schema,
]);
export type UnderstandingNodeProjectionV3 = z.infer<
  typeof understandingNodeProjectionV3Schema
>;
export type SourceNodeProjectionV3 = z.infer<typeof sourceNodeProjectionV3Schema>;
export type NoteNodeProjectionV3 = z.infer<typeof noteNodeProjectionV3Schema>;
export type CardQuestionNodeProjectionV3 = z.infer<typeof cardQuestionNodeProjectionV3Schema>;

export const understandingEdgeProjectionV3Schema = z.strictObject({
  edgeId: z.string().min(1).max(200),
  kind: understandingEdgeKindV3Schema,
  from: understandingNodeRefV3Schema,
  to: understandingNodeRefV3Schema,
  reasonCodes: z.array(z.string().min(1)).max(10).default([]),
});
export type UnderstandingEdgeProjectionV3 = z.infer<
  typeof understandingEdgeProjectionV3Schema
>;

export const understandingTopologySnapshotV3Schema = z.strictObject({
  version: z.literal(3),
  workspaceId: z.string().uuid(),
  topologyRevision: z.string().min(1).max(200),
  checkpointToken: z.string().min(1).max(200),
  nodes: z.array(understandingNodeProjectionV3Schema),
  edges: z.array(understandingEdgeProjectionV3Schema),
  continuationToken: z.string().nullable(),
  integrity: z.strictObject({
    truncated: z.boolean(),
  }),
});
export type NoteDeepeningSnapshotV1 = z.infer<
  typeof understandingTopologySnapshotV3Schema
>;
