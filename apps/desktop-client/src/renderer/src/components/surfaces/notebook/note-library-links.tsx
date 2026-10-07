import { useEffect, useState, type ReactNode } from "react";
import type { DesktopNoteListItem } from "@astella/shared/desktop-surface-contracts";
import { noteLinkTarget } from "@astella/shared/note-markdown";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";

class NoteLinkError extends Error {}
const linkErrorMessage = (error: unknown) => error instanceof NoteLinkError ? error.message : gatewayErrorMessage(error);
let latestLinkRequest = 0;

/** The list API applies the current space's visibility rules, including shared notes. */
export async function loadNoteLinkLibrary(): Promise<DesktopNoteListItem[]> {
  const scope = useRoomStore.getState().workspaceScopeRevision;
  const notes: DesktopNoteListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = unwrapGatewayResult(await window.astella.note.list({ meta: createRequestMeta(), limit: 100, trashed: false, ...(cursor ? { cursor } : {}) }));
    if (scope !== useRoomStore.getState().workspaceScopeRevision) throw new NoteLinkError("空间已切换，请重新选择笔记。");
    notes.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return notes;
}

export function useNoteLinkLibrary(enabled: boolean) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [state, setState] = useState<{ notes: DesktopNoteListItem[]; loading: boolean; failure: string | null }>({ notes: [], loading: false, failure: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setState({ notes: [], loading: true, failure: null });
    void loadNoteLinkLibrary().then(notes => { if (!disposed) setState({ notes, loading: false, failure: null }); })
      .catch(error => { if (!disposed) setState({ notes: [], loading: false, failure: linkErrorMessage(error) }); });
    return () => { disposed = true; };
  }, [enabled, scope, retry]);
  return { ...state, retry: () => setRetry(value => value + 1) };
}

export async function openLibraryNoteLink(href: string): Promise<void> {
  const target = noteLinkTarget(href);
  if (!target) return;
  const request = ++latestLinkRequest;
  const room = useRoomStore.getState();
  const scope = room.workspaceScopeRevision;
  let noteId = target.value;
  if (target.kind === "title") {
    const notes = await loadNoteLinkLibrary();
    const matches = notes.filter(note => note.title === target.value || note.title === target.value.replace(/\.md$/i, ""));
    if (matches.length !== 1) throw new NoteLinkError(matches.length ? "库里有多篇同名笔记，请在插入链接时选择具体的一篇。" : "库里还没有这篇笔记，或你暂时没有访问权限。");
    noteId = matches[0]!.id;
  }
  const response = await window.astella.note.get({ meta: createRequestMeta(), noteId });
  if (!response.ok) throw new NoteLinkError("这篇笔记已移走、放入回收站，或你暂时没有访问权限。");
  const current = useRoomStore.getState();
  if (request !== latestLinkRequest || scope !== current.workspaceScopeRevision || room.activeNoteRef?.noteId !== current.activeNoteRef?.noteId) return;
  const previous = room.activeNoteRef;
  const previousReturn = room.returnTarget;
  room.setActiveNoteRef({ noteId, noteVersionId: response.data.currentVersionId, mode: "preview" });
  if (previous && previous.noteId !== noteId) room.setReturnTarget({ label: "返回上一篇笔记", run: () => {
    const current = useRoomStore.getState();
    if (current.workspaceScopeRevision !== scope) return;
    current.setActiveNoteRef(previous);
    current.setReturnTarget(previousReturn);
    current.invoke("open-notebook");
  } });
  room.invoke("open-notebook");
}

export function NoteReadingLink({ href, children }: { href: string; children: ReactNode }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => { setFailure(null); setOpening(false); }, [href]);
  return <>
    <a href={href} className="note-library-link" aria-busy={opening} onClick={event => {
      event.preventDefault();
      if (opening) return;
      setOpening(true); setFailure(null);
      void openLibraryNoteLink(href).catch(error => setFailure(linkErrorMessage(error))).finally(() => setOpening(false));
    }}>{children}</a>
    {failure ? <span className="note-link-failure" role="status" data-note-decoration="true">{failure}</span> : null}
  </>;
}
