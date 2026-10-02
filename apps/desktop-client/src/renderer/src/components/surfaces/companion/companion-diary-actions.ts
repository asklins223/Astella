/**
 * 日记的三个写动作（40 §10）：隐藏 / 取消隐藏 / 删除。
 *
 * ## 为什么是单独一个 hook 而不是三个 useState 加在面板里
 *
 * 它们是一件事的三个分支：同一个 `date`、同一条 busy 闩、同一个「完成后
 * 重读日记与月历」的后置。拆散写在面板里会出现三个独立的 busy、三处
 * 各自的 notice、以及「删除完忘了重读月历」这种只在真实使用里才暴露的偏差。
 *
 * 顺带解决体量：`companion-center-surface.tsx` 的 hook 数已经越过软线，
 * 而这一块逻辑是**自包含**的——它只依赖 `date`、`reload` 与一个 meta 工厂，
 * 不碰别的取数链。按 AGENTS.md「拆分按依赖与职责判断」，它正是该搬的那一块。
 *
 * ## 隐藏与删除为什么是两个动作
 *
 * 合同把它们的��果写得完全不同：
 *   - 隐藏：从列表与主动推荐里移除，**不删内容**，可恢复；
 *   - 删除：连派生预览与摘录一起清掉，不能恢复。
 * 所以这里没有 `action: "hide" | "delete"` 那种"调用点自己记得传对"的接口，
 * 而是三个具名回调——读调用点就知道点的是哪个按钮。
 */
import { useCallback, useState } from "react";

import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";

export type DiaryWriteAction = "hide" | "unhide" | "delete";

export function useCompanionDiaryActions(input: {
  /** 当前正在看的那一天；null = 没选日期，此时三个动作都不可用。 */
  date: string | null;
  /** 当前工作区纪元；写操作必须带上，否则切过空间的在途请求会落到新空间上。 */
  epochRef: { readonly current: number | undefined };
  /** 后置：重读日记与月历标记。删除会改月历（那天不该再显示成「她写过」）。 */
  reload: () => Promise<void> | void;
}): {
  readonly busy: boolean;
  readonly confirmingDelete: boolean;
  readonly notice: string | null;
  readonly hide: () => void;
  readonly unhide: () => void;
  readonly remove: () => void;
  readonly setConfirmingDelete: (value: boolean) => void;
} {
  const [busyAction, setBusyAction] = useState<DiaryWriteAction | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const meta = useCallback(() => createRequestMeta(input.epochRef.current), [input.epochRef]);

  const run = useCallback(async (action: DiaryWriteAction) => {
    const date = input.date;
    if (!date || busyAction !== null) return;
    setBusyAction(action);
    setNotice(null);
    try {
      if (action === "delete") {
        const outcome = unwrapGatewayResult(
          await window.ailearn.companion.daily.delete({ meta: meta(), date }),
        );
        setConfirmingDelete(false);
        // §11.1 要求「展示实际范围与结果」：三个数分别是什么，别只说"删好了"。
        setNotice(outcome.diary
          ? `删掉了这一篇，同时清掉 ${outcome.entries} 条摘录、${outcome.memories} 条由它产生的记忆。那天的对话仍然在。`
          : "这一天已经没有日记了。");
      } else {
        const outcome = unwrapGatewayResult(action === "hide"
          ? await window.ailearn.companion.daily.hide({ meta: meta(), date })
          : await window.ailearn.companion.daily.unhide({ meta: meta(), date }));
        setNotice(outcome.changed
          ? (action === "hide" ? "藏起来了。内容还在，随时能取消隐藏。" : "取回来了。")
          : "这一次没有改变任何东西。");
      }
    } catch (error) {
      setNotice(action === "delete"
        ? `没能删掉：${gatewayErrorMessage(error)}`
        : `没能${action === "hide" ? "藏起来" : "取回"}：${gatewayErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
      await input.reload();
    }
  }, [busyAction, input, meta]);

  return {
    busy: busyAction !== null,
    confirmingDelete,
    notice,
    hide: useCallback(() => { void run("hide"); }, [run]),
    unhide: useCallback(() => { void run("unhide"); }, [run]),
    remove: useCallback(() => { void run("delete"); }, [run]),
    setConfirmingDelete,
  };
}