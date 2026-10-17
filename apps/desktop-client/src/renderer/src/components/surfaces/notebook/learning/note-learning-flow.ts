import type { RoundNextStepV1 } from "@astella/shared/note-learning-round-contracts";
import type { TaskIntentV1 } from "@astella/shared/learning-run-contracts";

/** The server's signed next step is the only automatic learning route. */
export type NoteLearningScene = "question" | "paused" | "teaching" | "practice" | "result" | "unavailable";

export function noteLearningScene(input: {
  roundPhase: "active" | "paused" | null;
  editingQuestion: boolean;
  hasTeaching: boolean;
  nextStep: RoundNextStepV1 | null;
}): NoteLearningScene {
  if (!input.roundPhase || input.editingQuestion) return "question";
  if (input.roundPhase === "paused") return "paused";
  if (!input.nextStep) return "unavailable";
  switch (input.nextStep.kind) {
    case "explain": return "question";
    case "attempt": return input.hasTeaching ? "teaching" : "question";
    case "review_material": return input.hasTeaching ? "teaching" : "unavailable";
    case "resume": return "practice";
    case "choose": return input.nextStep.basisRunId ? "result" : input.hasTeaching ? "teaching" : "question";
    case "help":
    case "retry":
    case "apply":
    case "finish":
    case "uncertain": return "result";
  }
}

// ════════════════════════════════════════════════════════════════════════
// 这一轮走到哪一步（39f UI-2）
// ════════════════════════════════════════════════════════════════════════

/**
 * 纸上那三枚纸签。**每一枚的"已过／正在／还没"都由真实状态算**，不由界面看着顺眼写：
 * 讲解过没过看讲解在不在，练过没练过看**已结算**的那几次（开着的那次算"正在答"，
 * 不算"练过了"——那一格还没结算，说它过了就是拿没跑完的尝试充成绩）。
 */
export type RoundTrackMarkV1 = "done" | "current" | "todo";

export interface RoundTrackStepV1 {
  readonly key: "teaching" | "practice" | "result";
  /** 纸签上的三个字。名词，不是系统词。 */
  readonly label: string;
  readonly mark: RoundTrackMarkV1;
  /** 这一枚凭什么这么说。一句人话，让用户不必猜这一格是什么意思。 */
  readonly note: string;
}

export function roundTrackV1(input: {
  scene: NoteLearningScene;
  hasTeaching: boolean;
  /** 这一轮开出去的练习总数。 */
  practiceCount: number;
  /** 其中**已结算**的次数。 */
  settledCount: number;
  /** 服务端说这一轮可以收了（`nextStep.kind === "finish"`）——只有那时候"看过结果"才签得过。 */
  canFinish: boolean;
}): readonly RoundTrackStepV1[] {
  const onTeaching = input.scene === "question" || input.scene === "teaching";
  const teaching: RoundTrackMarkV1 = input.hasTeaching
    // 讲过了就是讲过了；但当这一轮正停在讲解上、后面一步都还没开始时，它仍是"正在"的那一枚。
    ? (onTeaching && input.settledCount === 0 ? "current" : "done")
    : (onTeaching ? "current" : "todo");

  const practice: RoundTrackMarkV1 = input.settledCount > 0
    ? "done"
    : input.scene === "practice" ? "current" : "todo";

  const result: RoundTrackMarkV1 = input.scene === "result"
    ? (input.canFinish ? "done" : "current")
    : "todo";

  return [
    {
      key: "teaching",
      label: "讲一遍",
      mark: teaching,
      note: teaching === "done" ? "已经讲过" : teaching === "current" ? "正在讲" : "还没讲",
    },
    {
      key: "practice",
      label: "试一次",
      mark: practice,
      note: practice === "done"
        ? `已经试过 ${input.settledCount} 次`
        : practice === "current" ? "正在答" : "还没试过",
    },
    {
      key: "result",
      label: "看收获",
      mark: result,
      note: result === "done" ? "这一轮的结果在这儿" : result === "current" ? "正在看" : "等试过之后",
    },
  ];
}

// ════════════════════════════════════════════════════════════════════════
// 这一轮的收获回执（39f §3 最后一格）
// ════════════════════════════════════════════════════════════════════════

const FACET_LABEL: Record<TaskIntentV1, string> = {
  recall: "回忆关键条件",
  paraphrase: "用自己的话解释",
  explain: "说明原因或过程",
  example: "举一个合适例子",
  apply: "应用到情境",
  boundary: "辨认适用边界",
  procedure: "走通步骤",
  relate: "联系相关概念",
  repair: "修正原先的理解",
};

/** 「用这个说法讲一遍」——把一个能力名变成一句人话，结果页读起来才不是一张表。 */
function facetAsCanDoV1(facet: TaskIntentV1): string {
  switch (facet) {
    case "recall": return "凭记忆说出关键条件";
    case "paraphrase": return "用自己的话把它讲一遍";
    case "explain": return "讲清它为什么这样";
    case "example": return "举出一个合适的例子";
    case "apply": return "换到新情境里用一次";
    case "boundary": return "说出它什么时候不成立";
    case "procedure": return "照着把步骤走通一遍";
    case "relate": return "和相邻的概念连起来";
    case "repair": return "改掉原先理解错的地方";
  }
}

/** 一次练习的结算说法。**结果页拿它说"具体弄懂了什么"**，所以放在这里与别的文案同源。 */
export const ROUND_PRACTICE_OUTCOME_LABEL_V1: Record<string, string> = {
  demonstrated: "做出来了",
  partial: "做出一部分",
  needs_repair: "还有一处要补",
  not_assessable: "这一次判不了",
  practice_completed: "练完了",
  skipped: "跳过了",
  declared_unable: "说没想起来",
};

/**
 * 「接下来做什么」那一句。**一处签发**：暂停回执上那一格与结果页第三行读的是同一份，
 * 两处各写一遍的话，迟早会有一处漏改，于是同一个 `kind` 在两个界面上说两件事。
 */
export function roundTrackNextV1(kind: RoundNextStepV1["kind"]): string {
  return {
    explain: "先看一段讲解和例子，再决定要不要试。",
    attempt: "可以试这一道；也可以先看讲解。",
    resume: "回到已经开始的那次作答，结果会接回这一轮。",
    help: "先换一种针对这次缺口的讲解，再决定下一步。",
    retry: "看过针对这次缺口的讲解后，可以再试一次。",
    apply: "可以在新情境里试用一次，也可以先收尾。",
    finish: "这一轮可以收了，回笔记继续读。",
    uncertain: "可以回去看原回答和反馈；这次也可以先收尾。",
    choose: "自动加题已经停下，你可以选择帮助，或者先收尾。",
    review_material: "先回这篇笔记和讲解核对材料。",
  }[kind];
}

/**
 * 三行回执：这一轮弄懂了什么、还差什么、接着做什么。
 *
 * ## 为什么不再用那三句通用句
 *
 * 上一版按 `evidence` 归类，说出来的是「完成了这次练习，并留下作答记录」——**换任何
 * 一篇笔记、任何一个问题，这句话都一样**。用户读完仍然答不出"今天我到底弄懂了什么"。
 *
 * 现在这三行各自指名道姓：
 *   - 第一行点名**这一轮的问题**，再给出**最近那一次的真实结算说法**（不是"练过了"，
 *     是"做出来了"／"还有一处要补"／"这一次判不了"）；
 *   - 第二行点名**还差的那一个动作**（"举出一个合适的例子"），而不是能力名；
 *   - 第三行仍然是服务端签发的那一步，只是改成一句能直接照着做的说法。
 *
 * 三行都不越过服务端给的读数：结算说法来自 `practice.outcome`，缺口来自
 * `nextStep.gapFacets`，界面一个都不重算。
 */
export function notePracticeResultCopy(input: {
  /** 这一轮的问题。界面上重复它，是为了让"我到底弄懂了什么"有一个明确的宾语。 */
  question: string | null;
  /** 这一轮的练习，按时间先后。取最后**已结算**的那一次作为"最近一次"。 */
  practices: readonly { readonly outcome: string | null }[];
  nextStep: RoundNextStepV1 | null;
}): { today: string; gap: string; next: string } {
  const { question, practices, nextStep } = input;
  const subject = question && question.trim().length > 0 ? `「${question.trim()}」` : "这一个问题";
  const settled = [...practices].reverse().find((practice) => practice.outcome !== null);
  const lastOutcome = settled?.outcome ? ROUND_PRACTICE_OUTCOME_LABEL_V1[settled.outcome] : null;
  const lastSaid = (text: string) => `在${subject}上，${text}`;

  if (!nextStep || nextStep.evidence === "none") {
    return {
      today: settled
        ? lastSaid(`最近一次${lastOutcome}。`)
        : "这一轮还没有结算过的练习。",
      gap: settled
        ? "这一次的结果已经记下来了，但它只说明刚才那一次。"
        : "还没有能判断进度的作答，所以这里不替你下结论。",
      next: "继续把这一轮走完，或者先停在这里。",
    };
  }

  const lastOutcomeClause = lastOutcome ? `（最近一次：${lastOutcome}）` : "";
  const today = nextStep.evidence === "independent_demonstrated"
    ? lastSaid(`这次你能自己走出来了${lastOutcomeClause}。`)
    : nextStep.evidence === "practice_covered"
      ? lastSaid(`最近这一次已经练过${lastOutcomeClause}。`)
      : nextStep.evidence === "unassessable"
        ? lastSaid(`最近这一次已经保存，但系统没能可靠判断${lastOutcomeClause}。`)
        : lastSaid(`最近试了一次，还没走通${lastOutcomeClause}。`);

  const gap = nextStep.evidence === "unassessable"
    ? "这次判不出来是系统这边没把握，不代表你没学会。"
    : nextStep.gapFacets.length
      ? `还差这一步：${nextStep.gapFacets.map((facet) => facetAsCanDoV1(facet)).join("；")}。`
      : nextStep.evidence === "incomplete"
        ? "这一次还没有形成能自己用的证据。"
        : `这只是${subject}这一道题的证据，整篇笔记还不算走过。`;

  const next = roundTrackNextV1(nextStep.kind);
  return { today, gap, next };
}
