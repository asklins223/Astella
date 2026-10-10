/**
 * 她自己改人格的那条通路（40 §4.8.4「模型自改表达层」）。
 *
 * ## 这里只剩转接
 *
 * 写入本体已经抽到 `@astella/agent-host/src/identity.ts` 的共享提交端口。
 * 抽出去的理由是方案 50 §9.3：后台反思接进来之后，人格就有了**第二个写入者**。
 * 如果两条路径各自抄一遍 `SELECT … FOR UPDATE → 判断 → UPDATE → 插版本行`，
 * 「用户草稿优先」「排队不推当前版本」「版本号排在队尾」这几条规矩就会分处两地维护，
 * 早晚漂成两种行为——而漂的那一次是静默的。
 *
 * 本文件保留原签名，让四个前台工具的调用点不用一起改；新增的是**提案身份**：
 * 前台工具带当次 run 的 runId，于是同一次运行里先改语气、再改标签仍然两项都留下，
 * 而**另一个提案**（另一次运行、或一次后台反思）排的那一版不会被当成自己的底稿。
 *
 * ## 版本号
 *
 * 走 `nextPersonaRevisionNumber` 那条规矩（当前与待生效里更大的 +1）。起手那一份
 * 拿到的是第 1 版，档案行此前不存在时也要照常留版本行——否则用户在人格版本记录里
 * 看不到"她改的第一次是哪一版"。
 */

import type { WorkerTransaction } from "../db.ts";
import {
  commitPersonaProposalV1,
  type CompanionPersonaCommitOutcomeV1,
  type CompanionPersonaProposalV1,
} from "@astella/agent-host";
import type { CompanionPersonaProfileContent } from "@astella/shared/db-schema/companion-memory";
import type {
  PersonaAssistantEditableField,
  SwitchableField,
} from "@astella/shared/pet-persona-merge";

/** 前台工具用的字段集合；`selfDescription` 走的是后台反思那条通路。 */
export type PersonaSelfEditField = SwitchableField | PersonaAssistantEditableField;

export type PersonaSelfEditResult =
  /** 已保存实质改动；stage=true 时 revision 是待生效版本号。 */
  | { readonly kind: "changed"; readonly revision: number; readonly profile: CompanionPersonaProfileContent }
  /** 新值与现值相同：不给"已改"的回执，也不占一个版本号。 */
  | { readonly kind: "unchanged"; readonly profile: CompanionPersonaProfileContent }
  /** 并发把版本推走了；调用方按"请重试"处理。 */
  | { readonly kind: "conflict" };

function toSelfEditResult(outcome: CompanionPersonaCommitOutcomeV1): PersonaSelfEditResult {
  if (outcome.kind === "conflict") return { kind: "conflict" };
  if (outcome.kind === "unchanged") return { kind: "unchanged", profile: outcome.profile };
  // `supersededPendingRevision` 不往前台工具暴露：回执仍然说"排上了哪一版"，
  // 被顶掉的那一版由版本历史与诊断解释（它在历史里仍可查、可恢复）。
  return { kind: "changed", revision: outcome.revision, profile: outcome.profile };
}

/**
 * 改一项或多项表达层的设定，来源记 `assistant`。
 *
 * `field` 不含 `name` —— 用户起的名字她改不了（§4.8.4），类型上就不给这条路。
 * 一次改多项（改边界）只推一个版本号：分两次推会让用户在人格里看到两次改动，
 * 而他只提了一次要求。
 */
export async function applyAssistantPersonaEdits(
  tx: WorkerTransaction,
  userId: string,
  edits: readonly { field: PersonaSelfEditField; value: unknown }[],
  reason: string,
  options: {
    stage?: boolean;
    sourceWorkspaceId?: string;
    expectedRevision?: number;
    expectedPendingRevision?: number | null;
    proposal?: CompanionPersonaProposalV1;
  } = {},
): Promise<PersonaSelfEditResult> {
  if (edits.length === 0) throw new Error("applyAssistantPersonaEdits requires at least one edit");
  return toSelfEditResult(await commitPersonaProposalV1(
    tx,
    userId,
    {
      edits: edits.map((edit) => ({ field: edit.field, value: edit.value })),
      reason,
      stage: options.stage === true,
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      ...(options.expectedPendingRevision === undefined
        ? {} : { expectedPendingRevision: options.expectedPendingRevision }),
      ...(options.proposal === undefined ? {} : { proposal: options.proposal }),
    },
    { sourceWorkspaceId: options.sourceWorkspaceId ?? null },
  ));
}

/** 单项版的薄封装——四个工具里有三个只改一项。 */
export function applyAssistantPersonaEdit(
  tx: WorkerTransaction,
  userId: string,
  field: PersonaSelfEditField,
  value: unknown,
  reason: string,
  options: {
    stage?: boolean;
    sourceWorkspaceId?: string;
    expectedRevision?: number;
    expectedPendingRevision?: number | null;
    proposal?: CompanionPersonaProposalV1;
  } = {},
): Promise<PersonaSelfEditResult> {
  return applyAssistantPersonaEdits(tx, userId, [{ field, value }], reason, options);
}
