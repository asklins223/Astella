/**
 * 「补一节前置」的提案判据（39d W4-6 刀四·正面要求那一档；PRD §16.3、§5.3、§4.3）。
 *
 * ## 这一档原来缺什么
 *
 * `gap-help-policy.ts` 已经把停止规则判对了，`GAP_HELP_STOP_OPTIONS_V1` 里也已经有
 * `add_prerequisite` 这一档；但那四档摆出来之后，界面对这一档只能说一句"补一节前置还没
 * 接上"。缺的是**三样东西**，而这三样都不是界面文案：
 *
 *  1. **缺哪一个前置**（不是泛泛的"你可能缺前置"）；
 *  2. **从哪里补**（必须是本轮冻结材料里的东西，不能外求）；
 *  3. **新增多少学习量**——§16.3 的验收原话是"并**说明新增学习量**"，§4.3 是"新增明显
 *     增加负担或超出当前问题的内容时，提供'现在补／留到以后'"。没有这个数，那颗按钮就是
 *     一个没有代价的承诺，而 §5.3 明写"较大分支交给用户选择"。
 *
 * ## 三条不变量（写在这个文件里，而不是散在界面上）
 *
 *  - **只用本轮冻结材料里的块**。§5.3「解释依赖不足时不生成貌似确定的过程」——材料里没有
 *    可作前置的东西时，答案是 `none`，不是"帮你去别处找一个"。联网补基础课程是明确不在
 *    首期承诺内的扩展（§21）。
 *  - **已经讲过的块不算前置**。用户正在学的是这一轮的要点；把它再摆一次叫"换解释"，
 *    不叫"补前置"，而那已经是四档里的第一档 `switch_explanation` 了。两档内容重叠，
 *    用户点哪一格都得到同一个东西。
 *  - **候选只标"可能"**。§16.3 原文就是"系统提出**可能**缺少一个前置定义"，§5.3 也
 *    规定界面用"可能卡在……"、用户可以纠正"我不是这个意思"。所以 label 是提议不是
 *    诊断——它没有资格说"你缺 X"（D3 那条线：模型相似度只能提供建议，不能独立授权）。
 *
 * ## 为什么"学习量"是块数而不是字数
 *
 * 用户要判断的是"现在补还是留到以后"，她读的是**要读几段**，不是几个字。一个 2000 字的
 * 段落按字算像是大工程，按"一段"算是一步；后者才是她能拿来做决定的那个量。所以这里数
 * 的是"候选组里有几个可教要点"，规则写在 `countPrerequisiteStepsV1` 里，与 §18.4 那批
 * 冻结值同性质：阈值可由环境变量覆盖，逻辑只拿它比大小。
 */

/** 材料里的一格，带上"这一轮是不是已经用过"这个判断所需的那一个标记。 */
export type PrerequisiteCandidateBlockV1 = {
  readonly ordinal: number;
  readonly type: string;
  readonly text: string;
  /** 本轮已有教学引用过这一格（服务层读 `source_block_ordinals` 得出）。 */
  readonly usedByCurrentRound: boolean;
};

export type PrerequisiteProposalV1 =
  /** 材料里挑不出可作前置的东西。`reason` 用来对用户说不同的话，不是一句"没有"。 */
  | { readonly kind: "none"; readonly reason: "no_usable_material" | "nothing_beyond_current" }
  | {
      readonly kind: "candidate";
      /** 措辞是"可能缺"而不是"你缺"（见文件头第三条不变量）。 */
      readonly label: string;
      /** 依据：候选组里的块序号，界面要点得开、用户要核得对。 */
      readonly evidenceBlockOrdinals: number[];
      /** 新增学习量＝候选组里的可教要点条数。§16.3 验收要说明的那一个数。 */
      readonly estimatedSteps: number;
      /** §5.3「较大分支交给用户选择」：超阈值就要她选"现在补／留到以后"。 */
      readonly largeBranch: boolean;
    };

/**
 * 一格算几个"可教要点"。
 *
 * 标题与列表项各算一（它们本身就是被讲解的单位）；普通段落不算要点，但作为候选组的**一
 * 段**要被读一次——所以在"一个连续段"里它贡献 1。这里返回 0 是刻意的：调用方把它和
 * 标题/列表项一起累加时，段落的那 1 由"段"这一层单独计。
 */
export function countPrerequisiteStepsV1(blocks: readonly PrerequisiteCandidateBlockV1[]): number {
  let steps = 0;
  for (const block of blocks) {
    if (block.text.trim().length === 0) continue;
    if (block.type === "heading" || block.type === "listItem") steps += 1;
  }
  // 整组至少要读一段：全是散段落的材料也是"补一节"，不是"什么也没有"。
  return Math.max(steps, blocks.some((block) => block.text.trim().length > 0) ? 1 : 0);
}

/** 少于这个长度的块不作为候选：一句话撑不起"一节前置"，而空块更撑不起。 */
const MIN_CANDIDATE_CHARS_V1 = 24;

/**
 * 提案判据（纯函数：DB、冻结读取、阈值 env 都在调用方那一侧）。
 *
 * 候选怎么选：**取还没用过的、最靠前的连续一撮**。靠前是因为前置在材料里通常写在前面
 * （定义先于用法）；"连续"是因为一节前置往往是一段而不是散落三处的句子。最多取三块，
 * 再多就不是"补一节"而是"上一堂课"了——那属于 §5.3 明写不该自动扩张的分支。
 */
export function proposePrerequisiteV1(input: {
  readonly blocks: readonly PrerequisiteCandidateBlockV1[];
  /** §18.4 冻结项：超过这个步数就要用户选"现在补／留到以后"。 */
  readonly largeBranchThreshold: number;
}): PrerequisiteProposalV1 {
  const usable = input.blocks.filter((block) => block.text.trim().length >= MIN_CANDIDATE_CHARS_V1);
  if (usable.length === 0) return { kind: "none", reason: "no_usable_material" };

  const unused = usable.filter((block) => !block.usedByCurrentRound);
  if (unused.length === 0) return { kind: "none", reason: "nothing_beyond_current" };

  const head = unused[0]!;
  const picked: PrerequisiteCandidateBlockV1[] = [head];
  for (const block of unused.slice(1)) {
    // 连续：序号必须接得上，断开就不再是"一节"而是两处不相干的补充。
    if (block.ordinal !== picked[picked.length - 1]!.ordinal + 1) break;
    picked.push(block);
    if (picked.length >= 3) break;
  }

  const estimatedSteps = countPrerequisiteStepsV1(picked);
  return {
    kind: "candidate",
    label: `可能还缺一节前置：${head.text.trim().slice(0, 60)}${head.text.trim().length > 60 ? "…" : ""}`,
    evidenceBlockOrdinals: picked.map((block) => block.ordinal),
    estimatedSteps,
    largeBranch: estimatedSteps > input.largeBranchThreshold,
  };
}

// ─── 冻结值（§18.4）────────────────────────────────────────────────────

/**
 * 「较大分支」的步数阈值起点值。
 *
 * 与 `gap-help-policy.ts` 的 `DEFAULT_GAP_HELP_STOP_THRESHOLD_V1` 同一形状：它是**产品参数**
 * 、试用前冻结项，环境变量是给冻结留的口而不是界面设置项；坏值回落默认并保持可预测。
 * 默认 2 的理由：补一两个要点属于"顺手补上"，三个及以上已经是"要不要现在停下来上一节课"。
 */
export const DEFAULT_PREREQUISITE_LARGE_BRANCH_STEPS_V1 = 2;

const ENV_PREREQUISITE_LARGE_BRANCH = "NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS";

export function prerequisiteLargeBranchThresholdV1(): number {
  const raw = process.env[ENV_PREREQUISITE_LARGE_BRANCH]?.trim();
  if (!raw) return DEFAULT_PREREQUISITE_LARGE_BRANCH_STEPS_V1;
  const parsed = Number(raw);
  // `0` 是合法值（任何多于一格的都算"较大分支"），只有负数与非整数按坏值处理。
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_PREREQUISITE_LARGE_BRANCH_STEPS_V1;
  return parsed;
}
