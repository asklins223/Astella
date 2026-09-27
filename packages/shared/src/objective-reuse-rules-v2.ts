/**
 * 同目标复用的**判据**（39d W7-5；39 §4.2 第三段、§9.5）。
 *
 * §4.2 写死了两句话，一句管"该复用"、一句管"不许复用"：
 *  - 「同一篇笔记已有目标时，新的轮次**先匹配和复用适用目标**，再创建确实新增的目标；
 *    仅重新组织路线、改变题面或改写目标显示名，**不另建目标**、卡片或日程。」
 *  - 「系统**无法确定**一个主张是否与历史相同时**保留差异**，不按标题相似自动继承
 *    能力证据。」以及「默认去重范围是同工作区、**同笔记**、同一可确认的目标及能力维度」。
 *
 * ## 锚点为什么是**块**（blockId），不是标题也不是语义指纹
 *
 * - **不是标题**：§4.2 明写「不按标题相似自动继承能力证据」。标题还是**可改的**
 *   （同一格里就写着"改写目标显示名不另建目标"），按它分组等于按可改的名字分组。
 * - **不是 `semanticTargetFingerprint`**：那份的哈希输入里含 `objectiveId`
 *   本身（`card-generation-v2-hashing.ts:29`），所以它**算不出两条目标相等**——
 *   `personal-binding-link-rules-v2.ts` 的头注已经把这句话记下来了。
 * - **是块**：简化链里每张候选都锚在**封存证据的块**上（`sourceAtomIds` 经 sealed
 *   清单定位到 blockId，见 `plan-assembly.ts`），而块是那一版正文里的稳定坐标。
 *   「同篇 ＋ 同块 ＋ 同形态」是 §4.2 说的"可确认"：它不猜内容像不像，只核对
 *   **出处是不是同一处**。
 *
 * ## 三条不许做的事写在这里
 *
 *  1. **≥2 个候选 ⇒ 不复用**。§4.2「无法确定时保留差异」——两个都像的时候选一个，
 *     就是在替她做一次她没授权的合并。宁可多建一颗目标（那条错是"多了一颗"，
 *     可发现），也不要错并（那条错是"能力记录记到了另一件事上"，**不可发现**）。
 *  2. **形态不同 ⇒ 不复用**，哪怕块完全一样。§4.2「不同能力维度仍可分别需要回访，
 *    例如记住定义与在综合情境中使用」；§9.1 也按维度执法（0287 的键带维度）。
 *  3. **判据要能复核**。交回的 `evidence` 记的是**判据输入**（块、形态、命中了谁），
 *     不是一句"判定为同一条"——哪天块变了或形态变了，这条记录读得出当初凭什么说
 *     它们是同一条。这与 0300 那张表的 `link_evidence` 同一纪律。
 *
 * ## 不在这一份做的事
 *
 * **能力证据不跟着搬**。复用的是**身份**（那颗目标是谁），不是"你已经会了"。
 * §4.2「不按标题相似自动继承能力证据」，§9.2 也把「活动回执／能力证据／安排回执」
 * 分成三种事实。所以这一份只回"该落到哪颗目标上"，一个字都不谈证据。
 */

/** 一颗既有目标在本篇里的锚点。**由读侧按 noteId 收窄后交给判据**（不归判据自己查）。 */
export interface ObjectiveReuseCandidateV2 {
  readonly objectiveId: string;
  /** 这颗目标在这篇里的来源块。空数组＝没有块锚（老数据），**不参与复用**。 */
  readonly blockIds: readonly string[];
  readonly knowledgeForm: string;
}

export type ObjectiveReuseDecisionV2 =
  /** 确实新增，建一颗新的。 */
  | { readonly outcome: "create_new"; readonly reason: "no_match" | "ambiguous" | "different_form" | "no_block_anchor" }
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
 * 并由 `ObjectiveReuseCandidateV2` 只有块与形态这件事逼着它必须收窄。
 */
export function decideObjectiveReuseV2(input: {
  /** 新候选锚定的块（简化链的 `sourceAtomIds` 经 sealed 清单定位到块）。 */
  readonly candidateBlockIds: readonly string[];
  /** 新候选自己的能力形态。 */
  readonly knowledgeForm: string;
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
  if (bySharedBlocks.length > 1) {
    // **刻意不选**。两个都像就意味着"无法确定"，§4.2 写的是保留差异。
    // 选一个的后果不可发现：能力记录会记到另一件事上，而库里的目标 id 看不出错。
    return { outcome: "create_new", reason: "ambiguous" };
  }
  const hit = bySharedBlocks[0]!;
  return {
    outcome: "reuse",
    objectiveId: hit.candidate.objectiveId,
    basis: "same_note_same_block_same_form",
    evidence: {
      candidateBlockIds: [...input.candidateBlockIds],
      sharedBlockIds: hit.shared,
      knowledgeForm: input.knowledgeForm,
    },
  };
}
