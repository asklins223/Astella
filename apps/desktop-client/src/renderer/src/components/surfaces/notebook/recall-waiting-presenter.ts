/**
 * 回忆等待态在屏上摆的那几条线索（39d W5-4；PRD §7.1、§16.24）。
 *
 * ## 这里最要紧的一条：标题**不许**回退到 `publicSummary`
 *
 * `questionOf`（`ReviewSurface.tsx`）那一行是
 * `conceptLabel ?? publicSummary`——那在**平时**是对的（没标题就说摘要）。
 * 但在**回忆等待态**里它是泄露：`publicSummary` 是从笔记正文生成的内容摘要，
 * §7.1 明写等待时「不自动展示原文、正确结构或上次答案」。所以等待态走**另一个**
 * 取法：只有 `conceptLabel`，没有就是 `null`（屏上照实说"这一道暂时没给标题"）。
 *
 * 把这条写成函数而不是散在 JSX 里，是因为它**必须被一条用例钉住**：
 * 把 `?? publicSummary` 加回来，删掉任何一条断言都不会红——那正是这批代码
 * 一直在拆的形状（「同一个词两个来源」）。
 *
 * ## 线索只能是**结构事实**
 *
 * §7.1「提取线索」指向"去哪儿想"，不指向"答案是什么"。所以这里给的只有
 * 三样结构事实：这条卡来自哪一篇笔记（标题不是正文）、它是什么知识形态
 * （枚举词，不是描述）、以及"你练过几次"（一个数）。**任何一句复述都会变成半个答案。**
 */
import type { LearningObjectiveSurfaceV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import {
  RECALL_REVEAL_COPY_V1,
  recallWaitingCueV1Schema,
  type RecallWaitingCueV1,
  type RecallWaitingKindV1,
} from "@ailearn/shared/recall-waiting-v2-contracts";

/**
 * 知识形态 → 一句"往哪儿想"的提示（**不是**对内容的描述）。
 *
 * **键取自 `KnowledgeFormValuesV2` 的真值**（`fact` / `definition` / `relationship` /
 * `comparison` / `sequence` / `procedure` / `causal_model` / `boundary` /
 * `application_rule`），不是我自己编的一组近义词——编错键的后果是那一档**静默**
 * 少给一条线索，而少给线索没人会发现（它长得像"这一道本来就没线索"）。
 * 九档全覆盖，不留缺口。
 */
const KNOWLEDGE_FORM_HINT_V1: Record<string, string> = {
  fact: "想清楚那一条说的是什么。",
  definition: "想清楚它指的是什么。",
  relationship: "想清楚它和谁有关。",
  comparison: "想清楚它和哪一个容易混。",
  sequence: "想清楚先后是怎么排的。",
  procedure: "想清楚第一步做什么。",
  causal_model: "想清楚它是怎么发生的。",
  boundary: "想清楚它到哪儿为止。",
  application_rule: "想清楚它在什么场合用得上。",
};

function knowledgeFormHintV1(form: string | undefined): string | null {
  if (!form) return null;
  return KNOWLEDGE_FORM_HINT_V1[form] ?? null;
}

/**
 * 造出这一档等待态的线索。
 *
 * **两档的区别只有一处，但那一处是 §7.1 末句的全部**：
 * `mayReadSource` 在 `independent_recall` 恒为 `false`，在 `first_learning` 才为 `true`。
 * 界面据此决定"要不要提示她材料就在旁边"——而**不是**让她自己判断这是哪一种等待。
 *
 * `surface` 传 `null`（那张卡的面读不到）时给的是一个**说清原因**的空态，
 * 不是空数组（§13.4：空与失败是不同的话）。
 */
export function recallWaitingCueV1(input: {
  kind: RecallWaitingKindV1;
  surface: LearningObjectiveSurfaceV3 | null;
  /** 读不到那张卡的面时的那一句真因。 */
  unreadableReason?: string | null;
}): RecallWaitingCueV1 {
  const surface = input.surface;
  const clues: string[] = [];
  // **只取 `conceptLabel`**，不取 `publicSummary`（见文件头）。这是这一整份
  // 存在的理由，判据在 `recall-waiting-presenter.test.ts`。
  const title = surface?.content.conceptLabel ?? null;
  const noteTitle = surface?.sources.primaryNote?.title ?? null;
  if (noteTitle) clues.push(`来自《${noteTitle}》`);
  const formHint = knowledgeFormHintV1(surface?.content.knowledgeForm);
  if (formHint) clues.push(formHint);
  // **`personal` 那一块用可选链**：屏上的那份面是经网关 `safeParse` 过的，
  // 合同上 `personal` 必填，但**渲染层拿到的对象未必过得了那一份合同**
  // （既有几份页面用例喂的是精简面）。这里崩掉的后果是整页白屏，而这条线索
  // 本身是可有可无的——所以读不到就当"没练过这一条"，不抛。
  const practiceTrailCount = surface?.personal?.practiceTrailCount ?? 0;
  if (practiceTrailCount > 0) {
    clues.push(`这一条你练过 ${practiceTrailCount} 次。`);
  }

  return recallWaitingCueV1Schema.parse({
    version: 1,
    kind: input.kind,
    progressLabel: "正在准备这一道题…",
    title,
    // 读不到面时**说清是什么读不到**，不留一个空数组让人猜（§13.4）。
    clues: surface === null && input.unreadableReason ? [input.unreadableReason] : clues,
    // §7.1 末句：独立回忆等待**只能给安全线索**，材料不在这一档里。
    mayReadSource: input.kind === "first_learning",
  });
}

/** 屏上那一句（等待中为什么只有线索）。唯一一处说这句话的地方。 */
export function recallWaitingLineV1(kind: RecallWaitingKindV1): string {
  return RECALL_REVEAL_COPY_V1.waiting(kind);
}

/** 「先看笔记」那颗按钮上的字。 */
export const RECALL_READ_NOTE_LABEL_V1 = RECALL_REVEAL_COPY_V1.readNoteFirst;

/**
 * 点过「先看笔记」之后的那一句（回执同源，不在渲染层另写一遍）。
 *
 * 屏上**必须**说这一句：§7.1「如实按本次暴露条件处理」——用户点了一颗会改变
 * 这一次判定条件的按钮，屏上却不说话，那颗按钮就等于没有后果。
 */
export function recallRevealReceiptLineV1(kind: RecallWaitingKindV1): string {
  return RECALL_REVEAL_COPY_V1.recorded(kind);
}
