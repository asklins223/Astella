/**
 * Plan 23 W1-14..W1-15：Understanding Topology V3 公共合同。
 *
 * 依据 23 方案 §15：星图只展示 Source / Note / Objective / Evidence 四类节点，
 * **不包含 card / key_point 节点**（§15.1/§25.1/§25.6）。Shared topology 与
 * Personal overlay 分离：个人 mastery 只从 canonical learning event /
 * practice trail 读取，绝污染 shared topology（§15.2/§17.2）。
 *
 * 本文件不含 node: 依赖，可安全从 index 全量导出。
 */
import { z } from "zod";
import {
  objectivePersonalStateV3Schema,
  objectiveSurfaceFreshnessV3Schema,
  objectiveSurfaceLifecycleV3Schema,
  learningObjectivePrimaryActionV3Schema,
} from "./learning-objective-surface-contracts.ts";

// ─── W1-14/15: shared node kinds（无 card/key_point）──────────────────────

export const understandingNodeKindV3Schema = z.enum([
  "source",
  "note",
  "objective",
  "evidence",
]);
export type UnderstandingNodeKindV3 = z.infer<
  typeof understandingNodeKindV3Schema
>;

export const understandingEdgeKindV3Schema = z.enum([
  "sourced_from", // note/source → objective（血缘）
  "supported_by", // objective → evidence
  "relates_to", // objective ↔ objective 语义关系
  "supersedes", // old objective → new objective
  "contains_note", // source → note（来源包含笔记）
]);
export type UnderstandingEdgeKindV3 = z.infer<
  typeof understandingEdgeKindV3Schema
>;

/** 端点引用：只允许四类 shared node（无 card/key_point）。 */
export const understandingNodeRefV3Schema = z.strictObject({
  kind: understandingNodeKindV3Schema,
  id: z.string().uuid(),
});
export type UnderstandingNodeRefV3 = z.infer<
  typeof understandingNodeRefV3Schema
>;

// ─── node projections ───────────────────────────────────────────────────

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
  currentVersionId: z.string().uuid(),
  /**
   * 该笔记是否由某个来源收录而来（即 `notes.source_id` 非空）。
   *
   * 此处曾是 `freshness: "current" | "source_outdated" | "archived"`，但仓库
   * 从未计算过它：`topology-repository` 直接写死字面量 `"current"`。三个值里
   * `archived` 不可达（note 查询已过滤 `deleted_at IS NULL`），`source_outdated`
   * 也没有计算依据——数据模型没有「来源内容修订号」，只有 objective origin 才做
   * 「这条笔记出现新版本」的比较。恒为常量的字段在焦点卡上等于对用户说一句假话，
   * 因此收窄为服务端真正持有的事实。
   */
  hasSource: z.boolean(),
});

export const objectiveNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("objective"),
    objectiveId: z.string().uuid(),
  }),
  label: z.string().min(1).max(200),
  publicSummary: z.string().min(1).max(1500),
  activeCardId: z.string().uuid().nullable(),
  lifecycle: objectiveSurfaceLifecycleV3Schema,
  freshness: objectiveSurfaceFreshnessV3Schema,
  /** personal overlay：只从 canonical/practice 事件读取，不污染 shared topology。 */
  personal: z.strictObject({
    state: objectivePersonalStateV3Schema,
    activeRunId: z.string().uuid().nullable(),
    activeScheduleId: z.string().uuid().nullable(),
    nextReviewAt: z.string().datetime({ offset: true }).nullable(),
    practiceTrailCount: z.number().int().min(0),
    lastCanonicalEventId: z.string().nullable(),
    primaryAction: learningObjectivePrimaryActionV3Schema,
  }),
});

export const evidenceNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("evidence"),
    evidenceSnapshotId: z.string().uuid(),
  }),
  /** 只暴露 evidence metadata；权限/撤销状态不会泄露文本（§20.1）。 */
  supportSummary: z.string().min(1).max(2000),
  sourceLabel: z.string().min(1).max(300).nullable(),
  restricted: z.boolean(),
});

export const understandingNodeProjectionV3Schema = z.union([
  sourceNodeProjectionV3Schema,
  noteNodeProjectionV3Schema,
  objectiveNodeProjectionV3Schema,
  evidenceNodeProjectionV3Schema,
]);
export type UnderstandingNodeProjectionV3 = z.infer<
  typeof understandingNodeProjectionV3Schema
>;
export type SourceNodeProjectionV3 = z.infer<typeof sourceNodeProjectionV3Schema>;
export type NoteNodeProjectionV3 = z.infer<typeof noteNodeProjectionV3Schema>;
export type ObjectiveNodeProjectionV3 = z.infer<typeof objectiveNodeProjectionV3Schema>;
export type EvidenceNodeProjectionV3 = z.infer<typeof evidenceNodeProjectionV3Schema>;

// ─── edges ──────────────────────────────────────────────────────────────

/**
 * 边上**本人这一份**的表态投影（39d W8-2；39 §11.3、§16.20）。
 *
 * 三列都是**投影**，不是公共拓扑的一部分：公共 `edges` 与 `topologyRevision`
 * 不含它们（否则公共拓扑会被一个人的看法污染，而 §11.3 明写确认"首先只影响
 * 本人的学习视图"）。
 *
 * **为什么 `decidable` 是必填而另两列是可选**：
 *  - `decidable` 每一条边都有（血缘边与证据链接**不可**表态），界面据它决定给不给
 *    「确认／隐藏」两颗按钮——不给，就不存在"我能不能把这张纸藏起来"这个问题；
 *  - `relationStatus`／`countsAsEstablished` 只在**可表态**的那一类边上有。给不可表态的
 *    边也补上这两列，会让"待确认建议"这个词去套一条材料血缘边，而 §11.3 明写
 *    「材料血缘与教学关系使用不同表达」。
 */
export const understandingRelationEdgeStatusV3Schema = z.enum([
  "confirmed",
  "dismissed",
  "suggested",
]);
export type UnderstandingRelationEdgeStatusV3 = z.infer<typeof understandingRelationEdgeStatusV3Schema>;

export const understandingEdgeProjectionV3Schema = z.strictObject({
  edgeId: z.string().min(1).max(200),
  kind: understandingEdgeKindV3Schema,
  from: understandingNodeRefV3Schema,
  to: understandingNodeRefV3Schema,
  reasonCodes: z.array(z.string().min(1)).max(10).default([]),
  /** 这条边本人能不能表态（`relates_to` 那一族才能）。 */
  decidable: z.boolean().default(false),
  /** 仅 `decidable: true` 时有：这一档是**读侧补出来的**，库里只存两种表态。 */
  relationStatus: understandingRelationEdgeStatusV3Schema.optional(),
  /** 只有「已确认」才算成立的关系；待确认建议**不**进任何"正式掌握"的计算（§11.3）。 */
  countsAsEstablished: z.boolean().optional(),
});
export type UnderstandingEdgeProjectionV3 = z.infer<
  typeof understandingEdgeProjectionV3Schema
>;

// ─── W1-14: snapshot ────────────────────────────────────────────────────

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
    missingOriginObjectiveIds: z.array(z.string().uuid()),
  }),
});
export type UnderstandingTopologySnapshotV3 = z.infer<
  typeof understandingTopologySnapshotV3Schema
>;

// ─── 合同守卫：拒收 card/key_point 节点（§15.1/§25.1）──────────────────────

export function assertNoCardOrKeyPointNode(
  nodes: readonly unknown[],
): { violations: Array<{ index: number; kind: string }> } {
  const violations: Array<{ index: number; kind: string }> = [];
  nodes.forEach((node, index) => {
    if (typeof node !== "object" || node === null) return;
    const ref = (node as { nodeRef?: { kind?: unknown } }).nodeRef;
    const kind =
      ref && typeof ref === "object" && "kind" in ref
        ? String(ref.kind)
        : String((node as { kind?: unknown }).kind ?? "");
    if (kind === "card" || kind === "key_point") {
      violations.push({ index, kind });
    }
  });
  return { violations };
}
