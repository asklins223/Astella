/**
 * 长期复习的**授权与排除裁决**（39d W7-3 刀一；39 §9.1 那张规则表）。
 *
 * 为什么单独一份纯函数：§9.1 的原话是"重叠授权的操作范围按以下规则固定，**不能由入口各自
 * 解释**"。今天有两个入口会建立安排（结算时开启复习、学习轮次排下一步），明天还有首页与
 * 伴星。规则写在调用方 = 抄 N 份，哪天少抄一份就出现"同一件事在不同入口后果不一样"——
 * 那正是这张表当初要被写下来的原因。
 *
 * 这里只有**判断**，没有读写：哪一条排除还活着、这条安排在库里是什么状态，由
 * `apps/api/src/modules/review/review-schedule-boundary.ts` 那一边查出来交进来。
 * 分成两半的理由与 W0-2（唯一调度边界）一致：执法点要少，判据要能被逐条单测。
 *
 * 五条规则各自对应 §9.1 表里的一行（下面按行序注明），外加两条同段的补充句：
 * 目标排除不静默取消本人另外约定的一次性提醒、再次主动学习不自动解除排除。
 */

/** 一项持续回访授权的来源。`note_subscription` 与 `card_review` 可以分别存在（§9.1 第一段）。 */
export type ReviewAuthorizationSourceV2 = "note_subscription" | "card_review";

/**
 * 排期请求的来意。两个**订阅来源**是用户持有、可分别暂停的；第三种是结算时的自动排期
 * （本轮 demonstrated／declared 观察换来的那条安排，今天由 `run-processing-tick` 发出）。
 *
 * 第三种为什么要单独列：§9.1 那句"在笔记订阅继续有效时也不自动加回来"管的就是它——
 * 用户对着一个目标点了"暂不安排"，最刺眼的违反就是下一次结算又把它排回来。
 * 但它不是一项可以被"暂停"的订阅，所以 `applySourcePauseV2` 的入参不收它。
 */
export type ReviewScheduleRequestSourceV2 = ReviewAuthorizationSourceV2 | "learning_observed";

/** 一次性提醒：与「持续安排复习」在授权上明确区分（§9.1 末段）。 */
export type OneOffReminderV2 = "user_scheduled_once";

/** 活着的目标排除；`dimensions` 不在这里判——排除按目标生效，覆盖该目标的所有回访维度。 */
export interface ObjectiveHoldV2 {
  readonly objectiveId: string;
  /** 排除是哪一发的动作立下的（界面要说"什么时候为什么标的"，也要给恢复入口）。 */
  readonly reasonCode: string;
}

/**
 * §9.1 行 2："对本人在当前笔记内该目标的所有持续回访维度生效，**优先于笔记和卡片授权**；
 * 不停止其他目标、不删除历史"。
 *
 * 所以这里判的是"这一发持续授权能不能落成一条待办"，返回的原因要能被界面直接念出来。
 */
export function decideOngoingAuthorizationV2(input: {
  readonly objectiveId: string;
  readonly source: ReviewScheduleRequestSourceV2;
  readonly hold: ObjectiveHoldV2 | null;
}): { readonly allowed: true } | { readonly allowed: false; readonly reasonCode: "objective_held" } {
  // 判的是"这一发要安排的那个目标"，不是"这篇笔记里还有别的被排除的目标"——
  // 后者会误停其他目标，正是这条规则禁止的那一半。
  if (input.hold && input.hold.objectiveId === input.objectiveId) {
    return { allowed: false, reasonCode: "objective_held" };
  }
  return { allowed: true };
}

/**
 * §9.1 补充句："目标排除不静默取消本人另外约定的一次性提醒"。
 *
 * 排除停的是**持续回访**，不停用户自己约定的那一次。要取消那一次得用户明确选择，
 * 所以这一发判"允许"，同时把"这个目标还有一次你自己定的提醒"带回去，让操作时说明。
 */
export function decideOneOffReminderUnderHoldV2(input: {
  readonly hold: ObjectiveHoldV2 | null;
  readonly reminder: OneOffReminderV2;
}): {
  readonly allowed: true;
  readonly mustDiscloseCoexistingReminder: boolean;
} {
  return {
    allowed: true,
    mustDiscloseCoexistingReminder: input.hold !== null,
  };
}

/**
 * §9.1 行 1："暂停/移除笔记订阅或卡片订阅 ⇒ **仅停用该授权来源**；其他来源仍有效时显示原因"。
 *
 * 返回剩下的来源列表；调用方据此决定这条安排是留着（还有别的来源）还是取消（没有了）。
 * "暂停笔记复习时说明已单独开启的卡片是否继续，并提供分别处理的选择，不偷偷联动"——
 * 偷偷联动在这一份里的形状就是：把 `card_review` 也跟着摘掉。
 */
export function applySourcePauseV2(input: {
  readonly sources: readonly ReviewAuthorizationSourceV2[];
  readonly pausedSource: ReviewAuthorizationSourceV2;
}): {
  readonly remainingSources: readonly ReviewAuthorizationSourceV2[];
  /** 还有别的来源在撑这条安排 ⇒ 界面要说"仍由 X 继续安排"，不能显示成已停。 */
  readonly stillCoveredBy: readonly ReviewAuthorizationSourceV2[];
} {
  const remaining = input.sources.filter((source) => source !== input.pausedSource);
  return { remainingSources: remaining, stillCoveredBy: remaining };
}

/**
 * §9.1 行 3："在排除仍有效时开启该卡复习 ⇒ 明示该目标仍被暂停，**只有用户选择
 * '恢复此目标并开启'才解除排除；不能暗中复活**"。
 *
 * 判据的方向与行 2 相反但同源：这一发是用户主动要开启，所以既不能默默排上（暗中复活），
 * 也不能把他的意图丢掉——要回一个"需要先恢复"的结论，让界面给那颗合并的动作。
 */
export function decideEnableUnderHoldV2(input: {
  readonly hold: ObjectiveHoldV2 | null;
  /** 用户是否明确点了"恢复此目标并开启"。 */
  readonly releasesHold: boolean;
}): {
  readonly outcome: "scheduled" | "needs_explicit_release" | "released_and_scheduled";
} {
  if (!input.hold) return { outcome: "scheduled" };
  if (!input.releasesHold) return { outcome: "needs_explicit_release" };
  return { outcome: "released_and_scheduled" };
}

/**
 * §9.1 行 4："延后某一次回访 ⇒ 只改变明确的目标/维度或单次提醒及日期；笔记级批量延后
 * **列明本次涉及范围**，不影响未来新增目标"。
 *
 * 这一条判的是"这次延后的作用范围有没有被说清楚"：批量而不列范围，就会顺手把以后新增的
 * 目标也一起延后了——那是用户没做过的授权收缩。
 */
export function deferScopeIsExplicitV2(input: {
  readonly scope: "single_schedule" | "objective_dimension" | "note_batch";
  readonly listedObjectiveCount?: number | null;
}): { readonly explicit: true } | { readonly explicit: false; readonly reasonCode: "batch_scope_not_listed" } {
  if (input.scope !== "note_batch") return { explicit: true };
  const listed = Number(input.listedObjectiveCount ?? 0);
  if (!Number.isInteger(listed) || listed <= 0) {
    return { explicit: false, reasonCode: "batch_scope_not_listed" };
  }
  return { explicit: true };
}

/**
 * §9.1 行 5："略过首页建议或本批某题 ⇒ 只影响本次展示，**不等于取消订阅，也不记作已复习**"。
 *
 * 三个读数各自独立：展示层关掉、订阅状态不动、能力证据不写。写成一份是因为这三件事
 * 在界面上是同一次点击触发的，很容易顺手多写一条"已复习"或把订阅翻成暂停。
 */
export function skipAffectsOnlyThisDisplayV2(): {
  readonly hidesFromPresentation: true;
  readonly cancelsSubscription: false;
  readonly recordsReviewEvidence: false;
} {
  return { hidesFromPresentation: true, cancelsSubscription: false, recordsReviewEvidence: false };
}

/**
 * §9.1 补充句："再次主动学习被排除目标可以更新记录，但**不会自动解除排除**"。
 *
 * 与行 3 同一取向：解除排除是用户的一个明确动作，不是任何系统事件的副作用。
 */
export function learningDoesNotReleaseHoldV2(): {
  readonly updatesEvidence: true;
  readonly releasesHold: false;
} {
  return { updatesEvidence: true, releasesHold: false };
}

/**
 * §9.1 规则表行 1 的**判定**：「暂停/移除笔记订阅或卡片订阅 ⇒ **仅停用该授权来源**；
 * 其他来源仍有效时**显示原因**」。
 *
 * ## 为什么单独抽出来，而不是让边界自己去查
 *
 * 统一写入安排的**边界**（`review-schedule-boundary.ts`）今天只问目标级排除
 * （`liveHoldForObjectiveV2`），**完全不问来源级停用**。后果很具体：用户在笔记上
 * 停掉了「卡片复习」这个来源，结算那一发照样排期——**那颗按钮拨了等于没拨**。
 * 而边界要回答"这份安排还由谁撑着"就需要跨两张表（目标自己的来源 ＋ 它那些来源笔记
 * 的来源），所以判定抽成纯函数、读侧交给调用方，两边各做自己那份。
 *
 * ## 三种结果，别合成一个布尔
 *
 *  - `covered`：**还有活的来源**撑着 ⇒ 该排。停掉一个来源不误删另一个（行 1）。
 *  - `paused_all`：**所有相关来源都停着** ⇒ 这一发不该排。库里什么都不写。
 *  - `never_authorized`：**从来没有过授权**（既没开着也没停过）⇒ 这一发是谁替她
 *    开的授权？照 §9.1「创建卡、读过笔记或结束一轮都不默认授权未来提醒」，
 *    这一格要**问**，不能默默替她开。
 *
 * 第三档最容易被漏：前两档是"她拨过开关"，第三档是"没人拨过"。合成一档之后，
 * 「她从没开过」与「她开了又停了」会走同一条路，而 §9.1 把它们说成两件不同的事。
 */
export type ReviewSourceAuthorizationV2 =
  | "covered"
  | "paused_all"
  | "never_authorized";

export function decideSourceAuthorizationV2(input: {
  /** 这颗目标**自己**的卡片订阅档位；null = 从没开过（那一列在 0303 里可为 null）。 */
  readonly cardReview: "active" | "paused" | null;
  /** 这颗目标那些来源笔记的订阅档位；去重前给全，去重后由读侧做。 */
  readonly noteSubscriptions: ReadonlyArray<"active" | "paused">;
  /**
   * **这一发是不是「她刚激活了这颗目标」**（结算那一支恒为 true；别的调用方给 false）。
   *
   * ⚠️ **2026-09-28 用户裁定**：「**卡激活本身就算显式意图**」——她按下「保存并开启复习」
   * 那个动作**就是**授权。所以：
   *
   * - `true` ＋ 没有卡片订阅行 ⇒ **算 covered**（没有反对意见）；
   * - 显式 `paused` **仍然照办**（她开了又停了，那是另一句话，§9.1 把它们说成两件不同的事）；
   * - **笔记那一支一个字都不改**——§9.1「**读过笔记**不默认授权未来提醒」照旧要问。
   *
   * 改这一格之前，结算排期**默认整条是死的**：一条订阅都没有时一律 `never_authorized`，
   * 于是 E04 / P2 纵切 / RUN-V2-WIRE-01 三条老用例全红——**它们断言的是「激活即排期」
   * 这个默认，而刀三照 §9.1 行 1 的字面把它关掉了**。那不是那三条用例错了，是**默认**要定。
   */
  readonly cardActivationIsIntent?: boolean;
}): { readonly authorization: ReviewSourceAuthorizationV2; readonly activeSources: number; readonly pausedSources: number } {
  const noteActive = input.noteSubscriptions.filter((s) => s === "active").length;
  const notePaused = input.noteSubscriptions.filter((s) => s === "paused").length;
  // 卡那一支：`null`（从没开过）在**激活这一发**里算**一次主动授权**；显式 `paused` 照旧是停用。
  const cardActive = input.cardReview === "active" || (input.cardReview === null && input.cardActivationIsIntent === true) ? 1 : 0;
  const cardPaused = input.cardReview === "paused" ? 1 : 0;
  const activeSources = cardActive + noteActive;
  const pausedSources = cardPaused + notePaused;
  if (activeSources > 0) return { authorization: "covered", activeSources, pausedSources };
  if (pausedSources > 0) return { authorization: "paused_all", activeSources, pausedSources };
  // 一份授权都没有：不是"她停掉了"，是"没人开过"。§9.1「**读过笔记**不默认授权未来提醒」
  // ——这一格要问，不许默默替她开。（「创建卡」那一半已由上面的 `cardActivationIsIntent` 兑现。）
  return { authorization: "never_authorized", activeSources, pausedSources };
}
