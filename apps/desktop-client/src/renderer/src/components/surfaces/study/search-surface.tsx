import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, ChevronRight, FileText, Layers3, Leaf, Search, Sprout, X } from "lucide-react";
import type { DesktopSearchItem } from "@ailearn/shared/desktop-surface-contracts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { useRoomStore } from "../../../app/room-store";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import { SurfaceDataState, formatRelative } from "../notebook/surface-data";
import { containsQuery, markQuery, noResultEmpty, NO_QUERY_EMPTY, objectKey, openLabel, previewGap, previewParagraphs, PREVIEW_EMPTY, SEARCH_STATE_LINES, stripHighlight, TYPE_FILTERS, typeFilterLabel, typeLabel } from "./search-presenter";
import { useSearchDesk } from "./use-search-desk";
import { useSearchMotion } from "./use-search-motion";

const TYPE_ICONS = { all: Layers3, note: BookOpen, source: FileText, objective: Sprout };
const TYPE_NAMES = { all: "全部", note: "笔记", source: "来源", objective: "学习卡" };

export function SearchSurface() {
  const [composing, setComposing] = useState(false);
  const desk = useSearchDesk(composing);
  const setQuery = useRoomStore(state => state.setSearchQuery);
  const setType = useRoomStore(state => state.setSearchTypeFilter);
  const setWeakOnly = useRoomStore(state => state.setSearchWeakOnly);
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const index = useRef<HTMLDivElement>(null);
  const paperScroll = useRef<HTMLDivElement>(null);
  const previewRoot = useRef<HTMLElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const keyboardBrowsing = useRef(false);
  const focusPreview = useRef(false);
  const returnFromPreview = useRef(false);
  const focusSearch = useRef(false);
  const restoredIndex = useRef<string | null>(null);
  const restoredPreview = useRef<string | null>(null);
  const snapshot = useRef<ReturnType<typeof useRoomStore.getState>["searchResume"]>(null);
  const listId = useId(), previewId = useId(), queryId = useId();
  const listBusy = desk.searching || desk.filterBusy || desk.restoring;
  const hasQuery = Boolean(desk.value);
  const selected = desk.selected;
  const preview = desk.preview;
  const readyPreview = preview && preview.kind !== "loading" && preview.kind !== "error" ? preview : null;
  const previewBody = readyPreview ? previewParagraphs(readyPreview, desk.value) : [];
  const bodyHasMatch = previewBody.some(text => containsQuery(text, desk.value));
  const gap = readyPreview ? previewGap(readyPreview) : null;
  useHudPage("search");
  useSearchMotion(root, desk.filter, `${desk.identity}:${selected ? objectKey(selected) : "empty"}:${previewOpen}`);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const fit = () => setCompact(node.getBoundingClientRect().width < 690);
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, [desk.sessionReady]);
  useEffect(() => {
    keyboardBrowsing.current = false; setPreviewOpen(false);
    restoredIndex.current = null; restoredPreview.current = null;
    index.current?.scrollTo({ top: 0 });
  }, [desk.identity]);

  const remember = () => {
    if (!desk.settled) return;
    const position = {
      identity: desk.identity, selectedKey: desk.selectedKey, loadedCount: desk.items.length,
      indexScrollTop: index.current?.scrollTop ?? 0, previewScrollTop: paperScroll.current?.scrollTop ?? 0,
    };
    snapshot.current = position;
    useRoomStore.getState().setSearchResume(position);
  };
  snapshot.current = desk.settled ? {
    identity: desk.identity, selectedKey: desk.selectedKey, loadedCount: desk.items.length,
    indexScrollTop: index.current?.scrollTop ?? 0, previewScrollTop: paperScroll.current?.scrollTop ?? 0,
  } : snapshot.current?.identity === desk.identity ? snapshot.current : null;
  useEffect(() => () => {
    const saved = snapshot.current;
    if (saved && JSON.parse(saved.identity)[0] === useRoomStore.getState().workspaceScopeRevision) {
      useRoomStore.getState().setSearchResume({ ...saved, indexScrollTop: index.current?.scrollTop ?? saved.indexScrollTop, previewScrollTop: paperScroll.current?.scrollTop ?? saved.previewScrollTop });
    }
  }, []);

  useLayoutEffect(() => {
    if (!desk.settled || restoredIndex.current === desk.identity) return;
    if (desk.resume?.identity === desk.identity) index.current?.scrollTo({ top: desk.resume.indexScrollTop });
    restoredIndex.current = desk.identity;
  }, [desk.settled, desk.identity, desk.resume]);
  useLayoutEffect(() => {
    if (!selected) return;
    const key = `${desk.identity}:${objectKey(selected)}`;
    if (restoredPreview.current === key) return;
    const isResuming = desk.resume?.identity === desk.identity && desk.resume.selectedKey === objectKey(selected);
    if (isResuming && !readyPreview) return;
    const top = isResuming ? desk.resume!.previewScrollTop : 0;
    paperScroll.current?.scrollTo({ top }); restoredPreview.current = key;
  }, [desk.identity, selected, readyPreview, desk.resume]);
  useLayoutEffect(() => {
    if (previewOpen && focusPreview.current) { openButton.current?.focus({ preventScroll: true }); focusPreview.current = false; }
    if (!previewOpen && returnFromPreview.current) {
      const row = desk.selectedKey ? rows.current.get(desk.selectedKey) : null;
      (focusSearch.current ? input.current : row ?? input.current)?.focus({ preventScroll: true });
      returnFromPreview.current = false; focusSearch.current = false;
    }
  }, [previewOpen]);

  const choose = (item: DesktopSearchItem, reveal = true) => {
    desk.setSelectedKey(objectKey(item));
    if (reveal && compact) { focusPreview.current = true; setPreviewOpen(true); }
  };
  const moveSelection = (offset: number, fromInput = false) => {
    if (!desk.visible.length || listBusy) return;
    const current = desk.visible.findIndex(item => objectKey(item) === desk.selectedKey);
    const next = fromInput && !keyboardBrowsing.current ? Math.max(current, 0) : Math.min(Math.max(current + offset, 0), desk.visible.length - 1);
    keyboardBrowsing.current = true;
    const item = desk.visible[next];
    choose(item, false);
    const row = rows.current.get(objectKey(item));
    if (!fromInput) row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };
  const closePreview = () => {
    returnFromPreview.current = true;
    setPreviewOpen(false);
  };
  const openSelected = () => { if (selected && !listBusy) { remember(); void desk.openItem(selected); } };
  const keys = (event: KeyboardEvent<HTMLElement>, fromInput = false) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveSelection(event.key === "ArrowDown" ? 1 : -1, fromInput); }
    if (event.key === "Enter" || !fromInput && event.key === " ") {
      event.preventDefault();
      if (selected && !listBusy) openSelected(); else if (fromInput) void desk.runSearch();
    }
    if (!fromInput && event.key === "ArrowRight" && selected) {
      event.preventDefault(); focusPreview.current = true; setPreviewOpen(true);
      if (!compact) { openButton.current?.focus(); focusPreview.current = false; }
    }
  };

  const empty = noResultEmpty(desk.weakOnly, desk.query, Boolean(desk.nextCursor));
  const progressLabel = desk.weakOnly ? `${desk.items.length} / ${desk.total} 张 · 证据不足 ${desk.visible.length} 张` : `${desk.items.length} / ${desk.total} 条`;
  const depthLine = desk.weakOnly ? `已查 ${desk.items.length} 张命中的学习卡；只保留还没验证、有些生疏或需要重学的内容。` : `共 ${desk.total} 条，按最近更新排列。`;
  const tailLine = desk.nextCursor ? null : desk.items.length < desk.total
    ? `已到读取上限（前 ${desk.items.length} 条），请缩小关键词或筛选范围` : "已到末尾";
  const indexStateLine = !desk.sessionReady && !desk.sessionFailure ? SEARCH_STATE_LINES.confirmingSession
    : desk.sessionFailure ? SEARCH_STATE_LINES.sessionUnavailable : !hasQuery ? NO_QUERY_EMPTY.message
      : listBusy ? composing ? "写好关键词就会开始查找" : desk.filterBusy ? "正在看看哪些需要巩固" : SEARCH_STATE_LINES.searchingList
        : desk.filterFailure ? SEARCH_STATE_LINES.cannotCheckStates : desk.searchFailure && !desk.items.length ? SEARCH_STATE_LINES.listUnavailable
          : !desk.visible.length ? empty.message : null;
  const notice = desk.sessionFailure ? `${SEARCH_STATE_LINES.sessionUnavailable}：${desk.sessionFailure}`
    : !hasQuery ? `${NO_QUERY_EMPTY.message}：${NO_QUERY_EMPTY.detail}`
      : listBusy ? indexStateLine
        : desk.filterFailure ? `${SEARCH_STATE_LINES.cannotCheckStates}：${desk.filterFailure}`
          : desk.searchFailure ? `${SEARCH_STATE_LINES.listUnavailable}：${desk.searchFailure}`
            : !desk.visible.length ? `${empty.message}：${empty.detail}` : tailLine;
  const readable = useMemo<PageReadableV1 | null>(() => !desk.sessionReady && !desk.sessionFailure ? null : {
    pageId: "search", title: HUD_PAGES.search.title, statusLine: indexStateLine ?? progressLabel,
    metrics: hasQuery ? [{ label: "结果", value: progressLabel.slice(0, 40) }, { label: "查找范围", value: depthLine.slice(0, 40) }] : [],
    filters: [{ label: "类型", value: typeFilterLabel(desk.filter) }, ...(hasQuery ? [{ label: "关键词", value: desk.value.slice(0, 40) }] : []), ...(desk.weakOnly ? [{ label: "证据不足筛选", value: "证据不足" }] : [])],
    ...(desk.visible.length ? { items: desk.visible.slice(0, 12).map((item, i) => ({ ordinal: i + 1, label: (item.title || "未命名内容").slice(0, 120), state: typeLabel(item.objectType) })) } : {}),
    ...(notice ? { notice: notice.slice(0, 200) } : {}),
  }, [desk.sessionReady, desk.sessionFailure, desk.filter, desk.value, desk.weakOnly, desk.visible, hasQuery, progressLabel, depthLine, notice, indexStateLine]);
  usePageReadableView(readable);

  return <HudPage page="search">
    <section ref={root} className="search-desk" data-has-query={hasQuery} data-has-results={desk.visible.length > 0} data-compact={compact} data-preview-open={previewOpen} onKeyDown={event => {
      if (event.key === "Escape" && compact && previewOpen) { event.preventDefault(); event.stopPropagation(); closePreview(); }
      else if (event.key === "Escape" && desk.query) { event.preventDefault(); event.stopPropagation(); setQuery(""); input.current?.focus(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (compact && previewOpen) { focusSearch.current = true; closePreview(); } else input.current?.focus();
      }
    }}>
      <div className="search-tools" inert={compact && previewOpen || undefined}>
        <div className="search-command">
          <span className="search-command__icon" aria-hidden="true"><Search size={23} strokeWidth={2.5} /></span>
          <label className="sr-only" htmlFor={queryId}>搜索来源、笔记与学习卡</label>
          <input id={queryId} ref={input} data-search-query="true" type="search" maxLength={500} value={desk.query} aria-controls={hasQuery ? listId : undefined} aria-activedescendant={selected ? `${listId}-${objectKey(selected)}` : undefined}
            placeholder="想找什么？写下一个关键词…" onChange={event => setQuery(event.currentTarget.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={event => keys(event, true)} />
          {desk.query ? <button type="button" className="search-command__clear" aria-label="清空搜索关键词" onClick={() => { setQuery(""); input.current?.focus(); }}><X size={17} aria-hidden="true" /></button> : <kbd className="search-command__shortcut" aria-hidden="true">⌘ K</kbd>}
        </div>
        <div className="search-filter-row">
          <nav className="search-types" aria-label="结果类型">
            <span className="search-types__cushion" aria-hidden="true" />
            {TYPE_FILTERS.map(type => { const Icon = TYPE_ICONS[type]; return <button type="button" key={type} aria-pressed={desk.filter === type} aria-label={`结果类型：${typeFilterLabel(type)}`} onClick={() => setType(type)}><Icon size={16} aria-hidden="true" /><span>{TYPE_NAMES[type]}</span></button>; })}
          </nav>
          {desk.filter === "objective" ? <button type="button" className="search-weak" aria-pressed={desk.weakOnly} title="只看还没验证、有些生疏或需要重学的学习卡" onClick={() => setWeakOnly(!desk.weakOnly)}><Sprout size={15} aria-hidden="true" />证据不足<span className="search-weak__switch" aria-hidden="true" /></button> : <span className="search-scope"><Leaf size={14} aria-hidden="true" />这个学习空间</span>}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{desk.sessionReady && hasQuery ? listBusy ? indexStateLine : !desk.searchFailure && !desk.filterFailure ? progressLabel : "" : ""}</p>
      {!hasQuery ? <div className="search-welcome">
        <div className="search-welcome__objects" aria-hidden="true"><span><BookOpen size={48} strokeWidth={1.8} /></span><span><FileText size={43} strokeWidth={1.8} /></span><i><Search size={36} strokeWidth={2.3} /></i></div>
        {!desk.sessionReady && !desk.sessionFailure ? <SurfaceDataState kind="loading" message={SEARCH_STATE_LINES.confirmingSession} detail="正在准备这个学习空间的内容。" />
          : desk.sessionFailure ? <SurfaceDataState kind="error" message={SEARCH_STATE_LINES.sessionUnavailable} detail={desk.sessionFailure} onRetry={desk.retry} />
            : <><p className="search-welcome__eyebrow">把那一点灵感找回来</p><h2>{NO_QUERY_EMPTY.message}</h2><p>{NO_QUERY_EMPTY.detail}</p><div className="search-shortcuts"><span><kbd>↑</kbd><kbd>↓</kbd>挑选纸签</span><span><kbd>Enter</kbd>打开完整内容</span><span><kbd>Esc</kbd>清空关键词</span></div></>}
      </div> : <div className="search-layout">
        <div className="search-results" inert={compact && previewOpen || undefined}>
          <header className="search-index__heading"><span>找到的纸签</span><small>{listBusy ? indexStateLine : `${desk.total} ${desk.filter === "objective" ? "张" : "条"}命中`}</small></header>
          <div className="search-index" ref={index} onScroll={remember}>
            {!desk.sessionReady && !desk.sessionFailure ? <SurfaceDataState kind="loading" message={SEARCH_STATE_LINES.confirmingSession} detail="正在准备这个学习空间的内容。" /> : null}
            {desk.sessionFailure ? <SurfaceDataState kind="error" message={SEARCH_STATE_LINES.sessionUnavailable} detail={desk.sessionFailure} onRetry={desk.retry} /> : null}
            {desk.sessionReady && listBusy && !desk.visible.length ? <SurfaceDataState kind="loading" message={indexStateLine!} detail={composing ? "输入法确认后，纸签就会来。" : "纸签马上就来。"} /> : null}
            {desk.sessionReady && !listBusy && desk.filterFailure ? <SurfaceDataState kind="error" message={SEARCH_STATE_LINES.cannotCheckStates} detail={desk.filterFailure} onRetry={desk.retryFilter} /> : null}
            {desk.sessionReady && !listBusy && desk.searchFailure && !desk.items.length ? <SurfaceDataState kind="error" message={SEARCH_STATE_LINES.listUnavailable} detail={desk.searchFailure} onRetry={desk.retry} /> : null}
            {desk.sessionReady && !listBusy && !desk.filterFailure && !desk.searchFailure && !desk.visible.length ? <SurfaceDataState kind="empty" message={empty.message} detail={empty.detail} /> : null}
            <div id={listId} role="listbox" aria-label="搜索结果" aria-busy={listBusy || undefined}>
              {desk.visible.map(item => {
                const key = objectKey(item), active = key === desk.selectedKey, Icon = TYPE_ICONS[item.objectType];
                return <div key={key} id={`${listId}-${key}`} ref={node => { if (node) rows.current.set(key, node); else rows.current.delete(key); }} role="option" aria-selected={active} aria-disabled={listBusy || undefined} tabIndex={active ? 0 : -1}
                  className={`index-card${active ? " selected" : ""}`} data-kind={item.objectType} aria-controls={previewId} onClick={() => { if (!listBusy) choose(item); }} onDoubleClick={() => { if (!listBusy) { remember(); void desk.openItem(item); } }} onKeyDown={event => keys(event)}>
                  <span className="index-card__icon" aria-hidden="true"><Icon size={22} strokeWidth={2} /></span>
                  <div className="index-card__text"><span className="index-card__meta"><span className="kind">{typeLabel(item.objectType)}</span>{item.matchCount ? <span>匹配 {item.matchCount} 处</span> : null}</span><b>{markQuery(item.title || "未命名内容", desk.value)}</b><p>{markQuery(stripHighlight(item.snippet), desk.value)}</p></div>
                  <ChevronRight size={16} className="index-card__arrow" aria-hidden="true" />
                </div>;
              })}
              {desk.items.length > 0 ? <div className="search-index__tail">
                {desk.searchFailure ? <div className="search-page-error" role="alert"><p>{desk.searchFailure}</p><button type="button" className="button" disabled={listBusy || !desk.nextCursor} onClick={() => { if (desk.nextCursor) void desk.runSearch(desk.nextCursor); }}>重试这一页</button></div> : null}
                <div className="index-progress"><span>{progressLabel}</span>{desk.nextCursor ? <button type="button" className="button" disabled={listBusy} onClick={() => void desk.runSearch(desk.nextCursor!)}>{listBusy ? "正在读取…" : "继续读取"}<ArrowDown size={14} aria-hidden="true" /></button> : <span>{tailLine}</span>}</div>
                <p className="index-depth">{depthLine}</p>
              </div> : null}
            </div>
          </div>
          <p className="search-results__hint"><kbd>↑ ↓</kbd>挑选 <span>·</span><kbd>Enter</kbd>打开 <span>·</span>点选预览</p>
        </div>
        {desk.visible.length > 0 ? <aside ref={previewRoot} id={previewId} className="search-preview" role={compact && previewOpen ? "dialog" : undefined} aria-modal={compact && previewOpen || undefined} aria-label="搜索内容预览" onKeyDown={event => {
          if (compact && previewOpen && event.key === "Tab") {
            const controls = [...(previewRoot.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
            if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
            else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
          }
        }}>
          <div className="search-preview__paper">
            <header className="search-preview__head"><span><BookOpen size={16} aria-hidden="true" />{selected ? `${typeLabel(selected.objectType)}预览` : "接着读"}</span><button type="button" className="search-preview__close" aria-label="收起预览" onClick={closePreview}><ArrowLeft size={16} aria-hidden="true" /><span>纸签</span></button></header>
            <div className="preview-page" ref={paperScroll} tabIndex={0} role="region" aria-label="预览正文" onScroll={remember}>
              {!selected ? <div className="search-preview__empty"><BookOpen size={44} strokeWidth={1.5} aria-hidden="true" /><h2>{PREVIEW_EMPTY.message}</h2><p>{PREVIEW_EMPTY.detail}</p></div> : <>
                <h2>{selected.title || "未命名内容"}</h2>
                <p className="search-preview__meta">{selected.matchCount ? `关键词匹配 ${selected.matchCount} 处 · ` : ""}更新于 {formatRelative(selected.indexedAt)}</p>
                {(!readyPreview || !bodyHasMatch) && selected.snippet ? <p className="search-preview__snippet">{markQuery(stripHighlight(selected.snippet), desk.value)}</p> : null}
                {preview?.kind === "loading" ? <p className="search-preview__loading" role="status">正在展开内容…</p> : null}
                {preview?.kind === "error" ? <div className="search-preview__error" role="alert"><p>{preview.message}</p><button type="button" className="button" onClick={desk.retryPreview}>重新读取预览</button></div> : null}
                {previewBody.map((text, i) => <p key={`${readyPreview?.key}-${i}`}>{markQuery(text, desk.value)}</p>)}
                {gap ? <div className="margin-note"><b>阅读提示</b><p>{gap}</p></div> : null}
                {readyPreview?.kind === "objective" ? <p className="search-preview__origin">{readyPreview.detail.sources.primaryNote ? `来自笔记《${readyPreview.detail.sources.primaryNote.title}》` : "这张学习卡还没有主来源笔记"}</p> : null}
              </>}
            </div>
            {selected ? <footer className="search-preview__foot">
              {desk.openFailure ? <p role="alert">{desk.openFailure}</p> : <span>先读命中附近的内容</span>}
              <button type="button" ref={openButton} className="button primary" disabled={desk.openingKey !== null || listBusy} onClick={openSelected}>{desk.openingKey === objectKey(selected) ? "正在打开…" : openLabel(selected.objectType)}<ArrowRight size={17} aria-hidden="true" /></button>
            </footer> : null}
          </div>
        </aside> : null}
      </div>}
    </section>
  </HudPage>;
}
