import type { CompanionMemoryItemV1,CompanionMemoryKindV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { ArrowLeft,ExternalLink } from "lucide-react";
import { useMemo,useRef,useState } from "react";
import { useRoomStore } from "../../../app/room-store";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { UnderstandingUniverse,type UnderstandingUniverseHandle } from "../space/understanding-universe";
import { MEMORY_KIND_OPTIONS,MEMORY_STATE_LABEL } from "./companion-center-model";
import { CenterSearch,SectionState } from "./companion-center-primitives";
import { buildCompanionMemoryUniverse,routeForMemoryEntityTarget } from "./companion-memory-universe";
import { CompanionSelect } from "./companion-select";
import { useCompanionResource } from "./use-companion-resource";

export function CompanionMemoryMap({ refreshKey, memories, onBack, onMemory }: { refreshKey: number; memories: CompanionMemoryItemV1[]; onBack: () => void; onMemory: (id: string) => void }) {
  const resource = useCompanionResource(meta => window.ailearn.companion.memory.starMap({ meta }), [refreshKey]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | CompanionMemoryKindV1>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const universeRef = useRef<UnderstandingUniverseHandle | null>(null);
  const universe = useMemo(() => buildCompanionMemoryUniverse(resource.section?.ok ? resource.section.value : null, memories), [resource.section, memories]);
  const graph = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matchingEntities = new Set(universe.graph.nodes.filter(node => node.metadata.visualRole !== "memory" && needle && `${node.label} ${node.description ?? ""}`.toLowerCase().includes(needle)).map(node => node.id));
    const relatedMemoryIds = new Set(universe.graph.edges.filter(edge => matchingEntities.has(edge.from) || matchingEntities.has(edge.to)).flatMap(edge => [edge.from, edge.to]));
    const memoryIds = new Set(universe.graph.nodes.filter(node => node.metadata.visualRole === "memory" && (kind === "all" || node.metadata.memoryKind === kind) && (!needle || relatedMemoryIds.has(node.id) || `${node.label} ${node.description ?? ""}`.toLowerCase().includes(needle))).map(node => node.id));
    const edges = universe.graph.edges.filter(edge => memoryIds.has(edge.from) || memoryIds.has(edge.to));
    const ids = new Set([...memoryIds, ...edges.flatMap(edge => [edge.from, edge.to])]);
    return { nodes: universe.graph.nodes.filter(node => ids.has(node.id)), edges };
  }, [universe.graph, query, kind]);
  const selected = graph.nodes.find(node => node.id === selectedId) ?? null;
  const emptyMessage = universe.graph.nodes.length ? "当前筛选下没有节点" : "还没有可探索的记忆";
  const emptyDetail = universe.graph.nodes.length ? "调整搜索或筛选条件即可继续探索。" : "确认后的记忆会出现在这里，可以先返回记忆页添加或确认一条。";
  usePageReadableView(useMemo(() => ({ pageId: "companion" as const, title: "伴星中心", statusLine: resource.section?.ok ? graph.nodes.length ? `${graph.nodes.length} 个节点 · ${graph.edges.length} 条关系` : emptyMessage : resource.loading ? "正在读取记忆星图" : "记忆星图当前不可用", filters: [{ label: "记忆类型", value: kind === "all" ? "全部类型" : MEMORY_KIND_OPTIONS.find(option => option.value === kind)!.label }, ...(query ? [{ label: "关键词", value: query.slice(0, 40) }] : [])], ...(resource.section?.ok ? { items: graph.nodes.slice(0, 12).map((node, index) => ({ ordinal: index + 1, label: node.label.slice(0, 120) })) } : {}) }), [resource.section, resource.loading, graph, kind, query, emptyMessage]));
  const openEntity = () => {
    if (!selected) return;
    const target = universe.targetsByNode.get(selected.id); if (!target) return;
    const route = routeForMemoryEntityTarget(target); const room = useRoomStore.getState();
    if (route.kind === "note.detail") { room.setActiveNoteRef({ noteId: route.noteId, noteVersionId: null, mode: "preview" }); room.invoke("open-notebook"); }
    if (route.kind === "source.detail") { room.setActiveSourceId(route.sourceId); room.invoke("open-source"); }
    if (route.kind === "objective.detail") { room.setActiveObjectiveId(route.objectiveId); room.invoke("open-objective"); }
    if (route.kind === "learningRun.detail") { room.setActiveRunId(route.runId); room.invoke("validate"); }
  };
  return <div className="cc-map"><div className="cc-page-tools"><button type="button" className="cc-link" onClick={onBack}><ArrowLeft size={15} />返回记忆列表</button><span>记忆关联星图</span></div><div className="cc-toolbar"><CenterSearch value={query} onChange={setQuery} placeholder="搜索记忆…" label="搜索记忆或关联内容" /><CompanionSelect paper ariaLabel="筛选星图记忆类型" value={kind} options={[{ value: "all", label: "全部类型" }, ...MEMORY_KIND_OPTIONS]} onChange={setKind} /></div>
    {!resource.section ? <SectionState message={resource.failure ? "记忆星图当前不可用" : "正在读取记忆星图"} detail={resource.failure ?? undefined} onRetry={resource.failure ? () => void resource.reload() : undefined} /> : !resource.section.ok ? <SectionState message="记忆星图当前不可用" detail={resource.section.message} onRetry={() => void resource.reload()} /> : !graph.nodes.length ? <SectionState message={emptyMessage} detail={emptyDetail} /> : <div className="cc-map__workspace"><div className="cc-map__canvas"><UnderstandingUniverse ref={universeRef} nodes={graph.nodes} edges={graph.edges} positions={universe.layout.positions} selectedId={selectedId} onSelect={setSelectedId} insets={{ top: 42, bottom: 55, left: 75, right: 75 }} title="记忆关联星图" summaryLabel="记忆与学习实体节点" typeLabels={{ source: "来源", note: "笔记", card: "记忆", key_point: "学习实体" }} stateLabels={MEMORY_STATE_LABEL} staticMotion labelPolicy="pinned" offsetStorageKey="companion-memory-universe:v2" className="companion-memory-universe" /></div>
      <aside className="cc-map__index" aria-label="星图节点列表"><h3>节点索引</h3><p>{graph.nodes.length} 个节点 · {graph.edges.length} 条关系</p><div>{graph.nodes.map(node => <button type="button" key={node.id} aria-pressed={selectedId === node.id} onClick={() => { setSelectedId(node.id); universeRef.current?.focusNode(node.id); }}><span>{node.metadata.visualRole === "memory" ? "记忆" : "学习内容"}</span>{node.label}</button>)}</div>{selected ? <section className="cc-map__selected"><strong>{selected.label}</strong>{universe.memoryIdsByNode.has(selected.id) ? <button type="button" className="cc-link" onClick={() => onMemory(universe.memoryIdsByNode.get(selected.id)!)}>查看这条记忆</button> : universe.targetsByNode.has(selected.id) ? <button type="button" className="cc-link" onClick={openEntity}>打开内容<ExternalLink size={14} /></button> : <p>关联已失效，不能打开。</p>}</section> : null}</aside></div>}
  </div>;
}
