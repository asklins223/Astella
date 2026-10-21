// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  BookOpenText,
  ChevronRight,
  CircleHelp,
  BookMarked,
  Layers,
  Sparkles,
  Eye,
  EyeOff,
  Focus,
  Network,
  Search,
  Target,
  X,
} from "lucide-react";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@astella/shared/note-deepening-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import { NoteOverviewLayer, NoteLocalLayer, NoteRecordLayer } from "./graph-note-pages";
import { rememberGraphJourney, takeGraphJourney } from "./graph-journey";
import { useStarMapMotion } from "./use-star-map-motion";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { useSurfaceProjection } from "../notebook/shell/surface-data.tsx";
import {
  edgeEndpointKey,
  graphEdgeKindLabel,
  graphNodeKey,
  graphNodeKindLabel,
  graphNodeLabel,
  graphNodeSummary,
  isNoteNode,
  isSourceNode,
} from "./graph-sky.ts";
import {
  EMPTY_IDS,
  UnderstandingUniverse,
  type UnderstandingUniverseHandle,
} from "./understanding-universe.tsx";
import {
  createUniverseLayout,
  filterUnderstandingGraph,
  getSelectedGraphPath,
  UNIVERSE_STATE_LABEL,
  type GraphEdge,
  type GraphNode,
  type UnderstandingGraph,
  type UniverseLayout,
} from "./understanding-universe-data.ts";
import { RELATION_ROW_LIMIT } from "./graph-surface-types";
import type { DeepeningLayer, StateFilter } from "./graph-surface-types";
import { useGraphControls } from "./use-graph-controls";

const EMPTY_GRAPH: UnderstandingGraph = { nodes: [], edges: [] };
const SEARCH_RESULT_LIMIT = 8;

/** Same identity trick as `EMPTY_IDS` — a new `[]` per render would refresh
 *  `validEdges` and invalidate the canvas scene cache on every parent render. */
const NO_EDGES: GraphEdge[] = [];

/* ── 星图三层展开 ──────────────────────────────────────────────────────────
 *
 * 三个尺度是**同一条路径的三个尺度**：笔记总览 → 这张卡的题目 → 历次作答。
 * 屏上只有**一个**选中的笔记，换层不换笔记，换笔记回到层一。
 */

const LAYER_ORDER: readonly DeepeningLayer[] = ["overview", "local", "records"] as const;

const LAYER_LABEL: Readonly<Record<DeepeningLayer, string>> = {
  overview: "笔记总览",
  local: "配套练习",
  records: "练习记录",
};

/**
 * The star map is boundless: the canvas fills the whole window while the rail,
 * heading, room-control island and the floating HUD plates stay on top.
 */
const UNIVERSE_HUD_INSETS = { top: 150, bottom: 165, left: 340, right: 90 } as const;
const COMPACT_UNIVERSE_HUD_INSETS = { top: 130, bottom: 145, left: 205, right: 28 } as const;
const COMPACT_UNIVERSE_QUERY = "(max-width: 760px), (max-height: 480px)";

const FILTERS: ReadonlyArray<{
  readonly value: StateFilter;
  readonly label: string;
  readonly states: readonly string[] | null;
}> = [
  { value: "all", label: "全部题目", states: null },
  { value: "attention", label: "再练练", states: ["misunderstood"] },
  { value: "unseen", label: "没练过", states: ["unseen"] },
  { value: "understood", label: "练过", states: ["preliminary_understood", "reviewed"] },
];

const NODE_TYPE_LABEL: Record<GraphNode["type"], string> = {
  source: "来源行星",
  note: "笔记星座",
  card: "题目恒星",
  key_point: "证据卫星",
};

/** 一题卡片上的最好星级 → 屏上的粗状态。星级是唯一来源，不另算。 */
function questionUniverseState(bestStars: number | null): string {
  if (bestStars === null) return "unseen";
  if (bestStars <= 1) return "misunderstood";
  if (bestStars <= 3) return "preliminary_understood";
  return "reviewed";
}

function nodeStateLabel(node: GraphNode): string {
  if (node.type === "note") return node.metadata.hasSource ? "带来源的笔记" : "手写笔记";
  if (node.type === "source") return "可回到原材料";
  return node.state ? UNIVERSE_STATE_LABEL[node.state] ?? node.state : "还没有练过";
}

function searchableText(node: GraphNode): string {
  return `${node.label} ${node.description ?? ""} ${node.state ?? ""} ${NODE_TYPE_LABEL[node.type]}`
    .toLocaleLowerCase("zh-CN");
}

function useCompactUniverseLayout(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" && window.matchMedia(COMPACT_UNIVERSE_QUERY).matches
  ));

  useEffect(() => {
    const query = window.matchMedia(COMPACT_UNIVERSE_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return compact;
}

function toUniverseGraph(
  nodes: readonly UnderstandingNodeProjectionV3[],
  edges: readonly UnderstandingEdgeProjectionV3[],
): UnderstandingGraph {
  const graphNodes: GraphNode[] = nodes.map((node) => {
    const id = graphNodeKey(node);
    if ("bestStars" in node) {
      return {
        id,
        entityId: node.nodeRef.questionId,
        type: "card",
        label: graphNodeLabel(node),
        description: graphNodeSummary(node),
        state: questionUniverseState(node.bestStars),
        parentId: null,
        evidenceCoverage: node.bestStars === null ? null : node.bestStars / 5,
        metadata: {
          questionType: node.questionType,
          bestStars: node.bestStars,
          noteId: node.nodeRef.noteId,
        },
      };
    }
    if (isSourceNode(node)) {
      return {
        id,
        entityId: node.nodeRef.sourceId,
        type: "source",
        label: graphNodeLabel(node),
        description: graphNodeSummary(node),
        state: null,
        parentId: null,
        evidenceCoverage: null,
        metadata: { modality: node.modality },
      };
    }
    return {
      id,
      entityId: node.nodeRef.noteId,
      type: "note",
      label: graphNodeLabel(node),
      description: graphNodeSummary(node),
      state: null,
      parentId: null,
      evidenceCoverage: null,
      metadata: { hasSource: node.hasSource },
    };
  });

  const edgeType: Record<UnderstandingEdgeProjectionV3["kind"], GraphEdge["type"]> = {
    contains_note: "derived_from",
    contains_question: "contains",
    references: "contains",
  };
  return {
    nodes: graphNodes,
    edges: edges.map((edge) => ({
      id: edge.edgeId,
      from: edgeEndpointKey(edge.from),
      to: edgeEndpointKey(edge.to),
      type: edgeType[edge.kind],
      metadata: {},
    })),
  };
}

export function GraphSurface() {
  useHudPage("graph");
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setNoteReturnTo = useRoomStore((state) => state.setNoteReturnTo);

  const universeRef = useRef<UnderstandingUniverseHandle>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const motionMode = useRoomStore(state => state.reducedMotion ? "off" : state.motionMode);
  const searchShellRef = useRef<HTMLDivElement>(null);
  const mapOptionsRef = useRef<HTMLDetailsElement>(null);
  const compactLayout = useCompactUniverseLayout();

  const {
    query, setQuery, deferredQuery, searchOpen, setSearchOpen, searchActiveIndex, setSearchActiveIndex,
    stateFilter, setStateFilter, showSources, setShowSources,
    showLinks, setShowLinks, selectedId, setSelectedId, indexActiveIndex, setIndexActiveIndex,
    pendingFocusId, setPendingFocusId, fitRequest, setFitRequest, pathNoteId, setPathNoteId,
    layer, setLayer, listMode, setListMode, compactLayoutRef, listboxId,
  } = useGraphControls(compactLayout);
  const { data, loading, failure, reload, refreshing, refreshFailure } = useSurfaceProjection(
    async ({ workspaceEpoch }) => {
      const response = await window.astella.understanding.getTopology({ meta: createRequestMeta(workspaceEpoch) });
      return unwrapGatewayResult(response);
    },
    [],
    { refreshOnFocus: true },
  );

  const projections = useMemo(() => data?.nodes ?? [], [data]);
  const topologyEdges = useMemo(() => data?.edges ?? [], [data]);
  const projectionByKey = useMemo(
    () => new Map(projections.map((node) => [graphNodeKey(node), node])),
    [projections],
  );
  const rawGraph = useMemo(
    () => data ? toUniverseGraph(projections, topologyEdges) : EMPTY_GRAPH,
    [data, projections, topologyEdges],
  );
  const rawNodeById = useMemo(() => new Map(rawGraph.nodes.map((node) => [node.id, node])), [rawGraph.nodes]);
  const activeFilter = FILTERS.find((item) => item.value === stateFilter) ?? FILTERS[0];
  const visibleGraph = useMemo(
    () => filterUnderstandingGraph(rawGraph, {
      query: "",
      state: activeFilter.states,
    }),
    [activeFilter.states, rawGraph],
  );
  // The layout is deterministic, so a same-revision refresh (the focus
  // re-read) returns the cached layout instead of re-running the placement
  // search on the main thread.
  const layoutRevision = data?.topologyRevision ?? "";
  const layoutCacheRef = useRef<{ revision: string; layout: UniverseLayout } | null>(null);
  const layout = useMemo(() => {
    if (layoutCacheRef.current?.revision === layoutRevision && layoutRevision !== "") {
      return layoutCacheRef.current.layout;
    }
    const nextLayout = createUniverseLayout(rawGraph);
    layoutCacheRef.current = { revision: layoutRevision, layout: nextLayout };
    return nextLayout;
  }, [layoutRevision, rawGraph]);
  const selectedNode = selectedId ? rawNodeById.get(selectedId) ?? null : null;
  const selectedProjection = selectedId ? projectionByKey.get(selectedId) ?? null : null;
  const selectedPath = useMemo(
    () => selectedId ? getSelectedGraphPath(visibleGraph, selectedId) : null,
    [selectedId, visibleGraph],
  );

  // 笔记拥有三个阅读尺度；题目的详情只指向它所属的那一篇。
  const anchorNoteId = useMemo(() => {
    if (!selectedProjection) return null;
    if (isNoteNode(selectedProjection)) return selectedProjection.nodeRef.noteId;
    if (selectedProjection.nodeRef.kind === "card_question") return selectedProjection.nodeRef.noteId;
    return null;
  }, [selectedProjection]);

  // 换一篇笔记 ⇒ 回到层一。换层 ⇒ 不换笔记。
  useEffect(() => {
    if (anchorNoteId !== pathNoteId) {
      setPathNoteId(anchorNoteId);
      setLayer("overview");
    }
  }, [anchorNoteId, pathNoteId]);

  /**
   * 层二／层三。**只在这一篇上有 `pathNoteId` 时才读**——没点开任何一篇时，
   * 这一发一次都不该发。
   */
  const {
    data: deepening,
    loading: deepeningLoading,
    failure: deepeningFailure,
    reload: reloadDeepening,
  } = useSurfaceProjection(
    async ({ workspaceEpoch }) => {
      if (!pathNoteId || layer === "overview") return null;
      const response = await window.astella.understanding.getNoteDeepening({
        meta: createRequestMeta(workspaceEpoch),
        noteId: pathNoteId,
      });
      return unwrapGatewayResult(response);
    },
    [pathNoteId, layer === "overview"],
    {},
  );

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
    if (!nodeId) return;
    const node = rawNodeById.get(nodeId);
    if (node?.type === "source") setShowSources(true);
  }, [rawNodeById]);

  /**
   * 等价册页：与画布**同一份读**，所以它列的笔记与图上看到的一致。
   */
  const noteRows = useMemo(() => {
    const questionsByNote = new Map<string, number>();
    let bestByNote = new Map<string, number>();
    for (const edge of topologyEdges) {
      if (edge.kind !== "contains_question" || edge.from.kind !== "note") continue;
      questionsByNote.set(edge.from.id, (questionsByNote.get(edge.from.id) ?? 0) + 1);
    }
    for (const node of projections) {
      if (!("bestStars" in node) || node.bestStars === null) continue;
      const noteId = node.nodeRef.noteId;
      bestByNote.set(noteId, Math.max(bestByNote.get(noteId) ?? 0, node.bestStars));
    }
    return projections
      .filter(isNoteNode)
      .map((note) => ({
        noteId: note.nodeRef.noteId,
        title: graphNodeLabel(note),
        hasSource: note.hasSource,
        questionCount: questionsByNote.get(note.nodeRef.noteId) ?? 0,
        bestStars: bestByNote.get(note.nodeRef.noteId) ?? null,
      }))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }, [projections, topologyEdges]);
  const visibleNoteRows = noteRows.filter(row => visibleGraph.nodes.some(node => node.id === `note:${row.noteId}`));

  /** 打开一条笔记的向下路径：层一，并把它选成当前那颗星。 */
  const openNotePath = useCallback((noteId: string) => {
    setPathNoteId(noteId);
    setLayer("overview");
    const key = `note:${noteId}`;
    const node = rawNodeById.get(key);
    if (node) {
      setQuery("");
      if (!visibleGraph.nodes.some(visible => visible.id === key)) setStateFilter("all");
      setSelectedId(key);
      if (!listMode) setPendingFocusId(key);
    }
  }, [rawNodeById, listMode, visibleGraph.nodes]);

  const rememberJourney = useCallback(() => {
    if (!data?.workspaceId) return;
    rememberGraphJourney(data.workspaceId, {
      query, stateFilter, showSources, showLinks, selectedId, layer, listMode,
      viewport: universeRef.current?.getViewport() ?? null,
      shelfScrollTop: pageRef.current?.querySelector(".universe-booklist__pages")?.scrollTop ?? 0,
      detailScrollTop: pageRef.current?.querySelector(".universe-detail-body")?.scrollTop ?? 0,
    });
  }, [data?.workspaceId, query, stateFilter, showSources, showLinks, selectedId, layer, listMode]);
  const restoredWorkspace = useRef<string | null>(null);
  const returnedScroll = useRef<{ shelf: number; detail: number; layer: DeepeningLayer; selected: string | null } | null>(null);
  useEffect(() => {
    if (!data?.workspaceId || restoredWorkspace.current === data.workspaceId) return;
    restoredWorkspace.current = data.workspaceId;
    const saved = takeGraphJourney(data.workspaceId);
    if (!saved) return;
    returnedScroll.current = { shelf: saved.shelfScrollTop, detail: saved.detailScrollTop, layer: saved.layer, selected: saved.selectedId };
    setQuery(saved.query); setStateFilter(saved.stateFilter);
    setShowSources(saved.showSources); setShowLinks(saved.showLinks);
    setListMode(saved.listMode);
    if (saved.selectedId && rawNodeById.has(saved.selectedId)) {
      setSelectedId(saved.selectedId);
      const node = projectionByKey.get(saved.selectedId);
      setPathNoteId(node && isNoteNode(node) ? node.nodeRef.noteId : null);
      setLayer(saved.layer);
    }
    if (saved.viewport) universeRef.current?.restoreViewport(saved.viewport);
  }, [data?.workspaceId, rawNodeById, projectionByKey]);
  useEffect(() => {
    const saved = returnedScroll.current;
    if (!saved || selectedId !== saved.selected || layer !== saved.layer) return;
    const shelf = pageRef.current?.querySelector(".universe-booklist__pages");
    if (shelf) shelf.scrollTop = saved.shelf;
    if (pathNoteId && layer !== "overview" && deepening?.noteId !== pathNoteId && !deepeningFailure) return;
    const detail = pageRef.current?.querySelector(".universe-detail-body");
    if (detail) detail.scrollTop = saved.detail;
    returnedScroll.current = null;
  }, [selectedId, layer, listMode, pathNoteId, deepening, deepeningFailure]);

  /** 星图里的继续动作回到同一篇笔记，打开它的学习卡。 */
  const openNoteJourney = useCallback((noteId: string) => {
    rememberJourney();
    setActiveNoteRef({ noteId, noteVersionId: null, mode: "preview" });
    setNoteReturnTo("graph");
    invoke("open-notebook");
  }, [invoke, setActiveNoteRef, setNoteReturnTo, rememberJourney]);

  useEffect(() => {
    if (!pendingFocusId || !visibleGraph.nodes.some((node) => node.id === pendingFocusId)) return;
    const timer = window.setTimeout(() => {
      universeRef.current?.focusNode(pendingFocusId);
      setPendingFocusId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingFocusId, visibleGraph.nodes]);

  useEffect(() => {
    if (selectedId && !visibleGraph.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visibleGraph.nodes]);

  // The panel is non-modal (the canvas stays live behind it), so this is focus
  // hand-off, not a trap.
  const detailPanelRef = useRef<HTMLElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const panelWasOpenRef = useRef(false);
  useEffect(() => {
    const open = Boolean(selectedNode);
    if (open === panelWasOpenRef.current) return;
    panelWasOpenRef.current = open;
    if (open) {
      focusReturnRef.current = document.activeElement as HTMLElement | null;
      detailPanelRef.current
        ?.querySelector<HTMLElement>(".universe-detail-head button")
        ?.focus({ preventScroll: true });
    } else {
      const target = focusReturnRef.current;
      if (target?.isConnected && target !== document.body && !detailPanelRef.current?.contains(target)) {
        target.focus({ preventScroll: true });
      } else {
        searchShellRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
      }
      focusReturnRef.current = null;
    }
  }, [selectedNode]);

  // Consume dismissal before App's window-level Escape can leave the room.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (mapOptionsRef.current?.open) {
        mapOptionsRef.current.open = false;
        mapOptionsRef.current.querySelector("summary")?.focus();
      } else if (searchOpen && query.trim()) {
        setSearchOpen(false);
      } else if (selectedId) setSelectedId(null);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [query, searchOpen, selectedId]);

  useEffect(() => {
    if (fitRequest === 0) return;
    const timer = window.setTimeout(() => universeRef.current?.fit(), 0);
    return () => window.clearTimeout(timer);
  }, [fitRequest]);

  useEffect(() => {
    if (compactLayoutRef.current === compactLayout) return;
    compactLayoutRef.current = compactLayout;
  }, [compactLayout]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!searchShellRef.current?.contains(event.target as Node)) setSearchOpen(false);
      if (mapOptionsRef.current && !mapOptionsRef.current.contains(event.target as Node)) mapOptionsRef.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  const searchMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return EMPTY_GRAPH.nodes;
    return rawGraph.nodes.filter((node) => searchableText(node).includes(needle));
  }, [query, rawGraph.nodes]);
  const searchResults = useMemo(
    () => searchMatches.slice(0, SEARCH_RESULT_LIMIT),
    [searchMatches],
  );

  useEffect(() => {
    setSearchActiveIndex(searchOpen && searchResults.length > 0 ? 0 : -1);
  }, [searchOpen, searchResults]);

  useEffect(() => {
    setIndexActiveIndex((index) => (
      visibleGraph.nodes.length > 0 ? Math.min(index, visibleGraph.nodes.length - 1) : 0
    ));
  }, [visibleGraph.nodes.length]);

  const filterCounts = useMemo(() => {
    const questions = rawGraph.nodes.filter((node) => node.type === "card");
    return {
      all: questions.length,
      attention: questions.filter((node) => node.state === "misunderstood").length,
      unseen: questions.filter((node) => node.state === "unseen").length,
      understood: questions.filter((node) => node.state === "preliminary_understood" || node.state === "reviewed").length,
    } satisfies Record<StateFilter, number>;
  }, [rawGraph.nodes]);

  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [];
    const seen = new Set<string>();
    const neighbors: Array<{ edge: UnderstandingEdgeProjectionV3; node: UnderstandingNodeProjectionV3 }> = [];
    for (const edge of topologyEdges) {
      const from = edgeEndpointKey(edge.from);
      const to = edgeEndpointKey(edge.to);
      const otherKey = from === selectedId ? to : to === selectedId ? from : null;
      if (!otherKey || seen.has(otherKey)) continue;
      const node = projectionByKey.get(otherKey);
      if (!node) continue;
      seen.add(otherKey);
      neighbors.push({ edge, node });
    }
    return neighbors;
  }, [projectionByKey, selectedId, topologyEdges]);

  const revealNode = useCallback((node: GraphNode) => {
    // Search is a locator, not a persistent graph filter.
    setQuery("");
    setStateFilter("all");
    if (node.type === "source") setShowSources(true);
    setSelectedId(node.id);
    if (listMode && node.type !== "note") setListMode(false);
    if (!listMode || node.type !== "note") setPendingFocusId(node.id);
    setSearchOpen(false);
  }, [listMode]);

  const revealProjection = useCallback((node: UnderstandingNodeProjectionV3) => {
    const graphNode = rawNodeById.get(graphNodeKey(node));
    if (graphNode) revealNode(graphNode);
  }, [rawNodeById, revealNode]);

  const openNodeRecord = (node: UnderstandingNodeProjectionV3) => {
    rememberJourney();
    const ref = node.nodeRef;
    const returnTo = { label: "返回星图", run: () => invoke("graph") };
    if (ref.kind === "card_question") {
      openNoteJourney(ref.noteId);
    } else if (ref.kind === "note") {
      setActiveNoteRef({ noteId: ref.noteId, noteVersionId: null });
      setNoteReturnTo("graph");
      invoke("open-notebook");
    } else {
      setActiveSourceId(ref.sourceId);
      invoke("open-source", { returnTo });
    }
  };

  const counts = useMemo(() => ({
    questions: rawGraph.nodes.filter((node) => node.type === "card").length,
    sources: rawGraph.nodes.filter((node) => node.type === "source").length,
    edges: rawGraph.edges.length,
  }), [rawGraph]);
  const telemetry = useMemo(() => [
    `${visibleGraph.nodes.length} / ${rawGraph.nodes.length} 星体`,
    `${counts.questions} 题目恒星`,
    `${counts.sources} 来源行星`,
    `${counts.edges} 真实光路`,
  ].join(" · "), [counts, rawGraph.nodes.length, visibleGraph.nodes.length]);

  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!data) return null;
    return {
      pageId: "star_map",
      title: "理解星图",
      statusLine: telemetry,
      metrics: [
        { label: "可见星体", value: `${visibleGraph.nodes.length} / ${rawGraph.nodes.length}` },
        ...(selectedNode ? [{ label: "正在看", value: selectedNode.label.slice(0, 40) }] : []),
      ],
      items: visibleGraph.nodes.slice(0, 8).map((node, index) => ({
        ordinal: index + 1,
        label: node.label.slice(0, 60),
        state: `${NODE_TYPE_LABEL[node.type] ?? node.type} · ${nodeStateLabel(node)}`.slice(0, 24),
      })),
      filters: [
        { label: "状态筛选", value: stateFilter },
        { label: "搜索词", value: deferredQuery.slice(0, 40) || "未填" },
      ],
      ...(visibleGraph.nodes.length === 0
        ? { notice: "按当前的筛选与搜索词，图上没有剩下任何星体。" }
        : {}),
    };
  }, [data, deferredQuery, rawGraph.nodes.length, selectedNode, stateFilter, telemetry, visibleGraph.nodes]);
  usePageReadableView(readableView);

  const currentLayer = anchorNoteId === pathNoteId ? layer : "overview";
  const currentDeepening = deepening?.noteId === anchorNoteId ? deepening : null;
  const presentation = useRef({ node: selectedNode, projection: selectedProjection, noteId: anchorNoteId, layer: currentLayer, deepening: currentDeepening, neighbors: selectedNeighbors });
  if (selectedNode) presentation.current = { node: selectedNode, projection: selectedProjection, noteId: anchorNoteId, layer: currentLayer, deepening: currentDeepening, neighbors: selectedNeighbors };
  const { node: displayNode, projection: displayProjection, noteId: displayNoteId, layer: displayLayer, deepening: displayDeepening, neighbors: displayNeighbors } = presentation.current;
  useStarMapMotion(pageRef, Boolean(selectedNode), `${listMode}:${selectedId ?? "closed"}:${currentLayer}:${stateFilter}`);

  return (
    <HudPage page="graph" wide>
      <div ref={pageRef} className="universe-page" data-detail-open={Boolean(selectedNode)} data-view={listMode ? "notes" : "map"} data-motion={motionMode}>
        <div className="universe-stage" aria-hidden="true" />
        <div className="universe-chart" inert={listMode || undefined} aria-hidden={listMode}>
        <UnderstandingUniverse
          ref={universeRef}
          nodes={visibleGraph.nodes}
          edges={showLinks ? visibleGraph.edges : NO_EDGES}
          positions={layout.positions}
          selectedId={selectedId}
          highlightedNodeIds={selectedPath?.nodeIds ?? EMPTY_IDS}
          highlightedEdgeIds={selectedPath?.edgeIds ?? EMPTY_IDS}
          onSelect={selectNode}
          motionMode={motionMode}
          visualStyle="cosmic"
          typeLabels={NODE_TYPE_LABEL}
          stateLabels={UNIVERSE_STATE_LABEL}
          insets={{ ...(compactLayout ? COMPACT_UNIVERSE_HUD_INSETS : UNIVERSE_HUD_INSETS), ...(selectedNode && !compactLayout ? { right: 470 } : {}) }}
          offsetStorageKey={data?.workspaceId ? `understanding-universe:node-offsets:v1:${data.workspaceId}` : undefined}
          title="理解星图：你的真实知识宇宙"
        />
        </div>

        <header className="universe-top-hud">
          <nav className="universe-view-dock" aria-label="星图阅读方式" data-star-tabs>
            <span className="universe-tab-cushion" aria-hidden="true" />
            <button type="button" aria-pressed={!listMode} onClick={() => setListMode(false)}><Sparkles size={16} />漫游星图</button>
            <button type="button" aria-pressed={listMode} onClick={() => setListMode(true)}><BookMarked size={16} />按笔记读</button>
          </nav>
          <div ref={searchShellRef} className="universe-search-shell" data-open={searchOpen && Boolean(query.trim())}>
            <Search size={16} aria-hidden="true" />
            <input
              className="universe-search-input"
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setSearchOpen(Boolean(event.target.value.trim())); }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (!searchResults.length) {
                  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSearchOpen(false); }
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSearchActiveIndex((index) => (index + 1) % searchResults.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSearchActiveIndex((index) => (index <= 0 ? searchResults.length - 1 : index - 1));
                } else if (event.key === "Enter") {
                  const active = searchActiveIndex >= 0 ? searchResults[searchActiveIndex] : searchResults[0];
                  if (active) {
                    event.preventDefault();
                    revealNode(active);
                  }
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setSearchOpen(false);
                }
              }}
              placeholder="找一篇笔记、一道题…"
              aria-label="搜索理解星图"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={searchOpen && Boolean(query.trim())}
              aria-controls={listboxId}
              aria-activedescendant={searchOpen && searchActiveIndex >= 0 ? `${listboxId}-option-${searchActiveIndex}` : undefined}
            />
            {query ? <button className="universe-search-clear" type="button" onClick={() => { setQuery(""); setSearchOpen(false); }} aria-label="清除搜索"><X size={14} /></button> : null}
            {searchOpen && query.trim() ? (
              <div className="universe-search-results" role="listbox" id={listboxId} aria-label="搜索结果">
                {searchResults.length ? <>{searchResults.map((node, index) => (
                  <button
                    key={node.id}
                    type="button"
                    className={`universe-search-result${index === searchActiveIndex ? " is-active" : ""}`}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === searchActiveIndex || selectedId === node.id}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => revealNode(node)}
                  >
                    <span className={`universe-search-orb universe-search-orb--${node.type}`} aria-hidden="true" />
                    <span><strong>{node.label}</strong><small>{NODE_TYPE_LABEL[node.type]} · {nodeStateLabel(node)}</small></span>
                    <Target size={14} aria-hidden="true" />
                  </button>
                ))}{searchMatches.length > searchResults.length ? (
                  <p className="universe-search-more">还有 {searchMatches.length - searchResults.length} 颗匹配星体未列出，输入更精确的关键词可缩小范围</p>
                ) : null}</> : <div className="universe-search-empty"><Search size={15} /><span>这片宇宙里暂时没有匹配的星体</span></div>}
              </div>
            ) : null}
          </div>
        </header>

        <nav className="universe-filter-dock" data-star-tabs aria-label="按练习情况筛选星图" title="计数表示题目数量；相关来源与笔记会一并保留">
          <span className="universe-tab-cushion" aria-hidden="true" />
          {FILTERS.map((item) => (
            <button key={item.value} type="button" className={`universe-filter${stateFilter === item.value ? " is-active" : ""}`} onClick={() => setStateFilter(item.value)} disabled={item.value !== "all" && filterCounts[item.value] === 0} aria-pressed={stateFilter === item.value}>
              <span>{item.label}</span><small>{filterCounts[item.value]}</small>
            </button>
          ))}
        </nav>

        <details ref={mapOptionsRef} className="universe-map-options">
          <summary><Layers size={16} /><span>图层与图例</span></summary>
          <div className="universe-options-paper">
            <div className="universe-legend" aria-label="星体图例">
              <span><i className="is-card" />题目恒星</span><span><i className="is-note" />笔记星座</span>
              <span><i className="is-source" />来源行星</span>
            </div>
            <div className="universe-layer-dock" role="group" aria-label="控制知识宇宙图层">
              <label className="universe-layer-toggle"><input type="checkbox" checked={showSources} disabled={counts.sources === 0} onChange={event => setShowSources(event.target.checked)} /><BookOpenText size={15} /><span>来源行星</span></label>
              <label className="universe-layer-toggle"><input type="checkbox" checked={showLinks} disabled={counts.edges === 0} onChange={event => setShowLinks(event.target.checked)} />{showLinks ? <Eye size={15} /> : <EyeOff size={15} />}<span>关系光路</span></label>
            </div>
            <p>光路表示来源收录了哪篇笔记、笔记里有哪些题目、正文引用了谁。</p>
          </div>
        </details>
        <div className="universe-caption"><Sparkles size={14} aria-hidden="true" /><span>{listMode ? "选一本，沿着它的练习往下读" : "拖动漫游 · 滚轮缩放 · 点一颗星展开"}</span></div>
        <span className="universe-layer-readout" aria-live="polite">{telemetry}</span>
        {refreshing || refreshFailure ? <p className="universe-refresh-note" role="status">{refreshFailure ? `星图暂时没能更新：${refreshFailure}` : "正在更新星图…"}</p> : null}

        {data?.integrity.truncated ? <div className="universe-data-note" role="status">这张星图已经装到本次的上限，目前只展示已读到的星体。</div> : null}

        {/* §11.5「星图不可用时提供相同笔记和下一步的列表」。**随时可切**：
            这一份与画布读的是**同一份拓扑**，所以两份列的笔记逐字一致。 */}
        {listMode ? (
          <section className="universe-booklist" aria-label="按笔记读星图（与星图等价）">
            <header className="universe-booklist__head">
              <h2>按笔记读</h2>
              <p>把每一篇展开，看看它的配套练习，接回上次的作答。</p>
            </header>
            {visibleNoteRows.length === 0 ? (
              <p className="universe-layer-empty">当前范围里没有笔记，切回「全部题目」再看看。</p>
            ) : (
              <ol className="universe-booklist__pages">
                {visibleNoteRows.map((row, index) => (
                  <li key={row.noteId} className="universe-booklist__page" data-color={index % 4}>
                    <button
                      type="button"
                      className="universe-booklist__spine"
                      aria-current={pathNoteId === row.noteId ? "true" : undefined}
                      onClick={() => openNotePath(row.noteId)}
                    >
                      <span className="universe-booklist__mark" aria-hidden="true"><BookMarked size={25} /><small>{String(index + 1).padStart(2, "0")}</small></span>
                      <strong>{row.title}</strong>
                      <small>
                        {row.hasSource ? "有来源" : "手写笔记"} · {row.questionCount} 道题
                        {row.bestStars === null ? " · 还没练" : ` · 最好 ${row.bestStars} 星`}
                      </small>
                    </button>
                    {row.questionCount > 0 ? (
                      <button type="button" className="universe-booklist__act" onClick={() => openNoteJourney(row.noteId)}>
                        回笔记做这张卡<ArrowRight size={13} />
                      </button>
                    ) : (
                      <button type="button" className="universe-booklist__act" onClick={() => openNotePath(row.noteId)}>
                        看这一篇<ArrowRight size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}

        <button type="button" className="universe-detail-scrim" onClick={() => setSelectedId(null)} aria-label="关闭星体详情" aria-hidden={!selectedNode} tabIndex={selectedNode ? 0 : -1} />
        <aside ref={detailPanelRef} inert={!selectedNode || undefined} data-visible={Boolean(selectedNode)} className={`universe-detail-panel${selectedNode ? " is-open" : ""}`} role="complementary" aria-label="星体详情" aria-hidden={!selectedNode}>
          {displayNode && displayProjection ? (
            <>
              <header className="universe-detail-head">
                <div><span className={`universe-detail-type is-${displayNode.type}`}><i aria-hidden="true" /> {NODE_TYPE_LABEL[displayNode.type]}</span><small>{nodeStateLabel(displayNode)}</small></div>
                <button type="button" onClick={() => setSelectedId(null)} aria-label="关闭星体详情"><X size={16} /></button>
              </header>
              {displayNoteId ? (
                <nav className="universe-layers" data-star-tabs aria-label="这一篇笔记的三个尺度">
                  <span className="universe-tab-cushion" aria-hidden="true" />
                  {LAYER_ORDER.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`universe-layers__tab${displayLayer === value ? " is-active" : ""}`}
                      aria-current={displayLayer === value ? "true" : undefined}
                      onClick={() => setLayer(value)}
                    >{LAYER_LABEL[value]}</button>
                  ))}
                </nav>
              ) : null}
              <div className="universe-detail-body">
                {displayNoteId && displayLayer === "overview" ? (
                  <NoteOverviewLayer
                    noteId={displayNoteId}
                    projections={projections}
                    edges={topologyEdges}
                    onContinue={() => openNoteJourney(displayNoteId)}
                    onOpenNote={() => openNoteJourney(displayNoteId)}
                    onSelectQuestion={(questionId) => { const node = projectionByKey.get(`card_question:${questionId}`); if (node) revealProjection(node); }}
                    onSelectNote={targetNoteId => { const node = projectionByKey.get(`note:${targetNoteId}`); if (node) revealProjection(node); }}
                  />
                ) : null}
                {displayNoteId && displayLayer !== "overview" ? (
                  deepeningLoading && !displayDeepening ? (
                    <p className="universe-detail-description" role="status">正在把这一篇的练习记录取下来…</p>
                  ) : deepeningFailure ? (
                    <div className="universe-layer-empty" role="alert">
                      <p>这一层现在读不到：{deepeningFailure}</p>
                      <button type="button" onClick={() => void reloadDeepening()}>再读一次</button>
                    </div>
                  ) : displayDeepening ? (
                    displayLayer === "local" ? (
                      <NoteLocalLayer
                        deepening={displayDeepening}
                        onOpenNote={() => openNoteJourney(displayNoteId)}
                      />
                    ) : (
                      <NoteRecordLayer
                        deepening={displayDeepening}
                        onOpenNote={() => openNoteJourney(displayNoteId)}
                      />
                    )
                  ) : null
                ) : null}
                {!(displayNoteId && isNoteNode(displayProjection)) && (
                  <>
                <section><h2 className="universe-detail-title">{graphNodeLabel(displayProjection)}</h2><p className="universe-detail-description">{graphNodeSummary(displayProjection)}</p></section>
                <dl className="universe-detail-timing">
                  <div><dt>节点类型</dt><dd>{graphNodeKindLabel(displayProjection.nodeRef.kind)}</dd></div>
                  <div><dt>直接关系</dt><dd>{displayNeighbors.length} 条</dd></div>
                </dl>
                <section className="universe-detail-relations">
                  <div className="universe-detail-section-title"><span>真实光路</span><small>{displayNeighbors.length > RELATION_ROW_LIMIT ? `显示前 ${RELATION_ROW_LIMIT} 条，共 ${displayNeighbors.length} 条` : displayNeighbors.length ? "选择一条光路继续探索" : "暂无相邻星体"}</small></div>
                  {displayNeighbors.length ? <div>{displayNeighbors.slice(0, RELATION_ROW_LIMIT).map(({ edge, node }) => (
                    <div key={edge.edgeId} className="universe-detail-relation-row">
                      <button type="button" className="universe-detail-relation" onClick={() => revealProjection(node)}>
                        <i className={`is-${node.nodeRef.kind === "card_question" ? "card" : node.nodeRef.kind}`} aria-hidden="true" />
                        <span><small>{graphEdgeKindLabel(edge.kind)} · {graphNodeKindLabel(node.nodeRef.kind)}</small><strong>{graphNodeLabel(node)}</strong></span><ChevronRight size={14} />
                      </button>
                    </div>
                  ))}</div> : <p className="universe-detail-description">这是一颗暂时独立的星体，还没有可追溯的直接关系。</p>}
                </section>
                  </>
                )}
              </div>
              <footer className="universe-detail-actions">
                <button className="is-secondary" type="button" onClick={() => {
                  if (listMode) { setListMode(false); setPendingFocusId(displayNode.id); }
                  else universeRef.current?.focusNode(displayNode.id);
                  if (compactLayout) setSelectedId(null);
                }}><Focus size={14} />{listMode ? "在星图里看" : "聚焦星体"}</button>
                {!isNoteNode(displayProjection) || displayLayer === "overview" ? <button className="is-primary" type="button" onClick={() => openNodeRecord(displayProjection)}>
                  {isNoteNode(displayProjection) ? "打开笔记" : displayProjection.nodeRef.kind === "card_question" ? "去做这道题" : "打开来源"}<ArrowRight size={14} />
                </button> : null}
              </footer>
            </>
          ) : null}
        </aside>

        {((loading && !data) || failure || (!loading && !failure && rawGraph.nodes.length === 0) || (!loading && rawGraph.nodes.length > 0 && visibleGraph.nodes.length === 0)) ? (
          <div className="universe-status-overlay">
            <section className="universe-status-card" aria-busy={loading || undefined} role={failure ? "alert" : "status"}>
              <span className="universe-status-orbit" aria-hidden="true">{failure ? <CircleHelp size={20} /> : rawGraph.nodes.length > 0 ? <Search size={20} /> : <Network size={20} />}</span>
              {loading ? <><strong>正在点亮你的知识宇宙</strong><p>把笔记和配套练习放到星图上…</p></> : failure ? <><strong>理解星图暂时不可用</strong><p>{failure}</p><button type="button" onClick={() => void reload()}>重新读取</button></> : rawGraph.nodes.length === 0 ? <><strong>这片宇宙还没有星体</strong><p>从来源写下笔记，星体就会在这里出现；生成学习卡之后，题目会绕着它长出来。</p><button type="button" onClick={() => invoke("open-sources")}><BookOpenText size={14} />查看来源库</button></> : <><strong>这个星域里没有匹配项</strong><p>切回「全部题目」或打开来源图层即可恢复。</p><button type="button" onClick={() => { setQuery(""); setStateFilter("all"); setShowSources(true); setFitRequest((value) => value + 1); }}>显示全部星体</button></>}
            </section>
          </div>
        ) : null}

        {/* The keyboard loop into the canvas: one tab stop, arrow keys walk
            the stars, Enter selects and focuses one on the map. */}
        <div
          className="sr-only"
          role="listbox"
          aria-label="星图节点索引（方向键浏览，回车选中并聚焦）"
          inert={listMode || undefined}
          aria-hidden={listMode}
          tabIndex={!listMode && visibleGraph.nodes.length ? 0 : -1}
          aria-activedescendant={visibleGraph.nodes.length ? `universe-index-option-${indexActiveIndex}` : undefined}
          onKeyDown={(event) => {
            const count = visibleGraph.nodes.length;
            if (!count) return;
            if (event.key === "ArrowDown" || event.key === "ArrowRight") {
              event.preventDefault();
              setIndexActiveIndex((index) => Math.min(count - 1, index + 1));
            } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
              event.preventDefault();
              setIndexActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === "Home") {
              event.preventDefault();
              setIndexActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setIndexActiveIndex(count - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              const node = visibleGraph.nodes[Math.min(indexActiveIndex, count - 1)];
              if (node) {
                event.preventDefault();
                revealNode(node);
              }
            }
          }}
        >
          {visibleGraph.nodes.map((node, index) => (
            <div key={node.id} id={`universe-index-option-${index}`} role="option" aria-selected={node.id === selectedId}>
              {NODE_TYPE_LABEL[node.type]}：{node.label}
            </div>
          ))}
        </div>
      </div>
    </HudPage>
  );
}
