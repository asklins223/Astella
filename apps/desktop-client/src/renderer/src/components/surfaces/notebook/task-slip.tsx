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
import { useEffect, useState, type ReactNode } from "react";

export type TaskSlipKind = "overview" | "annotation" | "expansion" | "artifact";
export type TaskSlipStatus = "queued" | "running" | "ready" | "failed";

/**
 * 等待的两档口径（2026-10-16 线上实证）。
 *
 * 起因：一次速看卡在模型的长思考里，单发 242 s；客户端每 1.6 s 轮询、纸面从头到尾
 * 只写「正在整理整篇笔记」，用户看不出是在走还是死了，也没有任何出路。
 *
 * - {@link NOTE_TASK_SLOW_MS}：正常一发 10–30 s，超过它就直说「这次比平时久」，
 *   只给判断，不改动作；
 * - {@link NOTE_TASK_STALL_MS}：超过它就不再拦着用户重来一份——
 *   `use-notebook-overview` 用同一个值判断"这次已经不算在跑了"。它不是超时失败：
 *   轮询继续，旧任务真回来了结果照常上屏。
 */
export const NOTE_TASK_SLOW_MS = 45_000;
export const NOTE_TASK_STALL_MS = 180_000;

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

/** 比平时久：说实话，但不催用户做任何事。 */
const SLOW_NOTE = "这次比平时久。可以继续读或离开，结果出来仍会留在这里。";

/** 久到不像还在正常干活了：给一条出路。 */
const STALL_NOTE = "这次等得太久了。正文没有受影响，可以重新整理一份。";

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
}

export function TaskSlip(props: {
  readonly kind: TaskSlipKind;
  readonly status: TaskSlipStatus | null | undefined;
  readonly failureReason?: string | null;
  /**
   * 这次生成是什么时候开始的（任务的 `createdAt`）。给了就在纸签上走「已等 N 秒」，
   * 并按上面的两档改文案。计时器住在这个叶子组件里：纸面（NotebookSurface）一秒
   * 重渲一次是不可接受的。
   */
  readonly runningSince?: string | number | null;
  readonly onRetry?: () => void;
  readonly onOpenSettings?: () => void;
  readonly children?: ReactNode;
}) {
  const { kind, status, failureReason, onRetry, onOpenSettings } = props;
  const working = status === "queued" || status === "running";
  const since = props.runningSince ?? null;
  const [waitedMs, setWaitedMs] = useState(0);

  useEffect(() => {
    if (!working || since === null) { setWaitedMs(0); return; }
    const startedAt = typeof since === "number" ? since : Date.parse(since);
    if (!Number.isFinite(startedAt)) { setWaitedMs(0); return; }
    const tick = () => setWaitedMs(Math.max(0, Date.now() - startedAt));
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [working, since]);

  // `ready` 交给结果纸；`null` 表示压根没在做事。两种都不画。
  if (!status || status === "ready") return null;

  if (status === "failed") {
    const needsConsent = failureReason === "ai_consent_required";
    const policyDenied = failureReason === "ai_data_policy_denied";
    const needsSettings = needsConsent || policyDenied;
    return (
      <div className="task-slip task-slip--failed" role="status" data-task-slip={kind}>
        <span className="task-slip__mark" aria-hidden="true" />
        <div className="task-slip__body">
          <strong className="task-slip__lead">{FAILED[kind]}</strong>
          <p className="task-slip__note">
            {needsConsent
              ? "要先开启 AI 使用权限，任务才发得出去。"
              : policyDenied
                ? "账号的数据外发策略阻止了这次生成。请到 AI 数据同意设置核对外发开关。"
              : failureReason && failureReason !== "unknown"
                ? failureReason
                : "原文没有受影响，可以再来一次。"}
          </p>
        </div>
        {needsSettings && onOpenSettings
          ? <button type="button" className="task-slip__action" onClick={onOpenSettings}>去设置</button>
          : onRetry
            ? <button type="button" className="task-slip__action" onClick={onRetry}>再试一次</button>
            : null}
        {needsSettings && onOpenSettings && onRetry ? <button type="button" className="task-slip__action" onClick={onRetry}>设置好了，再试一次</button> : null}
      </div>
    );
  }

  // 基类 `.task-slip` **就是**在做的那一档：薄荷纸底 + 呼吸点，全族唯一的变体是
  // `--failed`。此前这里还挂着一个 `task-slip--working`，而 `note-hud.css` 只定义了
  // `--failed` —— 给"默认态"另起一个名字，代价是同一种纸有两个写法、其中一份没人接。
  // 状态由下面的 `data-task-state` 说，样子由基类给。
  const waitedSeconds = Math.floor(waitedMs / 1000);
  const slow = since !== null && waitedMs >= NOTE_TASK_SLOW_MS;
  const stalled = since !== null && waitedMs >= NOTE_TASK_STALL_MS;
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
        <p className="task-slip__note">{stalled ? STALL_NOTE : slow ? SLOW_NOTE : KEEP_READING}</p>
        {since !== null ? (
          // 每秒都在变，不能进 aria-live（读屏会每 1 秒念一次）；上面的文案变化
          // 只有两次，由它负责让读屏知道"慢了／太久了"。
          <p className="task-slip__elapsed" aria-hidden="true">已等 {formatWait(waitedSeconds)}</p>
        ) : null}
      </div>
      {/* 重来一份只在"这次已经不算在跑了"之后给：还在跑时服务端会挡下重复发起，
          现在就放一个按钮等于做一个按不动的按钮。 */}
      {stalled && onRetry ? <button type="button" className="task-slip__action" onClick={onRetry}>重新整理</button> : null}
      {props.children}
    </div>
  );
}
