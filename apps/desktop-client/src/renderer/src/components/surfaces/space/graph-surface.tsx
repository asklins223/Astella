// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  BookOpenText,
  ChevronRight,
  CircleHelp,
  Eye,
  EyeOff,
  Focus,
  ListTree,
  Network,
  Play,
  Quote,
  Search,
  Target,
  X,
} from "lucide-react";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@ailearn/shared/note-deepening-contracts";
import type {
  NoteApplicabilityAxisV3,
  NoteDeepeningV3,
  NoteNextStepAxisV3,
  NotePerformanceAxisV3,
} from "@ailearn/shared/note-deepening-v3-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { useSurfaceProjection } from "../notebook/surface-data.tsx";
import {
  edgeEndpointKey,
  graphEdgeKindLabel,
  graphNodeKey,
  graphNodeKindLabel,
  graphNodeLabel,
  graphNodeSummary,
  graphObjectiveStateLabel,
  isEvidenceNode,
  isNoteNode,
  isObjectiveNode,
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

type ObjectiveNode = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "objective" } }>;

const EMPTY_GRAPH: UnderstandingGraph = { nodes: [], edges: [] };
const SEARCH_RESULT_LIMIT = 8;
const RELATION_LIMIT = 8;
/**
 * 建议关系那一档的屏上说法（§11.3）。
 *
 * **三档都要有句子**：缺一档渲染出来就是 `undefined`，而那正是「屏上出现一个没人
 * 读得懂的状态」的那一类。措辞不用「已确认／待确认」这类后台词——它是给人看的，
 * 说的是「系统觉得这条关系成立，但那条只是它猜的」。
 */
/** 决策表用的语义关系四档（与 `personalRelationKindV2Schema` 同一份字面量）。 */
const SEMANTIC_RELATIONS = ["prerequisite", "explains", "contrasts", "relates_to"] as const;

/**
 * 从 `reasonCodes` 里取那条**具体的**语义关系。
 *
 * 取不到就落 `relates_to`（总称那一档），而不是 `undefined`：键对不上的后果是
 * 这次表态落在另一条边上，而那一条用户根本看不到——**一个静默写到别处去的表态**
 * 比一次明确的失败更难查。
 */
/** 导出是为了让 `graph-relation-stamp.test.tsx` 直接断言换算结果，
 *  而不是 `readFileSync` 源码抠字面量（那条路一拆文件就红）。 */
export function SEMANTIC_RELATION_FROM_REASON_CODES(reasonCodes: readonly string[]) {
  const hit = reasonCodes.find((code) => (SEMANTIC_RELATIONS as readonly string[]).includes(code));
  return (hit ?? "relates_to") as (typeof SEMANTIC_RELATIONS)[number];
}

export const RELATION_STAMP_LABEL: Readonly<Record<"confirmed" | "dismissed" | "suggested", string>> = {
  suggested: "系统猜的一条，还没当成真的",
  confirmed: "你确认过了",
  dismissed: "你收起了这条",
};

/** Same identity trick as `EMPTY_IDS` — a new `[]` per render would refresh
 *  `validEdges` and invalidate the canvas scene cache on every parent render. */
const NO_EDGES: GraphEdge[] = [];

/* ── 39d W8-1 · 星图三层展开 ────────────────────────────────────────────────
 *
 * §11.2 那张表的三层是**同一条学习路径的三个尺度**，不是三个页面。屏上的形状就是
 * 那条纪律：只有**一个**选中的笔记，层一／层二／层三是往下走的一格页签，换层不换
 * 笔记，换笔记回到层一。任何"另起一套导航"的实现都会在这里长出第二份选中态。
 */

const LAYER_ORDER: readonly DeepeningLayer[] = ["overview", "local", "records"] as const;

/** §11.2 那一列的层名，屏上念的是人话。 */
const LAYER_LABEL: Readonly<Record<DeepeningLayer, string>> = {
  overview: "笔记总览",
  local: "笔记局部",
  records: "证据详情",
};

/**
 * §11.4 三轴的屏上说法。
 *
 * **三份都是句子，没有一份是分数**——"折叠成一个亮度"这件事在这里没有落点，
 * 因为三个 `<dt>` 各自带自己的名字。
 */
const PERFORMANCE_AXIS_LABEL: Readonly<Record<NotePerformanceAxisV3, string>> = {
  no_record_yet: "还没有学习记录",
  met_once: "见过一次，还没有留下可复述的记录",
  assisted_once: "借助提示完成的",
  used_independently: "有一次是独立说出来的",
  repeated_over_time: "隔了不同日子，重复用上过",
};

const NEXT_STEP_AXIS_LABEL: Readonly<Record<NoteNextStepAxisV3, string>> = {
  nothing_to_do: "现在没有下一步",
  can_continue: "可以接着往下走",
  suggest_relearn: "建议补学",
  due_for_review: "适合回访",
  paused_by_user: "你把这一段停下了",
};

const APPLICABILITY_AXIS_LABEL: Readonly<Record<NoteApplicabilityAxisV3, string>> = {
  basis_holds: "依据还适用",
  basis_updated: "材料有更新，要对一眼",
  needs_check: "待核对",
  no_permission: "现在读不到材料",
};

/** §11.2 笔记局部那一行的三个动作，各叫什么。 */
const RELATION_REASON_LABEL: Readonly<Record<string, string>> = {
  prerequisite: "理解这条之前需要",
  explains: "用这一条来解释",
  contrasts: "可以和这一条对比",
  relates_to: "系统认为有关",
};

const RELATION_STATUS_LABEL: Readonly<Record<"confirmed" | "dismissed" | "suggested", string>> = {
  confirmed: "你确认过",
  suggested: "待确认建议",
  dismissed: "你收起了",
};

/**
 * The star map is boundless: the canvas fills the whole window while the rail,
 * heading chip, room-control island and the floating HUD plates stay on top.
 * `fit()` reserves those screen-space bands so the default view still reads as
 * a map instead of hiding labels under chrome. Keep every edge in step with the
 * matching CSS custom property in understanding-universe.css:
 *   top    — below the top row (search + filters), which starts at 100px and is
 *            52px tall, plus the heading chip's own band;
 *   bottom — above the upper instrument row, whose 54px plates start 86px off
 *            the bottom edge;
 *   left   — past the 73px navigation rail;
 *   right  — the same 22px gutter every plate on the right ends at.
 */
const UNIVERSE_HUD_INSETS = { top: 160, bottom: 156, left: 96, right: 36 } as const;
const COMPACT_UNIVERSE_HUD_INSETS = { top: 72, bottom: 72, left: 210, right: 24 } as const;
const COMPACT_UNIVERSE_QUERY = "(max-width: 760px), (max-height: 480px)";

const FILTERS: ReadonlyArray<{
  readonly value: StateFilter;
  readonly label: string;
  readonly states: readonly string[] | null;
}> = [
  { value: "all", label: "全部", states: null },
  { value: "attention", label: "要处理", states: ["misunderstood", "due_review"] },
  { value: "unseen", label: "没碰过", states: ["unseen"] },
  { value: "understood", label: "练过了", states: ["preliminary_understood", "reviewed"] },
];

const NODE_TYPE_LABEL: Record<GraphNode["type"], string> = {
  source: "来源行星",
  note: "笔记星座",
  card: "理解恒星",
  key_point: "证据卫星",
};

function objectiveUniverseState(state: string): string {
  if (state === "needs_repair" || state === "fragile" || state === "outdated") return "misunderstood";
  if (state === "due_review") return "due_review";
  if (state === "stable") return "reviewed";
  if (state === "learning" || state === "scheduled") return "preliminary_understood";
  return "unseen";
}

function nodeStateLabel(node: GraphNode): string {
  return node.state ? UNIVERSE_STATE_LABEL[node.state] ?? node.state : "知识锚点";
}

/** 抽屉按钮只写点击后真正打开的地方；正式作答由下一页自行开始。 */
function objectiveActionLabel(node: ObjectiveNode, linkedNoteId: string | null): string {
  if (node.activeCardId) return "查看对应卡片";
  return linkedNoteId ? "回笔记继续学习" : "查看目标详情";
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
  const evidenceDegree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "supported_by") continue;
    const from = edgeEndpointKey(edge.from);
    const to = edgeEndpointKey(edge.to);
    evidenceDegree.set(from, (evidenceDegree.get(from) ?? 0) + 1);
    evidenceDegree.set(to, (evidenceDegree.get(to) ?? 0) + 1);
  }

  const graphNodes: GraphNode[] = nodes.map((node) => {
    const id = graphNodeKey(node);
    if (isObjectiveNode(node)) {
      // 证据光晕只表达"有真实学习足迹"这一事实（PRD §11.4：星体的光痕可以
      // 表达真实学习足迹，但**不许**把证据条数画成理解百分比——改前
      // "一条证据 = 20%、五条封顶"的弧就是那个禁令指的形状）。V3 合同没有
      // 覆盖度字段；在真覆盖度到来之前，光痕只有"有/没有"两档。
      const evidenceDegreeForNode = evidenceDegree.get(id) ?? 0;
      return {
        id,
        entityId: node.nodeRef.objectiveId,
        type: "card",
        label: graphNodeLabel(node),
        description: node.publicSummary,
        state: objectiveUniverseState(node.personal.state),
        parentId: null,
        evidenceCoverage: evidenceDegreeForNode > 0 ? 1 : null,
        metadata: { objectiveState: node.personal.state },
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
    if (isNoteNode(node)) {
      return {
        id,
        entityId: node.nodeRef.noteId,
        type: "note",
        label: graphNodeLabel(node),
        description: graphNodeSummary(node),
        state: node.hasSource ? "seen" : "unseen",
        parentId: null,
        evidenceCoverage: null,
        metadata: { hasSource: node.hasSource },
      };
    }
    return {
      id,
      entityId: node.nodeRef.evidenceSnapshotId,
      type: "key_point",
      label: graphNodeLabel(node),
      description: graphNodeSummary(node),
      state: node.restricted ? "unseen" : "seen",
      parentId: null,
      evidenceCoverage: null,
      metadata: { restricted: node.restricted },
    };
  });

  const edgeType: Record<UnderstandingEdgeProjectionV3["kind"], GraphEdge["type"]> = {
    contains_note: "derived_from",
    sourced_from: "generated_from",
    supported_by: "contains",
    relates_to: "contains",
    supersedes: "generated_from",
  };
  return {
    nodes: graphNodes,
    edges: edges.map((edge) => ({
      id: edge.edgeId,
      from: edgeEndpointKey(edge.from),
      to: edgeEndpointKey(edge.to),
      type: edgeType[edge.kind],
    })),
  };
}

export function GraphSurface() {
  useHudPage("graph");
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setNoteReturnTo = useRoomStore((state) => state.setNoteReturnTo);

  const universeRef = useRef<UnderstandingUniverseHandle>(null);
  const searchShellRef = useRef<HTMLDivElement>(null);
  // 窄屏与否是**取数**（量视口），所以留在组件侧，作为入参传进 hook。
  const compactLayout = useCompactUniverseLayout();

  // 搜索 / 筛选 / 选中 / 路径 / 等价册页——**摆位参数，与服务端无关**。
  // 紧跟其后的 `useSurfaceProjection(…)` 是**取数**，留在组件里。
  const {
    query, setQuery, deferredQuery, searchOpen, setSearchOpen, searchActiveIndex, setSearchActiveIndex,
    stateFilter, setStateFilter, showEvidence, setShowEvidence, showSources, setShowSources,
    showLinks, setShowLinks, selectedId, setSelectedId, indexActiveIndex, setIndexActiveIndex,
    pendingFocusId, setPendingFocusId, fitRequest, setFitRequest, pathNoteId, setPathNoteId,
    layer, setLayer, listMode, setListMode, compactLayoutRef, listboxId,
  } = useGraphControls(compactLayout);
  const { data, loading, failure, reload } = useSurfaceProjection(
    async ({ workspaceEpoch }) => {
      const response = await window.ailearn.understanding.getTopology({ meta: createRequestMeta(workspaceEpoch) });
      return unwrapGatewayResult(response);
    },
    [],
    { refreshOnFocus: true },
  );

  // 建议关系上的本人表态：**本地先改、重取在后**（理由见 hook 的文件头）。
  const {
    epochRef, stampingEdgeId, setStampingEdgeId,
    relationStamps, setRelationStamps, relationStampError, setRelationStampError,
  } = useGraphRelationStamps();

  const stampRelationDecision = async (
    edge: UnderstandingEdgeProjectionV3,
    decision: "confirmed" | "dismissed",
  ) => {
    if (edge.from.kind !== "objective" || edge.to.kind !== "objective") return;
    // 语义关系（prerequisite／explains／contrasts）**不是** `edge.kind`：拓扑那五档
    // `relates_to` 是"这两个目标之间有一条语义关系"的总称，具体是哪一种在
    // `reasonCodes[0]`（`topology-repository` 从 revision 的 relations 投影过来）。
    // 拿 `edge.kind` 去问排除表，键永远对不上——**结构上问不到**。
    const relation = SEMANTIC_RELATION_FROM_REASON_CODES(edge.reasonCodes);
    setStampingEdgeId(edge.edgeId);
    setRelationStampError(null);
    const previous = relationStamps[edge.edgeId];
    // 乐观：先把它改过去。失败时回滚并**说出来**——静默回滚等于用户白按了一次。
    setRelationStamps((current) => ({ ...current, [edge.edgeId]: decision }));
    try {
      await unwrapGatewayResult(await window.ailearn.understanding.setRelationDecision({
        meta: createRequestMeta(epochRef.current),
        fromObjectiveId: edge.from.id,
        toObjectiveId: edge.to.id,
        relation,
        decision,
      }));
      setRelationStamps((current) => ({ ...current, [edge.edgeId]: decision }));
    } catch {
      setRelationStamps((current) => {
        const next = { ...current };
        if (previous) next[edge.edgeId] = previous; else delete next[edge.edgeId];
        return next;
      });
      setRelationStampError("这一下没有生效，再试一次。");
    } finally {
      setStampingEdgeId(null);
      // 写完之后在后台重取一次。乐观映射（relationStamps）会**永久**压过服务端读回���
      // relationStatus，所以不重取的话：写失败过一次之后，那条边在本页生命周期内
      // 永远停在乐观值上——用户看到的"改过去了"与服务端已经不一致了。
      void reload();
    }
  };

  const projections = useMemo(() => data?.nodes ?? [], [data]);
  const topologyEdges = useMemo(
    () => (data?.edges ?? []).map((edge) => {
      const local = relationStamps[edge.edgeId];
      return local === undefined ? edge : { ...edge, relationStatus: local, countsAsEstablished: local === "confirmed" };
    }),
    [data, relationStamps],
  );
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
      query: deferredQuery,
      state: activeFilter.states,
      showSources,
      showClaims: showEvidence,
    }),
    [activeFilter.states, deferredQuery, rawGraph, showEvidence, showSources],
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


  /* ── 39d W8-1：这条路径锚在哪一篇笔记上 ──────────────────────────────
   *
   * 选中**笔记本身**就锚在它身上；选中一颗目标／一颗证据，就顺着 `sourced_from`
   * 那条血缘边回它是从哪一篇长出来的。**锚不到就是锚不到**（证据可能跨篇共用），
   * 那时三层页签整条不画——画一组"这一篇的局部"而这一篇她根本没在读，就是让屏上
   * 多一份上下文幻觉。
   */
  const anchorNoteId = useMemo(() => {
    if (!selectedProjection) return null;
    if (isNoteNode(selectedProjection)) return selectedProjection.nodeRef.noteId;
    const key = graphNodeKey(selectedProjection);
    for (const edge of topologyEdges) {
      if (edge.kind !== "sourced_from") continue;
      const from = edgeEndpointKey(edge.from);
      const to = edgeEndpointKey(edge.to);
      if (from !== key && to !== key) continue;
      for (const endpoint of [edge.from, edge.to]) {
        if (endpoint.kind === "note") return endpoint.id;
      }
    }
    return null;
  }, [selectedProjection, topologyEdges]);

  // 换一篇笔记 ⇒ 回到层一。换层 ⇒ 不换笔记（就是上面那条纪律）。
  useEffect(() => {
    if (anchorNoteId !== pathNoteId) {
      setPathNoteId(anchorNoteId);
      setLayer("overview");
    }
  }, [anchorNoteId, pathNoteId]);

  /**
   * 层二／层三（§11.2 第二、三行）。**只在这一篇上有 `pathNoteId` 时才读**——
   * §11.5「局部按需加载」：没点开任何一篇时，这一发一次都不该发。
   */
  const {
    data: deepening,
    loading: deepeningLoading,
    failure: deepeningFailure,
    reload: reloadDeepening,
  } = useSurfaceProjection(
    async ({ workspaceEpoch }) => {
      // 没有选中笔记时**不发这一发**。`pathNoteId!` 那个非空断言只是骗过类型：
      // 首次挂载时它就是 null，于是每次进星图都先打一发必然失败的请求，
      // 失败落在 deepeningFailure 里，而那一格的错误分支又只在 pathNoteId 时才画
      // ——于是没人看得见，只是白白多一次往返。
      if (!pathNoteId) return null;
      const response = await window.ailearn.understanding.getNoteDeepening({
        meta: createRequestMeta(workspaceEpoch),
        noteId: pathNoteId,
      });
      return unwrapGatewayResult(response);
    },
    [pathNoteId],
    {},
  );

  // 选中一个节点：记下选中项，并**按它的类型把对应那层打开**——
  // 读者点一个来源却看不到来源，是最容易被骂成「点了没反应」的地方。
  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
    if (!nodeId) return;
    const node = rawNodeById.get(nodeId);
    if (node?.type === "source") setShowSources(true);
    if (node?.type === "key_point") setShowEvidence(true);
  }, [rawNodeById]);

  /**
   * §11.5 等价册页：与画布**同一份读**（`projections` / `topologyEdges`），所以
   * 它列的笔记、下一步与关系和图上看到的逐字一致——不是另一份"列表专用"的数据源。
   * §11.2「有正文的笔记无需制卡即可出现」在这一份上最直白：册页按**笔记**分组，
   * 零卡的那一篇照样有一行。
   */
  const noteRows = useMemo(() => {
    const objectivesByNote = new Map<string, Array<Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "objective" } }>>>();
    for (const edge of topologyEdges) {
      if (edge.kind !== "sourced_from") continue;
      if (edge.from.kind !== "note" || edge.to.kind !== "objective") continue;
      const objective = projectionByKey.get(edgeEndpointKey(edge.to));
      if (!objective || !isObjectiveNode(objective)) continue;
      const list = objectivesByNote.get(edge.from.id) ?? [];
      list.push(objective);
      objectivesByNote.set(edge.from.id, list);
    }
    return projections
      .filter(isNoteNode)
      .map((note) => {
        const objectives = objectivesByNote.get(note.nodeRef.noteId) ?? [];
        const openRun = objectives.find((objective) => objective.personal.activeRunId !== null) ?? null;
        const due = objectives
          .filter((objective) => objective.personal.state === "due_review")
          .sort((a, b) => String(a.personal.nextReviewAt ?? "").localeCompare(String(b.personal.nextReviewAt ?? "")))[0] ?? null;
        return {
          noteId: note.nodeRef.noteId,
          title: graphNodeLabel(note),
          hasSource: note.hasSource,
          objectiveCount: objectives.length,
          openRun,
          due,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }, [projectionByKey, projections, topologyEdges]);

  /** 打开一条笔记的向下路径：层一，并把它选成当前那颗星。 */
  const openNotePath = useCallback((noteId: string) => {
    setPathNoteId(noteId);
    setLayer("overview");
    setListMode(false);
    const key = `note:${noteId}`;
    const node = rawNodeById.get(key);
    if (node) {
      setQuery("");
      setStateFilter("all");
      setSelectedId(key);
      setPendingFocusId(key);
    }
  }, [rawNodeById]);

  /** 星图里的继续动作回到同一篇笔记，沿用它的学习轮次与记录。 */
  const openNoteJourney = useCallback((noteId: string) => {
    setActiveNoteRef({ noteId, noteVersionId: null, mode: "preview" });
    setNoteReturnTo("graph");
    invoke("open-notebook");
  }, [invoke, setActiveNoteRef, setNoteReturnTo]);

  /** 卡片是对应目标的记忆工具；详情使用目标 id，不能把 cardId 当来源 id。 */
  const openCardObjective = useCallback((objectiveId: string) => {
    setActiveObjectiveId(objectiveId);
    invoke("open-objective", { returnTo: { label: "返回星图", run: () => invoke("graph") } });
  }, [invoke, setActiveObjectiveId]);

  const linkedNoteIdForObjective = useCallback((objectiveId: string): string | null => {
    const relation = topologyEdges.find((edge) => edge.kind === "sourced_from"
      && edge.from.kind === "note"
      && edge.to.kind === "objective"
      && edge.to.id === objectiveId);
    return relation?.from.id ?? null;
  }, [topologyEdges]);

  useEffect(() => {
    if (!pendingFocusId || !visibleGraph.nodes.some((node) => node.id === pendingFocusId)) return;
    const timer = window.setTimeout(() => {
      universeRef.current?.focusNode(pendingFocusId);
      setPendingFocusId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingFocusId, visibleGraph.nodes]);

  // A selection that later leaves the visible graph (a filter or a layer toggle
  // hid its star) would leave the detail panel pointing at nothing on the map.
  useEffect(() => {
    if (selectedId && !visibleGraph.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visibleGraph.nodes]);

  // The panel is non-modal (the canvas stays live behind it), so this is focus
  // hand-off, not a trap: put the caret on the panel when it opens so keyboard
  // users are not stranded on the unfocusable canvas, and hand it back on close.
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
      focusReturnRef.current?.focus?.({ preventScroll: true });
      focusReturnRef.current = null;
    }
  }, [selectedNode]);

  // Escape unwinds the page top-down: close the search dropdown first, then
  // deselect the star (which closes the detail panel).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (searchOpen) {
        setSearchOpen(false);
        return;
      }
      if (selectedId) setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, selectedId]);

  useEffect(() => {
    if (fitRequest === 0) return;
    const timer = window.setTimeout(() => universeRef.current?.fit(), 0);
    return () => window.clearTimeout(timer);
  }, [fitRequest]);

  useEffect(() => {
    if (compactLayoutRef.current === compactLayout) return;
    compactLayoutRef.current = compactLayout;
    setFitRequest((value) => value + 1);
  }, [compactLayout]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!searchShellRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  // The dropdown caps at SEARCH_RESULT_LIMIT, so keep the full match list to
  // tell the reader how many hits were left out instead of silently truncating.
  const searchMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return EMPTY_GRAPH.nodes;
    return rawGraph.nodes.filter((node) => searchableText(node).includes(needle));
  }, [query, rawGraph.nodes]);
  const searchResults = useMemo(
    () => searchMatches.slice(0, SEARCH_RESULT_LIMIT),
    [searchMatches],
  );

  // A fresh result list restarts keyboard navigation at the first hit.
  useEffect(() => {
    setSearchActiveIndex(searchOpen && searchResults.length > 0 ? 0 : -1);
  }, [searchOpen, searchResults]);

  useEffect(() => {
    setIndexActiveIndex((index) => (
      visibleGraph.nodes.length > 0 ? Math.min(index, visibleGraph.nodes.length - 1) : 0
    ));
  }, [visibleGraph.nodes.length]);

  const filterCounts = useMemo(() => {
    const objectives = rawGraph.nodes.filter((node) => node.type === "card");
    return {
      all: objectives.length,
      attention: objectives.filter((node) => node.state === "misunderstood" || node.state === "due_review").length,
      unseen: objectives.filter((node) => node.state === "unseen").length,
      understood: objectives.filter((node) => node.state === "preliminary_understood" || node.state === "reviewed").length,
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
  // 选中动作的回调在 `use-graph-controls` 里（它本来就持有那几个 setter）。

  const revealNode = useCallback((node: GraphNode) => {
    // Search is a locator, not a persistent graph filter. Clear it before
    // focusing so the selected star and every relation around it stay visible.
    setQuery("");
    setStateFilter("all");
    if (node.type === "source") setShowSources(true);
    if (node.type === "key_point") setShowEvidence(true);
    setSelectedId(node.id);
    setPendingFocusId(node.id);
    setSearchOpen(false);
  }, []);

  const revealProjection = useCallback((node: UnderstandingNodeProjectionV3) => {
    const graphNode = rawNodeById.get(graphNodeKey(node));
    if (graphNode) revealNode(graphNode);
  }, [rawNodeById, revealNode]);

  const openNodeRecord = (node: UnderstandingNodeProjectionV3) => {
    const ref = node.nodeRef;
    const returnTo = { label: "返回星图", run: () => invoke("graph") };
    if (ref.kind === "objective") {
      const linkedNoteId = linkedNoteIdForObjective(ref.objectiveId);
      if (isObjectiveNode(node) && !node.activeCardId && linkedNoteId) {
        openNoteJourney(linkedNoteId);
        return;
      }
      setActiveObjectiveId(ref.objectiveId);
      invoke("open-objective", { returnTo });
    } else if (ref.kind === "note") {
      setActiveNoteRef({ noteId: ref.noteId, noteVersionId: null });
      setNoteReturnTo("graph");
      invoke("open-notebook");
    } else if (ref.kind === "source") {
      setActiveSourceId(ref.sourceId);
      invoke("open-source", { returnTo });
    }
  };

  const counts = useMemo(() => ({
    objectives: rawGraph.nodes.filter((node) => node.type === "card").length,
    evidence: rawGraph.nodes.filter((node) => node.type === "key_point").length,
    sources: rawGraph.nodes.filter((node) => node.type === "source").length,
    edges: rawGraph.edges.length,
  }), [rawGraph]);
  const telemetry = useMemo(() => [
    `${visibleGraph.nodes.length} / ${rawGraph.nodes.length} 星体`,
    `${counts.objectives} 理解恒星`,
    `${counts.evidence} 证据卫星`,
    `${counts.edges} 真实光路`,
  ].join(" · "), [counts, rawGraph.nodes.length, visibleGraph.nodes.length]);

  /**
   * 星图登记给伴星读的可读视图（doc 37）。
   *
   * `telemetry` 就是屏底那一行读数，条目取自**筛选后可见**的那几颗（不是全量
   * `rawGraph`）——用户说"第三颗星体"指的是屏幕上数得出来的那一个。
   * 当前筛选一并给出，否则她读到 12 颗而屏上只有 5 颗时会归错因。
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!data) return null;
    return {
      pageId: "star_map",
      title: "知识星图",
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

  return (
    <HudPage page="graph" wide>
      <div className="universe-page" data-detail-open={Boolean(selectedNode)} data-searching={query !== deferredQuery}>
        <UnderstandingUniverse
          ref={universeRef}
          nodes={visibleGraph.nodes}
          edges={showLinks ? visibleGraph.edges : NO_EDGES}
          positions={layout.positions}
          selectedId={selectedId}
          highlightedNodeIds={selectedPath?.nodeIds ?? EMPTY_IDS}
          highlightedEdgeIds={selectedPath?.edgeIds ?? EMPTY_IDS}
          onSelect={selectNode}
          insets={compactLayout ? COMPACT_UNIVERSE_HUD_INSETS : UNIVERSE_HUD_INSETS}
          offsetStorageKey={data?.workspaceId ? `understanding-universe:node-offsets:v1:${data.workspaceId}` : undefined}
          title="理解星图：你的真实知识宇宙"
        />
        <div className="universe-atmosphere" aria-hidden="true" />

        <header className="universe-top-hud">
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
              placeholder="搜索并定位来源、笔记或目标"
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

          <nav className="universe-filter-dock" aria-label="按学习目标状态筛选星图" title="计数表示各状态的学习目标数量，包含没有制卡的目标；相关来源、笔记与证据会一并保留">
            {FILTERS.map((item) => (
              <button key={item.value} type="button" className={`universe-filter${stateFilter === item.value ? " is-active" : ""}`} onClick={() => setStateFilter(item.value)} disabled={item.value !== "all" && filterCounts[item.value] === 0} aria-pressed={stateFilter === item.value}>
                <span>{item.label}</span><small>{filterCounts[item.value]}</small>
              </button>
            ))}
          </nav>
        </header>

        <div className="universe-legend" aria-label="星体图例">
          <span><i className="is-card" />理解恒星</span>
          <span><i className="is-note" />笔记星座</span>
          <span><i className="is-source" />来源行星</span>
          <span><i className="is-key-point" />证据卫星</span>
        </div>

        <div className="universe-layer-dock" role="group" aria-label="控制知识宇宙图层">
          <label className="universe-layer-toggle" title={counts.evidence === 0 ? "当前星图没有证据节点" : undefined}><input type="checkbox" checked={showEvidence} disabled={counts.evidence === 0} onChange={(event) => setShowEvidence(event.target.checked)} /><Quote size={14} /><span>证据卫星</span></label>
          <label className="universe-layer-toggle" title={counts.sources === 0 ? "当前星图没有来源节点" : undefined}><input type="checkbox" checked={showSources} disabled={counts.sources === 0} onChange={(event) => setShowSources(event.target.checked)} /><BookOpenText size={14} /><span>来源行星</span></label>
          <label className="universe-layer-toggle" title={counts.edges === 0 ? "当前星图没有关系光路" : undefined}><input type="checkbox" checked={showLinks} disabled={counts.edges === 0} onChange={(event) => setShowLinks(event.target.checked)} />{showLinks ? <Eye size={14} /> : <EyeOff size={14} />}<span>关系光路</span></label>
          {/* §11.5 等价列表的入口。**不是只在画布坏掉时才出现的降级件**——那
              就没法验收"它做的事一样多"（W8-3 完成判据：完成定位任务不比列表更费力）。 */}
          <button
            type="button"
            className={`universe-layer-toggle is-list${listMode ? " is-on" : ""}`}
            aria-pressed={listMode}
            onClick={() => setListMode((value) => !value)}
          ><ListTree size={14} /><span>按笔记读</span></button>
          <span className="universe-layer-readout" aria-live="polite">{telemetry}</span>
        </div>

        {data?.integrity.truncated ? <div className="universe-data-note" role="status">这张星图已经装到本次的上限，其余节点还在服务器上，继续读取就能看到</div> : null}

        {/* 39d W8-3 · §11.5「星图不可用时提供相同笔记和下一步的列表」。**随时可切**：
            降级件只有坏掉那天才在，就没法拿来验收"它做的事一样多"。这一份与画布
            读的是**同一份拓扑**（noteRows 由 projections/topologyEdges 派生），
            所以两份列的笔记与下一步逐字一致，不是第二个数据源。 */}
        {listMode ? (
          <section className="universe-booklist" aria-label="按笔记读星图（与星图等价）">
            <header className="universe-booklist__head">
              <h2>按笔记读</h2>
              <p>与星图同一份读数，笔记、下一步、关系都在；画布看不了的，这里都能做。</p>
            </header>
            {noteRows.length === 0 ? (
              <p className="universe-layer-empty">还没有可读的笔记。</p>
            ) : (
              <ol className="universe-booklist__pages">
                {noteRows.map((row) => (
                  <li key={row.noteId} className="universe-booklist__page">
                    <button
                      type="button"
                      className="universe-booklist__spine"
                      aria-current={pathNoteId === row.noteId ? "true" : undefined}
                      onClick={() => openNotePath(row.noteId)}
                    >
                      <strong>{row.title}</strong>
                      <small>
                        {row.hasSource ? "有来源" : "手写笔记"} · {row.objectiveCount} 个目标
                        {row.openRun ? " · 有一轮没走完" : ""}
                        {row.due ? " · 有该回访的" : ""}
                      </small>
                    </button>
                    {/* 下一件值得做的事：与图上那一格同一份（`primaryAction`），不另算。 */}
                    {row.openRun ? (
                      <button type="button" className="universe-booklist__act" onClick={() => openNoteJourney(row.noteId)}>
                        回笔记继续学习<ArrowRight size={13} />
                      </button>
                    ) : row.due ? (
                      <button type="button" className="universe-booklist__act" onClick={() => openNoteJourney(row.noteId)}>
                        回笔记查看回访<ArrowRight size={13} />
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
        <aside ref={detailPanelRef} className={`universe-detail-panel${selectedNode ? " is-open" : ""}`} role="complementary" aria-label="星体详情" aria-hidden={!selectedNode}>
          {selectedNode && selectedProjection ? (
            <>
              <header className="universe-detail-head">
                <div><span className={`universe-detail-type is-${selectedNode.type}`}><i aria-hidden="true" /> {NODE_TYPE_LABEL[selectedNode.type]}</span><small>{nodeStateLabel(selectedNode)}</small></div>
                <button type="button" onClick={() => setSelectedId(null)} aria-label="关闭星体详情"><X size={16} /></button>
              </header>
              {/* 39d W8-1 · §11.2：三层是同一条路径的三个尺度，所以它是抽屉里的
                  **一排页签**，不是另一个导航——底下换的是内容，锚着的还是这一篇。 */}
              {pathNoteId ? (
                <nav className="universe-layers" aria-label="这一篇笔记的三个尺度">
                  {LAYER_ORDER.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`universe-layers__tab${layer === value ? " is-active" : ""}`}
                      aria-current={layer === value ? "true" : undefined}
                      onClick={() => setLayer(value)}
                    >{LAYER_LABEL[value]}</button>
                  ))}
                </nav>
              ) : null}
              <div className="universe-detail-body">
                {pathNoteId && layer === "overview" ? (
                  <NoteOverviewLayer
                    noteId={pathNoteId}
                    projections={projections}
                    edges={topologyEdges}
                    // 与册页上那颗「继续学习」**同一个函数**（§11.5 等价）：
                    // 两处各写一遍，两处就会慢慢长出不同的下一步。
                    onContinue={() => openNoteJourney(pathNoteId)}
                    onOpenNote={() => openNoteJourney(pathNoteId)}
                  />
                ) : null}
                {pathNoteId && layer !== "overview" ? (
                  deepeningLoading && !deepening ? (
                    <p className="universe-detail-description" role="status">正在把这一篇的学习记录取下来…</p>
                  ) : deepeningFailure ? (
                    <div className="universe-layer-empty" role="alert">
                      <p>这一层现在读不到：{deepeningFailure}</p>
                      <button type="button" onClick={() => void reloadDeepening()}>再读一次</button>
                    </div>
                  ) : deepening ? (
                    layer === "local" ? (
                      <NoteLocalLayer
                        deepening={deepening}
                        onOpenLearningPosition={() => openNoteJourney(pathNoteId)}
                        onOpenCard={openCardObjective}
                      />
                    ) : (
                      <NoteRecordLayer
                        deepening={deepening}
                        onOpenNote={() => openNoteJourney(pathNoteId)}
                        onOpenCard={openCardObjective}
                      />
                    )
                  ) : null
                ) : null}
                {!(pathNoteId && isNoteNode(selectedProjection)) && (
                  <>
                <section><h2 className="universe-detail-title">{graphNodeLabel(selectedProjection)}</h2><p className="universe-detail-description">{graphNodeSummary(selectedProjection)}</p></section>
                <dl className="universe-detail-timing">
                  <div><dt>节点类型</dt><dd>{graphNodeKindLabel(selectedProjection.nodeRef.kind)}</dd></div>
                  <div><dt>直接关系</dt><dd>{selectedNeighbors.length} 条</dd></div>
                  {isObjectiveNode(selectedProjection) ? <div><dt>当前状态</dt><dd>{graphObjectiveStateLabel(selectedProjection.personal.state)}</dd></div> : null}
                </dl>
                <section className="universe-detail-relations">
                  <div className="universe-detail-section-title"><span>真实光路</span><small>{selectedNeighbors.length > RELATION_LIMIT ? `显示前 ${RELATION_LIMIT} 条，共 ${selectedNeighbors.length} 条` : selectedNeighbors.length ? "选择一条光路继续探索" : "暂无相邻星体"}</small></div>
                  {selectedNeighbors.length ? <div>{selectedNeighbors.slice(0, RELATION_LIMIT).map(({ edge, node }) => (
                    <div key={edge.edgeId} className="universe-detail-relation-row">
                      <button type="button" className="universe-detail-relation" onClick={() => revealProjection(node)}>
                        <i className={`is-${node.nodeRef.kind === "objective" ? "card" : node.nodeRef.kind === "evidence" ? "key_point" : node.nodeRef.kind}`} aria-hidden="true" />
                        <span><small>{graphEdgeKindLabel(edge.kind)} · {graphNodeKindLabel(node.nodeRef.kind)}</small><strong>{graphNodeLabel(node)}</strong></span><ChevronRight size={14} />
                      </button>
                      {edge.decidable ? (
                        // 39d W8-2 · §11.3。两颗按钮**只给可表态的那一类边**：
                        // 材料血缘（引用自／取代）与证据链接是"材料怎么来的"，
                        // 不是任何人的看法，没有「我不这么认为」这一档。
                        //
                        // 视觉上是一张压在边上面的**小纸签**，不是两颗同级按钮——
                        // 它是"我对这条关系的看法"，而上面那行是"这条关系本身"。
                        // 两件事的量级不同，摆成同级会让整屏读成一张关系管理表。
                        <div className={`universe-relation-stamp is-${edge.relationStatus ?? "suggested"}`}>
                          <span className="universe-relation-stamp__label">{RELATION_STAMP_LABEL[edge.relationStatus ?? "suggested"]}</span>
                          <div className="universe-relation-stamp__actions">
                            <button
                              type="button"
                              aria-pressed={edge.relationStatus === "confirmed"}
                              disabled={stampingEdgeId === edge.edgeId}
                              onClick={() => stampRelationDecision(edge, "confirmed")}
                            >{edge.relationStatus === "confirmed" ? "已确认" : "确认"}</button>
                            <button
                              type="button"
                              aria-pressed={edge.relationStatus === "dismissed"}
                              disabled={stampingEdgeId === edge.edgeId}
                              onClick={() => stampRelationDecision(edge, "dismissed")}
                            >{edge.relationStatus === "dismissed" ? "已收起" : "收起这条"}</button>
                            {/* 失败必须说出来。这一格此前只写进 state、从不被画出来，
                                而乐观映射会立刻把边改回原样——于是用户按了一次，
                                什么都没发生，也没有一句话告诉他为什么。 */}
                            {stampingEdgeId === null && relationStampError ? (
                              <p className="universe-relation-stamp__error" role="alert" data-relation-stamp-error="true">
                                {relationStampError}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}</div> : <p className="universe-detail-description">这是一颗暂时独立的星体，还没有可追溯的直接关系。</p>}
                </section>
                  </>
                )}
              </div>
              <footer className="universe-detail-actions">
                <button className={isEvidenceNode(selectedProjection) ? "is-primary" : "is-secondary"} type="button" onClick={() => universeRef.current?.focusNode(selectedNode.id)}><Focus size={14} /> 聚焦星体</button>
                {!isEvidenceNode(selectedProjection) ? <button className="is-primary" type="button" onClick={() => openNodeRecord(selectedProjection)}>
                  {isObjectiveNode(selectedProjection) ? objectiveActionLabel(selectedProjection, linkedNoteIdForObjective(selectedProjection.nodeRef.objectiveId)) : isNoteNode(selectedProjection) ? "打开笔记" : "打开来源"}<ArrowRight size={14} />
                </button> : null}
              </footer>
            </>
          ) : null}
        </aside>

        {(loading || failure || (!loading && !failure && rawGraph.nodes.length === 0) || (!loading && rawGraph.nodes.length > 0 && visibleGraph.nodes.length === 0)) ? (
          <div className="universe-status-overlay">
            <section className="universe-status-card" aria-busy={loading || undefined} role={failure ? "alert" : "status"}>
              <span className="universe-status-orbit" aria-hidden="true">{failure ? <CircleHelp size={20} /> : rawGraph.nodes.length > 0 ? <Search size={20} /> : <Network size={20} />}</span>
              {loading ? <><strong>正在点亮你的知识宇宙</strong><p>计算星系位置、关系光路与证据信号…</p></> : failure ? <><strong>理解星图暂时不可用</strong><p>{failure}</p><button type="button" onClick={() => void reload()}>重新读取</button></> : rawGraph.nodes.length === 0 ? <><strong>这片宇宙还没有星体</strong><p>从来源写下笔记，星体就会在这里出现——不需要先制卡；学习之后，真实的路径与证据会随之生长。</p><button type="button" onClick={() => invoke("open-sources")}><BookOpenText size={14} />查看来源库</button></> : <><strong>这个星域里没有匹配项</strong><p>清除搜索或切回“全部”即可恢复。</p><button type="button" onClick={() => { setQuery(""); setStateFilter("all"); setFitRequest((value) => value + 1); }}>显示全部星体</button></>}
            </section>
          </div>
        ) : null}

        {/* The keyboard loop into the canvas: one tab stop, arrow keys walk
            the stars, Enter selects and focuses one on the map. */}
        <div
          className="sr-only"
          role="listbox"
          aria-label="星图节点索引（方向键浏览，回车选中并聚焦）"
          tabIndex={visibleGraph.nodes.length ? 0 : -1}
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

/* ══ 三层的正文 ══════════════════════════════════════════════════════════
 *
 * 三个组件**共享一个** `noteId`（层二／层三从服务端那份读里拿，层一从拓扑投影
 * 拿）。它们是同一条路径的三个尺度，所以视觉上共用同一套物件语言：
 * 便签／册页／纸签，而不是三个页面的三套版式。
 */

/**
 * §11.4 三轴 —— **三张纸签，各自带自己的名字**。
 *
 * 这条是 W8-3 的核心。写成一个 `<div>` 里三个值的话，屏上就会出现一句
 * "整体：还不错"；分成三张带标题的纸签之后，**"合成一个亮度"在版式层就没有
 * 落点了**。`role="group"` + `aria-label` 把"这是三件独立的事"也说给读屏。
 */
function NoteStateAxes({ deepening }: { readonly deepening: NoteDeepeningV3 }) {
  return (
    <div className="universe-axes" role="group" aria-label="三种状态（分开看，不合成一个）">
      <dl className="universe-axes__row">
        <div className="universe-axes__slip">
          <dt>学习表现</dt>
          <dd>{PERFORMANCE_AXIS_LABEL[deepening.axes.performance]}</dd>
        </div>
        <div className="universe-axes__slip">
          <dt>下一步</dt>
          <dd>{NEXT_STEP_AXIS_LABEL[deepening.axes.nextStep]}</dd>
        </div>
        <div className="universe-axes__slip">
          <dt>内容适用性</dt>
          <dd>{APPLICABILITY_AXIS_LABEL[deepening.axes.applicability]}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * 层一：笔记总览（§11.2 第一行「笔记、最近学习位置、未完旅程和当前回访建议」）。
 *
 * **由拓扑投影出来，不额外发一次读**——这一层要的东西（未完的一轮、回访日期、
 * 继续学习）拓扑里逐字都有，另起一份读就是第二个出处。
 */
function NoteOverviewLayer({
  noteId,
  projections,
  edges,
  onContinue,
  onOpenNote,
}: {
  readonly noteId: string;
  readonly projections: readonly UnderstandingNodeProjectionV3[];
  readonly edges: readonly UnderstandingEdgeProjectionV3[];
  readonly onContinue: () => void;
  readonly onOpenNote: () => void;
}) {
  const note = projections.find((node) => isNoteNode(node) && node.nodeRef.noteId === noteId);
  const objectives = useMemo(() => {
    const keys = new Set(
      edges
        .filter((edge) => edge.kind === "sourced_from" && edge.from.kind === "note" && edge.from.id === noteId)
        .map((edge) => `${edge.to.kind}:${edge.to.id}`),
    );
    return projections.filter(
      (node): node is ObjectiveNode =>
        isObjectiveNode(node) && keys.has(`objective:${node.nodeRef.objectiveId}`),
    );
  }, [edges, noteId, projections]);
  const openRun = objectives.find((objective) => objective.personal.activeRunId !== null) ?? null;
  const due = objectives.find((objective) => objective.personal.state === "due_review") ?? null;

  return (
    <>
      <section>
        <h2 className="universe-detail-title">{note ? graphNodeLabel(note) : "这一篇笔记"}</h2>
        <p className="universe-detail-description">
          {note ? graphNodeSummary(note) : ""}
        </p>
      </section>
      <dl className="universe-detail-timing">
        <div><dt>已形成的目标</dt><dd>{objectives.length} 个</dd></div>
        <div><dt>未完的一轮</dt><dd>{openRun ? "有一轮" : "没有"}</dd></div>
        <div><dt>该回访的</dt><dd>{due ? graphObjectiveStateLabel(due.personal.state) : "暂时没有"}</dd></div>
      </dl>
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>从这一篇继续</span>
          <small>正文和这一轮学习在同一篇里</small>
        </div>
        <button type="button" className="universe-locals__act" onClick={openRun ? onContinue : onOpenNote}>
          {openRun ? <Play size={14} /> : <BookOpenText size={14} />}
          <span><strong>{openRun ? "回笔记继续学习" : "打开这一篇笔记"}</strong><small>正文、材料与本轮学习都在那儿</small></span>
          <ArrowRight size={14} />
        </button>
        {objectives.length === 0 ? (
          // §11.2「有正文的笔记无需制卡即可出现」：没有目标时**说清楚**是"还没有
          // 形成目标"，而不是画一句"知识宇宙正在生成"。
          <p className="universe-layer-empty">这一篇还没有形成任何目标——正文在就行，不需要先制卡。</p>
        ) : null}
      </section>
    </>
  );
}

/**
 * 层二：笔记局部（§11.2 第二行「核心问题／已形成的目标／必要前置和明确关系／
 * 当前缺口」；动作：查看关系理由、打开某个学习位置、查看相关记录）。
 */
function NoteLocalLayer({
  deepening,
  onOpenLearningPosition,
  onOpenCard,
}: {
  readonly deepening: NoteDeepeningV3;
  readonly onOpenLearningPosition: () => void;
  readonly onOpenCard: (objectiveId: string) => void;
}) {
  const { local } = deepening;
  return (
    <>
      <NoteStateAxes deepening={deepening} />
      {local.openDrivingQuestion ? (
        <section className="universe-locals">
          <div className="universe-detail-section-title"><span>这一轮的问题</span><small>未完的那一轮</small></div>
          <p className="universe-question">{local.openDrivingQuestion}</p>
        </section>
      ) : null}
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>核心问题与已形成的目标</span>
          <small>{local.coreQuestions.length} 个</small>
        </div>
        {local.objectives.length === 0 ? (
          <p className="universe-layer-empty">还没有形成任何目标，这里不替你编一条。</p>
        ) : (
          <ul className="universe-locals__list">
            {local.objectives.map((objective) => (
              <li key={objective.objectiveId} className="universe-locals__item">
                <button type="button" onClick={onOpenLearningPosition}>
                  <strong>{objective.label}</strong>
                  <small>{objective.summary}</small>
                </button>
                <span className="universe-locals__tags">
                  <em>{graphObjectiveStateLabel(objective.state)}</em>
                  {objective.runId ? <em className="universe-locals__tag--run">有一轮没走完</em> : null}
                  {objective.cardId ? (
                    <button type="button" className="universe-locals__card" onClick={() => onOpenCard(objective.objectiveId)}>
                      打开对应卡片
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="universe-locals">
        {/* §11.3 + §11.2「查看关系理由」：理由与关系在同一行。拆成两张表，
            屏上就得自己拼，而拼不上的那一行会变成一条没有理由的实线。 */}
        <div className="universe-detail-section-title">
          <span>必要前置与明确关系</span>
          <small>{local.relations.length ? "每条都写清为什么被推出来" : "这一篇还没有可核对的关系"}</small>
        </div>
        {local.relations.length === 0 ? (
          <p className="universe-layer-empty">没有可核对的关系。这里不替你推断——没有学习记录时不伪造关系。</p>
        ) : (
          <ul className="universe-locals__list">
            {local.relations.map((relation) => (
              <li key={relation.edgeId} className="universe-locals__item universe-locals__item--relation">
                <div>
                  <strong>{relation.otherLabel}</strong>
                  <small>{RELATION_REASON_LABEL[relation.relation] ?? relation.relation}</small>
                </div>
                <span className="universe-locals__tags">
                  <em className={`is-${relation.status}`}>{RELATION_STATUS_LABEL[relation.status]}</em>
                  {relation.reasonCodes.length ? (
                    <small className="universe-relation-reason">
                      理由：{relation.reasonCodes.map((code) => RELATION_REASON_LABEL[code] ?? code).join("、")}
                    </small>
                  ) : (
                    <small className="universe-relation-reason">系统没有给出理由。</small>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>当前缺口</span>
          <small>{local.gaps.length ? "哪一个目标卡在哪一档" : "暂时没有缺口"}</small>
        </div>
        {local.gaps.length === 0 ? (
          <p className="universe-layer-empty">没有列出来的缺口。</p>
        ) : (
          // §11.4「没有单一'整篇掌握亮度'」在层二的具体形状：列出来的是
          // **哪一个**目标卡在哪一档，不是一句整体百分比。
          <ul className="universe-locals__list">
            {local.gaps.map((gap) => (
              <li key={gap.objectiveId} className="universe-locals__item is-gap">
                <button type="button" onClick={onOpenLearningPosition}>
                  <strong>{gap.label}</strong>
                  <small>建议补学</small>
                </button>
                <span className="universe-locals__tags"><em className="is-gap">{graphObjectiveStateLabel(gap.state)}</em></span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * 层三：证据详情（§11.2 第三行「真实回答／反馈／日期／材料依据／可选卡片」；
 * 动作：回看、进入笔记旅程、打开相应卡片）。
 */
function NoteRecordLayer({
  deepening,
  onOpenNote,
  onOpenCard,
}: {
  readonly deepening: NoteDeepeningV3;
  readonly onOpenNote: () => void;
  readonly onOpenCard: (objectiveId: string) => void;
}) {
  return (
    <>
      <NoteStateAxes deepening={deepening} />
      <section className="universe-locals">
        <div className="universe-detail-section-title">
          <span>真实学习记录</span>
          <small>
            {deepening.recordsComplete
              ? `${deepening.records.length} 条，全部在这里`
              : `只列到这里 ${deepening.records.length} 条，更早的还在服务器上`}
          </small>
        </div>
        {deepening.records.length === 0 ? (
          <p className="universe-layer-empty">这一篇还没有学习记录。这里不替你造一条示例。</p>
        ) : (
          <ol className="universe-records">
            {deepening.records.map((record) => (
              <li key={record.recordId} className="universe-record">
                <header>
                  <time dateTime={record.occurredAt}>{formatDeepeningDate(record.occurredAt)}</time>
                  <span>{record.objectiveLabel ?? "这一步没有挂到具体目标上"}</span>
                </header>
                {/* 「原回答」。结构化作答那一格是空的——屏上就写清楚"这一步不是一句
                    可复述的回答"，不替她造一句。 */}
                {record.answerText ? (
                  <blockquote className="universe-record__answer">{record.answerText}</blockquote>
                ) : (
                  <p className="universe-record__answer is-empty">
                    {record.answerForm === "structured" ? "这一步是结构化作答，没有一句可念的回答。" : "这一次没有留下可念的回答。"}
                  </p>
                )}
                {record.feedback.length ? (
                  <ul className="universe-record__feedback">
                    {record.feedback.map((item, index) => (
                      <li key={`${record.recordId}-fb-${index}`}>
                        <em>{FEEDBACK_VERDICT_LABEL[item.verdict]}</em>
                        <span>{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="universe-record__answer is-empty">这一次没有留下可展示的反馈。</p>
                )}
                {record.materialBasis.length ? (
                  <div className="universe-record__material">
                    <span>材料依据</span>
                    {record.materialBasis.map((material) => (
                      <small key={material.evidenceSnapshotId}>{material.supportSummary}</small>
                    ))}
                  </div>
                ) : (
                  <div className="universe-record__material">
                    <span>材料依据</span>
                    <small>这一条没有挂材料。</small>
                  </div>
                )}
                <footer>
                  {/* 「可选卡片」——§11.2 末段：卡片是目标详情里的一条记忆工具
                      链接，不为同一目标再画一颗星。 */}
                  {record.cardId && record.objectiveId ? (
                    <button type="button" onClick={() => onOpenCard(record.objectiveId!)}>打开对应卡片</button>
                  ) : null}
                  <button type="button" onClick={onOpenNote}>进入笔记旅程</button>
                </footer>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

const FEEDBACK_VERDICT_LABEL: Readonly<Record<NoteDeepeningV3["records"][number]["feedback"][number]["verdict"], string>> = {
  covered: "讲到了",
  partial: "讲了一半",
  missing: "没讲到",
  contradicted: "与材料相反",
  not_assessable: "判不了",
};

/** 「日期」按本地日历念；解析不了就**原样交出**那一串 ISO，不显示 Invalid Date。 */
function formatDeepeningDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

import type { DeepeningLayer, StateFilter } from "./graph-surface-types";
import { useGraphControls } from "./use-graph-controls";
import { useGraphRelationStamps } from "./use-graph-relation-stamps";