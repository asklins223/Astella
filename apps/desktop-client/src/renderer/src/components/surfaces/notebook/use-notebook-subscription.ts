/**
 * 「笔记订阅」开／停那一簇。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `NotebookSurface` 还有 75 个 state。这是 `subscription` 簇（3 个 state + 1 个回调），
 * 与刚搬走的 `review` 簇**同源**——两处纪律一样，所以两处该住在一起看。
 *
 * 它也是 **journey 头部能被切的前提之一**：那个 262 行的区块用掉页面 32/81 个 state，
 * 所以要先按域把 state 收进 hook，才谈得上切它。
 *
 * ## 两处与「暂不安排」那一族同源、且都写在这里而不是散进 JSX
 *
 *  1. **成功后回读。** 开关拨完之后屏上那个「开／关」必须来自**服务端存下来的那一条**，
 *     不是本地改 state——本地改的后果是这一页说「已停用」而库里没有。
 *  2. **回执整句念出来。** §9.1 规则表行 1「其他来源仍有效时**显示原因**」是
 *     那一格存在的理由：停笔记订阅而那张卡还单独开着时，只说「已停用」会让用户以为
 *     整篇都不提醒了。`reviewSubscriptionNotice` 按 `stillCoveredBy` 分两句。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import { useState } from "react";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import type { ReviewSubscriptionResultV2 } from "../run/objective-state-copy.ts";

/** 成功后那一句回执。**由页面传进来**——它按 `stillCoveredBy` 分两句，
 * 形状是 `objective-state-copy.ts` 那个文件自己的事，我在这儿只引用不重写。 */
type SubscriptionNotices = {
  readonly notice: (receipt: ReviewSubscriptionResultV2) => string;
};

export function useNotebookSubscription(input: {
  readonly noteId: string | null;
  readonly epochRef: { current: number | undefined };
  readonly reload: (options?: { silent?: boolean }) => Promise<void>;
  readonly api: NonNullable<Window["ailearn"]> | undefined;
  readonly notices: SubscriptionNotices;
}) {
  const { noteId, epochRef, reload, api, notices } = input;

  const [subscriptionBusy, setSubscriptionBusy] = useState<"activate" | "pause" | null>(null);
  const [subscriptionNotice, setSubscriptionNotice] = useState<string | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

  const runNoteSubscriptionAction = async (kind: "activate" | "pause") => {
    if (!api || !noteId || subscriptionBusy) return;
    setSubscriptionBusy(kind);
    setSubscriptionError(null);
    setSubscriptionNotice(null);
    try {
      const request = { source: "note_subscription" as const, subjectId: noteId };
      const response = kind === "activate"
        ? await api.review.activateSubscription({ meta: createRequestMeta(epochRef.current), request })
        : await api.review.pauseSubscription({ meta: createRequestMeta(epochRef.current), request });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setSubscriptionNotice(notices.notice(unwrapGatewayResult(response)));
      await reload({ silent: true });
    } catch (error) {
      setSubscriptionError(gatewayErrorMessage(error));
    } finally {
      setSubscriptionBusy(null);
    }
  };

  return {
    subscriptionBusy,
    subscriptionNotice,
    subscriptionError,
    runNoteSubscriptionAction,
  };
}
