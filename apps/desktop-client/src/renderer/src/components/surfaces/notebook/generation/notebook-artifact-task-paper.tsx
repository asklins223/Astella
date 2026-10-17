/**
 * 「互动演示任务」那张小纸签：任务在飞、读不到进度、以及去开 AI 同意的那条路。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 速看发起的任务在原入口交代进度、重试与结果。做好后由用户主动打开，
 * 不让后台回执自动切换正在阅读的页面。
 *
 * ## 两条不许动
 *
 *  1. **`role="alert"` 只给「读不到任务进度」**，不给「做失败了」。前者是本页读不到，
 *     后者是服务端说的失败——两者混起来会让用户以为是本页坏了。
 *  2. **「没读到进度」不是「没有任务」**：没有任务时这一格画的是 header 而不是一个 alert。
 */
import type { ReactElement } from "react";
import type { NoteLearningArtifactTaskV1, NoteLearningArtifactV1 } from "@astella/shared/note-learning-artifact-contracts";
import { TaskSlip } from "./task-slip.tsx";

/** 一个还在飞的任务。**只声明这一格真正要读的三项**，多写一项就多一处与源头分叉的地方。 */
export type ArtifactTaskV1 = Pick<NoteLearningArtifactTaskV1, "taskId" | "status" | "failureReason" | "artifact">;

export function NotebookArtifactTaskPaper(props: {
  readonly tasks: readonly ArtifactTaskV1[];
  readonly error: string | null;
  readonly onStart: (task: ArtifactTaskV1) => void;
  readonly onOpen: (artifact: NoteLearningArtifactV1) => void;
  readonly onOpenSettings: () => void;
}): ReactElement {
  const { tasks, error, onStart, onOpen, onOpenSettings } = props;
  return (
    <aside className="note-learning-artifact-task-paper" aria-label="互动演示任务">
      <header><strong>互动演示</strong><span>做好后可以从这里打开</span></header>
      {tasks.map((task) => (
        <div className="note-learning-artifact-task-paper__row" key={task.taskId}>
          <TaskSlip kind="artifact" status={task.status}
            failureReason={task.failureReason ?? error}
            onRetry={() => onStart(task)}
            onOpenSettings={onOpenSettings} />
          {task.status === "ready" && task.artifact ? <button type="button" className="button" onClick={() => onOpen(task.artifact!)}>打开演示：{task.artifact.title}</button> : null}
        </div>
      ))}
      {error ? <p role="alert">暂时没读到任务进度：{error}</p> : null}
    </aside>

  );
}
