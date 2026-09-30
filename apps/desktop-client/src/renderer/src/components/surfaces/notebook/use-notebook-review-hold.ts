/**
 * 「复习安排」那一簇：暂不安排 / 恢复安排，以及它们的进行中与回执。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `NotebookSurface` 还有 77 个 state。这是 `review` 簇（3 个 state + 1 个回调）——
 * 当前最干净的一簇之一，也是 **journey 头部能被切的前提**之一：那个 262 行的区块
 * 用掉页面 32/81 个 state，所以要先按域把 state 收进 hook，才谈得上切它。
 *
 * ## 这一发里有三件不能少的事（原文注释照搬，别在搬的时候删掉）
 *
 *  1. **成功后必须回读**（`reload({silent:true})`），屏上那枚纸签与那颗按钮换不换，
 *     由**服务端存下来的那一条**说了算——不是本地把 state 改一下。本地改的后果是
 *     这一页说「暂不安排」而库里没有，下一次回读又变回去。
 *  2. **回执要念出来**（`objectiveHoldNotice` / `objectiveResumeNotice`），尤其是
 *     「顺手撤下了 N 条」与「沿用已经排好的安排」两句——它们是这一发唯一能让用户
 *     看见后果的地方（§9.1「操作时说明」）。
 *  3. **失败不吞**：409（`still_held`）与网络失败都走 `reviewHoldError`，
 *     且**清掉**上一次的成功回执——两句话同时挂着会读成「没生效但有结果」。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import { useState } from "react";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import type { ObjectiveHoldResultV2, ObjectiveResumeResultV2 } from "@ailearn/shared/review-queue-v2-contracts";

/**
 * 「暂不安排」与「恢复安排」成功后的那两句回执。
 *
 * **签名从 `objective-state-copy.ts` 推导**，不是我在���儿另写一份：那两个函数的收据
 * 形状是它们自己的事，在这里写 `unknown` 只会逼调用处做断言——那等于把形状藏起来。
 */
type ReviewHoldNotices = {
  readonly hold: (receipt: ObjectiveHoldResultV2) => string;
  readonly resume: (receipt: ObjectiveResumeResultV2) => string;
};
export function useNotebookReviewHold(input: {
  readonly noteId: string | null;
  readonly currentVersionId: string | null;
  /** 这一篇最近的那个目标。`null` 时那颗「暂不安排」不存在。 */
  readonly noteObjective: { readonly objectiveId: string } | null;
  readonly epochRef: { current: number | undefined };
  readonly reload: (options?: { silent?: boolean }) => Promise<void>;
  readonly api: NonNullable<Window["ailearn"]> | undefined;
  readonly notices: ReviewHoldNotices;
}) {
  const { noteId, currentVersionId, noteObjective, epochRef, reload, api, notices } = input;

  const [reviewHoldBusy, setReviewHoldBusy] = useState<"hold" | "resume" | null>(null);
  const [reviewHoldNotice, setReviewHoldNotice] = useState<string | null>(null);
  const [reviewHoldError, setReviewHoldError] = useState<string | null>(null);

  const runObjectiveReviewHoldAction = async (kind: "hold" | "resume") => {
    const currentNote = noteId && currentVersionId ? { noteId, currentVersionId } : null;
    const target = noteObjective;
    if (!api || !currentNote || !target || reviewHoldBusy) return;
    setReviewHoldBusy(kind);
    setReviewHoldError(null);
    setReviewHoldNotice(null);
    try {
      const request = { noteId: currentNote.noteId, objectiveId: target.objectiveId };
      if (kind === "hold") {
        const response = await api.review.holdObjective({ meta: createRequestMeta(epochRef.current), request });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        setReviewHoldNotice(notices.hold(unwrapGatewayResult(response)));
      } else {
        const response = await api.review.resumeObjective({ meta: createRequestMeta(epochRef.current), request });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        setReviewHoldNotice(notices.resume(unwrapGatewayResult(response)));
      }
      await reload({ silent: true });
    } catch (error) {
      setReviewHoldError(gatewayErrorMessage(error));
    } finally {
      setReviewHoldBusy(null);
    }
  };

  return {
    reviewHoldBusy,
    reviewHoldNotice,
    reviewHoldError,
    runObjectiveReviewHoldAction,
  };
}
