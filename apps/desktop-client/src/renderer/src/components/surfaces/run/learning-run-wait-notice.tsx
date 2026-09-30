/**
 * 题面下面那一块的**四档等待说明**：结果没回来 / checkpoint / 还没到能作答 / 兜底。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * 题面区是 `LearningRunBody` 剩下的最后一大块。它的上半（`InteractionEditor`）要读编辑内容，
 * 留在页面；**下半这四档说明是纯文案 + 两三个状态**，自足，可以整块搬。
 *
 * ## ⚠️ 三段裁决，别把它们当普通文案改掉
 *
 *  1. **checkpoint 那段（2026-09-21 实机截图）**：这里原本只写「等待下一步 / 正在准备下一步。」，
 *     而 checkpoint 的下一步其实**是用户自己**——服务端签发的是
 *     「继续补充证据 / 结束但不改变复习」，它们却落在折叠的「更多选择」里，
 *     屏上只剩一个「安全退出」。用户的原话是「我就一直在这里等着？」。
 *     所以这一段（1）**说清这一轮为什么停在这里**，（2）把真正的下一步提到明面上
 *     （见 `learning-run-dock.tsx` 里的 `checkpointPrimary`）。
 *  2. **审计 F11（兜底那一档）**：暂停之后旁边若还写着「正在准备下一步」，
 *     读者会以为后台还在推进。暂停是**用户自己做的**，这一句要说的是
 *     **「要等你继续」**，不是「还在算」。
 *  3. **等结果那一档的两种措辞**：`resultQueryBudgetExhausted` 为真时说的是
 *     「算好会自动回到这一页；这段时间**不用再交一次，也不会被算成两次**」——
 *     后半句是防止用户以为漏了提交会重复计分。那不是安慰，是**行为承诺**。
 */
import type { ReactElement } from "react";
import { LoaderCircle } from "lucide-react";

/** 一处失败。`null` = 这次没有失败要念。 */
type FailureLineV1 = { readonly message: string } | null;

export function LearningRunResultPending(props: {
  readonly headline: string;
  readonly waitingSeconds: number;
  /** 用户已经交上去的那段回答（提交后仍展示，让用户看见自己交了什么）。 */
  readonly lockedAnswer: string | null;
  readonly resultQueryBudgetExhausted: boolean;
  readonly processingFailure: FailureLineV1;
}): ReactElement {
  const { headline, waitingSeconds, lockedAnswer, resultQueryBudgetExhausted, processingFailure } = props;
  return (
    <div role="status" aria-live="polite" className="learning-run-assessing">
      <strong className="title">
        <LoaderCircle className="run-spinner" size={15} aria-hidden="true" />
        {headline}
        <b className="learning-run-assessing__wait">已等待 {waitingSeconds}s</b>
      </strong>
      {lockedAnswer ? (
        <blockquote className="learning-run-assessing__answer">
          <span className="meta">你交上去的回答</span>
          {lockedAnswer}
        </blockquote>
      ) : null}
      <p className="small">
        {resultQueryBudgetExhausted
          ? "结果还在后台算，算好会自动回到这一页；这段时间不用再交一次，也不会被算成两次。"
          : "可以先离开，不用等在这儿；结果没回来之前，这里不会先给结论。"}
      </p>
      {processingFailure ? <p className="small" role="alert">{processingFailure.message}</p> : null}
    </div>
  );
}

/**
 * checkpoint：这一轮为什么停在这里。
 *
 * 三档各有各的理由，**不是同一个句子的三种说法**：
 * - 缺原文证据 —— 判不出结论**不是因为你答得不够好**，是系统侧缺证据，再补也补不上；
 * - 判不出结论 —— 题目交上去了，但这一次没有结论，可以补证据也可以结束（不改变复习）；
 * - 只证明了一部分 —— 还有几处没被证明。
 */
export function LearningRunCheckpointNotice(props: {
  readonly evidenceGap: boolean;
  readonly unassessable: boolean;
  readonly failure: FailureLineV1;
}): ReactElement {
  const { evidenceGap, unassessable, failure } = props;
  return (
    /* 2026-09-21 实机截图：见文件头第 1 条。 */
    <div role="status">
      <strong className="title">
        {evidenceGap
          ? "这条还不能正式验证：缺原文证据"
          : unassessable
            ? "这次没有形成可记录的结论"
            : "这次只证明了一部分"}
      </strong>
      <p className="small">
        {evidenceGap
          ? "这次判不出结论不是因为你答得不够好：这条目标的评分点还缺系统侧的原文证据，再补一段回答也补不上。可以结束这一轮，回到目标去看还缺什么。"
          : unassessable
            ? "题目已经交上去了，但这一次判不出结论。你可以继续补充证据，或者结束这一轮——结束不会改变复习安排。"
            : "还有几处没被证明。你可以继续补充证据，或者就此结束这一轮。"}
      </p>
      {failure ? <p className="small" role="alert">{failure.message}</p> : null}
    </div>
  );
}

/** 兜底：还没到能作答。 */
export function LearningRunPreparing(props: {
  readonly title: string;
  readonly paused: boolean;
  readonly failure: FailureLineV1;
}): ReactElement {
  const { title, paused, failure } = props;
  return (
    <div role="status">
      <strong className="title">{title}</strong>
      {/* 审计 F11：暂停之后旁边还写着"正在准备下一步"，读者会以为后台还在推进。
          暂停是**用户自己做的**，这一句要说的是"要等你继续"，不是"还在算"。 */}
      <p className="small">
        {paused
          ? "已暂停计时；点继续之后才会读取下一步。"
          : "正在准备下一步。"}
      </p>
      {failure ? <p className="small" role="alert">{failure.message}</p> : null}
    </div>
  );
}

/** 结果读回来了但没确认（预算耗尽 / 读失败）：**这是失败，不是等待**。 */
export function LearningRunUnresolvedResult(props: {
  readonly message: string;
}): ReactElement {
  return (
    <div role="alert">
      <strong className="title">暂时无法确认最终学习结果</strong>
      <p className="small">{props.message}</p>
    </div>
  );
}
