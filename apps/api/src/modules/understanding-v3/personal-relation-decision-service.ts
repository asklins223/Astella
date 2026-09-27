/**
 * **本人对建议关系**的确认／隐藏（39d W5-6 刀七；39 §11.3、§16.20、§4.2）。
 *
 * 写入侧只做三件事，每一件都对应 §11.3 的一句：
 *  1. **两端都要读得到**（`decideRelationDecisionV2` 的 `missing_endpoints`）。首期以单篇
 *     笔记中可核对关系为主，而模型推测的前置关系可能指向他读不到的另一篇——确认一条自己
 *     端点都看不见的关系没有意义，他确认不了自己没看过的东西。
 *  2. **只写那一张按人收的表**（`relationsWritesNothingSharedV2()` 把其余五条钉成 `false`）。
 *     公共 `relations` jsonb 是材料血缘，随目标修订定版；往里写 `confirmedBy` 就是把个人
 *     数据烧进公共快照，正是 §11.3「不能让只读成员的确认修改公共知识结构」要禁止的。
 *  3. **改主意走 UPDATE**（0302 那条唯一索引把 decision 排除在键外），所以读侧不必判
 *     "哪一行更新"——§11.3「用户可纠正或隐藏」要的就是这个不分叉。
 *
 * 共享结构那半边（`decideSharedRelationWriteV2`）**不在这一份里执行**：把一条确认写进公共
 * 关系需要材料编辑权 + 明确作用范围，那是公共材料的写路径，与 0300/0296 同一支思路，
 * 但它的调用点是编辑动作那一侧，不在这里凭空开一个口。
 */
import { and, eq, sql } from "drizzle-orm";
import {
  personalRelationDecisionsV2,
  type PersonalRelationKindV2,
} from "@ailearn/shared/db-schema/personal-relation-decisions";
import { notes } from "@ailearn/shared/db-schema/note";
import { learningObjectiveOriginsV2, learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import {
  decideRelationDecisionV2,
  type PersonalRelationDecisionV2,
} from "@ailearn/shared/personal-relation-decision-rules-v2";
import { visibleNotesCondition } from "../note/visibility.ts";
import type { ApiTransaction } from "../../db/client.ts";
import { sha256Hex } from "@ailearn/shared/content-hash";

/** 两端有读不到的那一个——要让界面说清"哪一端读不到"，不是笼统一句"不行"。 */
export class RelationEndpointNotReadableV2 extends Error {
  constructor(readonly side: "from" | "to" | "both") {
    super(`relation_endpoint_not_readable:${side}`);
  }
}

export class RelationSelfLoopV2 extends Error {
  constructor() {
    super("relation_self_loop");
  }
}

function toView(row: typeof personalRelationDecisionsV2.$inferSelect) {
  return {
    version: 2 as const,
    fromObjectiveId: row.fromObjectiveId,
    toObjectiveId: row.toObjectiveId,
    relation: row.relation,
    decision: row.decision,
    noteId: row.noteId,
  };
}

/** 这个目标本人在哪一篇上——用来判"两端都读得到"。没有绑定就等于读不到。 */
async function readableNoteForObjectiveV2(
  tx: ApiTransaction,
  input: { workspaceId: string; userId: string; objectiveId: string },
): Promise<string | null> {
  const rows = await tx
    .select({ noteId: notes.id })
    .from(learningObjectiveOriginsV2)
    .innerJoin(learningObjectivesV2, and(
      eq(learningObjectivesV2.workspaceId, learningObjectiveOriginsV2.workspaceId),
      eq(learningObjectivesV2.objectiveId, learningObjectiveOriginsV2.objectiveId),
    ))
    .innerJoin(notes, and(
      eq(notes.id, learningObjectiveOriginsV2.noteId),
      eq(notes.workspaceId, learningObjectiveOriginsV2.workspaceId),
    ))
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, input.workspaceId),
      eq(learningObjectiveOriginsV2.objectiveId, input.objectiveId),
      eq(learningObjectiveOriginsV2.originKind, "note"),
      eq(learningObjectivesV2.lifecycle, "active"),
      // 判据取房子里那一份 `visibleNotesCondition`（不是在 where 里再抄一遍
      // `share_scope = 'shared' OR created_by = ...`）——这一族是目标读点棘轮盯着的。
      visibleNotesCondition(input.userId),
    ))
    .limit(1);
  return rows[0]?.noteId ?? null;
}

/**
 * 记一次确认／隐藏。改主意就再调一次——0302 那条唯一索引保证同一条边只留一行。
 *
 * `noteId` **不接受请求体给的值**（虽然合同里带着它）：两端在不在同一篇、以及本人读不读得到，
 * 都由服务端从公共血缘 + 可见性判据查出来。给了也当没给。
 */
export async function setPersonalRelationDecisionV2(
  tx: ApiTransaction,
  input: {
    workspaceId: string;
    userId: string;
    fromObjectiveId: string;
    toObjectiveId: string;
    relation: PersonalRelationKindV2;
    decision: PersonalRelationDecisionV2;
    evidence?: Record<string, unknown>;
    at: Date;
  },
): Promise<{ row: ReturnType<typeof toView>; changed: boolean }> {
  if (input.fromObjectiveId === input.toObjectiveId) throw new RelationSelfLoopV2();

  const [fromNote, toNote] = await Promise.all([
    readableNoteForObjectiveV2(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      objectiveId: input.fromObjectiveId,
    }),
    readableNoteForObjectiveV2(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      objectiveId: input.toObjectiveId,
    }),
  ]);
  const decided = decideRelationDecisionV2({
    fromReadable: fromNote !== null,
    toReadable: toNote !== null,
    sameObjective: input.fromObjectiveId === input.toObjectiveId,
    decision: input.decision,
  });
  if (!decided.allowed) {
    // 端点读不到要说清是哪一端：笼统一句"不行"会让她以为是关系本身有问题。
    // 判据函数只回一个 reason（它不必知道是哪一端——那是这里的事），
    // 所以「哪一端」直接从上面那两次查询的本地变量读。
    const side = fromNote === null && toNote === null ? "both"
      : fromNote === null ? "from" : "to";
    throw new RelationEndpointNotReadableV2(side);
  }
  // 两端在**同一篇**时才记 noteId；跨篇的首期不记（§11.3「首期以单篇笔记中可核对关系为主」），
  // 于是 note_id 可空这一档在读侧只有一个含义：这条不属于任何一篇。
  const noteId = fromNote !== null && fromNote === toNote ? fromNote : null;

  // 改主意走 upsert：键是 (ws, user, from, to, relation)，**不含 decision**，
  // 所以重复点是同一行被改写，不会长出"确认"与"隐藏"两行。
  const rows = await tx
    .insert(personalRelationDecisionsV2)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      noteId,
      fromObjectiveId: input.fromObjectiveId,
      toObjectiveId: input.toObjectiveId,
      relation: input.relation,
      decision: input.decision,
      evidence: input.evidence ?? {},
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoUpdate({
      target: [
        personalRelationDecisionsV2.workspaceId,
        personalRelationDecisionsV2.userId,
        personalRelationDecisionsV2.fromObjectiveId,
        personalRelationDecisionsV2.toObjectiveId,
        personalRelationDecisionsV2.relation,
      ],
      set: {
        decision: input.decision,
        evidence: input.evidence ?? {},
        noteId,
        updatedAt: input.at,
      },
    })
    .returning();
  return { row: toView(rows[0]), changed: true };
}

/** 本人在某一篇（或整个空间）上对关系边做过的全部表态。 */
export async function listPersonalRelationDecisionsV2(
  tx: ApiTransaction,
  input: { workspaceId: string; userId: string; noteId?: string; limit?: number },
): Promise<Array<ReturnType<typeof toView>>> {
  const rows = await tx
    .select()
    .from(personalRelationDecisionsV2)
    .where(and(
      eq(personalRelationDecisionsV2.workspaceId, input.workspaceId),
      eq(personalRelationDecisionsV2.userId, input.userId),
      ...(input.noteId ? [eq(personalRelationDecisionsV2.noteId, input.noteId)] : []),
    ))
    .orderBy(sql`${personalRelationDecisionsV2.updatedAt} DESC`)
    .limit(input.limit ?? 100);
  return rows.map(toView);
}

/**
 * 把本人的表态叠到一批建议边上——读侧那一半（§11.3「首先只影响本人的学习视图」）。
 *
 * 纯函数、不碰库：它只回答"这一条边在**这个人**眼里算什么"。调用方拿到建议边 + 本人的
 * 表，叠完就是这一篇在他视图里的样子；别人看到的是他们自己那张表的结果。
 *
 * 三档输出对应 §11.3 的措辞：
 *  - `confirmed` —— 已确认，可以当实线呈现；
 *  - `dismissed` —— 本人藏起来了，**不呈现**（不是"弱化"，是不画）；
 *  - `suggested` —— 没表态，按待确认建议处理：§11.3「先作为待确认建议，
 *    **不自动成为实线或影响正式掌握**」，所以它必须能拿"正式性"单独问一句。
 */
export function applyPersonalRelationDecisionsV2<T extends {
  fromObjectiveId: string;
  toObjectiveId: string;
  relation: string;
}>(input: {
  readonly suggested: readonly T[];
  readonly decisions: ReadonlyArray<{
    fromObjectiveId: string;
    toObjectiveId: string;
    relation: string;
    decision: PersonalRelationDecisionV2;
  }>;
}): ReadonlyArray<T & { relationStatus: "confirmed" | "dismissed" | "suggested"; countsAsEstablished: boolean }> {
  // 键用可读分隔符而不是裸拼接：`(from, to, relation)` 三元组直接拼字符串时，
  // 分隔符一旦混进去就分不开两对不同的边。这里显式写成 `from | to | relation`。
  const key = (a: { fromObjectiveId: string; toObjectiveId: string; relation: string }) =>
    `${a.fromObjectiveId} | ${a.toObjectiveId} | ${a.relation}`;
  const mine = new Map(input.decisions.map((d) => [key(d), d.decision]));
  return input.suggested.map((edge) => {
    const decision = mine.get(key(edge)) ?? "suggested";
    return {
      ...edge,
      relationStatus: decision,
      // 只有**已确认**才算"成立的关系"；待确认建议不因模型推测而成为实线，
      // 也不进任何"正式掌握"的计算（§11.3 那一整句）。
      countsAsEstablished: decision === "confirmed",
    };
  });
}

/**
 * 边在**投影里**的那一档：库里存的只有 `confirmed`／`dismissed` 两种表态，
 * 「没表态」不是一个被存下来的值，而是**读侧补出来的那一档**。
 *
 * 分开写是因为这两件事的含义不同：库里那一列记的是「这个人做过一次表态」，
 * 投影这一档回答的是「**此刻**这条边算什么」——一个人取消表态之后，
 * 库里那行会被删掉，而这一档回到 `suggested`。
 */
export type RelationEdgeStatusV2 = PersonalRelationDecisionV2 | "suggested";

/** 只有**教学关系**那一类边可以由本人表态；血缘与证据链接不行（§11.3）。 */
export const DECIDABLE_RELATION_EDGE_KINDS_V2 = ["relates_to"] as const;

/** 边能不能由本人表态——不能的那些**必须原样**呈现，不得被藏起来。 */
export function relationEdgeIsDecidableV2(kind: string): boolean {
  // §11.3：「材料血缘与教学关系使用不同表达」。`sourced_from`／`supersedes`／
  // `contains_note` 是**材料怎么来的**，它不是任何人的看法，所以没有「我不这么认为」
  // 这一档；`supported_by` 指向具体证据，同理。
  return (DECIDABLE_RELATION_EDGE_KINDS_V2 as readonly string[]).includes(kind);
}

/**
 * 把本人的表态叠到**整份快照**上（读侧那一半；§11.3、§16.20）。
 *
 * ## 为什么不在 `buildTopologySnapshotV3` 里做
 *
 * 拓扑快照有一条按 `${workspaceId}:${userId}` 的 TTL 缓存，而 `topologyRevision`
 * 是**内容指纹**。把「这个人确认了哪条边」折进那两样东西里会同时坏掉三件事：
 *  1. 公共拓扑被本人的表态污染——§11.3 明写「用户确认**首先只影响本人的学习视图**；
 *     写入共享关系需具备材料编辑权并明确作用范围」；
 *  2. `topologyRevision` 变成 per-user 的 ⇒ ETag 跨成员互相失效；
 *  3. 缓存与指纹的含义从「这个空间的拓扑」变成「这个人眼里的拓扑」，
 *     而后者的失效理由是表态变了，与拓扑变了完全不是一回事。
 *
 * 所以这里**只做投影**：快照保持公共、缓存仍然共享、指纹仍然只描述拓扑。
 *
 * ## ETag 必须一起改，否则决策改不动
 *
 * `topologyRevision` 只哈希「两端点 + kind」，**不包含本人对这条边的表态**。
 * 于是用户点完「确认」之后响应的 ETag 与上一次逐字节相同 ⇒ 客户端拿旧
 * `If-None-Match` 来协商会拿到 **304**，他刚点的确认**留在屏上不生效**，
 * 而且没有任何错误。所以 ETag 必须掺进一个**本人的表态摘要**
 * （见 {@link personalDecisionsETagSuffixV2}）。
 */
export function applyPersonalDecisionsToSnapshotV2<S extends { edges: ReadonlyArray<Record<string, unknown>> }>(input: {
  readonly snapshot: S;
  readonly decisions: ReadonlyArray<{
    fromObjectiveId: string;
    toObjectiveId: string;
    relation: string;
    decision: PersonalRelationDecisionV2;
  }>;
}): { edges: Array<Record<string, unknown>>; decisionByEdgeId: Record<string, PersonalRelationDecisionV2> } {
  const mine = new Map<string, PersonalRelationDecisionV2>();
  for (const d of input.decisions) {
    // 键是 `from | to | relation` 三元组：直接裸拼时分隔符混进去就分不开两对不同的边。
    mine.set(`${d.fromObjectiveId} | ${d.toObjectiveId} | ${d.relation}`, d.decision);
  }

  const decisionByEdgeId: Record<string, PersonalRelationDecisionV2> = {};
  const edges = input.snapshot.edges.map((edge) => {
    const kind = typeof edge.kind === "string" ? edge.kind : "";
    const from = edge.from as { id?: string } | undefined;
    const to = edge.to as { id?: string } | undefined;
    const edgeId = typeof edge.edgeId === "string" ? edge.edgeId : null;

    if (!relationEdgeIsDecidableV2(kind)) {
      // 血缘／证据边：**不给** relationStatus 那一列，也**不许**被藏。
      // 渲染层据 `decidable` 决定给不给「确认／隐藏」两颗按钮——不给，
      // 就不存在「我能不能把这张纸藏起来」这个问题。
      return { ...edge, decidable: false };
    }

    const decision: RelationEdgeStatusV2 =
      (from?.id && to?.id ? mine.get(`${from.id} | ${to.id} | ${kind}`) : undefined) ?? "suggested";
    // 只有**真的表过态**的那两档进这张表；`suggested` 是"没有表态"，
    // 写进去会让 ETag 摘要把"没表态"也当成一个需要协商的版本。
    if (edgeId && decision !== "suggested") decisionByEdgeId[edgeId] = decision;
    return {
      ...edge,
      relationStatus: decision,
      // §11.3：只有**已确认**才算成立的关系。模型推测的前置／相似／应用关系
      // 「不自动成为实线或影响正式掌握」——所以这一列不进任何"正式掌握"的计算。
      countsAsEstablished: decision === "confirmed",
      decidable: true,
    };
  });

  return { edges, decisionByEdgeId };
}

/**
 * 本人表态的 ETag 后缀（见上面「ETag 必须一起改」）。
 *
 * **确定性排序**：同一组表态无论读回顺序如何都得到同一个摘要，否则用户什么都没改
 * 也会偶发一次 304 失效。
 */
export function personalDecisionsETagSuffixV2(
  decisions: ReadonlyArray<{ edgeId: string; decision: PersonalRelationDecisionV2 }>,
): string {
  const parts = [...decisions].map((d) => `${d.edgeId}:${d.decision}`).sort();
  return parts.length === 0 ? "p0" : `p${sha256Hex(parts.join(";"))}`;
}
