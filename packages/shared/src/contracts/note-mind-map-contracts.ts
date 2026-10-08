import { z } from "zod";

export const MIND_MAP_MAX_NODES = 120;
export const MIND_MAP_MAX_DEPTH = 6;
export const mindMapReferenceV1Schema = z.strictObject({
  blockOrdinal: z.number().int().min(0).max(100_000),
  quote: z.string().trim().min(1).max(500),
});
export const mindMapNodeV1Schema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  parentId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).nullable(),
  kind: z.enum(["root", "group", "concept"]),
  label: z.string().trim().min(1).max(48),
  explanation: z.string().trim().min(1).max(600).nullable(),
  references: z.array(mindMapReferenceV1Schema).max(6),
});

export const mindMapContentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  rootId: z.string().min(1).max(64),
  nodes: z.array(mindMapNodeV1Schema).min(2).max(MIND_MAP_MAX_NODES),
}).superRefine((map, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const nodes = new Map(map.nodes.map(node => [node.id, node]));
  if (nodes.size !== map.nodes.length) fail("脑图节点身份重复");
  const roots = map.nodes.filter(node => node.parentId === null || node.kind === "root");
  if (roots.length !== 1 || roots[0]?.id !== map.rootId || roots[0]?.parentId !== null || roots[0]?.kind !== "root") fail("脑图必须只有一个主题根节点");
  for (const node of map.nodes) {
    if (node.kind === "concept" && !node.references.length) fail("知识节点需要原文依据");
    if (node.kind === "group" && node.explanation !== null && !node.references.length) fail("分组解释需要原文依据");
    if (node.id !== map.rootId && node.parentId === null) fail("非主题节点需要父节点");
    const visited = new Set<string>();
    let current: typeof node | undefined = node;
    let depth = 0;
    while (current) {
      if (visited.has(current.id)) { fail("脑图不能成环"); break; }
      visited.add(current.id);
      if (++depth > MIND_MAP_MAX_DEPTH) { fail("脑图层级超过上限"); break; }
      if (current.parentId === null) break;
      const parent: typeof node | undefined = nodes.get(current.parentId);
      if (!parent) { fail("脑图父节点不存在"); break; }
      current = parent;
    }
  }
  if (!map.nodes.some(node => node.kind === "concept")) fail("脑图缺少有依据的知识节点");
  for (const node of map.nodes) if (node.kind === "group" && !map.nodes.some(child => child.parentId === node.id)) fail("分组不能是空枝条");
});
export const mindMapCoverageV1Schema = z.strictObject({
  totalBlocks: z.number().int().nonnegative(),
  textBlockOrdinals: z.array(z.number().int().nonnegative()).max(100_000),
  imageBlocksNotRead: z.number().int().nonnegative(),
  allTextRead: z.literal(true),
});
export const noteMindMapV1Schema = z.strictObject({
  mindMapId: z.string().uuid(), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  noteVersionNumber: z.number().int().positive(),
  title: z.string().min(1).max(500), contentHash: z.string().min(1).max(128),
  content: mindMapContentV1Schema, coverage: mindMapCoverageV1Schema,
  generationJobId: z.string().uuid(), modelId: z.string().min(1).max(200), promptVersion: z.string().min(1).max(200),
  versionState: z.enum(["current", "older"]), createdAt: z.string().datetime({ offset: true }),
});
export const noteMindMapPageV1Schema = z.strictObject({version:z.literal(1),items:z.array(noteMindMapV1Schema).max(100),nextCursor:z.string().uuid().nullable()});
export const noteMindMapListQueryV1Schema = z.strictObject({before:z.string().uuid().optional()});
export const createNoteMindMapTaskV1Schema = z.strictObject({noteVersionId:z.string().uuid(),requestId:z.string().uuid()});
export const noteMindMapTaskV1Schema = z.strictObject({
  taskId:z.string().uuid(),agentRunId:z.string().uuid().optional(),noteId:z.string().uuid(),noteVersionId:z.string().uuid(),
  status:z.enum(["queued","running","ready","failed"]),mindMap:noteMindMapV1Schema.nullable(),
  failureReason:z.enum(["ai_consent_required","ai_data_policy_denied","unknown"]).nullable(),
  failureMessage:z.string().max(500).nullable(),createdAt:z.string().datetime({offset:true}),
});
export const noteMindMapLatestTaskV1Schema = z.strictObject({version:z.literal(1),task:noteMindMapTaskV1Schema.nullable()});
export const noteMindMapLatestTaskQueryV1Schema = z.strictObject({noteVersionId:z.string().uuid()});
/** Read-only snapshot reached through an owned artifact, never restores the live note. */
export const noteMindMapSourceV1Schema = z.strictObject({
  noteId:z.string().uuid(),noteVersionId:z.string().uuid(),noteVersionNumber:z.number().int().positive(),title:z.string(),
  blocks:z.array(z.strictObject({ordinal:z.number().int().nonnegative(),type:z.string(),content:z.string()})).max(100_000),
});
export type MindMapContentV1 = z.infer<typeof mindMapContentV1Schema>;
export type MindMapNodeV1 = z.infer<typeof mindMapNodeV1Schema>;
export type MindMapReferenceV1 = z.infer<typeof mindMapReferenceV1Schema>;
export type NoteMindMapV1 = z.infer<typeof noteMindMapV1Schema>;
export type NoteMindMapTaskV1 = z.infer<typeof noteMindMapTaskV1Schema>;
export type NoteMindMapSourceV1 = z.infer<typeof noteMindMapSourceV1Schema>;
