/**
 * 「回想一下」这一屏与页面之间传的那几个形状。
 *
 * ## 为什么要有这个文件（2026-09-29）
 *
 * `notebook-surface.tsx` 的 `actOnActiveRecall` 早就带着一个**精确的判别联合**，
 * 但它是**匿名内联**的：
 *
 * ```ts
 * action: { kind: "hint" } | { kind: "reveal" }
 *       | { kind: "self_report"; value: "remembered" | "partly" | "not_yet"; reflection?: string }
 * ```
 *
 * 于是「回想那张纸」那一块（48 行）**切不出去**——页面传得进去，组件声明不了这个回调，
 * 只能自己重写一遍分支。2026-09-29 那次抽取就是这么失败的：抄出来的联合少了
 * `reflection`，typecheck 报了两处。
 *
 * 给它一个名字，两边就都能引用同一份形状，抽取这件事不再需要「把逻辑抄一遍」——
 * **这比直接切组件更根本**，因为它让「切组件」这件事不再有代价。
 *
 * 这里是**纯类型**（加一个纯函数），零行为变化。
 */

/** 三档自评，是 `noteRecall.act` 合同里的那一组字面量，不是我们自己起的名。 */
export type RecallSelfReportV1 = "remembered" | "partly" | "not_yet";

/** 回想这一屏的全部动作。`self_report` 那一支多带一句用户自己写的话。 */
export type RecallActionV1 =
  | { readonly kind: "hint" }
  | { readonly kind: "reveal" }
  | { readonly kind: "self_report"; readonly value: RecallSelfReportV1; readonly reflection?: string };

/** 三颗自评按钮的文案。**顺序即屏上顺序**，别随手改。 */
export const RECALL_SELF_REPORT_LABEL: Readonly<Record<RecallSelfReportV1, string>> = {
  remembered: "想起来了",
  partly: "想起一部分",
  not_yet: "还没想起来",
};

/**
 * `recallBusy` 的四档：取线索 / 翻开对照 / **起一轮回想（start）** / 记自评。
 * `start` 也在这儿——回想这一块与「开始一次回想」共用同一个忙标记，所以别把它删掉。
 */
export type RecallBusyV1 = "start" | "hint" | "reveal" | "report" | null;

/**
 * 当前这一条回想在屏上要显示的形状。
 *
 * `versionState` 决定那块「笔记后来改过，这里保留的是当时的原文快照」出不出现——
 * 旧版记录不许点「回到第 N 段」跳进现在的正文，所以它是分支而不是装饰。
 */
export type NoteRecallCardV1 = {
  readonly question: string;
  /** 合同里这两项是可选的（没取到就是 undefined），屏上按「没有」处理，所以收成 `?`。 */
  readonly answer?: string | null;
  readonly hint?: string | null;
  readonly answerTruncated?: boolean;
  readonly versionState: "current" | "older";
  readonly noteVersionNumber: number;
  readonly sectionTitle?: string | null;
  readonly sectionOrdinal?: number | null;
  readonly selfReport: RecallSelfReportV1 | null;
};
