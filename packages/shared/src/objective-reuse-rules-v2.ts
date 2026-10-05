/**
 * 同笔记目标复用的保守判据。读侧先按工作区和笔记收窄；只有来源块、
 * 知识形态和答案主张都一致，且唯一命中，才复用目标身份。
 *
 * 一个来源块可以包含多个知识点。块与形态相同不能证明目标相同；缺少
 * 有效答案或主张无法确认时新建，避免把另一知识点的作答记录带进来。
 * 答案比较只移除修订内的 unitId，保留文字、公式、代码和结构差异。
 */

import { canonicalAnswerV2Schema } from "./contracts/card-generation-v2-contracts.ts";
import { sha256Utf8V1, stableStringify } from "./content-hash.ts";

/** Compare the actual answer claim, without revision-local answer unit IDs.
 * A shared block can contain several different learning targets. Missing or
 * malformed legacy answers cannot establish equivalence. */
export function objectiveReuseClaimHashV2(answer: unknown): string | null {
  const parsed = canonicalAnswerV2Schema.safeParse(answer);
  if (!parsed.success) return null;
  const stripIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripIds);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "unitId").map(([key, child]) => [key, stripIds(child)]));
    return value;
  };
  return sha256Utf8V1(stableStringify(stripIds(parsed.data)));
}

/** 一颗既有目标在本篇里的锚点。**由读侧按 noteId 收窄后交给判据**（不归判据自己查）。 */
export interface ObjectiveReuseCandidateV2 {
  readonly objectiveId: string;
  /** 这颗目标在这篇里的来源块。空数组＝没有块锚（老数据），**不参与复用**。 */
  readonly blockIds: readonly string[];
  readonly knowledgeForm: string;
  readonly claimHash?: string | null;
}

export type ObjectiveReuseDecisionV2 =
  /** 确实新增，建一颗新的。 */
  | { readonly outcome: "create_new"; readonly reason: "no_match" | "ambiguous" | "different_form" | "no_block_anchor" | "unconfirmed_claim" }
  /** 落到既有那一颗上。 */
  | {
      readonly outcome: "reuse";
      readonly objectiveId: string;
      /** 判据那一档。写死成一个字面量而不是自由文本：它是**可枚举**的事实。 */
      readonly basis: "same_note_same_block_same_form";
      readonly evidence: {
        /** 新候选锚在哪些块上。 */
        readonly candidateBlockIds: readonly string[];
        /** 与既有那颗**共有**的那几个块——不是全部块，是交集。 */
        readonly sharedBlockIds: readonly string[];
        readonly knowledgeForm: string;
        readonly claimHash: string;
      };
    };

/**
 * 判一次复用。
 *
 * **纯函数**：不查库、不看模型输出、不读配置。读侧收窄、块锚映射、落库都在外面，
 * 所以这一份可以被小夹具直接钉住——而"两个都像时会不会偷偷选一个"这种问题，
 * 只有纯函数才答得清。
 *
 * `existing` 应当**已经按 (workspace, noteId) 收窄**（§4.2「默认去重范围是同工作区、
 * 同笔记」）。这一份不再核 noteId：核不了——它手里没有 noteId，核了就等于把
 * "读侧有没有收窄"这件事藏进一个看不见的参数里。收窄那一半由读侧负责，
 * 并由 `ObjectiveReuseCandidateV2` 不携带笔记身份，读侧必须完成收窄。
 */
export function decideObjectiveReuseV2(input: {
  /** 新候选锚定的块（简化链的 `sourceAtomIds` 经 sealed 清单定位到块）。 */
  readonly candidateBlockIds: readonly string[];
  /** 新候选自己的能力形态。 */
  readonly knowledgeForm: string;
  readonly candidateClaimHash?: string | null;
  readonly existing: readonly ObjectiveReuseCandidateV2[];
}): ObjectiveReuseDecisionV2 {
  const candidateBlocks = new Set(input.candidateBlockIds);
  // 没有块锚就没法判——这是"无法确定"，按 §4.2 **保留差异**。
  // 特别地：一个连块锚都没有的既有目标**不会被新候选认领**：认了就是把"不知道"
  // 当成"是同一条"。
  if (candidateBlocks.size === 0) return { outcome: "create_new", reason: "no_block_anchor" };

  const bySharedBlocks = input.existing
    // 形态不同直接出局（§4.2「不同能力维度仍可分别需要回访」）。放在交集之前判，
    // 是为了让"块一样但形态不同"落到 `different_form` 而不是"命中了但不敢用"。
    .filter((candidate) => candidate.knowledgeForm === input.knowledgeForm)
    .map((candidate) => ({
      candidate,
      shared: candidate.blockIds.filter((blockId) => candidateBlocks.has(blockId)),
    }))
    .filter((entry) => entry.shared.length > 0);

  if (bySharedBlocks.length === 0) {
    return {
      outcome: "create_new",
      // 形态不同与根本没交集是两件事，屏上与台账要能分开说——所以分两个 reason。
      reason: input.existing.some((candidate) => candidate.knowledgeForm !== input.knowledgeForm)
        ? "different_form"
        : "no_match",
    };
  }
  const confirmed = bySharedBlocks.filter(entry => input.candidateClaimHash
    && entry.candidate.claimHash === input.candidateClaimHash);
  if (confirmed.length === 0) return { outcome: "create_new", reason: "unconfirmed_claim" };
  if (confirmed.length > 1) {
    // **刻意不选**。两个都像就意味着"无法确定"，§4.2 写的是保留差异。
    // 选一个的后果不可发现：能力记录会记到另一件事上，而库里的目标 id 看不出错。
    return { outcome: "create_new", reason: "ambiguous" };
  }
  const hit = confirmed[0]!;
  return {
    outcome: "reuse",
    objectiveId: hit.candidate.objectiveId,
    basis: "same_note_same_block_same_form",
    evidence: {
      candidateBlockIds: [...input.candidateBlockIds],
      sharedBlockIds: hit.shared,
      knowledgeForm: input.knowledgeForm,
      claimHash: input.candidateClaimHash!,
    },
  };
}
