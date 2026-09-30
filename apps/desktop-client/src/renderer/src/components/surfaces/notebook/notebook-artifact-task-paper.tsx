/**
 * 「互动演示任务」那张小纸签：任务在飞、读不到进度、以及去开 AI 同意的那条路。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 13 行、4 个外部符号。它**只列 `sourceKind === "overview"` 且还在飞的那几条**——
 * 已完成的不列（那些在「学习记录」里），失败且已被读到的也不列（那张纸自己会说）。
 *
 * ## 两条不许动
 *
 *  1. **`role="alert"` 只给「读不到任务进度」**，不给「做失败了」。前者是本页读不到，
 *     后者是服务端说的失败——两者混起来会让用户以为是本页坏了。
 *  2. **「没读到进度」不是「没有任务」**：没有任务时这一格画的是 header 而不是一个 alert。
 */
import type { ReactElement } from "react";
import { TaskSlip, type TaskSlipStatus } from "./task-slip.tsx";

/** 一个还在飞的任务。**只声明这一格真正要读的三项**，多写一项就多一处与源头分叉的地方。 */
export type ArtifactTaskV1 = {
  readonly taskId: string;
  readonly status: TaskSlipStatus;
  readonly failureReason: string | null;
};

export function NotebookArtifactTaskPaper(props: {
  readonly tasks: readonly ArtifactTaskV1[];
  readonly error: string | null;
  readonly onStart: (task: ArtifactTaskV1) => void;
  readonly onOpenSettings: () => void;
}): ReactElement {
  const { tasks, error, onStart, onOpenSettings } = props;
  return (
    <aside className="note-learning-artifact-task-paper" aria-label="互动演示任务">
      <header><strong>互动演示</strong><span>做好后可以从这里打开</span></header>
      {tasks.map((task) => (
        <div className="note-learning-artifact-task-paper__row" key={task.taskId}>
          <p>为这篇笔记做演示</p>
          <TaskSlip kind="artifact" status={task.status}
            failureReason={task.failureReason ?? error}
            onRetry={() => onStart(task)}
            onOpenSettings={onOpenSettings} />
        </div>
      ))}
      {error ? <p role="alert">暂时没读到任务进度：{error}</p> : null}
    </aside>

  );
}
