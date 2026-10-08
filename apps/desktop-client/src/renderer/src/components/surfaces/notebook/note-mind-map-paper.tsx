import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Maximize2, Minus, Plus, RotateCcw, ListTree, X, ChevronRight, Info, GitBranch } from "lucide-react";
import type { MindMapReferenceV1, NoteMindMapSourceV1, NoteMindMapV1 } from "@astella/shared/note-mind-map-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { useNotebookFullscreenActive, useNotebookFullscreenState } from "./notebook-fullscreen-state";
import { NoteMarkdownReading } from "./note-markdown-reading";
import { layoutMindMap } from "./note-mind-map-layout";

const COLORS = ["#9c6349", "#637c65", "#737592", "#ad8349", "#558184", "#a06479"];
type View = { x: number; y: number; scale: number };
// Per-visit viewport survives switching 要点 / 脑图; workspace scope is part of the key.
const views = new Map<string, { view: View; collapsed: string[]; selected: string | null }>();
export function NoteMindMapPaper({ map, currentVersionId, unversioned, regenerating, onRegenerate, epoch, notice }: {
  map: NoteMindMapV1; currentVersionId: string | null; unversioned: boolean; regenerating: boolean; onRegenerate: () => void; epoch: number | undefined; notice?: ReactNode;
}) {
  const scope = useRoomStore(state => state.workspaceScopeRevision), fullscreen = useNotebookFullscreenActive();
  const key = `${scope}:${map.mindMapId}`;
  const cached = views.get(key);
  const fitAfterFold = useRef(false);
  const [collapsed, setCollapsed] = useState(() => new Set(cached?.collapsed ?? map.content.nodes.filter(n => n.parentId === map.content.rootId && map.content.nodes.some(child => child.parentId === n.id)).map(n => n.id)));
  const [selected, setSelected] = useState<string | null>(cached?.selected ?? null);
  const [view, setView] = useState<View>(cached?.view ?? { x: 0, y: 0, scale: 1 });
  const [panel, setPanel] = useState<"outline" | "detail" | "info" | "branches" | null>(null);
  const panelTrigger = useRef<HTMLElement | null>(null), panelElement = useRef<HTMLElement | null>(null);
  const reveal = useRef<{ id: string; focus: boolean; center?: boolean } | null>(null);
  const livePanel = useRef(panel); livePanel.current = panel;
  const [sourceRef, setSourceRef] = useState<MindMapReferenceV1 | null>(null);
  const [source, setSource] = useState<NoteMindMapSourceV1 | null>(null), [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const sourceDialog = useRef<HTMLDialogElement>(null), sourceTrigger = useRef<HTMLElement | null>(null);
  const viewport = useRef<HTMLDivElement>(null), live = useRef(view); live.current = view;
  const layout = useMemo(() => layoutMindMap(map.content, collapsed), [map.content, collapsed]);
  const latestLayout = useRef(layout); latestLayout.current = layout;
  const node = map.content.nodes.find(n => n.id === selected) ?? null;
  const old = map.noteVersionId !== currentVersionId;
  const root = map.content.nodes.find(n => n.id === map.content.rootId)!;
  const orderedNodes = useMemo(() => {
    const entries: { id: string; depth: number }[] = [];
    const visit = (id: string, depth: number) => { entries.push({ id, depth }); for (const child of layout.children.get(id) ?? []) visit(child.id, depth + 1); };
    visit(map.content.rootId, 0); return entries;
  }, [map.content]);
  const readingBounds = (element: HTMLElement) => {
    const pane = livePanel.current ? panelElement.current?.getBoundingClientRect() : null;
    const bounds = element.getBoundingClientRect();
    // 全屏里阅读页开在左边（见 note-mind-map.css），非全屏在右边：可见区要跟着让开，选中的节点才落在看得见的位置。
    const reserve = pane?.width ? (fullscreen ? pane.right - bounds.left + 24 : bounds.right - pane.left + 24)
      : livePanel.current ? Math.min(340, element.clientWidth - 36) + 36 : 36;
    const top = element.clientHeight < 350 ? 86 : 114;
    return fullscreen
      ? { left: Math.min(reserve, element.clientWidth * .55), right: 36, top, bottom: 82 }
      : { left: 36, right: Math.min(reserve, element.clientWidth * .55), top, bottom: 82 };
  };
  const fit = () => {
    const element = viewport.current; if (!element) return;
    const { bounds: b } = latestLayout.current;
    const insets = readingBounds(element), width = Math.max(100, element.clientWidth - insets.left - insets.right), height = Math.max(100, element.clientHeight - insets.top - insets.bottom);
    const scale = Math.max(.25, Math.min(1, width / (b.right - b.left), height / (b.bottom - b.top)));
    setView({ x: insets.left + width / 2 - (b.left + b.right) / 2 * scale, y: insets.top + height / 2 - (b.top + b.bottom) / 2 * scale, scale });
  };
  useLayoutEffect(() => { if (!cached) fit(); }, []);
  useLayoutEffect(() => { if (fitAfterFold.current) { fitAfterFold.current = false; fit(); } }, [collapsed]);
  const previousSize = useRef<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const observe = () => {
      const size = { width: element.clientWidth, height: element.clientHeight }, previous = previousSize.current;
      if (previous) setView(v => ({ ...v, x: v.x + (size.width - previous.width) / 2, y: v.y + (size.height - previous.height) / 2 }));
      previousSize.current = size;
    }; observe(); const observer = new ResizeObserver(observe); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    views.set(key, { view, collapsed: [...collapsed], selected });
    if (views.size > 40) views.delete(views.keys().next().value!);
  }, [key, view, collapsed, selected]);
  const zoom = (factor: number, point?: { x: number; y: number }) => {
    const element = viewport.current; if (!element) return;
    const p = point ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    setView(v => { const scale = Math.max(.25, Math.min(2, v.scale * factor)); return { scale, x: p.x - (p.x - v.x) * scale / v.scale, y: p.y - (p.y - v.y) * scale / v.scale }; });
  };
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const r = element.getBoundingClientRect(), intensity = event.ctrlKey || event.metaKey ? .008 : .002;
      zoom(Math.max(.76, Math.min(1.32, Math.exp(-event.deltaY * intensity))), { x: event.clientX - r.left, y: event.clientY - r.top });
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, []);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ view: View; points: { x: number; y: number }[] } | null>(null);
  const rebase = () => { drag.current = { view: live.current, points: [...pointers.current.values()] }; };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest("button"))) return;
    e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect(); pointers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top }); rebase();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !drag.current) return;
    const r = e.currentTarget.getBoundingClientRect(); pointers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    const now = [...pointers.current.values()], before = drag.current.points, base = drag.current.view;
    if (now.length >= 2 && before.length >= 2) {
      const distance = (p: typeof now) => Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y);
      const a = { x: (before[0]!.x + before[1]!.x) / 2, y: (before[0]!.y + before[1]!.y) / 2 };
      const b = { x: (now[0]!.x + now[1]!.x) / 2, y: (now[0]!.y + now[1]!.y) / 2 };
      const scale = Math.max(.25, Math.min(2, base.scale * distance(now) / Math.max(1, distance(before))));
      setView({ scale, x: b.x - (a.x - base.x) * scale / base.scale, y: b.y - (a.y - base.y) * scale / base.scale });
    } else if (now[0] && before[0]) setView({ ...base, x: base.x + now[0].x - before[0].x, y: base.y + now[0].y - before[0].y });
  };
  const end = (e: PointerEvent<HTMLDivElement>) => { pointers.current.delete(e.pointerId); rebase(); };
  const toggle = (id: string) => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId : undefined;
    if (!collapsed.has(id) && focused) {
      let ancestor = map.content.nodes.find(n => n.id === focused);
      while (ancestor?.parentId) { if (ancestor.parentId === id) { viewport.current?.querySelector<HTMLButtonElement>(`[data-node-id="${id}"]`)?.focus({ preventScroll: true }); break; } ancestor = map.content.nodes.find(n => n.id === ancestor?.parentId); }
    }
    setCollapsed(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const select = (id: string, focus = false, center = false) => {
    reveal.current = { id, focus, center };
    setSelected(id); setPanel("detail");
    panelTrigger.current = viewport.current?.querySelector<HTMLButtonElement>(`[data-node-id="${id}"]`) ?? viewport.current;
    setCollapsed(current => {
      const next = new Set(current); let ancestor = map.content.nodes.find(n => n.id === id);
      while (ancestor?.parentId) { next.delete(ancestor.parentId); ancestor = map.content.nodes.find(n => n.id === ancestor?.parentId); }
      return next;
    });
  };
  useLayoutEffect(() => {
    const pending = reveal.current; if (!pending) return;
    const p = layout.positions.find(p => p.node.id === pending.id), element = viewport.current;
    if (p && element) {
      const v = live.current, x = p.x * v.scale + v.x, y = p.y * v.scale + v.y, insets = readingBounds(element);
      // 从大纲／键盘跳过来时每次都居中（可见区中心，跟着阅读页在哪边让位）；画布上直接点选只在会被挡住或缩放太小时才搬。
      if (pending.center || x < insets.left + p.width / 2 || x > element.clientWidth - insets.right - p.width / 2 || y < insets.top + p.height / 2 || y > element.clientHeight - insets.bottom - p.height / 2 || v.scale < .7) {
        const scale = Math.max(.85, v.scale); setView({ scale, x: (element.clientWidth + insets.left - insets.right) / 2 - p.x * scale, y: (element.clientHeight + insets.top - insets.bottom) / 2 - p.y * scale });
      }
      const button = viewport.current?.querySelector<HTMLButtonElement>(`[data-node-id="${pending.id}"]`);
      if (button) panelTrigger.current = button;
      if (pending.focus) button?.focus({ preventScroll: true });
    }
    reveal.current = null;
  }, [layout, selected, panel]);
  const closePanel = () => {
    setPanel(null);
    const trigger = panelTrigger.current;
    (trigger?.isConnected ? trigger : viewport.current)?.focus({ preventScroll: true });
  };
  const openPanel = (value: "outline" | "info" | "branches", trigger: HTMLElement) => {
    if (panel === value) { closePanel(); return; }
    panelTrigger.current = trigger; setPanel(value);
  };
  useLayoutEffect(() => { if (panel && panel !== "detail") panelElement.current?.focus({ preventScroll: true }); }, [panel]);
  useEffect(() => {
    if (!sourceRef) return;
    const dialog = sourceDialog.current;
    if (dialog && !dialog.open) dialog.showModal();
    let obsolete = false;
    setSourceError(null);
    void window.astella.noteMindMap.source({ meta: createRequestMeta(epoch), noteId: map.noteId, mindMapId: map.mindMapId }).then(result => {
      if (!obsolete && useRoomStore.getState().workspaceScopeRevision === scope) setSource(unwrapGatewayResult(result));
    }).catch(error => { if (!obsolete) setSourceError(gatewayErrorMessage(error)); });
    return () => { obsolete = true; };
  }, [sourceRef, sourceAttempt]);
  useLayoutEffect(() => { if (source && sourceRef) sourceDialog.current?.querySelector<HTMLElement>(`[data-source-ordinal="${sourceRef.blockOrdinal}"]`)?.scrollIntoView({ block: "center" }); }, [source, sourceRef]);
  const closeSource = () => { sourceDialog.current?.close(); setSourceRef(null); sourceTrigger.current?.focus({ preventScroll: true }); };
  return <section className="note-mind-map" data-fullscreen={fullscreen} aria-label="笔记思维导图"
    onKeyDown={event => {
      if (event.key === "Escape" && panel && !(event.target instanceof Element && event.target.closest("dialog"))) {
        event.preventDefault(); event.stopPropagation(); closePanel();
      }
    }}>
    <header className="note-mind-map__info-island">
      <button type="button" aria-label="脑图信息" aria-expanded={panel === "info"} aria-controls="mind-map-reading-pane" onClick={event => openPanel("info", event.currentTarget)}>
        <Info size={17} aria-hidden="true"/><span><strong>{root.label}</strong><small>{map.content.nodes.length} 个节点 · 笔记 v{map.noteVersionNumber}{old ? " · 旧版" : ""}{regenerating ? " · 正在重新整理" : ""}</small></span>
      </button>
    </header>
    {notice}
    <nav className="note-mind-map__toolbar" aria-label="脑图工具">
      <button type="button" onClick={() => zoom(1 / 1.2)} aria-label="缩小脑图"><Minus size={16}/></button>
      <button type="button" onClick={() => zoom(1 / live.current.scale)} title="恢复原始大小">{Math.round(view.scale * 100)}%</button>
      <button type="button" onClick={() => zoom(1.2)} aria-label="放大脑图"><Plus size={16}/></button>
      <button type="button" onClick={fit}><RotateCcw size={15}/>适应</button>
      <span className="note-mind-map__tool-divider" aria-hidden="true"/>
      <button type="button" aria-expanded={panel === "outline"} aria-controls="mind-map-reading-pane" onClick={event => openPanel("outline", event.currentTarget)}><ListTree size={16}/>大纲</button>
      <button type="button" aria-expanded={panel === "branches"} aria-controls="mind-map-reading-pane" onClick={event => openPanel("branches", event.currentTarget)}><GitBranch size={16}/>分支</button>
      <button type="button" onClick={() => useNotebookFullscreenState.setState({ active: !fullscreen })} aria-label={fullscreen ? "退出脑图全屏" : "全屏脑图"}><Maximize2 size={16}/></button>
    </nav>
    <div className="note-mind-map__viewport" ref={viewport} tabIndex={0} aria-label="脑图画布，可拖动平移；方向键移动画布，加减键缩放" onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={e => { if (e.target !== e.currentTarget) return; if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)) { e.preventDefault(); setView(v => ({ ...v, x: v.x + (e.key === "ArrowLeft" ? 48 : e.key === "ArrowRight" ? -48 : 0), y: v.y + (e.key === "ArrowUp" ? 48 : e.key === "ArrowDown" ? -48 : 0) })); } else if (["+","=","-","0"].includes(e.key)) { e.preventDefault(); if (e.key === "0") fit(); else zoom(e.key === "-" ? 1/1.2 : 1.2); } }}>
      <div className="note-mind-map__world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg className="note-mind-map__lines" aria-hidden="true">{layout.positions.filter(p => p.node.parentId).map(p => { const parent = layout.positions.find(q => q.node.id === p.node.parentId)!; const fromX = parent.x + p.side * parent.width / 2, toX = p.x - p.side * p.width / 2, middle = (fromX + toX) / 2; return <path key={p.node.id} stroke={COLORS[p.branch % COLORS.length]} d={`M ${fromX} ${parent.y} C ${middle} ${parent.y} ${middle} ${p.y} ${toX} ${p.y}`}/>; })}</svg>
        {layout.positions.map(p => <div key={p.node.id} className="note-mind-map__node" data-kind={p.node.kind} data-selected={selected === p.node.id} style={{ left: p.x - p.width / 2, top: p.y - p.height / 2, width: p.width, minHeight: p.height, "--branch-color": p.branch < 0 ? "#8d6148" : COLORS[p.branch % COLORS.length] } as CSSProperties}>
          <button type="button" data-node-id={p.node.id} aria-pressed={selected === p.node.id} onClick={() => select(p.node.id)} onKeyDown={e => { const index = layout.positions.findIndex(q => q.node.id === p.node.id); let id: string | undefined; if (e.key === "ArrowUp") id = layout.positions[Math.max(0,index-1)]?.node.id; else if (e.key === "ArrowDown") id = layout.positions[Math.min(layout.positions.length-1,index+1)]?.node.id; else if (e.key === "ArrowLeft") id = p.node.parentId ?? undefined; else if (e.key === "ArrowRight") { if (collapsed.has(p.node.id)) toggle(p.node.id); else id = layout.children.get(p.node.id)?.[0]?.id; } if (id) { e.preventDefault(); select(id,true); } }}>{p.node.label}</button>
          {layout.children.get(p.node.id)?.length ? <button type="button" className="note-mind-map__fold" aria-label={`${collapsed.has(p.node.id) ? "展开" : "折叠"}${p.node.label}`} aria-expanded={!collapsed.has(p.node.id)} onClick={() => toggle(p.node.id)}>{collapsed.has(p.node.id) ? "+" : "−"}</button> : null}
        </div>)}
      </div>
      <span className="note-mind-map__hint">拖动画布 · 滚轮缩放 · 点选节点看依据</span>
    </div>
    {panel ? <aside id="mind-map-reading-pane" className="note-mind-map__reading-pane" data-panel={panel} ref={panelElement} tabIndex={-1} aria-label={panel === "outline" ? "脑图大纲" : panel === "detail" ? "节点详情" : panel === "info" ? "脑图信息" : "分支工具"}>
      <header><span>{panel === "outline" ? "整篇大纲" : panel === "detail" ? "节点与依据" : panel === "info" ? "这份脑图" : "展开与收起"}</span><button type="button" onClick={closePanel} aria-label="收起脑图阅读页"><X size={17}/></button></header>
      <div className="note-mind-map__pane-scroll">
        {panel === "outline" ? <nav className="note-mind-map__outline" aria-label="脑图文字大纲">{orderedNodes.map(entry => {
          const item = map.content.nodes.find(n => n.id === entry.id)!;
          return <button type="button" key={item.id} style={{ paddingInlineStart: 10 + entry.depth * 14 }} aria-pressed={selected === item.id} onClick={() => select(item.id, true, true)}><ChevronRight size={14}/><span>{item.label}</span></button>;
        })}</nav> : null}
        {panel === "detail" && node ? <div className="note-mind-map__detail" aria-live="polite">
          <h3>{node.label}</h3>
          <p>{node.explanation ?? (node.kind === "root" ? "这篇笔记的中心主题。沿分支展开，点选知识节点查看解释。" : "这是知识分组，可以继续展开下一级。")}</p>
          {layout.children.get(node.id)?.length ? <button type="button" className="note-mind-map__pane-action" onClick={() => toggle(node.id)}>{collapsed.has(node.id) ? "展开这个分支" : "收起这个分支"}</button> : null}
          {node.references.map((ref,i) => <button type="button" className="note-mind-map__reference" key={i} onClick={event => { sourceTrigger.current = event.currentTarget; setSourceRef(ref); }}><span>查看原文 v{map.noteVersionNumber} · 第 {ref.blockOrdinal + 1} 段</span><q>{ref.quote}</q></button>)}
        </div> : null}
        {panel === "info" ? <div className="note-mind-map__metadata">
          <h3>{root.label}</h3><p>基于笔记 v{map.noteVersionNumber} · 已读取全部文字</p>
          {old ? <p>这是旧版脑图，可重新整理当前版本。</p> : unversioned ? <p>正文还有未存成版本的改动，重新生成前可以选择使用的版本。</p> : null}
          {map.coverage.imageBlocksNotRead ? <p>{map.coverage.imageBlocksNotRead} 处图片未读取。</p> : null}
          <button type="button" className="note-mind-map__pane-action" disabled={regenerating} onClick={onRegenerate}>{regenerating ? "正在重新整理…" : "重新生成脑图"}</button>
          <p className="small">重新生成会保留旧图，可在学习记录里回看。</p>
        </div> : null}
        {panel === "branches" ? <div className="note-mind-map__branch-actions">
          <button type="button" className="note-mind-map__pane-action" onClick={() => { fitAfterFold.current = true; setCollapsed(new Set()); closePanel(); }}>展开全部</button>
          <button type="button" className="note-mind-map__pane-action" onClick={() => { fitAfterFold.current = true; setCollapsed(new Set(map.content.nodes.filter(n => n.parentId === map.content.rootId && map.content.nodes.some(child => child.parentId === n.id)).map(n => n.id))); setSelected(null); closePanel(); }}>收起分支</button>
          <p className="small">也可以点节点旁的加减号，单独展开一个分支。</p>
        </div> : null}
      </div>
    </aside> : null}
    {sourceRef ? <dialog ref={sourceDialog} className="note-mind-map__source" aria-labelledby="mind-map-source-title" onCancel={e => { e.preventDefault(); closeSource(); }}><header><div><p className="small">脑图生成时的原文 · 只读 v{map.noteVersionNumber}</p><h2 id="mind-map-source-title">{map.title}</h2></div><button type="button" aria-label="返回脑图" onClick={closeSource}><X size={20}/></button></header><blockquote>{sourceRef.quote}</blockquote>{sourceError ? <p role="alert">{sourceError}<button type="button" onClick={() => setSourceAttempt(v => v+1)}>重新读取</button></p> : !source ? <p role="status">正在读取当时的正文…</p> : <div className="note-mind-map__source-body note-transcript">{source.blocks.map(block => <article key={block.ordinal} data-source-ordinal={block.ordinal} data-cited={block.ordinal === sourceRef.blockOrdinal}><small>第 {block.ordinal+1} 段</small><NoteMarkdownReading type={block.type} content={block.content} options={{ workspaceEpoch: epoch, documentSource: source.blocks.map(b => b.content).join("\n\n") }}/></article>)}</div>}<footer><button type="button" className="button" onClick={closeSource}>回到脑图</button></footer></dialog> : null}
  </section>;
}
