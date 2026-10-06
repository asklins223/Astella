/**
 * 「回看某一轮」那一簇：翻开某一轮当时的讲解与练习记录。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `NotebookSurface` 还有 67 个 state，按前缀聚成若干簇（annotation / learning / round /
 * recall / expansion / older / teaching / inspected …）。这是 `inspected` 簇——
 * 3 个 state + 1 个 effect，是当前区段最集中的一簇（setter 只落在 2 个区段里）。
 *
 * 它也是 **journey 头部能被切的前提之一**：那个 250 行的区块用掉页面三成的 state，
 * 所以要先按域把 state 收进 hook，才谈得上切它。
 *
 * ## ⚠️ 那个 `cancelled` 闭包不能省
 *
 * 翻篇、切到别的叶、重试——三样都会连发。慢的那一发回来会覆盖快的那一发，
 * 于是「轮回看」那一格会显示**上一轮**的讲解。`cancelled` 是这一串防竞态的唯一凭据，
 * `finally` 里的 `if (!cancelled)` 同理。
 */
import { useEffect, useState } from "react";
import type { RoundTeachingViewV1 } from "@astella/shared/note-learning-round-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";

export function useNotebookInspectedRound(input: {
  /** 当前叶。**只有 `history` 才翻**——别处翻它没有意义，还会在正文页抢一格。 */
  readonly leaf: string;
  readonly roundId: string | undefined;
  readonly noteId: string | undefined;
  /** 这一轮的内容按当前权限遮蔽了。遮蔽时**不发**那一发。 */
  readonly masked: boolean;
  /** 递增一次 = 重发。`notebook-round-recap` 里那颗「重试」调的就是它。 */
  readonly inspectRevision: number;
  readonly epochRef: { current: number | undefined };
  readonly api: NonNullable<Window["astella"]> | undefined;
}) {
  const { leaf, roundId, noteId, masked, inspectRevision, epochRef, api } = input;

  const [inspectedRound, setInspectedRound] = useState<{ roundId: string; view: RoundTeachingViewV1 } | null>(null);
  const [inspectedRoundBusy, setInspectedRoundBusy] = useState(false);
  const [inspectedRoundFailure, setInspectedRoundFailure] = useState<string | null>(null);

  useEffect(() => {
    if (leaf !== "history" || !roundId || !noteId || masked) return;
    let cancelled = false;
    setInspectedRoundBusy(true);
    setInspectedRoundFailure(null);
    if (!api) {
      setInspectedRoundBusy(false);
      setInspectedRoundFailure("这一轮暂时读不到，请稍后重试。");
      return;
    }
    void api.noteLearningRound.teaching({
      meta: createRequestMeta(epochRef.current),
      roundId,
    }).then((response) => {
      if (cancelled) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setInspectedRound({ roundId, view: unwrapGatewayResult(response) });
    }).catch((error) => {
      if (!cancelled) setInspectedRoundFailure(gatewayErrorMessage(error));
    }).finally(() => {
      if (!cancelled) setInspectedRoundBusy(false);
    });
    return () => { cancelled = true; };
  }, [leaf, roundId, noteId, masked, inspectRevision, api]);

  return { inspectedRound, inspectedRoundBusy, inspectedRoundFailure };
}
