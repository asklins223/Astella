/**
 * **只对本人可见**的目标绑定（39d W5-6 刀四；39 §4.2、§16.20、§14.4）。
 *
 * §4.2 那句"不能为了获得稳定 ID 要求公共编辑权"在这里被真正执行成三件事：
 *
 *  1. **建绑定只要求读得到那篇笔记，不要求是本人写的**。判据是房子里那一份
 *     `visibleNotesCondition`——不是"必须是作者"（那是公共编辑权，会把只读成员挡在门外），
 *     也不是"读都不必读"（那会让他对着看不见的东西建计划）。
 *  2. **绝不写 `learning_objective_origins_v2`**。那张表是空间共用的公共血缘，
 *     一个只读成员写进去，另一位成员就会看到一条他没写过的目标（§4.2 明写禁止）。
 *  3. **关联公共目标要判据**。§4.2：「后来公共卡片出现时，只在目标与修订可确认一致后
 *     关联已有个人记录，不复制或迁入其他成员表现」。今天这一刀把 `linked_objective_id`
 *     留空——指纹与 revision 两边对得上的判据属于 0234 那套口径，不在这里另写一份。
 *     **宁可先不链接，也不要把两条不同的目标说成同一条**；链接那一步单独归 W5-6 刀五。
 *
 * 判据与写侧的分工照本仓惯例：这一份只回答"现在要写什么"，能不能写由 `visibleNotesCondition`
 * 判、不由这里重写；唯一性交给 0300 那条部分唯一索引。
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { personalObjectiveBindingsV2 } from "@astella/shared/db-schema/personal-objective-bindings";
import {
  learningObjectiveOriginsV2,
  learningObjectiveRevisionsV2,
  learningObjectivesV2,
} from "@astella/shared/db-schema/card-generation-v2";
import { notes, noteVersions } from "@astella/shared/db-schema/note";
import {
  bindingLinkEvidenceV2,
  decideBindingLinkV2,
  type BindingLinkCandidateV2,
} from "@astella/shared/personal-binding-link-rules-v2";
import { visibleNotesCondition, visibleObjectivesCondition } from "../note/visibility.ts";
import type { ApiTransaction } from "../../db/client.ts";

type BindingRow = typeof personalObjectiveBindingsV2.$inferSelect;

/** 只读成员读不到那篇笔记——建计划的前提不成立。要被路由翻成 404，不是 500。 */
export class BindingNoteNotFoundV2 extends Error {
  constructor() {
    super("note_not_found");
  }
}

export interface PersonalBindingV2View {
  readonly id: string;
  readonly noteId: string;
  readonly noteVersionId: string;
  readonly objectiveStatement: string;
  readonly knowledgeForm: string;
  readonly conceptLabel: string | null;
  /** 还没判据确认之前恒为 null（见头注第 3 条）。 */
  readonly linkedObjectiveId: string | null;
  readonly status: string;
  readonly createdAt: string;
}

/**
 * 立一条本人可见的目标绑定。
 *
 * 幂等：同一个人对同一篇同一版**至多一条**活的（0300 的部分唯一索引）。再点一次
 * 交回既有那一条、`created: false`——连点两下不该长出两份，也不该让界面以为"这次才生效"。
 *
 * `noteVersionId` 必填：§4.2 讲的是"本人的计划/观察"要**和**可确认的材料身份分开，
 * 而"依据哪一版"正是那个分开的地方。传一个不是该篇当前版本的 id 会被这里挡掉。
 */
export async function createPersonalObjectiveBindingV2(
  tx: ApiTransaction,
  input: {
    workspaceId: string;
    userId: string;
    noteId: string;
    noteVersionId: string;
    objectiveStatement: string;
    knowledgeForm?: string;
    conceptLabel?: string | null;
    at: Date;
  },
): Promise<{ binding: BindingRow; created: boolean }> {
  // 只要求**读得到**。判据取房子里那一份，不另写"必须是作者"——那正是会把只读成员
  // 挡在门外的公共编辑权（§4.2 明写不能为了稳定 ID 要求它）。
  const readable = await tx
    .select({ id: notes.id, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(
      eq(notes.id, input.noteId),
      eq(notes.workspaceId, input.workspaceId),
      visibleNotesCondition(input.userId),
    ))
    .limit(1);
  const note = readable[0];
  if (!note) throw new BindingNoteNotFoundV2();
  // 依据的必须是**这一篇的某一版**：防止拿别篇的 versionId 把两个人的计划串起来。
  const version = await tx
    .select({ id: noteVersions.id })
    .from(noteVersions)
    .where(and(
      eq(noteVersions.id, input.noteVersionId),
      eq(noteVersions.noteId, input.noteId),
      eq(noteVersions.workspaceId, input.workspaceId),
    ))
    .limit(1);
  if (!version[0]) throw new BindingNoteNotFoundV2();

  const inserted = await tx
    .insert(personalObjectiveBindingsV2)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
      objectiveStatement: input.objectiveStatement,
      knowledgeForm: input.knowledgeForm ?? "concept",
      conceptLabel: input.conceptLabel ?? null,
      status: "active",
      createdAt: input.at,
      updatedAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { binding: inserted[0], created: true };
  // 撞了那条部分唯一索引 ⇒ 同一篇同一版已经有一条活着的。交回它，不报"我立的"。
  const existing = await tx
    .select()
    .from(personalObjectiveBindingsV2)
    .where(and(
      eq(personalObjectiveBindingsV2.workspaceId, input.workspaceId),
      eq(personalObjectiveBindingsV2.userId, input.userId),
      eq(personalObjectiveBindingsV2.noteId, input.noteId),
      eq(personalObjectiveBindingsV2.noteVersionId, input.noteVersionId),
      isNull(personalObjectiveBindingsV2.releasedAt),
      eq(personalObjectiveBindingsV2.status, "active"),
    ))
    .limit(1);
  if (!existing[0]) {
    // 唯一索引挡住了 insert、回读又是空 ⇒ 并发下刚被解除。让这一发失败，
    // 比让它回一句"已建立"而库里什么都没立要诚实。
    throw new Error("个人目标绑定写入被挡但读不到活行：并发解除，请重试这一发");
  }
  return { binding: existing[0], created: false };
}

/** 这个人自己写下的绑定（只活着的）。RLS 已按 (workspace, user) 收，这里不再筛 note 可见性。 */
export async function listPersonalObjectiveBindingsV2(
  tx: ApiTransaction,
  input: { workspaceId: string; userId: string; noteId?: string; limit?: number },
): Promise<BindingRow[]> {
  return tx
    .select()
    .from(personalObjectiveBindingsV2)
    .where(and(
      eq(personalObjectiveBindingsV2.workspaceId, input.workspaceId),
      eq(personalObjectiveBindingsV2.userId, input.userId),
      ...(input.noteId ? [eq(personalObjectiveBindingsV2.noteId, input.noteId)] : []),
      isNull(personalObjectiveBindingsV2.releasedAt),
    ))
    .orderBy(sql`${personalObjectiveBindingsV2.createdAt} DESC`)
    .limit(input.limit ?? 50);
}

/**
 * 撤下自己的一条绑定。**写状态不删行**（§4.2「不删除历史」的同一条纪律，与 0295 排除表同形）：
 * 撤的是"我现在不按这条计划走"，不是"它从没存在过"。
 *
 * 幂等：已经撤过的交回 `released: false`，界面要能把"本来就不在"与"刚撤下"说成两句话。
 */
export async function releasePersonalObjectiveBindingV2(
  tx: ApiTransaction,
  input: { workspaceId: string; userId: string; bindingId: string; reason: string; at: Date },
): Promise<{ released: boolean }> {
  const updated = await tx
    .update(personalObjectiveBindingsV2)
    .set({ status: "released", releasedAt: input.at, releaseReason: input.reason, updatedAt: input.at })
    .where(and(
      eq(personalObjectiveBindingsV2.id, input.bindingId),
      eq(personalObjectiveBindingsV2.workspaceId, input.workspaceId),
      eq(personalObjectiveBindingsV2.userId, input.userId),
      isNull(personalObjectiveBindingsV2.releasedAt),
    ))
    .returning({ id: personalObjectiveBindingsV2.id });
  return { released: updated.length > 0 };
}

export function toBindingViewV2(row: BindingRow): PersonalBindingV2View {
  return {
    id: row.id,
    noteId: row.noteId,
    noteVersionId: row.noteVersionId,
    objectiveStatement: row.objectiveStatement,
    knowledgeForm: row.knowledgeForm,
    conceptLabel: row.conceptLabel,
    linkedObjectiveId: row.linkedObjectiveId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 关联被拒的原因要能被路由翻成具体状态码，不是笼统 400。 */
export class BindingLinkRefusedV2 extends Error {
  constructor(
    readonly reasonCode:
      | "binding_not_live"
      | "already_linked"
      | "not_same_note_version"
      | "needs_confirmation",
  ) {
    super(reasonCode);
  }
}

// ─── 关联（39d W5-6 刀六；§4.2）────────────────────────────────────────────

/**
 * 这一条本人绑定可以关联的候选：**同篇同版**上的公共目标。
 *
 * 为什么不按指纹找：见 `@astella/shared/personal-binding-link-rules-v2` 的头注——
 * `semanticTargetFingerprint` 的输入含 `objectiveId`，而本人绑定建立那一刻**没有**
 * `objectiveId`，所以"指纹相等"在数据面上不可能成立。能当"同一批材料"用的只有
 * `(noteId, noteVersionId)`，它来自 `learning_objective_origins_v2` 那条公共血缘。
 *
 * 同篇同版**不够**（一版正文里通常有好几个目标），所以这里只给候选、**不自动关联**：
 * 最后一步由本人点（`decideBindingLinkV2` 的 `needs_confirmation`）。
 *
 * 只取当前修订（`current_objective_revision_id` 指的那一版）：历史修订对"现在这个人
 * 说的是哪一个目标"没有意义，摆进候选只会让人挑到一个已经改过的题面。
 */
export async function listBindingLinkCandidatesV2(
  tx: ApiTransaction,
  input: { workspaceId: string; userId: string; bindingId: string },
): Promise<BindingLinkCandidateV2[]> {
  const binding = await tx
    .select({
      noteId: personalObjectiveBindingsV2.noteId,
      noteVersionId: personalObjectiveBindingsV2.noteVersionId,
    })
    .from(personalObjectiveBindingsV2)
    .where(and(
      eq(personalObjectiveBindingsV2.id, input.bindingId),
      eq(personalObjectiveBindingsV2.workspaceId, input.workspaceId),
      eq(personalObjectiveBindingsV2.userId, input.userId),
    ))
    .limit(1);
  if (!binding[0]) throw new BindingNoteNotFoundV2();

  // drizzle 的 select 不会因为 where 里的 `isNotNull` 就把列收窄成非空，所以类型在**投影**
  // 上补：两处都要写——只留 where 那一处，就会变成"类型说不可能、运行时其实是 null"。
  const rows = await tx
    .select({
      objectiveId: learningObjectivesV2.objectiveId,
      objectiveRevisionId: learningObjectivesV2.currentObjectiveRevisionId,
      objectiveRevision: learningObjectiveRevisionsV2.revision,
      objectiveStatement: learningObjectiveRevisionsV2.objectiveStatement,
      conceptLabel: learningObjectiveRevisionsV2.conceptLabel,
    })
    .from(learningObjectiveOriginsV2)
    // 这一发返回**目标正文**（题面 + 概念标题），所以要按「目标 → 卡 → 笔记」判可见性。
    // 判据写在 **join 条件**里而不是 where：对 inner join 两者等价，而「join 上本人看得见的
    // 目标」比「join 完再筛」更贴近这句话本来的意思。
    // 有人会问：绑定建立那一刻已经验过「读得到那篇笔记」了，为什么还要再判一次？
    // 因为那是**另一次调用**——那一发在这里之外。把「上游验过了」当豁免理由，等于让这一发
    // 在绑定行被别处改过之后仍然照读。成本是一次 EXISTS，划算。
    .innerJoin(learningObjectivesV2, and(
      eq(learningObjectivesV2.workspaceId, learningObjectiveOriginsV2.workspaceId),
      eq(learningObjectivesV2.objectiveId, learningObjectiveOriginsV2.objectiveId),
      visibleObjectivesCondition(input.userId, learningObjectivesV2.objectiveId),
    ))
    .innerJoin(learningObjectiveRevisionsV2, and(
      eq(learningObjectiveRevisionsV2.workspaceId, learningObjectivesV2.workspaceId),
      eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
    ))
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, input.workspaceId),
      eq(learningObjectiveOriginsV2.originKind, "note"),
      eq(learningObjectiveOriginsV2.noteId, binding[0].noteId),
      eq(learningObjectiveOriginsV2.noteVersionId, binding[0].noteVersionId),
      eq(learningObjectivesV2.lifecycle, "active"),
      // 没有当前修订的目标**不是候选**：那条列可空，而候选要给出"这个人说的是哪一句"，
      // 没有当前修订就没有那句话。与其在类型上放宽成 `string | null` 再让界面自己判，
      // 不如在查询里挡掉——摆一个题面取不出来的候选没有意义。
      isNotNull(learningObjectivesV2.currentObjectiveRevisionId),
    ))
    .limit(20);
  return rows.flatMap((row) => (
    row.objectiveRevisionId
      ? [{
        objectiveId: row.objectiveId,
        objectiveRevisionId: row.objectiveRevisionId,
        objectiveRevision: row.objectiveRevision,
        objectiveStatement: row.objectiveStatement,
        conceptLabel: row.conceptLabel,
      }]
      : []
  ));
}

/**
 * 本人确认之后把这条绑定关联到那个公共目标。
 *
 * 只写 `linked_objective_id` 与判据快照两列——`bindingLinkWritesOnlyLinkV2()` 把这条
 * 钉成常量：**不复制、不迁入**任何学习表现（§4.2「不复制或迁入其他成员表现」），
 * 也不碰 `review_schedules`：关联一条计划**不等于**给她开复习，那是 §9.1 的授权，
 * 走另一个入口与另一个同意。
 *
 * 候选的篇与版**由服务端从公共血缘读出来**，不信请求体：请求体只带 `objectiveId`。
 * 一个人可以把任意 id 填进来，挡住她的唯一办法是拿服务端读到的那一对去判。
 */
export async function linkPersonalBindingToObjectiveV2(
  tx: ApiTransaction,
  input: {
    workspaceId: string;
    userId: string;
    bindingId: string;
    objectiveId: string;
    confirmedByUser: boolean;
    at: Date;
  },
): Promise<{ binding: BindingRow; linked: true }> {
  const rows = await tx
    .select()
    .from(personalObjectiveBindingsV2)
    .where(and(
      eq(personalObjectiveBindingsV2.id, input.bindingId),
      eq(personalObjectiveBindingsV2.workspaceId, input.workspaceId),
      eq(personalObjectiveBindingsV2.userId, input.userId),
    ))
    .limit(1);
  const binding = rows[0];
  if (!binding) throw new BindingNoteNotFoundV2();

  // 候选的篇与版从公共血缘读，不从请求体取。
  const origins = await tx
    .select({
      noteId: learningObjectiveOriginsV2.noteId,
      noteVersionId: learningObjectiveOriginsV2.noteVersionId,
      objectiveRevisionId: learningObjectiveOriginsV2.objectiveRevisionId,
    })
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, input.workspaceId),
      eq(learningObjectiveOriginsV2.objectiveId, input.objectiveId),
      eq(learningObjectiveOriginsV2.originKind, "note"),
    ))
    .limit(1);
  const origin = origins[0];

  const current = origin
    ? (await tx
      .select({
        objectiveRevisionId: learningObjectivesV2.currentObjectiveRevisionId,
        revision: learningObjectiveRevisionsV2.revision,
      })
      .from(learningObjectivesV2)
      .innerJoin(learningObjectiveRevisionsV2, and(
        eq(learningObjectiveRevisionsV2.workspaceId, learningObjectivesV2.workspaceId),
        eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
      ))
      .where(and(
        eq(learningObjectivesV2.workspaceId, input.workspaceId),
        eq(learningObjectivesV2.objectiveId, input.objectiveId),
      ))
      .limit(1))[0]
    : undefined;

  const decided = decideBindingLinkV2({
    bindingLive: binding.releasedAt === null && binding.status === "active",
    alreadyLinkedObjectiveId: binding.linkedObjectiveId,
    candidate: {
      objectiveId: input.objectiveId,
      objectiveRevisionId: current?.objectiveRevisionId ?? origin?.objectiveRevisionId ?? "",
      objectiveRevision: current?.revision ?? 0,
      objectiveStatement: "",
      conceptLabel: null,
    },
    bindingNoteId: binding.noteId,
    bindingNoteVersionId: binding.noteVersionId,
    // 候选根本不存在时（origin 为空）拿空串去比，自然过不了同篇同版那一道——
    // 不必另开一个 reason：请求体里的 id 不作数这件事，结果就是"不成立"。
    candidateNoteId: origin?.noteId ?? "",
    candidateNoteVersionId: origin?.noteVersionId ?? "",
    confirmedByUser: input.confirmedByUser,
  });
  if (!decided.allowed) throw new BindingLinkRefusedV2(decided.reasonCode);

  const { objectiveId, evidence } = bindingLinkEvidenceV2({
    objectiveId: input.objectiveId,
    objectiveRevisionId: current?.objectiveRevisionId ?? origin?.objectiveRevisionId ?? "",
    objectiveRevision: current?.revision ?? 0,
    noteId: binding.noteId,
    noteVersionId: binding.noteVersionId,
    confirmedByUser: true,
  });

  const updated = await tx
    .update(personalObjectiveBindingsV2)
    .set({ linkedObjectiveId: objectiveId, linkEvidence: evidence, updatedAt: input.at })
    .where(and(
      eq(personalObjectiveBindingsV2.id, input.bindingId),
      eq(personalObjectiveBindingsV2.workspaceId, input.workspaceId),
      eq(personalObjectiveBindingsV2.userId, input.userId),
    ))
    .returning();
  if (!updated[0]) throw new Error("关联写入没有命中那一行：并发撤下了，请重试");
  return { binding: updated[0], linked: true };
}
