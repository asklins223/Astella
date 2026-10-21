/**
 * Pure labels, narrowing helpers and keys shared by the understanding star map
 * and its detail drawer. Everything here is a projection of the server's
 * topology contract — no layout, no geometry, no invented records.
 */

import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@astella/shared/note-deepening-contracts";
export type GraphNodeKind = UnderstandingNodeProjectionV3["nodeRef"]["kind"];
/** The record's own id, whichever kind it is — the one field all four node
 *  refs share under a different name. */
function nodeRefId(node: UnderstandingNodeProjectionV3): string {
  const ref = node.nodeRef;
  return ref.kind === "source" ? ref.sourceId
    : ref.kind === "note" ? ref.noteId
      : ref.questionId;
}

export function graphNodeKey(node: UnderstandingNodeProjectionV3): string {
  return `${node.nodeRef.kind}:${nodeRefId(node)}`;
}

export function edgeEndpointKey(ref: UnderstandingEdgeProjectionV3["from"]): string {
  return `${ref.kind}:${ref.id}`;
}

/* --- labels -------------------------------------------------------------- */

const KIND_LABEL: Record<GraphNodeKind, string> = {
  source: "来源",
  note: "笔记",
  card_question: "学习卡题目",
};

export function graphNodeKindLabel(kind: GraphNodeKind): string {
  return KIND_LABEL[kind] ?? kind;
}

export const EDGE_KIND_LABEL = {
  contains_note: "收录笔记",
  contains_question: "配套题目",
  references: "正文引用",
} as const satisfies Record<UnderstandingEdgeProjectionV3["kind"], string>;

export function graphEdgeKindLabel(kind: UnderstandingEdgeProjectionV3["kind"]): string {
  return EDGE_KIND_LABEL[kind] ?? kind;
}

/** The 来源库 writes the same four words in `formatSourceKindLabel`; that
 *  helper lives in a React module this pure layout file must not import, so
 *  the graph keeps its own table for kinds, edges and source modality. */
const SOURCE_MODALITY_LABEL: Record<string, string> = {
  url: "网页",
  web: "网页",
  markdown: "Markdown",
  code: "代码",
  text: "文本",
};

export function graphSourceModalityLabel(modality: string): string {
  return SOURCE_MODALITY_LABEL[modality] ?? modality;
}

/* --- node narrowing ------------------------------------------------------- *
 * The contract is a plain `z.union`, not a discriminated one: the
 * discriminant (`kind`) sits inside `nodeRef`, so a `nodeRef.kind` check
 * narrows the ref but never the node, and every variant has to be recognised
 * by a property of its own. The node schemas are `strictObject`s, so
 * these keys are exact hit tests on exactly one kind:
 *
 *   source → modality · note → currentVersionId · card_question → bestStars
 */

export type SourceNodeV3 = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "source" } }>;
export type NoteNodeV3 = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "note" } }>;
export type CardQuestionNodeV3 = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "card_question" } }>;

export function isSourceNode(node: UnderstandingNodeProjectionV3): node is SourceNodeV3 {
  return "modality" in node;
}

export function isNoteNode(node: UnderstandingNodeProjectionV3): node is NoteNodeV3 {
  return "currentVersionId" in node;
}

export function isCardQuestionNode(node: UnderstandingNodeProjectionV3): node is CardQuestionNodeV3 {
  return "bestStars" in node;
}

/** One line the detail drawer shows under the label — a second fact, never a
 *  restatement of the heading the card already carries. The guards are
 *  mutually exclusive, so the order here is a readability choice, not a
 *  correctness one. */
export function graphNodeSummary(node: UnderstandingNodeProjectionV3): string {
  if ("bestStars" in node) return node.bestStars === null ? "还没有练过" : `最佳 ${node.bestStars} 星`;
  if (isSourceNode(node)) return `${graphSourceModalityLabel(node.modality)}来源`;
  // The server has no basis to compute a note's freshness (it records no
  // per-source content revision), so the note reports the one link it does
  // know: whether a source stands behind it.
  return node.hasSource ? "已关联来源" : "手写笔记";
}

/** The cosmos labels stay short; the detail drawer carries the full summary. */
export const GRAPH_CAPTION_MAX_LENGTH = 48;

export function graphNodeLabel(node: UnderstandingNodeProjectionV3): string {
  const trimmed = node.label.trim().replace(/\s+/g, " ");
  return trimmed.length > GRAPH_CAPTION_MAX_LENGTH
    ? trimmed.slice(0, GRAPH_CAPTION_MAX_LENGTH)
    : trimmed;
}
