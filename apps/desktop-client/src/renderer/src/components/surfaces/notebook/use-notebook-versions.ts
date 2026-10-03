/**
 * 笔记「版本历史」那一簇：读列表、把某一版换回当前。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `NotebookSurface` 单个函数还有 81 个 state，按前缀聚成若干簇（annotation / learning /
 * round / recall / expansion / older / teaching / versions …）。这是 `versions` 簇：
 * 4 个 state + 2 个回调，只依赖 `data` / `epochRef` / `reload` 三样，是当前最干净的一簇。
 *
 * 它也是 **journey 头部能被切的前提之一**——那个 262 行的区块用掉页面 32/81 个 state，
 * 所以先按域把 state 收进 hook，才谈得上切它。
 *
 * ## 语义：读列表与恢复是两件事
 *
 * 列表**不含正文**：一版正文要把那一版换回当前才读得出来（`api.note.restoreVersion`）。
 * 这条不是实现取舍——它决定了屏上怎么说话：这里写「回到这一版」而不是「查看」，
 * 因为查看是不存在的操作。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import { useState } from "react";
import type { DesktopNoteVersionItem } from "@ailearn/shared/desktop-surface-contracts";
import type { NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";

export function useNotebookVersions(input: {
  readonly data: { readonly note: NoteDetailV1 } | null;
  readonly epochRef: { current: number | undefined };
  /** 换回之后要重读笔记本体——它连带影响标题、正文与那张速看。 */
  readonly reload: (options?: { silent?: boolean }) => Promise<void>;
  /**
   * 网关句柄。**由页面传进来**，因为 `desktopApi()` 是页面里的一个函数
   * （`notebook-surface.tsx:397`），不在 app 层——hook 拿不到它。
   * 于是这里用 `Window` 上真实的那个类型，而不是我另编一份结构类型。
   */
  /** 可能是 undefined——页面里的 `desktopApi()` 在 SSR 下就返回 undefined。 */
  readonly api: NonNullable<Window["ailearn"]> | undefined;
}) {
  const { data, epochRef, reload, api } = input;

  const [versions, setVersions] = useState<readonly DesktopNoteVersionItem[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsFailure, setVersionsFailure] = useState<string | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);

  const loadVersions = async (currentVersionId = data?.note.currentVersionId) => {
    const current = data?.note ?? null;
    if (!api || !current || !currentVersionId) return;
    setVersionsLoading(true);
    setVersionsFailure(null);
    try {
      const response = await api.note.versions({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        currentVersionId,
        limit: 50,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setVersions(unwrapGatewayResult(response).items);
    } catch (error) {
      setVersionsFailure(gatewayErrorMessage(error));
    } finally {
      setVersionsLoading(false);
    }
  };

  const restoreVersion = async (version: DesktopNoteVersionItem) => {
    const current = data?.note ?? null;
    if (!api || !current || restoringVersionId) return;
    setRestoringVersionId(version.versionId);
    setVersionsFailure(null);
    try {
      const response = await api.note.restoreVersion({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        versionId: version.versionId,
        baseVersionId: current.currentVersionId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await reload({ silent: true });
      // reload publishes new data on the next render. This request still
      // closes over the previous version, so use the successful restore target.
      await loadVersions(version.versionId);
    } catch (error) {
      setVersionsFailure(`恢复未确认：${gatewayErrorMessage(error)}`);
    } finally {
      setRestoringVersionId(null);
    }
  };

  return {
    versions,
    setVersions,
    versionsLoading,
    versionsFailure,
    setVersionsFailure,
    restoringVersionId,
    loadVersions,
    restoreVersion,
  };
}
