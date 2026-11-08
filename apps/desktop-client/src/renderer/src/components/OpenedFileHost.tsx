import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenedFileBatchV1, OpenedFileV1 } from "@astella/shared/desktop-ipc-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../app/client/desktop-client";
import { useOptionalCompanionChat } from "../app/companion-session/companion-chat-session";
import { requestCompanionFileAttachment } from "../app/companion-session/companion-file-attachment";
import { NotebookLocalFiles } from "./surfaces/notebook/document/notebook-local-files.tsx";

type HostState = { readonly files: readonly OpenedFileV1[]; readonly active: number };

/**
 * 系统文件关联的渲染层落点（2026-11）。
 *
 * 挂在书房内：文件先由主进程收着，等这个窗口能读工作区了再 `take`，所以登录页不会
 * 被一张稿纸抢走。稿纸铺满窗口，但 Live2D 伴星在它上方，对话仍走现有 HUD。
 * 一批文件顺序打开；当前稿纸有未保存修改时，新文件只进顶部页签，不抢走焦点。
 */
export function OpenedFileHost() {
  const [state, setState] = useState<HostState>({ files: [], active: -1 });
  const seenPaths = useRef(new Set<string>());
  const seenBatches = useRef(new Set<string>());
  const chat = useOptionalCompanionChat();

  const accept = useCallback((batch: OpenedFileBatchV1) => {
    if (seenBatches.current.has(batch.batchId)) return;
    seenBatches.current.add(batch.batchId);
    const fresh = batch.files.filter(file => !seenPaths.current.has(file.path));
    if (fresh.length === 0) return;
    for (const file of fresh) seenPaths.current.add(file.path);
    setState(current => ({
      files: [...current.files, ...fresh],
      active: current.active < 0 ? 0 : current.active,
    }));
  }, []);

  useEffect(() => {
    const api = window.astella?.openedFile;
    if (!api) return;
    const unsubscribe = api.onIncoming(accept);
    void api.take({ meta: createRequestMeta() }).then(response => {
      const batch = unwrapGatewayResult(response);
      if (batch) accept(batch);
    }).catch(() => {
      // 首帧补读失败不是致命问题：下一次系统打开仍会推上来。
    });
    return unsubscribe;
  }, [accept]);

  const close = useCallback(() => {
    setState(current => {
      if (current.active >= 0 && current.active < current.files.length - 1) {
        return { ...current, active: current.active + 1 };
      }
      seenPaths.current.clear();
      return { files: [], active: -1 };
    });
  }, []);

  const activeFile = state.active >= 0 ? state.files[state.active] : undefined;
  const entries = state.files.map(file => ({ path: file.path, name: file.name }));

  const [askPending, setAskPending] = useState(false);
  const askCompanion = useCallback((file: { readonly path: string; readonly name: string; readonly markdown: string }) => {
    if (!chat) return;
    requestCompanionFileAttachment({ path: file.path, name: file.name, text: file.markdown });
    seenPaths.current.clear();
    setState({ files: [], active: -1 });
    // 稿纸卸载时会把 HUD 页恢复成上一页；在同一个提交里开对话会被那次恢复立即关掉。
    // 先让稿纸落地，再由 effect 打开现有伴星面板。
    setAskPending(true);
  }, [chat]);
  useEffect(() => {
    if (!askPending) return;
    // 不要在 effect 开头把 askPending 清掉：那个 commit 的 cleanup 会把还没响的定时器一并取消。
    const timer = window.setTimeout(() => {
      setAskPending(false);
      chat?.setMode("conversation");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [askPending, chat]);

  if (!activeFile) return null;

  return <NotebookLocalFiles
    key={activeFile.id}
    initialPath={activeFile.path}
    initialEntries={entries}
    onClose={close}
    onAskCompanion={askCompanion}
  />;
}
