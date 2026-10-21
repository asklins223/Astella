import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpenText, ChevronLeft, X } from "lucide-react";
import type { DesktopSourceDetail } from "@astella/shared/desktop-surface-contracts";
import { useCompanionChat } from "../../../app/companion-session/companion-chat-session";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import { renderCompanionMarkdown } from "../content/companion-markdown";
import { restoreCompanionPreviewFocus, targetCompanionJournal, useCompanionResultPreview } from "./companion-result-preview";

export function CompanionSourcePreview({ motion }: { motion: "full" | "lite" | "off" }) {
  const chat = useCompanionChat();
  const { sourceTarget: target, sourceReturnTo: returnTo, target: noteTarget, positions } = useCompanionResultPreview();
  const dialog = useRef<HTMLDialogElement>(null), body = useRef<HTMLDivElement>(null), origin = useRef<typeof target>(null);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{ identity: string; detail?: DesktopSourceDetail; error?: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const close = () => useCompanionResultPreview.setState({ sourceTarget: null });
  useLayoutEffect(() => {
    if (target) { origin.current = target; if (!dialog.current?.open) dialog.current?.showModal(); }
    else if (dialog.current?.open) {
      dialog.current.close();
      if (!useCompanionResultPreview.getState().sourceReturnTo && !useCompanionResultPreview.getState().target) restoreCompanionPreviewFocus(origin.current);
      origin.current = null;
    }
  }, [target]);
  useEffect(() => {
    if (!target) return;
    let current = true;
    void (async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        if (target.scope !== useRoomStore.getState().workspaceScopeRevision) return;
        const detail = unwrapGatewayResult(await window.astella.source.get({ meta: createRequestMeta(epoch), sourceId: target.sourceId }));
        if (current && target.scope === useRoomStore.getState().workspaceScopeRevision) setRead({ identity: target.identity, detail });
      } catch (error) { if (current) setRead({ identity: target.identity, error: gatewayErrorMessage(error) }); }
    })();
    return () => { current = false; };
  }, [target?.identity, attempt]);
  const current = read?.identity === target?.identity ? read : null;
  useLayoutEffect(() => {
    if (!target || !current?.detail || !body.current) return;
    const position = positions.get(target.identity);
    if (position !== undefined) body.current.scrollTop = position;
    else if (target.segmentOrdinal !== undefined) body.current.querySelector<HTMLElement>(`[data-source-ordinal="${target.segmentOrdinal}"]`)?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [target?.identity, current?.detail]);
  const journal = (selected: NonNullable<typeof target>, locate = false) => {
    if (selected.runId && (locate || !selected.journalOrigin)) targetCompanionJournal(selected.runId);
    chat.setMode("history");
  };
  return <>
    {!target && !noteTarget && returnTo ? <button type="button" className="companion-preview-return" onClick={() => {
      journal(returnTo); useCompanionResultPreview.setState({ sourceTarget: returnTo, sourceReturnTo: null });
    }}><ChevronLeft size={15} />返回手记与来源预览<span>{returnTo.title}</span></button> : null}
    <dialog ref={dialog} className="companion-result-preview" data-companion-owned="true" data-motion={motion} aria-label={target ? `来源预览：${target.title}` : "来源预览"}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }} onCancel={event => { event.preventDefault(); close(); }}>
      {target ? <>
        <header><div><small><BookOpenText size={14} />当前来源{target.segmentOrdinal !== undefined ? ` · 从第 ${target.segmentOrdinal + 1} 段定位` : " · 全文"}</small><h2>{current?.detail?.source.title ?? target.title}</h2></div>
          <button type="button" autoFocus onClick={close} aria-label="关闭来源预览，返回原位置"><X size={18} /></button></header>
        <div className="companion-result-preview__body" ref={body} tabIndex={0} onScroll={event => positions.set(target.identity, event.currentTarget.scrollTop)}>
          {!current ? <p role="status">正在读取来源全文…</p> : current.error ? <div role="status"><p>{current.error}</p><button type="button" onClick={() => { setRead(null); setAttempt(value => value + 1); }}>重新读取</button></div>
            : current.detail?.segments.length ? <>{target.segmentOrdinal !== undefined && !current.detail.segments.some(segment => segment.ordinal === target.segmentOrdinal) ? <p>原段落位置暂时不可用，下面显示当前来源全文。</p> : null}
              {current.detail.segments.map(segment => <section key={segment.id} data-source-ordinal={segment.ordinal}>{renderCompanionMarkdown(segment.text)}</section>)}</>
              : <p>这份来源暂时没有可阅读的正文，解析完成后可重新读取。原对话中的摘录仍然保留。</p>}
        </div>
        <footer>{target.runId ? <button type="button" onClick={() => { journal(target, true); close(); }}>查看这次完整记录</button> : <span>引用摘录保留在原对话中</span>}
          <button type="button" disabled={!current?.detail || opening === target.identity} onClick={() => {
            setOpening(target.identity);
            void chat.goToRoute({ kind: "source.detail", sourceId: target.sourceId }, () => useCompanionResultPreview.getState().sourceTarget === target).then(() => {
              if (useCompanionResultPreview.getState().sourceTarget !== target || target.scope !== useRoomStore.getState().workspaceScopeRevision) return;
              useCompanionResultPreview.setState({ sourceTarget: null, sourceReturnTo: target, returnTo: null, sourceLocation: target }); chat.setMode("closed");
            }).catch(error => { if (useCompanionResultPreview.getState().sourceTarget === target) setRead({ identity: target.identity, error: gatewayErrorMessage(error) }); })
              .finally(() => setOpening(value => value === target.identity ? null : value));
          }}>进入来源页面<ArrowUpRight size={14} /></button></footer>
      </> : null}
    </dialog>
  </>;
}
