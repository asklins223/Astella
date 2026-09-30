/**
 * 「先讲讲这一节」那一簇：生成这一轮当前问题下的一条解释。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `NotebookSurface` 还有 72 个 state。这是 `teaching` 簇（3 个 state + 1 个回调），
 * 与 `review` / `subscription` 两簇同源——三簇都是「一颗写动作 + 它的在途 + 它的失败」。
 *
 * 它也是 **journey 头部能被切的前提之一**：那个 262 行的区块用掉页面 32/81 个 state，
 * 所以要先按域把 state 收进 hook，才谈得上切它。
 *
 * ## 三件事刻意与别的写动作同一形状（原文照搬）
 *
 *  1. 带 `expectedRevision`——两发之间问题被改写或轮次被收尾时，后到的那一发
 *     必须失败并拿到现在那一版。
 *  2. 成功后走 silent 回读，屏上那句解释**来自服务端存下来的那一条**，不是本机拼的。
 *  3. 失败也要回读一次，把屏上换回现在那一版（§16.39 那条一样的道理）。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import { useState } from "react";
import type { GatewayFailureKind } from "../../../app/desktop-client";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";

/** 生成失败那一句。`kind` 由 `classifyGatewayError` 判，页面按它选话。 */
export type NotebookTeachingFailureV1 = {
  readonly kind: GatewayFailureKind;
  readonly message: string;
} | null;

/** 切到别的一篇/别的一轮时，把「勾了哪几条当私人感想」清空——它们属于原来那一轮。 */
export function useNotebookTeaching(input: {
  readonly epochRef: { current: number | undefined };
  readonly reload: (options?: { silent?: boolean }) => Promise<void>;
  readonly api: NonNullable<Window["ailearn"]> | undefined;
  /** 没有 openRound 就不发——那是「无目标轮次」，服务端也没有可讲的那一条。 */
  readonly openRound: { readonly roundId: string; readonly revision: number } | null;
  readonly classifyError: (error: unknown) => NotebookTeachingFailureV1 extends never
    ? never
    : { kind: GatewayFailureKind; message: string };
}) {
  const { epochRef, reload, api, openRound, classifyError } = input;

  const [teachingBusy, setTeachingBusy] = useState(false);
  const [teachingFailure, setTeachingFailure] = useState<NotebookTeachingFailureV1>(null);
  const [teachingReflectionIds, setTeachingReflectionIds] = useState<string[]>([]);

  const startRoundTeaching = async (regenerate = false, personalReflectionIds = teachingReflectionIds) => {
    if (!api || !openRound || teachingBusy) return;
    setTeachingBusy(true);
    setTeachingFailure(null);
    try {
      const response = await api.noteLearningRound.explain({
        meta: createRequestMeta(epochRef.current),
        roundId: openRound.roundId,
        expectedRevision: openRound.revision,
        personalReflectionIds,
        // 「换一种解释」走同一发：服务端据此**跳过复用**，在同一问题下落第二条（序号 +1）。
        ...(regenerate ? { regenerate: true } : {}),
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setTeachingReflectionIds([]);
      await reload({ silent: true });
    } catch (error) {
      setTeachingFailure(classifyError(error));
      await reload({ silent: true });
    } finally {
      setTeachingBusy(false);
    }
  };

  return {
    teachingBusy,
    teachingFailure,
    teachingReflectionIds,
    setTeachingReflectionIds,
    startRoundTeaching,
  };
}
