/**
 * **本人对建议关系**的确认／隐藏（39d W5-6 刀七；39 §11.3、§16.20）。
 *
 * §11.3 把这一块讲成一句话：「用户确认**首先只影响本人的学习视图**；写入共享关系需具备
 * **材料编辑权**并明确作用范围，**不能让只读成员的确认修改公共知识结构**。」
 *
 * 这份判据把它拆成三件能逐条单测的事：
 *  1. **只影响本人**——确认／隐藏的写入范围就是那一张按 (workspace, user) 收的表。
 *  2. **不改公共结构**——`relationsWritesNothingSharedV2()` 是**常量**判据：确认一次关系
 *     不写 `learning_objective_revisions_v2.relations`、不改目标生命周期、不建任何
 *     跨成员可见的行。哪天它能返回 true，§11.3 那半句就破了。
 *  3. **不伪造学习事实**——确认不是一次学习表现，所以不进证据表、不推进复习安排、
 *     不产生"跨时间重复"那一类计数。§11.3 原话：「关系修改**不伪造过去的学习事实**」。
 *
 * 另一件顺带在这里判掉的：**共享关系要材料编辑权**。只读成员（笔记的 `created_by`
 * 不是他）**不能**把确认写进公共结构——这与 §4.2「不能为了获得稳定 ID 要求公共编辑权」
 * 是同一件事的两面：个人视图不需要编辑权，公共结构需要。
 */
import { z } from "zod";

/** §11.3 要求四类关系分开表达。 */
export const personalRelationKindV2Schema = z.enum([
  "relates_to",
  "prerequisite",
  "explains",
  "contrasts",
]);
export type PersonalRelationKindV2Wire = z.infer<typeof personalRelationKindV2Schema>;

/** 只有这两种表态。**没有** `pending`：没表态就是不写这一行。 */
export const personalRelationDecisionV2Schema = z.enum(["confirmed", "dismissed"]);
export type PersonalRelationDecisionV2 = z.infer<typeof personalRelationDecisionV2Schema>;

/**
 * 判「这一下能不能生效」。
 *
 * 三道，顺序有讲究：**先看人**（他是不是这条边的两端都能读到），**再看对象**
 * （两端是不是同一个），最后看表态本身。理由与 0300 那条关联闸一样——先问数据事实、
 * 最后才问人的动作，日志里出现的第一个原因总是可复现的那一个。
 *
 * `missing_endpoints` 这一档是首期最要紧的：§11.3 说"首期以**单篇笔记中可核对**关系为主"，
 * 而模型推测的前置关系可能指向一篇他**读不到**的笔记里的目标。确认一条自己端点都看不见的
 * 关系没有意义（他确认不了自己没看过的东西），所以那一档不成立。
 */
export function decideRelationDecisionV2(input: {
  readonly fromReadable: boolean;
  readonly toReadable: boolean;
  readonly sameObjective: boolean;
  readonly decision: PersonalRelationDecisionV2;
}): {
  readonly allowed: true;
} | {
  readonly allowed: false;
  readonly reasonCode: "missing_endpoints" | "same_objective" | "invalid_decision";
} {
  if (!input.fromReadable || !input.toReadable) {
    return { allowed: false, reasonCode: "missing_endpoints" };
  }
  if (input.sameObjective) return { allowed: false, reasonCode: "same_objective" };
  // 两值都合法时这一档永远不触发；留着是为了将来加第三档时不必改这条的形状。
  if (input.decision !== "confirmed" && input.decision !== "dismissed") {
    return { allowed: false, reasonCode: "invalid_decision" };
  }
  return { allowed: true };
}

/**
 * §11.3「不能让只读成员的确认修改公共知识结构」——常量判据，不是判断。
 *
 * 确认一次关系**只**写那一张按人收的表。剩下那五条全是 `false`：
 * 哪天任何一条能返回 true，§11.3 后两句就破了，而那种破损在集成测试里很难看出来
 * （行数确实没涨，只是公共快照里多了一列被改了），所以让它在单测里一眼可见。
 */
export function relationsWritesNothingSharedV2(): {
  readonly writesPersonalDecisionTable: true;
  readonly writesSharedRelationsJsonb: false;
  readonly mutatesObjectiveLifecycle: false;
  readonly createsCrossMemberRows: false;
  readonly writesEvidenceTable: false;
  readonly createsReviewSchedule: false;
} {
  return {
    writesPersonalDecisionTable: true,
    writesSharedRelationsJsonb: false,
    mutatesObjectiveLifecycle: false,
    createsCrossMemberRows: false,
    writesEvidenceTable: false,
    createsReviewSchedule: false,
  };
}

/**
 * 共享关系写入的资格（§11.3「写入共享关系需具备**材料编辑权**并明确作用范围」）。
 *
 * 注意它**只**管共享结构，不管个人视图：个人视图不需要编辑权（§4.2）。所以这一条
 * 返回 `false` 时，那个人**仍然可以**记自己的确认——只是写不进公共结构。这个区别
 * 写成两个返回值而不是一个 `allowed`，就是为了让调用方不能顺手把两件事一起拒掉。
 */
export function decideSharedRelationWriteV2(input: {
  /** 他是不是这篇笔记的作者（`notes.created_by`）。 */
  readonly isNoteAuthor: boolean;
  /** 有没有材料编辑权（个人空间里作者恒有，别把"没有成员表"当成"没有编辑权"）。 */
  readonly hasMaterialEditRight: boolean;
  /** 作用范围是否说清了（§11.3「明确作用范围」）。 */
  readonly scopeDeclared: boolean;
}): {
  readonly mayWriteShared: false;
  /** 个人视图不受影响——§4.2「不能为了获得稳定 ID 要求公共编辑权」。 */
  readonly personalViewStillAllowed: true;
  readonly reasonCode: "no_material_edit_right" | "scope_not_declared";
} | {
  readonly mayWriteShared: true;
  readonly personalViewStillAllowed: true;
} {
  if (!input.isNoteAuthor && !input.hasMaterialEditRight) {
    return { mayWriteShared: false, personalViewStillAllowed: true, reasonCode: "no_material_edit_right" };
  }
  if (!input.scopeDeclared) {
    return { mayWriteShared: false, personalViewStillAllowed: true, reasonCode: "scope_not_declared" };
  }
  return { mayWriteShared: true, personalViewStillAllowed: true };
}

// ─── wire 合同 ────────────────────────────────────────────────────────────

export const setPersonalRelationDecisionV2Schema = z.strictObject({
  fromObjectiveId: z.string().uuid(),
  toObjectiveId: z.string().uuid(),
  relation: personalRelationKindV2Schema,
  decision: personalRelationDecisionV2Schema,
  noteId: z.string().uuid().nullish(),
  evidence: z.record(z.unknown()).default({}),
});
export type SetPersonalRelationDecisionV2Input = z.infer<typeof setPersonalRelationDecisionV2Schema>;

export const personalRelationDecisionViewV2Schema = z.strictObject({
  version: z.literal(2),
  fromObjectiveId: z.string().uuid(),
  toObjectiveId: z.string().uuid(),
  relation: personalRelationKindV2Schema,
  decision: personalRelationDecisionV2Schema,
  noteId: z.string().uuid().nullable(),
});
export type PersonalRelationDecisionViewV2 = z.infer<typeof personalRelationDecisionViewV2Schema>;

/**
 * 记一次表态的回执（写侧）。
 *
 * **`changed: false` 走 HTTP 304 而不是 200**：用户重复点一次「确认」不该在审计里
 * 留两条记录。桌面那一侧把 304 当成"没变"而不是失败（见 `desktop-gateway.ts`）——
 * 把它转成异常会让屏上弹一个错，而用户做的事完全正确。
 */
export const setPersonalRelationDecisionV2ResultSchema = z.strictObject({
  version: z.literal(2),
  changed: z.boolean(),
  decision: personalRelationDecisionViewV2Schema,
});
export type SetPersonalRelationDecisionV2Result = z.infer<
  typeof setPersonalRelationDecisionV2ResultSchema
>;
