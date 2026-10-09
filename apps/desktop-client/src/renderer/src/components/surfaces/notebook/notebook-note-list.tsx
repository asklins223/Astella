import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronLeft, PanelLeftOpen, RefreshCw, Search, X } from "lucide-react";
import { useRoomStore } from "../../../app/room-store";
import { useNotebookNoteList } from "./use-notebook-note-list";
import { useNotebookNotePresence } from "./use-notebook-note-presence";
import { NotebookPresenceReaders } from "./notebook-presence";
import { useNotebookPaperMotion, useNotebookPaperPresence } from "./use-notebook-paper-motion";
import { useNotebookTouch } from "./use-notebook-touch";
import { formatRelative } from "./surface-data";

type Props = {
  readonly currentId: string | null;
  readonly currentTitle: string | null;
  readonly fullscreen: boolean;
  readonly onSelect: (noteId: string) => void;
};

export function NotebookNoteList(props: Props) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  return <NotebookNoteListContent key={scope} {...props} scope={scope} />;
}

function NotebookNoteListContent({ scope, ...props }: Props & { readonly scope: number }) {
  const [bookOpen, setBookOpen] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const open = props.fullscreen ? fullscreenOpen : bookOpen;
  const setOpen = props.fullscreen ? setFullscreenOpen : setBookOpen;
  const [query, setQuery] = useState("");
  const library = useNotebookNoteList(scope);
  // 只在纸展开的那一段读：这一排印章说的是"此刻"，纸都合上了还留着一条轮询没有意义。
  const presence = useNotebookNotePresence(scope, open);
  const play = useNotebookPaperMotion();
  const paper = useNotebookPaperPresence(open ? true : null, "note-list", "index", play);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollPosition = useRef(0);
  const wasOpen = useRef(open);
  useNotebookTouch(rootRef);
  const term = query.trim().toLocaleLowerCase();
  const items = useMemo(() => {
    const loaded: { id: string; title: string; updatedAt: string | null }[] = library.items.map(item => item.id === props.currentId && props.currentTitle !== null
      ? { ...item, title: props.currentTitle } : item);
    // A note opened from search can belong to a later page; keep its known title within reach.
    if (props.currentId && props.currentTitle !== null && !loaded.some(item => item.id === props.currentId)) {
      loaded.unshift({ id: props.currentId, title: props.currentTitle, updatedAt: null });
    }
    return loaded.filter(item => !term || (item.title || "未命名笔记").toLocaleLowerCase().includes(term));
  }, [library.items, props.currentId, props.currentTitle, term]);

  // Search all title pages, without pretending that a match in the first page is the whole library.
  useEffect(() => {
    if (term && library.nextCursor && !library.loading && !library.failure) void library.loadMore();
  }, [term, library.nextCursor, library.loading, library.failure, library.loadMore]);

  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollPosition.current;
    if (open && !wasOpen.current) (paper.ref.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? paper.ref.current?.querySelector<HTMLElement>("input"))?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open, Boolean(paper.value)]);
  useEffect(() => {
    if (!open || !props.fullscreen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229
        || document.querySelector("dialog[open], [aria-modal='true'], .companion-hud:not([data-mode='closed']), .notebook-desk__side-page:not([inert]), .notebook-desk__index:not([inert]), .cm-search")) return;
      event.preventDefault(); close();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open, props.fullscreen]);
  useEffect(() => {
    if (!open) return;
    const floating = () => props.fullscreen || (rootRef.current?.getBoundingClientRect().width ?? Infinity) <= 42;
    const pointerdown = (event: PointerEvent) => {
      if (!floating() || !(event.target instanceof Element) || event.target.closest("dialog, [aria-modal='true']")) return;
      if (event.target.closest(".notebook-workspace")) setOpen(false);
    };
    const focusin = (event: FocusEvent) => {
      if (floating() && event.target instanceof Element && event.target.closest(".notebook-focus-ribbon__tools, .notebook-desk__chrome")) setOpen(false);
    };
    document.addEventListener("pointerdown", pointerdown);
    document.addEventListener("focusin", focusin);
    return () => { document.removeEventListener("pointerdown", pointerdown); document.removeEventListener("focusin", focusin); };
  }, [open, props.fullscreen]);

  return <div className="notebook-note-list" data-open={open} data-fullscreen={props.fullscreen || undefined} ref={rootRef}>
    <button type="button" className="text-action notebook-note-list__toggle" ref={triggerRef}
      aria-label={open ? "收起笔记列表" : "展开笔记列表"} title={open ? "收起笔记列表" : "展开笔记列表"}
      aria-expanded={open} aria-controls="notebook-note-list-paper" onClick={() => open ? close() : setOpen(true)}>
      {open ? <ChevronLeft size={18} aria-hidden="true" /> : <PanelLeftOpen size={18} aria-hidden="true" />}<span>笔记列表</span>
    </button>
    {paper.value ? <aside id="notebook-note-list-paper" className="notebook-note-list__paper" aria-label="笔记列表"
      ref={paper.ref} inert={paper.closing} aria-hidden={paper.closing || undefined}
      onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header className="notebook-note-list__head"><div><BookOpen size={18} aria-hidden="true" /><h2>手边的笔记</h2></div>
        <button type="button" className="text-action" aria-label="刷新笔记列表" title="刷新笔记列表" disabled={library.loading} onClick={() => void library.reload()}><RefreshCw size={15} aria-hidden="true" /></button>
      </header>
      <div className="notebook-note-list__search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="查找笔记" placeholder="找一篇笔记…" value={query} onChange={event => setQuery(event.target.value)} />
        {query ? <button type="button" className="text-action" aria-label="清除笔记查找" onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button> : null}
      </div>
      <div className="notebook-note-list__scroll" ref={scrollRef} onScroll={event => { scrollPosition.current = event.currentTarget.scrollTop; }}>
        <nav aria-label="切换笔记"><ul>{items.map(item => {
          // 没人在看的笔记，这一行保持原来的样子；只在真的有人在这篇里时多一个东西。
          const readers = presence.others.get(item.id) ?? [];
          return <li key={item.id}>
          <button type="button" className="notebook-note-list__item" aria-current={item.id === props.currentId ? "page" : undefined} title={item.title || "未命名笔记"} onClick={() => props.onSelect(item.id)}>
            <span className="notebook-note-list__title">{item.title || "未命名笔记"}</span><span className="notebook-note-list__meta">{item.updatedAt ? <time dateTime={item.updatedAt}>{formatRelative(item.updatedAt)}更新</time> : null}{item.id === props.currentId ? <span><Check size={12} aria-hidden="true" />当前</span> : null}<NotebookPresenceReaders viewers={readers} /></span>
          </button>
        </li>; })}</ul></nav>
        {library.loading ? <p className="notebook-note-list__message" role="status">{term ? "正在查找更多笔记…" : "正在翻开笔记列表…"}</p> : null}
        {!library.loading && !library.failure && !items.length ? <p className="notebook-note-list__message" role="status">{term ? "没有找到这个标题，试试别的词。" : "这间书房还没有笔记。"}</p> : null}
        {library.failure ? <div className="notebook-note-list__message" role="alert"><p>{library.failure}</p><button type="button" className="text-action" onClick={() => void library.retry()}>重试读取笔记</button></div> : null}
        {/* 读不到在场就收回那一排，并说一句实话：什么都不说会让人以为"没人在这几篇里"，
            而那正是这一排本来要回答的问题。 */}
        {presence.failure ? <p className="notebook-note-list__readers-failure" role="status">别人在不在看，这一列暂时读不到。<button type="button" className="text-action" onClick={() => void presence.reload()}>重试</button></p> : null}
        {library.nextCursor && !term && !library.failure ? <button type="button" className="text-action notebook-note-list__more" disabled={library.loading} onClick={() => void library.loadMore()}>继续翻 · 更多笔记</button> : null}
      </div>
      <footer className="notebook-note-list__foot">{term ? `找到 ${items.length} 篇${library.nextCursor ? " · 继续查找中" : ""}` : `共 ${library.total} 篇`}<span>点一篇，接着读</span></footer>
    </aside> : null}
  </div>;
}
