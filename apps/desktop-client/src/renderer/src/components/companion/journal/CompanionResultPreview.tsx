import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, BookOpenText, ChevronLeft, X } from "lucide-react";
import type { NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { noteBlockMarkdown } from "@astella/shared/note-markdown";
import { useCompanionChat } from "../../../app/companion-session/companion-chat-session";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import { renderCompanionMarkdown, stripLeadingPreviewTitle } from "../content/companion-markdown";
import { closeCompanionPreview, restoreCompanionPreviewFocus, targetCompanionJournal, useCompanionResultPreview } from "./companion-result-preview";
import { CompanionArtifactPreview } from "./CompanionArtifactPreview";
import { openAgentArtifact } from "../goals/agent-goal-presentation";
import { openCompanionGoalJournal } from "../content/companion-events";
import { CompanionSourcePreview } from "./CompanionSourcePreview";

/** Reads saved content only. The selected identity stays fixed while new results arrive. */
export function CompanionResultPreview({ motionMode }: { motionMode: "full" | "lite" | "off" }) {
  const chat = useCompanionChat();
  const { target, parentPreview, returnTo, positions, sourceTarget } = useCompanionResultPreview();
  const reduced = useRoomStore(state => state.reducedMotion);
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const origin = useRef<typeof target>(null);
  const restoring = useRef<string | null>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<{ identity: string; note?: NoteDetailV1; error?: string } | null>(null);
  const [openingTarget, setOpeningTarget] = useState<string | null>(null);
  const opening = Boolean(target && openingTarget === target.identity);
  useLayoutEffect(() => { restoring.current = target?.identity ?? null; }, [target?.identity]);
  useLayoutEffect(() => {
    if (target) origin.current = target;
    if (target && dialog.current) {
      if (!dialog.current.open) dialog.current.showModal();
      dialog.current.querySelector<HTMLElement>("header button")?.focus({ preventScroll: true });
    }
    if (!target && dialog.current?.open) {
      dialog.current.close();
      if (!useCompanionResultPreview.getState().returnTo) restoreCompanionPreviewFocus(origin.current);
      origin.current = null;
    }
  }, [target]);
  useEffect(() => {
    if (!target) return;
    let current = true;
    void (async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        epochRef.current = epoch;
        if (target.scope !== useRoomStore.getState().workspaceScopeRevision) return;
        const note = unwrapGatewayResult(await window.astella.note.get({ meta: createRequestMeta(epoch), noteId: target.noteId,
          ...(target.noteVersionId ? { noteVersionId: target.noteVersionId } : {}) }));
        if (target.noteVersionId && note.requestedVersion?.versionId !== target.noteVersionId)
          throw new Error("这份保存版本暂时读不到，请重试；不会用其他版本替代。");
        if (current && target.scope === useRoomStore.getState().workspaceScopeRevision) setRead({ identity: target.identity, note });
      } catch (error) { if (current) setRead({ identity: target.identity, error: gatewayErrorMessage(error) }); }
    })();
    return () => { current = false; };
  }, [target?.identity, attempt]);
  const loaded = read?.identity === target?.identity ? read : null;
  const version = loaded?.note?.requestedVersion ?? loaded?.note?.currentVersion;
  useLayoutEffect(() => {
    if (body.current && target && version && !target.artifact) {
      const saved = positions.get(target.identity);
      if (saved !== undefined) body.current.scrollTop = saved;
      else if (target.blockOrdinal !== undefined) body.current.querySelector<HTMLElement>(`[data-block-ordinal="${target.blockOrdinal}"]`)?.scrollIntoView({ block: "start", behavior: "instant" });
      else body.current.scrollTop = 0;
      restoring.current = null;
    }
  }, [target?.identity, target?.blockOrdinal, version?.versionId]);
  const backToJournal = (selected: NonNullable<typeof target>, locate = false) => {
    if (locate || !selected.journalOrigin) {
      if (selected.goalRunId) openCompanionGoalJournal(selected.goalRunId, selected.scope);
      else if (selected.runId) targetCompanionJournal(selected.runId);
    }
    chat.setMode("history");
  };
  return createPortal(<>
    {!target && !sourceTarget && returnTo ? <button type="button" className="companion-preview-return" onClick={() => {
      backToJournal(returnTo);
      useCompanionResultPreview.setState({ target: returnTo, returnTo: null });
    }}><ChevronLeft size={15} />返回手记与预览<span>{returnTo.title}</span></button> : null}
    <dialog ref={dialog} className="companion-result-preview" data-companion-owned="true" data-motion={reduced ? "off" : motionMode}
      aria-label={target ? `预览：${target.title}` : "成果预览"} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCompanionPreview(); } }}
      onCancel={event => { event.preventDefault(); closeCompanionPreview(); }}>
      {target ? <>
        <header><div><small><BookOpenText size={14} />{target.artifact ? "已保存的成果" : "已保存的笔记"}{version ? ` · v${version.versionNo}` : ""}</small><h2>{target.title}</h2></div>
          <button type="button" onClick={closeCompanionPreview} aria-label={parentPreview ? "返回成果预览" : "关闭预览，返回原位置"} autoFocus>{parentPreview ? <ChevronLeft size={18} /> : <X size={18} />}</button></header>
        <div className="companion-result-preview__body" ref={body} tabIndex={0} onScroll={event => { if (restoring.current !== target.identity) positions.set(target.identity, event.currentTarget.scrollTop); }}>
          {!loaded ? <p role="status">正在读取已保存内容…</p> : loaded.error ? <div role="status"><p>{loaded.error}</p><p>笔记可能已删除、权限已变化，或连接暂时中断。</p><button type="button" onClick={() => { setRead(null); setAttempt(value => value + 1); }}>重新读取</button></div>
            : version ? <>{loaded.note && version.versionId !== loaded.note.currentVersionId ? <p className="companion-result-preview__notice">正在回看 v{version.versionNo}。笔记已有更新，原保存内容保留在此。</p> : null}
              {!target.artifact && target.blockOrdinal !== undefined && !version.blocks.some(block => block.ordinal === target.blockOrdinal)
                ? <p className="companion-result-preview__notice">原段落已不在这份版本中，以下保留完整正文。</p> : null}
              {target.artifact ? <CompanionArtifactPreview key={target.identity} artifact={target.artifact} epoch={epochRef.current}
                currentVersionId={loaded.note!.currentVersionId} goalRunId={target.goalRunId} motion={reduced ? "off" : motionMode}
                onReady={() => { if (restoring.current === target.identity && body.current && useCompanionResultPreview.getState().target?.identity === target.identity) { body.current.scrollTop = positions.get(target.identity) ?? 0; restoring.current = null; } }} />
                : version.blocks.map((block, index) => {
                  // The preview header prints the note title; AI-written notes repeat it
                  // as their leading heading. Drop only that duplicate for display.
                  const markdown = noteBlockMarkdown(block.type, block.content);
                  const visible = index === 0 ? stripLeadingPreviewTitle(markdown, target.title) : markdown;
                  return visible.trim() ? <section key={block.ordinal} data-block-ordinal={block.ordinal} tabIndex={-1}>{renderCompanionMarkdown(visible)}</section> : null;
                })}</> : null}
        </div>
        <footer>{parentPreview ? <button type="button" onClick={closeCompanionPreview}><ChevronLeft size={14} />返回成果预览</button> : target.runId || target.goalRunId ? <button type="button" onClick={() => { backToJournal(target, true); closeCompanionPreview(); }}><BookOpenText size={14} />查看这次完整记录</button> : <span>预览只读取已有内容</span>}
          {target.sourceOnly ? <button type="button" onClick={closeCompanionPreview}>返回练习报告</button> : <button type="button" disabled={!loaded?.note || opening} onClick={() => {
            setOpeningTarget(target.identity);
            if (target.artifact) {
              if (openAgentArtifact(target.artifact, target.scope)) {
                useCompanionResultPreview.setState({ target: null, returnTo: target, sourceReturnTo: null }); chat.setMode("closed");
              }
              setOpeningTarget(null); return;
            }
            // The editor opens the current document; the exact saved version stays in this preview.
            void chat.goToRoute({ kind: "note.detail", noteId: target.noteId }, () => useCompanionResultPreview.getState().target === target).then(() => {
              if (useCompanionResultPreview.getState().target !== target || target.scope !== useRoomStore.getState().workspaceScopeRevision) return;
              useCompanionResultPreview.setState({ target: null, returnTo: target, sourceReturnTo: null }); chat.setMode("closed");
            }).catch(error => {
              if (useCompanionResultPreview.getState().target === target) setRead({ identity: target.identity, error: gatewayErrorMessage(error) });
            }).finally(() => setOpeningTarget(value => value === target.identity ? null : value));
          }}>{opening ? "正在打开…" : target.artifact ? "进入成果页面" : "打开当前笔记"}<ArrowUpRight size={14} /></button>}</footer>
      </> : null}
    </dialog>
    <CompanionSourcePreview motion={reduced ? "off" : motionMode} />
  </>, document.body);
}
