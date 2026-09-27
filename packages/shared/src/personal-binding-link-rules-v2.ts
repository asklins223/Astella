/**
 * **本人确认**的目标关联（39d W5-6 刀六；39 §4.2、§14.4）。
 *
 * §4.2 那句是："后来公共卡片出现时，**只在目标与修订可确认一致后**关联已有个人记录，
 * **不复制或迁入其他成员表现**。系统生成了一份目标草稿不等于用户已经学过。"
 *
 * 为什么**不是**按指纹自动关联（第一版想的就是这个，量过之后否掉了）：
 * `computeSemanticTargetFingerprintV2`（`card-generation-v2-hashing.ts:29`）的输入是
 * `{ workspaceId, objectiveId, semanticIdentityClassId, semanticIdentityPolicyVersion }`
 * ——**指纹里含 `objectiveId`**。而一条本人绑定在建立那一刻**没有** objectiveId
 * （它正是"还没有对应公共目标"的那个东西），所以它算不出与任何公共目标相同的指纹。
 * 拿指纹自动关联在数据面上根本不可能成立，不是"要不要做"的问题。
 *
 * 退到同一条材料身份（§4.2「目标的可确认材料身份」）：`learning_objective_origins_v2`
 * 把公共目标绑到 `(objectiveRevisionId, noteId, noteVersionId)`。本人绑定也记着
 * `(noteId, noteVersionId)`——两者**同篇同版**才算同一批材料。但**同篇同版不够**：
 * 一版正文里通常有好几个目标，§4.2 明写"系统无法确定一个主张是否与历史相同时保留差异，
 * **不按标题相似自动继承能力证据**"。所以最后一步必须由**本人确认**。
 *
 * 两条不可越过的边界（写成常量判据，不是判断）：
 *  1. **不迁入**：关联只写 `linked_objective_id` 与判据快照，**不碰**任何别人的学习表现。
 *  2. **不自动**：没有本人这一下，`linked_objective_id` 永远是空。
 */
import { z } from "zod";

/** 一条候选：同篇同版上的某个公共目标。 */
export interface BindingLinkCandidateV2 {
  readonly objectiveId: string;
  readonly objectiveRevisionId: string;
  readonly objectiveRevision: number;
  readonly objectiveStatement: string;
  readonly conceptLabel: string | null;
}

/**
 * 判「这一条本人绑定能不能关联到那个公共目标」。
 *
 * 四道闸，每一道都对应 §4.2 的一句：
 *  - `binding_not_live`：已撤下的绑定不参与关联（§4.2「不删除历史」——历史留着，但不再生效）。
 *  - `already_linked`：一条绑定至多链一个目标。重复调用要交回既有那个，不是改指。
 *  - `not_same_note_version`：候选必须与绑定**同篇同版**。这一条挡的是"把另一篇的目标
 *    接到这条计划上"——那不是关联，那是伪造血缘。
 *  - `needs_confirmation`：没有本人这一下就不成立。**这是本文件存在的主要理由**。
 */
export function decideBindingLinkV2(input: {
  readonly bindingLive: boolean;
  readonly alreadyLinkedObjectiveId: string | null;
  readonly candidate: BindingLinkCandidateV2;
  readonly bindingNoteId: string;
  readonly bindingNoteVersionId: string;
  /** 候选公共目标所依据的篇与版（从 `learning_objective_origins_v2` 读出来）。 */
  readonly candidateNoteId: string;
  readonly candidateNoteVersionId: string;
  /** 本人是否明确点了这一条。 */
  readonly confirmedByUser: boolean;
}): {
  readonly allowed: true;
} | {
  readonly allowed: false;
  readonly reasonCode:
    | "binding_not_live"
    | "already_linked"
    | "not_same_note_version"
    | "needs_confirmation";
} {
  if (!input.bindingLive) return { allowed: false, reasonCode: "binding_not_live" };
  if (input.alreadyLinkedObjectiveId) return { allowed: false, reasonCode: "already_linked" };
  if (
    input.candidateNoteId !== input.bindingNoteId
    || input.candidateNoteVersionId !== input.bindingNoteVersionId
  ) {
    return { allowed: false, reasonCode: "not_same_note_version" };
  }
  // 排到最后：前面三道是数据事实，这一道是**人的动作**。
  if (!input.confirmedByUser) return { allowed: false, reasonCode: "needs_confirmation" };
  return { allowed: true };
}

/** 关联只写这两样，**不碰**任何学习表现（§4.2「不复制或迁入其他成员表现」）。 */
export function bindingLinkWritesOnlyLinkV2(): {
  readonly writesLinkedObjectiveId: true;
  readonly writesLinkEvidence: true;
  readonly copiesPerformanceRecords: false;
  readonly writesReviewSchedules: false;
  readonly writesEvidenceTable: false;
} {
  return {
    writesLinkedObjectiveId: true,
    writesLinkEvidence: true,
    copiesPerformanceRecords: false,
    writesReviewSchedules: false,
    writesEvidenceTable: false,
  };
}

/** 判据快照：没有它链接不可复核，所以它和 `linked_objective_id` 同生共死。 */
export function bindingLinkEvidenceV2(input: {
  readonly objectiveId: string;
  readonly objectiveRevisionId: string;
  readonly objectiveRevision: number;
  readonly noteId: string;
  readonly noteVersionId: string;
  readonly confirmedByUser: true;
}): { readonly objectiveId: string; readonly evidence: Record<string, unknown> } {
  return {
    objectiveId: input.objectiveId,
    evidence: {
      // 记的是**那一刻**的判据输入。哪天公共目标改了题面，这里还留着旧值，
      // 于是"当初凭什么说它们是同一条"这件事始终可复核（§4.3「教学要分别检查」的同一条纪律）。
      objectiveId: input.objectiveId,
      objectiveRevisionId: input.objectiveRevisionId,
      objectiveRevision: input.objectiveRevision,
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
      confirmedByUser: true,
      // 显式写清判据是"同篇同版 + 本人确认"，不是指纹相等——指纹那一路根本不存在
      // （见头注：`semanticTargetFingerprint` 含 objectiveId，本人绑定算不出它）。
      basis: "same_note_version_plus_user_confirmation",
    },
  };
}

// ─── wire 合同 ────────────────────────────────────────────────────────────

export const linkPersonalBindingV2Schema = z.strictObject({
  bindingId: z.string().uuid(),
  /** 本人点的那个候选。服务端仍要核它同篇同版——请求体里的 id 不作数。 */
  objectiveId: z.string().uuid(),
  /** 本人确认这一下。**不接受默认值**：没有它就没有关联。 */
  confirmed: z.literal(true),
});
export type LinkPersonalBindingV2Input = z.infer<typeof linkPersonalBindingV2Schema>;
