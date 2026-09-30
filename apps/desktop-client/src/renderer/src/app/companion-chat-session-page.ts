/**
 * 伴星会话的**页面上下文**（2026-09-30 从 `companion-chat-session.tsx` 抽出）。
 *
 * ## 为什么抽
 *
 * `CompanionChatProvider` 一开头就是九条几乎一模一样的 `useRoomStore((s) => s.x)`，
 * 接着一个页面实例 id 的 ref 和一个把它们拼成 bridge 上下文的 `useMemo`。
 * **十一条 hook，占了 Provider 开头 24 行**——而它们回答的是同一个问题：
 * 「**用户现在站在哪一页、看着哪一条**」。
 *
 * 这个问题的答案**不属于聊天**。它属于「谁在陪着他站在这一页」。
 * 把它收进一个 hook，Provider 开头就只剩一句调用。
 *
 * ## 拆的是位置，不是行为
 *
 * 一行没改，依赖数组一个没动。Provider 那边照旧按原名解构，
 * 所以**下面 400 行里所有用到这些名字的地方都不用动**。
 *
 * ## 为什么单独一个文件，而不是同文件里的一个函数
 *
 * 它是**另一个模块**的职责（页面上下文 ↔ 聊天会话），
 * 而同文件里的自定义 hook 会继续给 Provider 添行数。
 * `component-size-guard` 量的是**最长导出函数体**——
 * 放同文件 Provider 仍是那个函数，hook 数也降不下来。
 */
import { useEffect, useMemo, useRef } from "react";
import { bridgePageContext } from "./companion-chat-session-bridge";
import { useRoomStore } from "./room-store";

/**
 * 订阅房间状态，拼出「他在哪一页、看着哪一条」。
 *
 * 页面实例 id **在切换运行或切换空间时换一个**——
 * 桥那边按它判断「这是不是同一次停留」，换了就当新的一次开始计数。
 */
export function useCompanionPageContext() {
  const hudPage = useRoomStore((state) => state.hudPage);
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const activeNoteId = useRoomStore((state) => state.activeNoteRef?.noteId ?? null);
  const activeNoteVersionId = useRoomStore((state) => state.activeNoteRef?.noteVersionId ?? null);
  const activeSourceId = useRoomStore((state) => state.activeSourceId);
  const activeReviewScheduleId = useRoomStore((state) => state.activeReviewTarget?.scheduleId ?? null);
  const settingsSection = useRoomStore((state) => state.settingsSection);
  const pageReadableView = useRoomStore((state) => state.pageReadableView);
  const workspaceScopeRevision = useRoomStore((state) => state.workspaceScopeRevision);
  const pageInstanceIdRef = useRef(crypto.randomUUID());
  useEffect(() => {
    pageInstanceIdRef.current = crypto.randomUUID();
  }, [activeRunId, workspaceScopeRevision]);
  const brokerPageContext = useMemo(() => bridgePageContext({
    hudPage,
    activeRunId,
    activeNoteId,
    activeNoteVersionId,
    activeSourceId,
    activeReviewScheduleId,
    settingsSection,
    readableView: pageReadableView?.view ?? null,
  }), [activeNoteId, activeNoteVersionId, activeReviewScheduleId, activeRunId, activeSourceId, hudPage, settingsSection, pageReadableView]);

  return {
    hudPage,
    activeRunId,
    activeNoteId,
    activeNoteVersionId,
    activeSourceId,
    activeReviewScheduleId,
    settingsSection,
    pageReadableView,
    workspaceScopeRevision,
    pageInstanceIdRef,
    brokerPageContext,
  };
}
