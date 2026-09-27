/**
 * 学习判定的**争议与更正**裁决（39d W5-5；39 §14.2、§16.11、§16.22、§16.25）。
 *
 * 为什么单独一份纯函数：§14.2 的原话是"用户提出争议后……**不能反复要求用户接受同一判定**"，
 * 而"反复"的形状不是某一个 bug，是**多处各自解释**。今天只有结算与结果页两处会读
 * "这条判定现在算不算数"，明天复核台、历史与星图也要读。规则写在调用方 = 抄 N 份，
 * 少抄一份就出现"同一个争议在结算页被压住、在历史页又被当成定论"。
 * 与 `review-authorization-rules-v2`（§9.1 那张规则表）同一条纪律：执法点要少，
 * 判据要能被逐条单测。
 *
 * 这里只有**判断**，没有读写：争议现在是什么状态、复核做过没有、更正写过没有，
 * 由 `apps/api/src/modules/learning-runs/run-disputes.ts` 查出来交进来。
 *
 * §14.2 的六条规则各自对应下面一段函数；§16.25 把其中最容易混的两件事拆成不可覆盖的
 * 不变量（`correctionBackdatesFirstAnswerV2` / `correctionOverwritesFirstAnswerV2`），
 * 它们是**返回常量的判据而不是判断**：这两条如果哪天能返回 false，§16.25 就破了，
 * 而那种破损在集成测试里很难看出来，所以让它在单测里一眼可见。
 */
import { z } from "zod";

// ─── 词汇（§14.2「用户可以报告"解释不对""题目有问题""我的意思被误解"」）────────────

/**
 * 争议的种类。四种都**不预设**系统错了——§16.11 的验收是"用户提出一种不同解释时，
 * 不因表述不一致直接判错"，所以 `misunderstood` 与 `item_faulty` 都可能是用户自己
 * 想错了。把它们压成一个 `dispute` 布尔值会让复核台无从下手：题目有问题要去核题面，
 * 我的意思被误解要去核原回答，方向不同。
 */
export type AssessmentDisputeKindV2 =
  | "explanation_faulty" // 解释不对
  | "item_faulty" // 题目有问题
  | "misunderstood" // 我的意思被误解
  | "misjudged"; // 系统判错了

/**
 * 一次重新检查的三个结论（§14.2："展示**维持／修正／仍无法判断**的理由"）。
 *
 * 三个都不能省：`upheld` 是"看过原题原答之后原判定仍成立"，`corrected` 是"原回答
 * 本身已满足原评分条件、原判被纠正"，`undetermined` 是"仍然不可靠，维持争议状态，
 * **不强行选一方作为事实**"。少了 `undetermined` 就会逼系统二选一，那正是 §14.2
 * 明写不许做的事。
 */
/**
 * 复核结论，**四档**（2026-09-27 由三档扩为四档；39 §14.2）。
 *
 * 前三档对应"原判对不对"，第四档对应"**原判太宽松**"——它此前无处可归：
 * 真模型实测遇到过这一种（原判 `covered`，原回答其实只有"记不清了"，
 * 复核逐条判 `missing`）。三档里它只能落进 `undetermined`，而那是**另一句话**：
 * `undetermined`＝复核自己也判不准（§14.2"不强行选一方"），
 * `over_broad`＝复核**可靠地**说原判把没答对的算成了答对。
 * 两者对用户是两件不同的事：一个是"系统还没想清楚"，一个是"上次说答对的那次不算"。
 *
 * - `upheld`：原判站得住（逐条无变化）
 * - `corrected`：原判**偏严**——原判说没达成，复核说达成了（全部变化都是升档）
 * - `over_broad`：原判**过宽**——原判说达成，复核说没达成（全部变化都是降档）
 * - `undetermined`：判不出来（升档与降档混在一起、逐条 id 对不齐、或模型自述与逐条之差打架）
 */
export type AssessmentDisputeRecheckOutcomeV2 =
  | "upheld"
  | "corrected"
  | "over_broad"
  | "undetermined";

/** 争议行自身的生命周期。`recheck_*` 三态与 `recheck_outcome` 一一对应，不重复表达。 */
export type AssessmentDisputeStatusV2 =
  | "open" // 已受理，尚未复核
  | "recheck_upheld" // 复核维持
  | "recheck_corrected" // 复核修正原判（原判偏严）
  | "recheck_over_broad" // 复核认为原判过宽（**这一档有自己的状态名**，不复用 undetermined）
  | "recheck_undetermined" // 复核仍无法判断（**争议保持未决**，不是关闭）
  | "closed_held"; // 本人选择结束并把该项暂不安排

/**
 * 更正的两种形状（§16.25：第一位用户原答案**包含**必要条件、系统漏判；第二位用户
 * 原来**缺少**条件、看到反馈后才补充）。
 *
 * 两者在库上是**不同形状的更正记录**，不是同一条的两个取值：前者纠正的是**系统误判**，
 * 依据仍然是同一份原回答；后者形成的是**新的解释或练习**，依据是用户后来补的答案。
 * §14.2 末段明写"前者纠正系统误判，后者形成新的解释或练习，均保留第一次原文"——
 * 合成一种形状就必然要靠一个布尔去猜，而那个布尔正是 §16.25 要防的"混算"。
 */
export type AssessmentCorrectionKindV2 = "system_misjudgment" | "user_supplement";

// ─── 规则一：一次重新检查，争议不形成死循环（§16.22）────────────────────

/**
 * §16.22 的验收原话是"本批不自动变长，**争议不形成死循环**"。
 *
 * 判据只问"这一次判定上有没有已经落库的复核结果"，不问原因、不看是谁触发的：
 * 允许"维持之后用户再补充说明"是**产品**要的（§14.2："用户提出争议后，可补充说明"），
 * 但那之后**不得再触发第二次重新检查**——所以闸门是"复核已经发生过"，不是"结果是否有用"。
 * 结果是 `upheld` 也不例外：让系统可以对着同一次回答反复重检，就是这条规则要挡的死循环。
 *
 * 返回 `null` 表示可以复核；返回原因时调用方要把既有回执原样交回，**不得**当成新一次。
 */
export function decideDisputeRecheckV2(input: {
  readonly disputeClosed: boolean;
  readonly recheckPerformed: boolean;
}): { readonly allowed: true } | {
  readonly allowed: false;
  readonly reasonCode: "dispute_closed" | "recheck_already_performed";
} {
  if (input.disputeClosed) return { allowed: false, reasonCode: "dispute_closed" };
  if (input.recheckPerformed) return { allowed: false, reasonCode: "recheck_already_performed" };
  return { allowed: true };
}

// ─── 规则二：待复核时不持续放大结论（§14.2）────────────────────────────────

/**
 * §14.2："待复核时**不持续放大结论**"；§14.3 对可疑断言也是同一句
 * "不能因为用户准确复述原句就增加正式正确证据或推进该主张的记忆间隔"。
 *
 * 三个取值对应结算与推荐对**这一次观察**能做的三件事：
 *  - `withhold_conclusion`：结论保留可查，但不据此推进间隔、不作为负面推荐依据
 *    （§14.2 末句"未经确认的争议结果不继续作为负面推荐依据"）；
 *  - `apply_correction_once`：复核结论是"修正"——写**一条**更正记录（不是改原判定），
 *    并且只许应用一次（§16.25 的"不倒算"在数据面上的形状）；
 *  - `use_as_is`：无活争议，或复核结论是"维持"——按原判定走。
 *
 * `recheck_corrected` 仍然**不**直接"用修正后的结果去推进间隔"：§9.6 要求"需要重新
 * 计算时仍经唯一调度服务，基于全部适用事实和当前授权给出一次明确回执"，所以这一发
 * 交给调度边界重算，而不是就地插一条安排。
 */
export function decideDisputedObservationV2(input: {
  readonly hasLiveDispute: boolean;
  readonly recheckOutcome: AssessmentDisputeRecheckOutcomeV2 | null;
  readonly correctionAlreadyApplied: boolean;
}): {
  readonly action: "use_as_is" | "withhold_conclusion" | "apply_correction_once";
  /** §14.2"问题产物对本人暂停复用"：这一发要顺带交回去的话，就是"别再用这题了"。 */
  readonly suspendsArtifactReuse: boolean;
  readonly reasonCode: string;
} {
  if (!input.hasLiveDispute) {
    return { action: "use_as_is", suspendsArtifactReuse: false, reasonCode: "no_live_dispute" };
  }
  if (input.recheckOutcome === null) {
    return { action: "withhold_conclusion", suspendsArtifactReuse: true, reasonCode: "awaiting_recheck" };
  }
  if (input.recheckOutcome === "undetermined") {
    // 维持争议状态，**不强行选一方**（§14.2 末句）。所以它仍然不发结论。
    return { action: "withhold_conclusion", suspendsArtifactReuse: true, reasonCode: "recheck_undetermined" };
  }
  if (input.recheckOutcome === "over_broad") {
    // 原判过宽：**绝不能走 `use_as_is`**。那一档的字面意思是"原判站得住，照用"，
    // 而这一档恰恰是原判被复核**否定**了——照用等于让一个已被推翻的"这是独立表现"
    // 去推进复习间隔，那是把系统自己的错误变成用户的进度。
    //
    // 也**不是** `apply_correction_once`：那一档是"把原判改成达成"，而这里没有
    // 任何可升档的东西（全部变化都是降档），没有可写的更正。
    // 所以：扣住这一次观察的结论，让它不进排期；争议保持未决，用户仍可补充说明、
    // 或按 §16.22 结束并暂不安排。reasonCode 单独一档，屏上要说得出区别。
    return { action: "withhold_conclusion", suspendsArtifactReuse: true, reasonCode: "recheck_original_too_broad" };
  }
  if (input.recheckOutcome === "upheld") {
    return { action: "use_as_is", suspendsArtifactReuse: true, reasonCode: "recheck_upheld" };
  }
  // corrected：更正记录只许应用一次。第二次进来（重试、迟到回执）必须回到
  // "已经应用过"，否则同一次更正会被消费两次，也就是重复计学习。
  if (input.correctionAlreadyApplied) {
    return { action: "withhold_conclusion", suspendsArtifactReuse: true, reasonCode: "correction_already_applied" };
  }
  return { action: "apply_correction_once", suspendsArtifactReuse: true, reasonCode: "recheck_corrected" };
}

// ─── 规则三：更正不重写历史原回答（§14.2、§16.25）────────────────────────

/**
 * §14.2："更正以新的有理由记录表达，**不重写历史原回答**"。
 *
 * 常量判据，不是判断：调用方（服务层）照它写代码，单测照它钉住这个不变量。
 * 写成 `true` 而不是由入参推导，是为了让它在"入参写错"时仍然报出矛盾——
 * 任何一次试图让更正覆盖原回答的改法，都会在这条单测上立刻红。
 */
export function correctionOverwritesFirstAnswerV2(
  _kind: AssessmentCorrectionKindV2,
): false {
  return false;
}

/**
 * §14.2 末段与 §16.25："**不能倒算第一次已答对**"；用户的补充"是新材料，不覆盖第一次
 * 回答，也不能倒算第一次已答对"。
 *
 * 与上一条同形：两种更正都不倒算。区别在于第二种**另外**形成一次新的表现记录
 * （§16.25："后者保留原回答并记录补充后的表现"）——那是"新增一次观察"，
 * 而不是"把第一次那次改成答对"。
 */
export function correctionBackdatesFirstAnswerV2(
  _kind: AssessmentCorrectionKindV2,
): false {
  return false;
}

/**
 * §16.25："用户补答"这一档**必须**挂一份新的作答产物。
 *
 * 判据是给数据面用的：没有 `supplement_artifact_id` 的 `user_supplement` 更正
 * 无法说清"补充后的表现"是哪一次表现，那种行会让 §14.1"每个可观察目标至少保留：
 * 观察时间、使用的内容、任务与回答"这一格读不出来。返回原因码而不是抛错，
 * 便于路由翻成 422 而不是 500。
 */
export function decideSupplementArtifactRequiredV2(input: {
  readonly kind: AssessmentCorrectionKindV2;
  readonly supplementArtifactId: string | null;
}): { readonly required: false } | { readonly required: true; readonly provided: boolean } {
  if (input.kind !== "user_supplement") return { required: false };
  return { required: true, provided: Boolean(input.supplementArtifactId) };
}

// ─── 规则四：仍有争议时可结束并暂不安排（§14.2）────────────────────────────

/**
 * §14.2："仍有争议时可结束并将该项**暂不安排**，不能反复要求用户接受同一判定"。
 *
 * 走的是 0295 那张目标级排除（`objective_review_holds_v2`），不是新的一套：
 * §9.1 把它定义为"优先于笔记和卡片授权"的持续排除，争议收尾要的就是这一个语义。
 * 复用它的另一个好处是"结束并暂不安排"会**连带撤下此刻已排着的那一条待办**
 * （`holdObjectiveFromReviewV2` 已有这个行为），不必在这里再抄一遍。
 *
 * 排除**按目标**生效，所以争议指向哪个目标是判据的一部分；判不出来（那次观察没有
 * 挂目标）时只能结束争议而**不能**顺手动别人的安排——返回 `close_without_hold`。
 *
 * 第三档 `hold_unavailable`：本人要暂不安排，但这一发**排不出**可挂的笔记
 * （排除表的 `note_id` 不可空，而手动／导入来源的目标没有"这一篇笔记"）。
 * 单独一档而不是静默降级成 `close_without_hold`——那会让界面显示"已暂不安排"而库里
 * 什么都没写，是假回执；也不抛错把整个结束动作卡死：争议**照样结束**，只把没能落排除
 * 这件事如实说出来。§14.2 的出口是"可结束"，让用户走不掉是更坏的失败。
 */
export function decideDisputeCloseV2(input: {
  readonly objectiveId: string | null;
  readonly userAskedForHold: boolean;
  /** 能不能挂上一篇真笔记（`origin_kind='note'` 的绑定）。缺省按"能"处理。 */
  readonly noteBindingAvailable?: boolean;
}): {
  readonly outcome: "hold_objective" | "close_without_hold" | "hold_unavailable";
} {
  if (!input.objectiveId || !input.userAskedForHold) return { outcome: "close_without_hold" };
  if (input.noteBindingAvailable === false) return { outcome: "hold_unavailable" };
  return { outcome: "hold_objective" };
}

// ─── 规则五：争议是个人数据（§14.4）────────────────────────────────────────

/**
 * §14.4："每个人的作答、安排、提示暴露、学习位置和学习回写建议为**个人数据**"。
 *
 * 争议报告的是"我为什么觉得这次判得不对"——同一个人对同一题可能开两次、也可能撤掉，
 * 另一位成员看不到、也不该被这条记录影响。判据把"能不能读"这件事收在
 * (workspace, user) 两列上，与表上的 RLS 策略同一条；共享材料侧的撤回与修改
 * 仍按权限另走，**不由这一发代替**（§14.2 末段）。
 */
export function disputeIsPersonalOnlyV2(): {
  readonly readableByAuthorOnly: true;
  readonly affectsOtherMembersEvidence: false;
  readonly sharedMaterialWithdrawalHandledElsewhere: true;
} {
  return {
    readableByAuthorOnly: true,
    affectsOtherMembersEvidence: false,
    sharedMaterialWithdrawalHandledElsewhere: true,
  };
}

// ─── 规则六：复核结论由「逐条判定之差」定档（§14.2、§8.6、§16.25）────────

/**
 * 比对用的最小形状：只要 id 与判定，理由与出处都归调用方。
 *
 * 一次重新检查的**报告 wire 合同**在下面 wire 那一节（`disputeRecheckReportV2Schema`）——
 * 它要用到本节之后才声明的 `assessmentDisputeRecheckOutcomeV2Schema`，放在这里会在
 * 模块加载期就撞 TDZ（"红在文件没加载"那一族）。
 */
export interface DisputeRecheckVerdictPairV2 {
  readonly rubricItemId: string;
  readonly verdict: string;
}

/**
 * 复核者逐条重判的结果与原判之差（`derivation` 那条判据的原料）。
 *
 * 三档的来历只有一句话：**"修正"必须是"原来没达成的那些，原回答其实达成了"。**
 *  - 一条都没变 ⇒ 维持（§14.2「维持」）。
 *  - 有变化，且**每一条**都变成 `covered` ⇒ 修正（§14.2 末段「若重新检查发现原回答
 *    本身已满足原评分条件，应以更正记录修正原判」）。只增不减是"纠正系统误判"的
 *    确切形状：更正记录不该顺手引入一条新的、更严的指控。
 *  - 其它任何形状（有的变成达成、有的反而变差；或干脆只是措辞不同）⇒ 仍无法判断。
 *    §14.2「判断仍不可靠时维持争议状态，**不强行选一方作为事实**」——混合的那一档
 *    正是"强行选一方"最像的地方。
 *
 * 逐条 id 集合不齐（多一条、少一条、重复）也归第三档：判不出差就等于没有结论，
 * 而"没有结论"在这一层与"仍无法判断"是同一件事。
 */
export function decideRecheckVerdictDiffV2(input: {
  readonly originalVerdicts: readonly DisputeRecheckVerdictPairV2[];
  readonly recheckedVerdicts: readonly DisputeRecheckVerdictPairV2[];
}): {
  readonly derivation: "upheld" | "corrected" | "over_broad" | "undetermined";
  /** 逐条 id 集合对不齐（多一条／少一条／重复）：连"之差"都算不出来。 */
  readonly shapeMismatch: boolean;
  readonly changedUnitIds: readonly string[];
  readonly upgradedUnitIds: readonly string[];
  readonly notCoveredUnitIds: readonly string[];
} {
  const original = new Map(input.originalVerdicts.map((v) => [v.rubricItemId, v.verdict]));
  const rechecked = new Map(input.recheckedVerdicts.map((v) => [v.rubricItemId, v.verdict]));
  const shapeMatches =
    original.size === rechecked.size
    && input.originalVerdicts.length === original.size
    && input.recheckedVerdicts.length === rechecked.size
    && [...rechecked.keys()].every((id) => original.has(id));

  if (!shapeMatches) {
    return {
      derivation: "undetermined",
      shapeMismatch: true,
      changedUnitIds: [],
      upgradedUnitIds: [],
      notCoveredUnitIds: [],
    };
  }

  const changed: string[] = [];
  const upgraded: string[] = [];
  const notCovered: string[] = [];
  for (const [unitId, next] of rechecked) {
    const previous = original.get(unitId);
    if (previous === next) continue;
    changed.push(unitId);
    if (next === "covered") upgraded.push(unitId);
    else notCovered.push(unitId);
  }
  changed.sort();
  upgraded.sort();
  notCovered.sort();

  if (changed.length === 0) {
    return { derivation: "upheld", shapeMismatch: false, changedUnitIds: changed, upgradedUnitIds: [], notCoveredUnitIds: [] };
  }
  if (notCovered.length === 0 && upgraded.length > 0) {
    return { derivation: "corrected", shapeMismatch: false, changedUnitIds: changed, upgradedUnitIds: upgraded, notCoveredUnitIds: [] };
  }
  // 全是降档 ⇒ **原判过宽**。与 `corrected` 严格对称：那一档是"原判偏严"，
  // 这一档是"原判偏松"。两者都必须单独成档——混进 `undetermined` 就等于把
  // 「系统确认上次判宽了」说成「系统还没想清楚」，而用户该做的两件事完全不同。
  if (upgraded.length === 0 && notCovered.length > 0) {
    return { derivation: "over_broad", shapeMismatch: false, changedUnitIds: changed, upgradedUnitIds: [], notCoveredUnitIds: notCovered };
  }
  return { derivation: "undetermined", shapeMismatch: false, changedUnitIds: changed, upgradedUnitIds: upgraded, notCoveredUnitIds: notCovered };
}

/**
 * 真正落库的那一档：**模型说的** 对上 **逐条之差推出来的**。
 *
 * §14.2 明写三个结论都要能展示，而"展示"的前提是它站得住。模型自己说的话不是证据，
 * 它逐条判了什么才是——所以：
 *
 *  - 两者一致 ⇒ 照记那一档，`disagreementNote` 为空串（理由直接用复核者自己那一句）；
 *  - 两者不一致 ⇒ **记「仍无法判断」**，并交回一句要接在理由后面的说明。既不把没依据
 *    的"维持／修正"放过去（那是假回执：屏上写"已修正"而库里一条判定都没变），也不把
 *    复核者的诚实自述推翻（§14.2 要的那扇出口必须一直开着）。
 *
 * 记「仍无法判断」不是失败：那一档正是 §14.2 规定的行为，而且它不是死路——用户
 * 可以补充说明、可以结束并暂不安排（§16.22 的出口）。
 */
export function decideRecheckOutcomeV2(input: {
  readonly claimed: AssessmentDisputeRecheckOutcomeV2;
  readonly originalVerdicts: readonly DisputeRecheckVerdictPairV2[];
  readonly recheckedVerdicts: readonly DisputeRecheckVerdictPairV2[];
}): {
  readonly outcome: AssessmentDisputeRecheckOutcomeV2;
  readonly derivation: "upheld" | "corrected" | "over_broad" | "undetermined";
  readonly disagrees: boolean;
  /** 接在复核者自己那一句理由**后面**的话；一致时为空串。 */
  readonly disagreementNote: string;
} {
  const diff = decideRecheckVerdictDiffV2(input);
  if (diff.derivation === input.claimed) {
    return { outcome: input.claimed, derivation: diff.derivation, disagrees: false, disagreementNote: "" };
  }
  const upgraded = diff.upgradedUnitIds.length;
  const notCovered = diff.notCoveredUnitIds.length;
  const summary = diff.shapeMismatch
    ? "复核给出的逐条判定与原判对不上号（条数或 id 不齐）"
    : [
      `${diff.changedUnitIds.length} 条逐条判定发生变化`,
      upgraded > 0 ? `其中 ${upgraded} 条改为达成` : "",
      notCovered > 0 ? `${notCovered} 条不是达成` : "",
    ].filter((part) => part.length > 0).join("、");
  return {
    outcome: "undetermined",
    derivation: diff.derivation,
    disagrees: true,
    disagreementNote: `（附：${summary}，与复核自己说的结论对不上；按「不强行选一方」记为仍无法判断）`,
  };
}

// ─── wire 合同（路由与桌面共用）────────────────────────────────────────────
const isoTimestampV2Schema = z.string().datetime({ offset: true });

export const assessmentDisputeKindV2Schema = z.enum([
  "explanation_faulty",
  "item_faulty",
  "misunderstood",
  "misjudged",
]);
export type AssessmentDisputeKindV2Wire = z.infer<typeof assessmentDisputeKindV2Schema>;

export const assessmentDisputeRecheckOutcomeV2Schema = z.enum([
  "upheld",
  "corrected",
  "over_broad",
  "undetermined",
]);
export type AssessmentDisputeRecheckOutcomeV2Wire = z.infer<
  typeof assessmentDisputeRecheckOutcomeV2Schema
>;

/**
 * 争议状态的 zod 那一档，**只在读侧用**（写侧的状态由服务端按复核结论推进，
 * 不接受调用方指定——否则就能凭空写出一个"已结束"来结束掉别人的争议）。
 *
 * 单独导出而不是就地内联在 `assessmentDisputeViewV2Schema` 里：0296 的
 * `adv2_status_chk` 是这五档的抄本，`assessment-dispute-kinds.test.ts` 要把三处
 * 一次对齐，内联的那一份它抓不到。
 */
export const assessmentDisputeStatusV2Schema = z.enum([
  "open",
  "recheck_upheld",
  "recheck_corrected",
  "recheck_over_broad",
  "recheck_undetermined",
  "closed_held",
]);
export type AssessmentDisputeStatusV2Wire = z.infer<typeof assessmentDisputeStatusV2Schema>;

export const assessmentCorrectionKindV2Schema = z.enum([
  "system_misjudgment",
  "user_supplement",
]);

/**
 * 一次重新检查里**每条 rubric 的独立判定**。取值与开放回答评估那条 critic 的
 * 枚举同形（`run-critic.ts` 的 `RubricVerdictOutput.verdict`）——不是抄，是同一件
 * 东西：判"这一条评分条件被答案覆盖了没有"。换成另一套取值就会出现"复核说达成、
 * 原判说没达成"这种没法比的形状，`decideRecheckVerdictDiffV2` 的"之差"也就无从算起。
 */
export const disputeRecheckUnitVerdictV2Schema = z.enum([
  "covered",
  "partial",
  "missing",
  "contradicted",
  "not_assessable",
]);
export type DisputeRecheckUnitVerdictV2 = z.infer<typeof disputeRecheckUnitVerdictV2Schema>;

/**
 * **一次重新检查的报告 wire 合同**：三档结论 ＋ 一句理由 ＋ 逐条判定。
 *
 * 逐条判定必填（`.min(1)`）而不是可选：§14.2 要展示的是"基于原题、原回答和依据"
 * 得出的理由，而一个没有任何逐条依据的"我判你错了"无法与原判对照——定档判据
 * （`decideRecheckVerdictDiffV2`）完全建立在逐条判定上。§8.6「不得把同一次生成的
 * 自评直接当成独立评估」在这里也有形状：复核者交的是**它自己逐条重判的结果**，
 * 不是把原判抄一遍或换个说法。
 */
export const disputeRecheckReportV2Schema = z.strictObject({
  outcome: assessmentDisputeRecheckOutcomeV2Schema,
  reason: z.string().min(1).max(2000),
  verdicts: z.array(z.strictObject({
    rubricItemId: z.string().min(1),
    verdict: disputeRecheckUnitVerdictV2Schema,
    unitReason: z.string().min(1).max(500),
  })).min(1).max(80),
});
export type DisputeRecheckReportV2 = z.infer<typeof disputeRecheckReportV2Schema>;

/** 开一份争议。`statement` 是必填：没有理由的"我不同意"没法进复核。 */
export const openAssessmentDisputeV2Schema = z.strictObject({
  assessmentId: z.string().uuid(),
  kind: assessmentDisputeKindV2Schema,
  statement: z.string().min(1).max(2000),
});
export type OpenAssessmentDisputeV2Input = z.infer<typeof openAssessmentDisputeV2Schema>;

/** 补充说明。§14.2 明写这是允许的，且**不重开**已落库的复核。 */
export const submitDisputeSupplementV2Schema = z.strictObject({
  supplement: z.string().min(1).max(2000),
});
export type SubmitDisputeSupplementV2Input = z.infer<typeof submitDisputeSupplementV2Schema>;

/**
 * 一次重新检查的落库形状。
 *
 * `reason` 必填：§14.2 要求"**展示**维持／修正／仍无法判断的**理由**"，
 * 交不出一句话就等于没展示。`reportHash` 必填，同 `learning_assessments` 的
 * 终态要求（§12.4 fail closed）——理由要能被追溯到哪一次复核产物。
 */
export const completeDisputeRecheckV2Schema = z.strictObject({
  outcome: assessmentDisputeRecheckOutcomeV2Schema,
  reason: z.string().min(1).max(2000),
  reportHash: z.string().min(1).max(128),
});
export type CompleteDisputeRecheckV2Input = z.infer<typeof completeDisputeRecheckV2Schema>;

/** 写一条更正。`kind` 决定 `supplementArtifactId` 是否必填（见上面的规则三）。 */
export const recordAssessmentCorrectionV2Schema = z.strictObject({
  kind: assessmentCorrectionKindV2Schema,
  reason: z.string().min(1).max(2000),
  /** `user_supplement` 必填：这次"补充后的表现"是哪一次作答。 */
  supplementArtifactId: z.string().uuid().nullish(),
  correctedRubricResults: z.array(z.unknown()).max(200).default([]),
});
export type RecordAssessmentCorrectionV2Input = z.infer<
  typeof recordAssessmentCorrectionV2Schema
>;

/** 结束争议。`holdObjective` 是"把该项暂不安排"那颗按钮（§14.2）。 */
export const closeAssessmentDisputeV2Schema = z.strictObject({
  holdObjective: z.boolean().default(false),
  note: z.string().max(500).optional(),
});
export type CloseAssessmentDisputeV2Input = z.infer<typeof closeAssessmentDisputeV2Schema>;

// ─── 桌面侧要发的**三条请求体** ────────────────────────────────────────────

/**
 * 与服务端那份同形，但在这里另起一个名字：IPC 合同是渲染层唯一看得见的形状，
 * 它必须自带一份，缺字段时渲染层先红，而不是运行时从主进程报一个没有上下文的 400。
 * （与 `review-queue-v2-contracts.ts` 里 `objectiveHoldCommandV2Schema` 同一个理由。）
 *
 * `assessmentId` 在**每一条**上而不是只放在外层：§14.4「争议是个人数据」，读别人的
 * 那一判定服务端只能回 404，把这个 id 放在信封外层会让它看起来像是可以复用的
 * 「当前判定」，而它其实每次都指向一条**具体的、可能被遮蔽的**历史判定。
 */
export const openAssessmentDisputeCommandV2Schema = openAssessmentDisputeV2Schema;
export type OpenAssessmentDisputeCommandV2 = z.infer<typeof openAssessmentDisputeCommandV2Schema>;

export const supplementAssessmentDisputeCommandV2Schema = z.strictObject({
  assessmentId: z.string().uuid(),
  supplement: z.string().min(1).max(2000),
});
export type SupplementAssessmentDisputeCommandV2 = z.infer<
  typeof supplementAssessmentDisputeCommandV2Schema
>;

/**
 * 「结束争议」＋「把该项暂不安排」是**一颗按钮上的两格**，不是两颗按钮
 * （§14.2：「仍有争议时可结束并将该项暂不安排」）。
 *
 * `holdObjective: true` 而服务端判出 `hold_unavailable` 时，那一格**照常结束争议**、
 * 只把没能落排除这件事如实回来说明——所以这条命令**不带 noteId**：排除的可用性由
 * 服务端按目标自己的绑定判断（`decideDisputeCloseV2` 的 `noteBindingAvailable`），
 * 渲染层自造一个「当前笔记」塞进去只会变成第二个可能说谎的来源。
 */
export const closeAssessmentDisputeCommandV2Schema = z.strictObject({
  assessmentId: z.string().uuid(),
  holdObjective: z.boolean().default(false),
  note: z.string().max(500).optional(),
});
export type CloseAssessmentDisputeCommandV2 = z.infer<typeof closeAssessmentDisputeCommandV2Schema>;

// ─── 桌面侧的**四条回执**（`run-dispute-routes.ts` 逐条同形）────────────────

/** 开一份争议。`created: false` = 原来就开着这一份（幂等回执，不是新一次）。 */
/**
 * 开争议的回执，**拆成两步**（§10.3「区分『当时的结算』与『后续确认」」）。
 *
 * ## 为什么拆
 *
 * 这一发会**等**那一次系统复核跑完（真模型实测 2.8–3.0 秒）。两件事发生在同一发里，
 * 而它们的性质完全不同：
 *  - 「异议记下了」＝ **当时的结算**：用户按了按钮，事实立刻成立；
 *  - 「复核怎么看」＝ **后续确认**：它需要一次模型调用，可能成功、可能跳过、可能失败。
 *
 * 把两者塞进一个扁平的 `status` 字段，就会有两个后果：①用户等 3 秒期间不知道自己按的
 * 那一下有没有生效（于是会重复点，而重复点就是 §16.22 那个可重复动作）；②复核失败时
 * 那一发要么整体报错、要么假装成功——前者让用户以为异议没记下来，后者是假回执。
 *
 * ## 不做成 fire-and-forget
 *
 * 挂成后台 job、立即回执，屏上那颗按钮就会变成一个**能被按的重复动作**：
 * 按一次开一份争议、按两次开两份，§16.22 的死循环立刻有了一个新入口。
 * 所以这里保留等待，只把**回执的形状**拆开：第一步永远先成立，第二步自己带时间戳。
 */
export const openAssessmentDisputeRecheckReceiptV2Schema = z.strictObject({
  /** 固定为「后续确认」：这一格永远不是当时的结算。 */
  stage: z.literal("supplementary"),
  status: z.enum(["committed", "skipped", "failed"]),
  /** 复核落库的时刻。**它与「异议记下」不是同一刻**，屏上要分开显示。 */
  decidedAt: z.string().datetime({ offset: true }),
  /** `committed` 时才有；其余两档为 null（不是「没有结论」，是「这一档还没有结论」）。 */
  outcome: assessmentDisputeRecheckOutcomeV2Schema.nullable(),
  /** 复核者自己那一句理由 + 与之差的对照说明（§14.2「展示理由」）。 */
  reason: z.string().nullable(),
  /** 没跑成时说清是哪一种，别让屏上只剩一句「复核还没做」。 */
  reasonCode: z.string().nullable(),
});
export type OpenAssessmentDisputeRecheckReceiptV2 = z.infer<
  typeof openAssessmentDisputeRecheckReceiptV2Schema
>;

export const openAssessmentDisputeResultV2Schema = z.strictObject({
  version: z.literal(2),
  disputeId: z.string().uuid(),
  status: assessmentDisputeStatusV2Schema,
  created: z.boolean(),
  /** 「当时的结算」那一句。屏上**先**说这一句，第二步是补充。 */
  recordedLine: z.string(),
  /** 「后续确认」。一定有这一格（哪怕是 skipped），这样屏上不必猜有没有发生过复核。 */
  recheck: openAssessmentDisputeRecheckReceiptV2Schema,
});
export type OpenAssessmentDisputeResultV2 = z.infer<typeof openAssessmentDisputeResultV2Schema>;


/**
 * 结束争议的回执。`outcome` 是**判据的结果**而不是「成功了」：
 * `hold_objective` / `close_without_hold` / `hold_unavailable` 三档各有各的话要说
 * （`decideDisputeCloseV2` 的注释解释了为什么第三档不能静默降级成第一档）。
 *
 * `dismissedPendingSchedules` 必须念出来：撤下了几条此刻排着的待办是「结束并暂不安排」
 * 唯一看得见的副作用，不报它，那颗按钮看起来像什么也没做。
 */
export const closeAssessmentDisputeResultV2Schema = z.strictObject({
  version: z.literal(2),
  disputeId: z.string().uuid(),
  status: assessmentDisputeStatusV2Schema,
  outcome: z.enum(["hold_objective", "close_without_hold", "hold_unavailable"]),
  dismissedPendingSchedules: z.number().int().min(0),
});
export type CloseAssessmentDisputeResultV2 = z.infer<typeof closeAssessmentDisputeResultV2Schema>;

/** 读侧：一份争议在界面上要能说清的全部内容。 */
export const assessmentDisputeViewV2Schema = z.strictObject({
  version: z.literal(2),
  id: z.string().uuid(),
  assessmentId: z.string().uuid(),
  /** §14.2"争议记录关联原产物和版本"——原答案冻结在哪个修订上，界面要能念出来。 */
  artifactId: z.string().uuid(),
  artifactRevision: z.number().int().positive(),
  objectiveId: z.string().uuid().nullable(),
  kind: assessmentDisputeKindV2Schema,
  status: assessmentDisputeStatusV2Schema,
  statement: z.string(),
  supplement: z.string().nullable(),
  recheckOutcome: assessmentDisputeRecheckOutcomeV2Schema.nullable(),
  /** 界面直接念这一句；`null` 表示复核还没做，不要显示成"维持"。 */
  recheckReason: z.string().nullable(),
  corrections: z.array(z.strictObject({
    id: z.string().uuid(),
    kind: assessmentCorrectionKindV2Schema,
    reason: z.string(),
    supplementArtifactId: z.string().uuid().nullable(),
    createdAt: isoTimestampV2Schema,
  })),
  createdAt: isoTimestampV2Schema,
  resolvedAt: isoTimestampV2Schema.nullable(),
});
export type AssessmentDisputeViewV2 = z.infer<typeof assessmentDisputeViewV2Schema>;

export const assessmentDisputeEnvelopeV2Schema = z.strictObject({
  version: z.literal(2),
  dispute: assessmentDisputeViewV2Schema.nullable(),
});
export type AssessmentDisputeEnvelopeV2 = z.infer<typeof assessmentDisputeEnvelopeV2Schema>;

/**
 * 读侧。`dispute: null` 是**正常状态**而不是错误：界面要先问一句「有没有得吵」
 * 才决定显不显示入口，把「还没有争议」报成失败会让那颗入口永远出不来。
 */

/**
 * 争议**状态**到界面话术的**唯一**映射（§14.2「展示维持／修正／仍无法判断的理由」）。
 *
 * 放在共享层而不是渲染层：结果页、笔记历史、未来的复核台都要念这一份，
 * 写在组件里就变成三处各抄一遍，而 `recheck_undetermined`（维持争议状态、不强行选一方）
 * 恰恰是最容易被抄错成「已关闭」的那一档——抄错的后果是让用户以为争议已经翻篇。
 *
 * `recheckReason: null` 时**不说结论**，只说还没复核：判据是
 * `assessmentDisputeViewV2Schema` 上那句注释（不要显示成「维持」）。
 */
export type AssessmentDisputeSurfaceCopyV2 = {
  readonly headline: string;
  readonly detail: string;
  /** `true` 时界面要明确告诉用户「这次不推进复习」——§16.22 的读侧语义。 */
  readonly withholdsConclusion: boolean;
  /** `true` 时不该再出现「补充说明」入口：§14.2「不能反复要求用户接受同一判定」。 */
  readonly acceptsSupplement: boolean;
};

export function assessmentDisputeSurfaceCopyV2(
  view: AssessmentDisputeViewV2,
): AssessmentDisputeSurfaceCopyV2 {
  const reason = view.recheckReason;
  const reasonLine = reason ? `理由：${reason}` : "复核还没做，暂时不显示结论。";
  switch (view.status) {
    case "open":
      return {
        headline: "你提了异议，这次先不推进复习。",
        detail: reasonLine,
        withholdsConclusion: true,
        acceptsSupplement: true,
      };
    case "recheck_undetermined":
      // §14.2 末句：「判断仍不可靠时**维持争议状态**，不强行选一方作为事实。」
      // 所以这一档既不能说「已关闭」，也不能说「维持原判」——`upheld` 才是后者。
      return {
        headline: "复核之后仍然无法可靠判断，这份异议保持未决。",
        detail: reasonLine,
        withholdsConclusion: true,
        acceptsSupplement: true,
      };
    case "recheck_over_broad":
      // 第四档。**与 `undetermined` 说两句话**：那一档是"系统还没想清楚"，
      // 这一档是"系统想清楚了，上次判宽了"。用户该做的事不同——
      // 前者可以补充说明再等一次，后者该回原回答重看。
      return {
        headline: "复核之后，上次那条判定偏宽了：原回答并没有满足条件，那一次不算达成。",
        detail: reasonLine,
        withholdsConclusion: true,
        // 不接受补充说明：§14.2「不能反复要求用户接受同一判定」。
        // 补充说明只能改变"判不出来"那一档（证据确实缺一块），而这一档的结论已定，
        // 再补充也不会让一条已经过宽的判定重新成立。
        acceptsSupplement: false,
      };
    case "recheck_upheld":
      return {
        headline: "复核之后维持原来的判定。",
        detail: reasonLine,
        withholdsConclusion: false,
        acceptsSupplement: true,
      };
    case "recheck_corrected":
      return {
        headline: "复核之后修正了原来的判定，你原来的回答仍然保留。",
        detail: reasonLine,
        withholdsConclusion: false,
        acceptsSupplement: false,
      };
    case "closed_held":
      return {
        headline: "这份异议已结束，这一项已设为「暂不安排」。",
        detail: reasonLine,
        withholdsConclusion: false,
        acceptsSupplement: false,
      };
  }
}

/**
 * 复核**四档**各有一句人话（§14.2「展示维持／修正／仍无法判断的理由」，四档扩后同理）。
 *
 * **写成人话而不是状态名的原因**：状态名是给数据库与测试看的。屏上念
 * `recheck_original_too_broad` 没有人读得懂，而「上次说答对的那次，这次重新看下来
 * 没成立」是用户能据此行动的句子。四个键一个都不能少——少一个就会有那一档落进兜底，
 * 而兜底句对任何已知档都不该生效（与台账里那条 `schedule-copy` 判据同一形状）。
 */
export const RECHECK_OUTCOME_LINE_V2: Readonly<Record<AssessmentDisputeRecheckOutcomeV2, string>> = {
  upheld: "重新看过一次，上次的判断站得住。",
  corrected: "重新看过一次，上次判严了：原回答其实已经满足条件，已按更正记录改正。",
  over_broad: "重新看过一次，上次判宽了：原回答并没有满足条件，那一次的达成不成立。",
  undetermined: "这一次仍然判断不了：两种可能都有，暂不采信任何一方。",
};

/**
 * 开争议那两步回执的屏上文案（**唯一出处**）。
 *
 * 第一步与第二步是**两句话**，不是一句加个尾巴：第一步回答"我按的那一下生效了吗"，
 * 第二步回答"系统怎么看"。合成一句的后果就是用户在等第二句时不知道第一句已成立，
 * 于是重复点——而重复点就是 §16.22 的可重复动作。
 */
export function disputeReceiptLinesV2(input: {
  readonly created: boolean;
  readonly recheck: OpenAssessmentDisputeRecheckReceiptV2;
}): { readonly first: string; readonly second: string } {
  const first = input.created
    ? "异议已经记下了。这一次先不推进复习。"
    : "这份异议之前已经记过，这次没有重复记。";
  switch (input.recheck.status) {
    case "committed":
      return {
        first,
        second: RECHECK_OUTCOME_LINE_V2[input.recheck.outcome ?? "undetermined"],
      };
    case "skipped":
      // **不说「正在处理」**：那一刻没有东西在处理（这一发已经等完了）。
      // 说「正在处理」会让用户以为再等一会儿就有结果，而实际出口是他自己结束争议。
      return { first, second: "系统这次没能重新看一遍（暂时不能这样做）。你可以补充说明，或结束这份异议并暂不安排。" };
    case "failed":
      return { first, second: "系统这次没能重新看一遍。你可以补充说明，或结束这份异议并暂不安排。" };
  }
}
