import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { BookOpen, Code2, Eye, History, Lightbulb, ListTree, MoreHorizontal, PencilLine, Pin, PinOff, ScanText, Sprout, X } from "lucide-react";
import { NOTE_BODY_MODES, type NoteBodyMode } from "./note-document-mode";
import type { NoteOutlineEntry } from "./note-outline";
import { useNotebookPageTurn, useNotebookPaperMotion, useNotebookPaperPresence } from "./use-notebook-paper-motion";
import { useNotebookTouch } from "./use-notebook-touch";

const modeIcons = { preview: Eye, "live-preview": PencilLine, source: Code2 };
const learningTabs = [
  { kind: "overview", label: "速看", detail: "读懂重点", Icon: ScanText },
  { kind: "recall", label: "回想", detail: "想起一点", Icon: Lightbulb },
  { kind: "expansion", label: "往外学", detail: "发现关联", Icon: Sprout },
] as const;
export type NotebookLearningView = "body" | "overview" | "recall" | "artifact";
export type NotebookSidePage = {
  readonly kind: "source" | "history" | "annotation";
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly content: ReactNode;
};

type Props = {
  readonly noteId: string;
  readonly noteTitle: string;
  readonly version: number;
  readonly mode: NoteBodyMode;
  readonly canEdit: boolean;
  readonly pendingMode: NoteBodyMode | null;
  readonly onMode: (mode: NoteBodyMode) => void;
  readonly articleHeader: ReactNode;
  readonly outline: readonly NoteOutlineEntry[];
  readonly onLocate: (block: number) => void;
  readonly onOpenDirectory: () => void;
  readonly learningView: NotebookLearningView | "expansion" | "history" | "learning";
  readonly onLearning: (kind: "overview" | "recall" | "expansion") => void;
  readonly onBody: () => void;
  readonly onHistory?: () => void;
  readonly tools: ReactNode;
  readonly primaryAction: ReactNode;
  readonly taskActions: ReactNode;
  readonly sourceAction: ReactNode;
  readonly generationAction?: ReactNode;
  readonly extraActions: ReactNode;
  readonly status: ReactNode;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly children: ReactNode;
  readonly sidePage: NotebookSidePage | null;
};
/** A single binding holds the index, current page and one opened attachment. */
export function NotebookDesk(props: Props) {
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [compact, setCompact] = useState(true);
  const spreadRef = useRef<HTMLDivElement | null>(null);
  const deskRef = useRef<HTMLDivElement | null>(null);
  useNotebookTouch(deskRef);
  const [currentBlock, setCurrentBlock] = useState(0);
  const drawerRef = useRef<HTMLDetailsElement>(null);
  const sideTriggerRef = useRef<HTMLElement | null>(null);
  const directoryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const directoryWasOpen = useRef(false);
  const sideWasOpen = useRef(false);
  const showDirectory = props.learningView === "body" && directoryOpen && !props.sidePage;
  const play = useNotebookPaperMotion();
  const indexPaper = useNotebookPaperPresence(showDirectory ? true : null, "index", "index", play);
  const sidePaper = useNotebookPaperPresence(props.sidePage, props.sidePage?.kind ?? "", "side", play);
  const pageRef = useRef<HTMLDivElement | null>(null);
  useNotebookPageTurn(pageRef, `${props.noteId}:${props.learningView}:${props.mode}`, play);
  const editingBody = props.learningView === "body" && props.mode !== "preview";
  const context = props.learningView === "body"
    ? props.mode === "preview" ? "正在阅读" : props.mode === "source" ? "Markdown 源码" : "正在编辑"
    : { overview: "这篇的速看", recall: "回想这篇", expansion: "往外学", artifact: "互动演示", history: "学习记录", learning: "这一轮学习" }[props.learningView];

  useEffect(() => {
    setDirectoryOpen(false);
    setPinned(false);
    setCurrentBlock(0);
  }, [props.noteId]);

  useEffect(() => {
    const spread = spreadRef.current;
    if (!spread || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width <= 1050));
    observer.observe(spread);
    return () => observer.disconnect();
  }, []);

  const restoreFocus = (trigger: HTMLElement | null) => {
    const target = trigger?.isConnected && !trigger.closest("[hidden], [inert]") ? trigger : props.scrollRef.current;
    if (target && !target.closest("[hidden], [inert]")) target.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (showDirectory && (!directoryWasOpen.current || document.activeElement?.closest("[hidden], [inert]"))) {
      indexPaper.ref.current?.querySelector<HTMLElement>('[aria-current="location"]')?.focus({ preventScroll: true });
      directoryWasOpen.current = true;
    } else if (!showDirectory && directoryWasOpen.current) {
      if (!props.sidePage) restoreFocus(directoryTriggerRef.current);
      directoryWasOpen.current = false;
    }
  }, [showDirectory, Boolean(indexPaper.value), Boolean(sidePaper.value), compact]);
  useLayoutEffect(() => {
    if (props.sidePage) {
      if (!sideWasOpen.current && document.activeElement instanceof HTMLElement) sideTriggerRef.current = document.activeElement;
      sideWasOpen.current = true;
      sidePaper.ref.current?.focus({ preventScroll: true });
    } else if (!props.sidePage && sideWasOpen.current) {
      restoreFocus(sideTriggerRef.current);
      sideTriggerRef.current = null; sideWasOpen.current = false;
    }
  }, [Boolean(props.sidePage), Boolean(sidePaper.value), props.sidePage?.kind, props.sidePage?.title, compact]);

  useEffect(() => {
    const scroll = props.scrollRef.current;
    if (!scroll || props.learningView !== "body" || props.mode === "source") return;
    const update = () => {
      const top = scroll.getBoundingClientRect().top + 28;
      let block = 0;
      const editorChildren = scroll.querySelector(".ProseMirror")?.children;
      for (const entry of props.outline) {
        const target = props.mode === "preview" ? scroll.querySelector(`[data-block-ordinal="${entry.block}"]`) : editorChildren?.[entry.block];
        if (target && target.getBoundingClientRect().top <= top) block = entry.block;
      }
      setCurrentBlock(block);
    };
    scroll.addEventListener("scroll", update, { passive: true });
    return () => scroll.removeEventListener("scroll", update);
  }, [props.outline, props.mode, props.learningView, props.scrollRef]);

  const locate = (block: number) => {
    setCurrentBlock(block);
    props.onLocate(block);
    if (!pinned || compact) setDirectoryOpen(false);
  };

  const coveringPage = compact && Boolean(showDirectory || props.sidePage);
  return <div className="notebook-desk" ref={deskRef} data-mode={props.mode} data-view={props.learningView} data-compact={compact} data-margin-open={indexPaper.value ? "directory" : sidePaper.value ? "side" : undefined}>
      <nav className="notebook-volume__bookmarks" aria-label="笔记学习">
        <button type="button" className="text-action notebook-volume__bookmark" data-learning="body" aria-pressed={props.learningView === "body"} onClick={props.onBody}>
          <BookOpen size={18} aria-hidden="true" /><span>正文</span>
        </button>
        {learningTabs.map(({ kind, label, detail, Icon }) => <button key={kind} type="button" className="text-action notebook-volume__bookmark"
          data-learning={kind} aria-label={label} title={`${label} · ${detail}`} aria-pressed={props.learningView === kind} onClick={() => props.onLearning(kind)}>
          <Icon size={18} aria-hidden="true" /><span>{label}<small aria-hidden="true">{detail}</small></span>
        </button>)}
        {props.onHistory ? <button type="button" className="text-action notebook-volume__bookmark" data-learning="history" aria-label="学习记录" aria-pressed={props.learningView === "history"} onClick={props.onHistory}>
          <History size={18} aria-hidden="true" /><span>记录</span>
        </button> : null}
      </nav>

    <section className="notebook-volume" aria-label="笔记册页">
      <div className="notebook-desk__spread" ref={spreadRef}>
        {coveringPage ? <button type="button" className="notebook-desk__veil" aria-label="合起旁页，回到正文" tabIndex={-1}
          onClick={() => { if (props.sidePage) props.sidePage.onClose(); else setDirectoryOpen(false); }} /> : null}
        {indexPaper.value ? <aside id="notebook-directory" className="notebook-desk__index" aria-label="笔记目录" ref={indexPaper.ref} tabIndex={-1} inert={indexPaper.closing} aria-hidden={indexPaper.closing || undefined}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDirectoryOpen(false); } }}>
          <header className="notebook-desk__index-head">
            <h2>这一篇</h2>
            <button type="button" className="text-action" disabled={compact} aria-pressed={pinned && !compact} aria-label={pinned ? "取消固定目录" : "固定目录"} title={compact ? "纸面较窄，点目录条目后回到正文" : undefined} onClick={() => setPinned(!pinned)}>
              {pinned ? <Pin size={15} aria-hidden="true" /> : <PinOff size={15} aria-hidden="true" />}
            </button>
            <button type="button" className="text-action" aria-label="收起目录" onClick={() => setDirectoryOpen(false)}><X size={17} aria-hidden="true" /></button>
          </header>
          <nav className="notebook-desk__index-scroll" aria-label="大小标题">
            <button type="button" className="text-action" aria-current={currentBlock === 0 ? "location" : undefined} onClick={() => locate(0)}>开篇</button>
            {props.outline.length ? <ol>{props.outline.map((entry) => <li key={entry.block} data-heading-level={entry.level}>
              <button type="button" className="text-action" aria-current={entry.block === currentBlock ? "location" : undefined} onClick={() => locate(entry.block)}>{entry.title}</button>
            </li>)}</ol> : <p>这篇还没有小节标题。</p>}
          </nav>
          <div className="notebook-desk__index-foot">笔记 v{props.version}<span>{props.outline.find((entry) => entry.block === currentBlock)?.title ?? "正在读 · 开篇"}</span></div>
        </aside> : null}

        <div className="notebook-volume__leaf" inert={coveringPage} aria-hidden={coveringPage || undefined}>
          <nav className="notebook-desk__rack" aria-label="笔记工具">
            {props.learningView === "body" ? <div className="notebook-desk__modes" role="group" aria-label="正文视图">
              <button type="button" className="text-action notebook-desk__directory-toggle" ref={directoryTriggerRef} aria-label="目录" title="目录" aria-expanded={showDirectory} aria-controls="notebook-directory"
                onClick={() => { if (!showDirectory) props.onOpenDirectory(); setDirectoryOpen(!showDirectory); }}><ListTree size={18} aria-hidden="true" /></button>
              <div className="notebook-desk__mode-switch" data-mode={props.mode}>
              {NOTE_BODY_MODES.map(({ id, label }) => {
                const Icon = modeIcons[id];
                return <button key={id} type="button" className="text-action notebook-desk__mode" aria-pressed={props.mode === id}
                  disabled={id !== "preview" && !props.canEdit} title={id !== "preview" && !props.canEdit ? "当前身份只能阅读这篇笔记" : label}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => props.onMode(id)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>;
              })}
              </div>
            </div> : <div className="notebook-volume__trail">
              <span title={props.noteTitle}>{props.noteTitle}</span>
            </div>}
            <div className="notebook-desk__utilities">
              {props.generationAction}
              {props.sourceAction}
              <details className="notebook-desk__drawer" ref={drawerRef}
                onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}
                onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
                <summary className="text-action" aria-label="更多笔记操作" title="更多"><MoreHorizontal size={20} aria-hidden="true" /></summary>
                <div className="notebook-desk__drawer-paper" onClick={(event) => { if ((event.target as Element).closest("button")) drawerRef.current!.open = false; }}>{props.extraActions}</div>
              </details>
            </div>
          </nav>

          {props.tools ? <div className="notebook-volume__tools">{props.tools}</div> : null}
          {props.pendingMode ? <p className="notebook-volume__pending" role="status">输入法确认后会切换正文视图。</p> : null}
          <div className="notebook-desk__scroll" ref={props.scrollRef} tabIndex={0} aria-label={context}>
            <div className="notebook-desk__page" ref={pageRef}>{props.articleHeader}{props.children}</div>
          </div>
          {editingBody ? <footer className="notebook-desk__save-tray">
            <div className="notebook-desk__status" role="status" aria-live="polite">{props.status}</div>{props.primaryAction}
          </footer> : null}
          {props.taskActions ? <footer className="notebook-desk__save-tray">{props.taskActions}</footer> : null}
        </div>

        {sidePaper.value ? <aside className="notebook-desk__side-page" data-kind={sidePaper.value.kind} aria-label="笔记旁页" ref={sidePaper.ref} tabIndex={-1} inert={sidePaper.closing} aria-hidden={sidePaper.closing || undefined}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); sidePaper.value?.onClose(); } }}>
          <header className="notebook-desk__side-head"><h2>{sidePaper.value.title}</h2><button type="button" className="text-action" aria-label={sidePaper.value.closeLabel} onClick={sidePaper.value.onClose}><X size={18} aria-hidden="true" /></button></header>
          <div className="notebook-desk__side-scroll">{sidePaper.value.content}</div>
        </aside> : null}
      </div>
    </section>
  </div>;
}
