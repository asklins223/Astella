/**
 * 一处说清「AI 正在做什么」的地方。
 *
 ## 为什么把这件事收成一个组件
 *
 笔记页此前有 40 多句手写的「正在…」，散在各个按钮里：按下去的那一下按钮变成
 「正在准备…」，过了两秒纸签上又变成「正在整理这篇」，失败时另有一句
 「上次没整理成，可以重新整理」。三句话各写一遍，用户看到的是**状态在变**而不是
 **事在做成**；而且每一处都没说同一件最要紧的事——**你可以继续读**。
 *
 于是这四件事（看懂这篇 / 讲讲这句 / 往外学 / 互动讲解）里只要有一件在做，
 用户就被挡在原地看一个转圈的东西。任务安静不等于让人干等。
 *
 ## 它必须说的三句
 *
 1. **在做什么**（人话，不是 `job` / `round` / `artifact`）；
 2. **不用等**——正文照常能读，离开这页也不取消；
 3. **没做成时怎么办**——重试，或者去开 AI 权限（那是另一件事，重试没有用）。
 */
import type { ReactNode } from "react";

export type TaskSlipKind = "overview" | "annotation" | "expansion" | "artifact";
export type TaskSlipStatus = "queued" | "running" | "ready" | "failed";

/** 每个动作的「正在做什么」。人话，不是内部词。 */
const WORKING: Record<TaskSlipKind, { queued: string; running: string }> = {
  overview: { queued: "正在准备整理这篇", running: "正在整理整篇笔记" },
  annotation: { queued: "正在准备解释这句", running: "正在把这句话讲清楚" },
  expansion: { queued: "正在准备相关草稿", running: "正在写相关的短笔记" },
  artifact: { queued: "正在准备互动演示", running: "正在制作互动演示" },
};

/** 没做成的理由。分清「再试一次有用」和「怎么试都没用」。 */
const FAILED: Record<TaskSlipKind, string> = {
  overview: "这次没整理出来",
  annotation: "这句没讲成",
  expansion: "这次没找到方向",
  artifact: "这个演示没做成",
};

/**
 * 还没做完时**统一**附上的一句。
 *
 它是这张纸签存在的意义所在：没有这句，用户看到一个转圈的按钮，只能理解成
 「我得站在这儿等」。写上去之后，同一件事就从阻塞变成了后台——这与 41 §2.1
 「关闭纸签或切页不取消任务」是同一句话的两面。
 */
const KEEP_READING = "可以继续读或离开，回来仍能在这里查看结果。";

export function TaskSlip(props: {
  readonly kind: TaskSlipKind;
  readonly status: TaskSlipStatus | null | undefined;
  readonly failureReason?: string | null;
  readonly onRetry?: () => void;
  readonly onOpenSettings?: () => void;
  readonly children?: ReactNode;
}) {
  const { kind, status, failureReason, onRetry, onOpenSettings } = props;
  // `ready` 交给结果纸；`null` 表示压根没在做事。两种都不画。
  if (!status || status === "ready") return null;

  if (status === "failed") {
    const needsConsent = failureReason === "ai_consent_required";
    return (
      <div className="task-slip task-slip--failed" role="status" data-task-slip={kind}>
        <span className="task-slip__mark" aria-hidden="true" />
        <div className="task-slip__body">
          <strong className="task-slip__lead">{FAILED[kind]}</strong>
          <p className="task-slip__note">
            {needsConsent
              ? "要先开启 AI 使用权限，任务才发得出去。"
              : failureReason && failureReason !== "unknown"
                ? failureReason
                : "原文没有受影响，可以再来一次。"}
          </p>
        </div>
        {needsConsent && onOpenSettings
          ? <button type="button" className="task-slip__action" onClick={onOpenSettings}>去设置</button>
          : onRetry
            ? <button type="button" className="task-slip__action" onClick={onRetry}>再试一次</button>
            : null}
      </div>
    );
  }

  // 基类 `.task-slip` **就是**在做的那一档：薄荷纸底 + 呼吸点，全族唯一的变体是
  // `--failed`。此前这里还挂着一个 `task-slip--working`，而 `note-hud.css` 只定义了
  // `--failed` —— 给"默认态"另起一个名字，代价是同一种纸有两个写法、其中一份没人接。
  // 状态由下面的 `data-task-state` 说，样子由基类给。
  return (
    <div
      className="task-slip"
      role="status"
      aria-live="polite"
      data-task-slip={kind}
      data-task-state={status}
    >
      {/* 会动，但动效不是唯一的信号：旁边那句文字已经把状态说全了。 */}
      <span className="task-slip__mark" aria-hidden="true" />
      <div className="task-slip__body">
        <strong className="task-slip__lead">{WORKING[kind][status]}</strong>
        <p className="task-slip__note">{KEEP_READING}</p>
      </div>
      {props.children}
    </div>
  );
}
