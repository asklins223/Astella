import { useCallback, useEffect, useRef, useState } from "react";
import type { NotePresenceViewerV1 } from "@astella/shared/note-presence-contracts";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { readAuthenticatedSession } from "../../../app/surface-session";

/**
 * 「此刻哪一篇有别人在」——笔记列表那一行印章的读数。
 *
 * ## 为什么这一份要单独读一次
 *
 * 笔记页的在场来自那一篇自己那条实时连接（`use-note-doc-live-view`），它只知道
 * **这一篇**上有谁；列表要知道的是另外几十篇，而那些篇没有连接可问。所以这里读的是
 * 服务端把全部活连接收成的一份快照（`GET /notes/presence`）。两处端的是同一个事实，
 * 只是各自从不同的高度看它。
 *
 * ## 只报此刻，本机不留副本
 *
 * 事实源是"活着的那些连接"，人走了那一格就没了。本机留一份缓存，就会有一天在别人
 * 早就关掉笔记之后还挂着他的名字，而列表上那句话的措辞是「在读」——它必须是真的。
 *
 * ## 10 秒这个节拍（以及它买不到的那件事）
 *
 * 列表这一发是**读一次快照**，不是流：某个人刚关掉笔记，列表最迟要等一个节拍才知道。
 * 真窗口量过（2026-10-09，两个客户端）：你正开着的那一篇是即时的（那一排走 WS awareness），
 * 列表里别的那几篇会带着旧名字最多一个节拍。节拍取 10 秒——比 awareness 那一份的
 * 30 秒超时短得多，也不至于让一张偶尔展开的纸一直打服务端。
 * 要做到即时就得让列表也挂一条流，那是另一个决定（每一篇都建连，比这份读数贵得多）。
 */
const PRESENCE_REFRESH_MS = 10_000;

export type NotebookPresenceViewer = { id: string; name: string | null; mode: NotePresenceViewerV1["mode"] };

export function useNotebookNotePresence(scope: number, open: boolean) {
  const [others, setOthers] = useState<Map<string, NotebookPresenceViewer[]>>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const requestRef = useRef(0);
  // 我自己那一格不算「别人」：那一篇我正在读，列表里说的是「当前」，两个都摆出来只会
  // 让那一行看起来比实际上多一个人。
  const selfId = useRoomStore(state => state.spaceIdentity?.userId ?? null);
  const selfIdRef = useRef(selfId);
  selfIdRef.current = selfId;

  const read = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    try {
      const session = await readAuthenticatedSession(epochRef);
      const listed = unwrapGatewayResult(await window.astella.note.presenceList({
        meta: createRequestMeta(session.workspaceEpoch),
      }));
      if (request !== requestRef.current || scope !== useRoomStore.getState().workspaceScopeRevision) return;
      const next = new Map<string, NotebookPresenceViewer[]>();
      for (const item of listed.items) {
        const viewers = item.viewers
          .filter(viewer => viewer.userId !== selfIdRef.current)
          .map(viewer => ({ id: viewer.userId, name: viewer.displayName || null, mode: viewer.mode }));
        if (viewers.length > 0) next.set(item.noteId, viewers);
      }
      setOthers(next);
      setFailure(null);
    } catch (error) {
      if (request !== requestRef.current) return;
      // 读不到就把这一排收起来，而不是留着上一秒的那一份：这一句话只说"此刻"，
      // 拿着旧的名单说「在读」比什么都不说更坏。
      setOthers(new Map());
      setFailure(error instanceof Error ? error.message : "在场暂时读不到");
    }
  }, [scope]);

  useEffect(() => {
    if (!open) return undefined;
    void read();
    const timer = setInterval(() => void read(), PRESENCE_REFRESH_MS);
    return () => { clearInterval(timer); ++requestRef.current; };
  }, [open, read]);

  // 换空间：上一间书房的名单一张都不该留在这里（列表本身按 scope 重挂，这一条是同一句
  // 话在数据那一侧的保险）。
  useEffect(() => {
    setOthers(new Map()); setFailure(null); ++requestRef.current;
  }, [scope]);

  return { others, failure, reload: read };
}
