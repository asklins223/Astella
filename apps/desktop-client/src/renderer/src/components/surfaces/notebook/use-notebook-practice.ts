/**
 * 「练一道」那一发的在途与失败。
 *
 * ## 为什么只收 state、不收 handler（2026-09-29）
 *
 * `prepareRoundPractice` / `startRoundPractice` 两个 handler 各自要读 `openRound`、
 * `roundPracticeStart`、`startObjectiveJourney`、`activeRunId`…——它们是**页面级动作**，
 * 搬进来就要把这些一起搬，那不是拆分是重新设计。
 *
 * 所以这里**只收这一对 state**：它是这一发真正私有的东西，两个 handler 共享它。
 * 判据是「**谁改 state**」——两个 handler 改的是同两格，就归一个 hook。
 *
 * ## 一条不许动
 *
 * **`busy` 只有一个**。`prepare` 与 `start` 共用这一格，所以「准备小问题」在途时
 * 「用这一身去练」不会再发第二发——两发并发会得到两个 run，屏上只看得见一个。
 */
import { useState } from "react";
import type { GatewayFailureKind } from "../../../app/desktop-client";

/** 这一发失败时页面按 `kind` 选话。 */
export type PracticeFailureV1 = { readonly kind: GatewayFailureKind; readonly message: string } | null;

export function useNotebookPractice() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PracticeFailureV1>(null);

  /** 发之前清一次——两发共用这一格，上一发的失败不该挂在这一发上。 */
  const begin = () => {
    setBusy(true);
    setFailure(null);
  };

  return { busy, failure, begin, end: () => setBusy(false), setFailure };
}
