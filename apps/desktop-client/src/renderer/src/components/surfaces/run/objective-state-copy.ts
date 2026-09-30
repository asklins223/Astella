/**
 * 学习卡状态的**唯一**一份人话文案。
 *
 * 此前同一个状态词在四处各写各的（列表页 / 卡片页 / 星空图 / 宇宙图），
 * 于是「待验证」在两个不同的状态轴上各指一件事——用户看到同一个词，
 * 却不知道指的是哪一件（2026-09-20 实走复盘 #9、#14）。
 * 本文件是纯模块：React 组件与 `graph-sky.ts` 这类无 React 依赖的布局代码都能引。
 */
// 深路径导入：`@ailearn/shared` 的 barrel 会把 Node 侧模块（content-hash、
// feature-flags、provider-capabilities）拖进 renderer 的编译与打包图里。
import type {
  LearningObjectivePrimaryActionV3,
  ObjectiveNoteChangeImpactV1,
  ObjectiveReviewHoldV1,
  ObjectiveSurfaceFreshnessV3,
  ObjectivePersonalStateV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import type {
  ObjectiveHoldResultV2,
  ObjectiveResumeResultV2,
  ReviewAuthorizationSourceV2Wire,
} from "@ailearn/shared/review-queue-v2-contracts";

const STATE_COPY: Record<ObjectivePersonalStateV3, { label: string; hint: string }> = {
  unvalidated: {
    label: "还没正式答过",
    hint: "这张卡还没有一次正式作答。答一次才知道你到底会不会。",
  },
  learning: {
    label: "正在作答",
    hint: "这一轮还没有结束，接着上次的位置继续就行。",
  },
  stable: {
    label: "已经答对过",
    hint: "至少有一次正式作答被判为达标。",
  },
  fragile: {
    label: "有点生疏",
    hint: "隔得久了正确率在掉，做一遍就能补回来。",
  },
  needs_repair: {
    label: "上次答错了",
    hint: "最近一次正式作答没达标，需要重新把理解修一遍。",
  },
  due_review: {
    label: "到复习时间了",
    hint: "按记忆曲线排到今天，复习一次就好。",
  },
  scheduled: {
    label: "已排复习",
    hint: "下一次复习时间已经排好，到期之前不用管它。",
  },
  outdated: {
    label: "原文更新了",
    hint: "笔记内容变了，这张卡说的还是旧版本，需要重新核对。",
  },
  archived: {
    label: "已归档",
    hint: "你把它收起来了，不再出现在作答和复习队列里。",
  },
  superseded: {
    label: "已被新卡替代",
    hint: "同一件事有了新版本，旧卡只留记录，不再可答。",
  },
};

/** 星空图等投影侧的 state 是自由字符串；认不出的一律原样显示，不编造文案。 */
function copyOf(state: string): { label: string; hint: string } | null {
  return STATE_COPY[state as ObjectivePersonalStateV3] ?? null;
}

export function formatObjectiveState(state: string): string {
  return copyOf(state)?.label ?? state;
}

/** 一句话说明这个状态到底意味着什么；列表与详情共用同一句，不另写一份。 */
export function objectiveStateHint(state: string): string {
  return copyOf(state)?.hint ?? "";
}

export function objectiveStateTone(state: string): "calm" | "attention" | "progress" | "neutral" {
  switch (state) {
    case "stable": return "calm";
    case "learning":
    case "scheduled": return "progress";
    case "fragile":
    case "needs_repair":
    case "due_review":
    case "outdated": return "attention";
    default: return "neutral";
  }
}

/**
 * 「需要学习者来一趟」的唯一口径：星空图靠它决定星星的大小，列表页靠它数
 * 「要处理」。`unvalidated` 不在 tone 的 attention 里，但一张从没答过的卡
 * 恰恰是最需要处理的那一类——这个例外以前写在调用方的 if 里，现在写在这里。
 */
export function objectiveStateNeedsAttention(state: string): boolean {
  return objectiveStateTone(state) === "attention" || state === "unvalidated";
}

/**
 * 时间点自己拼，不走 `Intl` 的 zh-CN：同一份 `month:"numeric"` 在 Electron
 * （full-icu）里出「9月21日」，在 vitest 的 Node 里出「9/21」——等待终点是
 * 用户要做决定的信息，不能随运行环境的 ICU 版本换写法。
 */
export function formatObjectiveDateTime(value: string | null | undefined): string {
  if (!value) return "时间未定";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未定";
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${hour}:${minute}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 「今天 / 昨天 / 5 天后 / 9月25日」：行内放不下完整日期，也不该让用户自己减天数。 */
export function formatObjectiveDay(value: string | null | undefined): string {
  const parsed = value ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.valueOf())) return "时间未定";
  const dayDiff = Math.round((startOfDay(parsed) - startOfDay(new Date())) / 86_400_000);
  if (dayDiff === 0) return "今天";
  if (dayDiff === -1) return "昨天";
  if (dayDiff === 1) return "明天";
  if (dayDiff > 1 && dayDiff <= 30) return `${dayDiff} 天后`;
  if (dayDiff < -1 && dayDiff >= -30) return `${-dayDiff} 天前`;
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
}

/**
 * 列表行上的进展标记（复盘 #7：答完一张卡回到列表，行上什么变化都看不到）。
 * 只讲服务端确实知道的事实，不重复状态标签已经说过的话。
 */
export function objectiveProgressChips(progress: {
  practiceTrailCount: number;
  lastCanonicalAt: string | null;
  reviewDueAt: string | null;
  initialValidation: "ready" | "deferred" | "completed" | null;
  validationNotBefore: string | null;
}): string[] {
  const chips: string[] = [];
  if (progress.lastCanonicalAt) {
    chips.push(`正式答过 · ${formatObjectiveDay(progress.lastCanonicalAt)}`);
  } else if (progress.practiceTrailCount > 0) {
    chips.push(`练过 ${progress.practiceTrailCount} 次`);
  }
  if (progress.initialValidation === "deferred") {
    chips.push(`${formatObjectiveDateTime(progress.validationNotBefore)} 后才能正式答`);
  }
  if (progress.reviewDueAt) {
    // 「复习 11 天前」在活应用里被读成了"11 天前复习过"（实测一行 overdue 的卡）。
    // 过期的要说成过期，未到的说还有几天。
    const due = new Date(progress.reviewDueAt);
    const days = Number.isFinite(due.valueOf())
      ? Math.round((startOfDay(due) - startOfDay(new Date())) / 86_400_000)
      : null;
    chips.push(days === null || days > 30
      ? `复习 ${formatObjectiveDay(progress.reviewDueAt)}`
      : days < 0
        ? `复习已到期 ${-days} 天`
        : days === 0
          ? "今天复习"
          : `复习 ${days} 天后`);
  }
  return chips;
}

/**
 * `content.freshness` 的人话。这一格此前只有目标简报里写着一份（`WorkspaceLibrarySurface`
 * 的局部函数），笔记页要附「来源已有更新」那枚徽标时面临两个选择：抄一份、或按 PRD
 * 草稿另写一句「有内容更新」。两条都会让同一个服务端值在两块屏幕上说两个词——
 * 所以取过来共用（本文件就是为这件事存在的）。
 */
export function freshnessLabel(value: ObjectiveSurfaceFreshnessV3): string {
  return {
    fresh: "来源内容最新",
    source_outdated: "来源已有更新",
    legacy_unreviewed: "旧来源待复核",
  }[value];
}

/**
 * 目标所引用的笔记内容有没有变化，与来源版本是否更新是两件事。
 * 笔记页把这句放在原有学习动作旁边，语气只描述证据情况，不代替用户做决定。
 */
export function objectiveNoteChangeImpactCopy(
  impact: ObjectiveNoteChangeImpactV1 | null | undefined,
): string | null {
  if (!impact) return null;
  if (impact.reasonCode === "explicit_change_relation") {
    return "这条目标有明确的改动关系，先核对旧记录再继续。";
  }
  if (impact.reasonCode === "mixed_evidence") {
    return "这条目标有引用段落变了，也有旧证据无法比对；先核对原文。";
  }
  if (impact.status === "affected") {
    return "引用的段落有改动，先核对原文再继续。";
  }
  if (impact.status === "uncertain") {
    return "旧证据不够完整，暂时不能判断这次变化；先回原文核对。";
  }
  if (impact.reasonCode === "stable_anchor_unchanged") {
    return "这次笔记更新没碰到引用的段落，这条目标可以照常用。";
  }
  return "引用的句子还在；旁边的补充没有影响这条目标。";
}

/**
 * 「回到这一轮没跑完的地方」唯一的一个词。
 *
 * 两个读者：`primaryActionLabel`（列表／详情／首页／星图）与伴星中心「动态」那一格的
 * 恢复按钮。服务端这一族动作里只有 `create_*`／`practice_only` 自带 `label`——
 * `resume_run` 那一支没有这个字段（`learning-objective-surface-contracts.ts`），
 * 所以这个词由本模块签发；再往按钮上写一遍字面量就是第二个来源（39d W4-2 第三处）。
 */
export const RESUME_RUN_ACTION_LABEL = "继续作答";

export function primaryActionLabel(action: LearningObjectivePrimaryActionV3): string {
  switch (action.kind) {
    case "create_run":
    case "create_review_run":
    case "practice_only": return action.label;
    case "resume_run": return RESUME_RUN_ACTION_LABEL;
    case "wait_for_initial_validation": return "现在还不能正式答";
    case "view_successor": return "看新版本";
    case "refresh": return "重新读取";
    case "none": return "暂无可做的";
  }
}

/**
 * 按钮下面那一句话。`wait_for_initial_validation` 与 `practice_only` 必须
 * 把「为什么」和「什么时候能正式算」写在明面上——只给一个灰色按钮，
 * 用户只会以为产品坏了（复盘 #9）。
 */export function primaryActionDescription(action: LearningObjectivePrimaryActionV3): string {
  switch (action.kind) {
    case "create_run":
    case "create_review_run": return `${action.label}，完成后会写回这一题的真实状态。`;
    case "resume_run": return "上次保存的进度还在，不会从头再来。";
    case "practice_only": return action.formalValidationNotBefore
      ? `这一题的参考答案你看过，所以这次只算练习；正式验证 ${formatObjectiveDateTime(action.formalValidationNotBefore)} 开放。`
      : "这一题的参考答案你看过，所以这次只算练习，不改动正式理解状态。";
    case "wait_for_initial_validation": return `这一题要到 ${formatObjectiveDateTime(action.qualificationNotBefore)} 才能开始正式验证。到点自动开放；这段时间可以先看讲解，或去做别的卡。`;
    case "view_successor": return "这张卡已经有新版本，旧版本只保留记录。";
    case "refresh": return "目标或来源内容变了，需要重新读取最新内容。";
    case "none": return "这一轮暂时没有要做的。";
  }
}

// ─── W7-3 刀三：目标级「暂不安排」／「恢复并开启」（39 §9.1 行 2、行 3）──
//
// 这几句话与 `objective-state-copy` 其余部分同一理由放在这里：**同一个服务端值
// 只许有一份人话**。笔记页的学习区、卡库的列表行、伴星读页面那一句都要说
// 「暂不安排」，三处各写一遍就是三颗目标在三个面上各说一句话的预备状态。
//
// 两条规则决定了这几句话必须长这样，不是文风偏好：
//  1. §9.1 行 2：「对本人在当前笔记内该目标的**所有**持续回访维度生效，不停止其他
//     目标、不删除历史」——所以按钮与回执都要把"只停这一个"说出来，否则用户
//     会以为整篇笔记的学习安排都停了。
//  2. §9.1 行 3：恢复是**组合动作**（解除 + 排上），不是解除——所以那一档要念出
//     下一次回访是哪一天，否则用户点完不知道有没有真的开始。

/** 那颗按钮。动词是「暂不安排」而不是「暂停」：§9.1 的词是前者。 */
export const OBJECTIVE_HOLD_ACTION_LABEL = "暂不安排这个目标";
/** 排除生效时换上去的那颗。承诺的是「恢复**并开启**」，不是「取消排除」。 */
export const OBJECTIVE_RESUME_ACTION_LABEL = "恢复并开启";

/** 按钮下面那句：说清范围与代价，不让用户猜。 */
export function objectiveHoldActionDescription(): string {
  return "只停这一个目标的回访安排，别的目标和已经记下的练习都不动。";
}

export function objectiveResumeActionDescription(): string {
  return "解除「暂不安排」，并重新排上第一次回访。";
}

/** 屏上那枚纸签：排除生效中。 */
export function objectiveReviewHoldLabel(hold: ObjectiveReviewHoldV1): string {
  return `暂不安排 · ${formatObjectiveDay(hold.createdAt)}`;
}

/** 排除生效时那行说明：为什么它现在不回到队列里，以及怎么回来。 */
export function objectiveReviewHoldHint(hold: ObjectiveReviewHoldV1): string {
  return `你在 ${formatObjectiveDateTime(hold.createdAt)} 把它设成暂不安排，所以它不会再自动回到复习队列；笔记和卡片的其他安排照旧。点「${OBJECTIVE_RESUME_ACTION_LABEL}」就会重新排上。`;
}

/**
 * 立排除那一发的回执。三种说法分开：
 *  - 本来就在排除中 ⇒ 说"本来就在"，不说"刚刚设好了"（`alreadyHeld`）。
 *  - 撤下了待办 ⇒ **把数念出来**。§9.1 那一格要"操作时说明"，
 *    而"顺手撤了 2 条"正是用户能看见的后果；不说就等于只有未来被挡住。
 *  - 一条也没撤 ⇒ 明说"此刻没有排着的待办"，别让"撤了 0 条"读成"没生效"。
 */
export function objectiveHoldNotice(receipt: ObjectiveHoldResultV2): string {
  if (receipt.alreadyHeld) {
    return "这个目标本来就在暂不安排中，这次没有改动。";
  }
  return receipt.dismissedPendingSchedules > 0
    ? `已设为暂不安排，顺手撤下了 ${receipt.dismissedPendingSchedules} 条排着的回访。`
    : "已设为暂不安排；它此刻没有排着的回访，所以没有需要撤下的。";
}

/**
 * 「恢复并开启」那一发的回执。三档分开（§9.1 行 3）：
 *  - 新排上的 ⇒ 念出日期，用户要能对上"我什么时候会被叫回来"。
 *  - 沿用已有的那一格 ⇒ 说"沿用已经排好的"，不说"重新排了"（那会把别人排的那条
 *    记成这次排的）。
 *  - `released: false`（本来就没在排除中）仍要说排上了——这两件事在回执里是两个
 *    字段，合成一句"已恢复"会把其中一件吞掉。
 */
export function objectiveResumeNotice(receipt: ObjectiveResumeResultV2): string {
  const when = formatObjectiveDay(receipt.nextReviewAt);
  const scheduled = receipt.scheduled === "created"
    ? `已经排上，第一次回访在 ${when}。`
    : `沿用已经排好的安排，回访在 ${when}。`;
  return receipt.released ? scheduled : `本来就没有在暂不安排中；${scheduled}`;
}

// ─── W7-3 刀六：订阅来源分别开停的人话（39 §9.1 第一段与规则表行 1）──
//
// 这一族与上面的「暂不安排」同一理由放在这里：**一个服务端值只许有一份人话**。
// 笔记页、书房页、伴星读页面都要说"这次停的是哪一个来源、还有什么在撑着"。
//
// 规则表行 1 逼出三句必须分开的话：
//  1. 停一个来源 ≠ 停掉整篇（`stillCoveredBy` 非空时）；
//  2. `changed: false` 是「本来就在那一档」，不是「刚刚改好了」；
//  3. 范围说明（`scopeNote`）要念出来——§9.1「开启时用一句话说明这个持续范围」。

export const REVIEW_SOURCE_LABEL: Record<ReviewAuthorizationSourceV2Wire, string> = {
  note_subscription: "笔记订阅",
  card_review: "卡片复习",
};

/** 开关本身：一颗开关拨的是**一个来源**，所以标签要带上是谁。 */
export function reviewSourceSwitchLabel(source: ReviewAuthorizationSourceV2Wire, active: boolean): string {
  return active
    ? `停用${REVIEW_SOURCE_LABEL[source]}`
    : `开启${REVIEW_SOURCE_LABEL[source]}`;
}

export function reviewSourceScopeHint(subscription: {
  readonly source: ReviewAuthorizationSourceV2Wire;
  readonly scopeNote: string;
  readonly status: "active" | "paused";
  readonly createdAt: string;
}): string {
  const since = subscription.status === "active"
    ? "现在在持续回访"
    : `你在 ${formatObjectiveDateTime(subscription.createdAt)} 之后停用了它`;
  return `${since}：${subscription.scopeNote}`;
}

/**
 * 一发开/停之后的回执。
 *
 * **三句话的顺序不能换**：先说这一发的结果（开好了/停掉了/本来就在），再说范围与
 * 还有什么在撑着。用户要能回答"我刚才那一下到底改了什么"。
 *
 * `stillCoveredBy` 为空与非空是两句不同的话，且**非空时要点名**——§9.1 规则表行 1
 * 「其他来源仍有效时**显示原因**」。只说"已停用"会让用户以为整篇都不提醒了，
 * 而她那张卡明明还开着。
 */
/** 开／停订阅成功后那句话的入参形状。**给它一个名字**，
 *  这样 `use-notebook-subscription.ts` 就不用把这份结构抄一遍。 */
export type ReviewSubscriptionResultV2 = {
  readonly subscription: { readonly source: ReviewAuthorizationSourceV2Wire; readonly status: "active" | "paused" };
  readonly changed: boolean;
  readonly stillCoveredBy: readonly ReviewAuthorizationSourceV2Wire[];
};

export function reviewSubscriptionNotice(result: ReviewSubscriptionResultV2): string {
  const who = REVIEW_SOURCE_LABEL[result.subscription.source];
  const lead = result.changed
    ? (result.subscription.status === "active" ? `已开启${who}。` : `已停用${who}。`)
    : `本来就${result.subscription.status === "active" ? "开着" : "停着"}，这次没有改动。`;
  if (result.stillCoveredBy.length === 0) {
    return `${lead}现在没有别的来源撑着它，这一份不再被安排。`;
  }
  return `${lead}仍由${result.stillCoveredBy.map((source) => REVIEW_SOURCE_LABEL[source]).join("、")}继续安排。`;
}
