import type { CompanionMemoryKindV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { Archive,Map,RotateCcw } from "lucide-react";
import { Activity,useEffect,useRef,useState } from "react";
import { CompanionMethodsPage } from "./companion-methods-page";
import { CompanionLongGoalsPage } from "./companion-long-goals-page";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { SectionState } from "./companion-center-primitives";
import { CompanionMemoryMaintenance } from "./companion-memory-maintenance";
import { CompanionMemoryMap } from "./companion-memory-map";
import { MemoryPanel,type MemoryStateFilter } from "./companion-memory-panel";
import type { CooperationScope } from "./companion-memory-rule-fields";
import { MEMORY_SCOPE_LABEL } from "./companion-center-model";
import { publishCompanionRecordsChanged,useCompanionRecordsRefresh,useCompanionResource } from "./use-companion-resource";

type MemoryPageProps = { refreshKey: number; requestedMemoryId: string | null; onFocusConsumed: () => void;
  requestedMethodId?: string | null; onMethodFocusConsumed?: () => void };
export function CompanionMemoryPage(props: MemoryPageProps) {
  const [view,setView] = useState<"all" | "cooperation" | "methods" | "goals">("all");
  useEffect(() => { if (props.requestedMemoryId) setView("all"); },[props.requestedMemoryId]);
  useEffect(() => { if (props.requestedMethodId) setView("methods"); },[props.requestedMethodId]);
  return <>
    <div className="cc-segments cc-memory-views" role="group" aria-label="记忆视图">
      <button type="button" aria-pressed={view==="all"} onClick={()=>setView("all")}>全部记忆</button>
      <button type="button" aria-pressed={view==="cooperation"} onClick={()=>setView("cooperation")}>合作方式</button>
      <button type="button" aria-pressed={view==="methods"} onClick={()=>setView("methods")}>我们的方法</button>
      <button type="button" aria-pressed={view==="goals"} onClick={()=>setView("goals")}>长期目标</button>
    </div>
    <Activity mode={view==="methods" ? "visible" : "hidden"}><CompanionMethodsPage refreshKey={props.refreshKey} requestedId={props.requestedMethodId} onFocusConsumed={props.onMethodFocusConsumed} /></Activity>
    <Activity mode={view==="goals" ? "visible" : "hidden"}><CompanionLongGoalsPage refreshKey={props.refreshKey} onMemory={id=>{useRoomStore.getState().setCompanionCenterTarget({tab:"memory",focusMemoryId:id});setView("all");}} /></Activity>
    <Activity mode={view==="all" || view==="cooperation" ? "visible" : "hidden"}><CompanionMemoryRecordsPage {...props} cooperation={view==="cooperation"} onViewMemory={()=>setView("all")} /></Activity>
  </>;
}
function CompanionMemoryRecordsPage({ refreshKey, requestedMemoryId, onFocusConsumed, cooperation, onViewMemory }: MemoryPageProps & { cooperation: boolean; onViewMemory: () => void }) {
  const [anchorId, setAnchorId] = useState(requestedMemoryId);
  const resource = useCompanionResource(async meta => {
    const result = await window.astella.companion.memory.list({ meta, query: { includeCandidates: true, includeArchived: true, ...(anchorId ? { focusMemoryId: anchorId } : {}) } });
    return result.ok ? { ...result, data: { ...result.data, focusId: anchorId } } : result;
  }, [refreshKey, anchorId]);
  useCompanionRecordsRefresh(resource.reload);
  const [selectedId, setSelectedId] = useState<string | null>(requestedMemoryId);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | CompanionMemoryKindV1>("all");
  const [filter, setFilter] = useState<MemoryStateFilter>("all");
  useEffect(() => { setKind(cooperation ? "preference" : "all"); setFilter("all"); setQuery(""); if (cooperation) setCreateKind("preference"); },[cooperation]);
  const [mapOpen, setMapOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createContent, setCreateContent] = useState("");
  const [createKind, setCreateKind] = useState<CompanionMemoryKindV1>("preference");
  const [createScope, setCreateScope] = useState<CooperationScope>("workspace");
  const [createAppliesWhen, setCreateAppliesWhen] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionContent, setCorrectionContent] = useState("");
  const [correctionAppliesWhen, setCorrectionAppliesWhen] = useState("");
  const [correctionBase, setCorrectionBase] = useState<{ id: string; revision: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [lastDeleted, setLastDeleted] = useState<{ id: string; content: string } | null>(null);
  const items = resource.section?.ok ? resource.section.value.items : [];
  const selected = items.find(item => item.memoryItemId === selectedId) ?? null;
  const selectionRef = useRef(selectedId); selectionRef.current = selectedId;
  const revisions = useCompanionResource(meta => window.astella.companion.memory.revisions({ meta, memoryId: selectedId! }), [selectedId, selected?.revision, refreshKey], selectedId !== null);
  useEffect(() => {
    if (!requestedMemoryId) return;
    setAnchorId(requestedMemoryId);
    setSelectedId(requestedMemoryId); setQuery(""); setKind("all"); setFilter("all"); onViewMemory(); setMapOpen(false); setMaintenanceOpen(false);
  }, [requestedMemoryId]);
  useEffect(() => {
    if (!requestedMemoryId || !resource.section || resource.loading) return;
    if (resource.section.ok && resource.section.value.focusId !== requestedMemoryId) return;
    if (resource.section.ok && !items.some(item => item.memoryItemId === requestedMemoryId)) setNotice("这条记忆已不在列表里，可以到回收区查找。");
    onFocusConsumed();
  }, [requestedMemoryId, resource.section, resource.loading, onFocusConsumed]);
  useEffect(() => {
    setCorrectionOpen(false); setCorrectionContent(selected?.content ?? ""); setCorrectionAppliesWhen(selected?.appliesWhen ?? "");
    setCorrectionBase(null); setConfirmDelete(false); setConfirmErase(false);
  }, [selectedId]);
  const write = async (key: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(key); setError(null); setNotice(null);
    try { await action(); publishCompanionRecordsChanged(); }
    catch (failure) { setError(gatewayErrorMessage(failure)); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const memoryAction = (action: "confirm" | "pin" | "unpin" | "archive" | "restore" | "dismiss" | "remove" | "erase") => {
    if (!selected) return;
    const item = selected;
    void write(action, async () => {
      unwrapGatewayResult(await window.astella.companion.memory[action]({ meta: resource.meta(), memoryId: item.memoryItemId }));
      setConfirmDelete(false); setConfirmErase(false);
      if (action === "remove") { setLastDeleted({ id: item.memoryItemId, content: item.content }); setNotice("已移入回收区，30 天内可撤回删除。"); }
      else if (action === "erase") setNotice("这条记忆及其版本已彻底清除。");
      await resource.reload({ silent: true });
    });
  };
  const openMemory = (id: string) => {
    setAnchorId(id); setSelectedId(id); setQuery(""); setKind("all"); setFilter("all"); onViewMemory();
    setMapOpen(false); setMaintenanceOpen(false);
  };
  const create = () => void write("create", async () => {
    const content = createContent.trim();
    if (!content) return;
    const created = unwrapGatewayResult(await window.astella.companion.memory.create({ meta: resource.meta(),
      request: { kind: createKind, content, scope: createKind === "preference" ? createScope : "workspace", appliesWhen: createAppliesWhen.trim() || null } }));
    setSelectedId(created.memoryItemId); setCreateContent(""); setCreateAppliesWhen(""); setCreateScope("workspace"); setCreateOpen(false);
    setQuery(""); setKind(cooperation && created.kind === "preference" ? "preference" : "all"); setFilter("all");
    if (created.kind !== "preference") onViewMemory();
    setNotice(`已保存，适用于${MEMORY_SCOPE_LABEL[created.scope]}。`);
    await resource.reload({ silent: true });
  });
  const correct = () => {
    if (!selected || correctionBase?.id !== selected.memoryItemId || !correctionContent.trim()) return;
    const item = selected, base = correctionBase;
    const content = correctionContent.trim(), appliesWhen = correctionAppliesWhen.trim() || null;
    void write("correct", async () => {
      const corrected = unwrapGatewayResult(await window.astella.companion.memory.correct({ meta: resource.meta(), memoryId: item.memoryItemId,
        request: { content, appliesWhen, expectedRevision: base.revision } }));
      if (selectionRef.current === item.memoryItemId) {
        setCorrectionOpen(false);
        setNotice(`已修订为第 ${corrected.revision} 版，适用于${MEMORY_SCOPE_LABEL[corrected.scope]}；原来源和旧版本保留。`);
      }
      await resource.reload({ silent: true });
    });
  };
  if (!resource.section) return <SectionState message={resource.failure ? "记忆暂时读不到" : "正在读取记忆…"} detail={resource.failure ?? undefined} onRetry={resource.failure ? () => void resource.reload() : undefined} />;
  const pendingFocus = requestedMemoryId ?? anchorId;
  if (pendingFocus && resource.section.ok && resource.section.value.focusId !== pendingFocus) return <SectionState message="正在定位这条记忆…" />;
  if (maintenanceOpen) return <CompanionMemoryMaintenance refreshKey={refreshKey} onBack={() => setMaintenanceOpen(false)} onRestore={id => { openMemory(id); setLastDeleted(null); setNotice("这条记忆已恢复。"); void resource.reload({ silent: true }); }} />;
  if (mapOpen) return <CompanionMemoryMap refreshKey={refreshKey} memories={items} onBack={() => setMapOpen(false)} onMemory={openMemory} />;
  return <>
    <div className="cc-page-tools cc-memory-page-tools"><div className="cc-actions"><button type="button" className="cc-link" onClick={() => setMapOpen(true)}><Map size={15} aria-hidden="true" />关联星图</button><button type="button" className="cc-link" onClick={() => setMaintenanceOpen(true)}><Archive size={15} aria-hidden="true" />整理与回收</button></div></div>
    {lastDeleted ? <div className="cc-undo" role="status"><span>已删除：{lastDeleted.content}</span><button type="button" className="cc-link" disabled={busy !== null} onClick={() => void write("undo", async () => { unwrapGatewayResult(await window.astella.companion.memory.restoreDeleted({ meta: resource.meta(), memoryId: lastDeleted.id })); openMemory(lastDeleted.id); setLastDeleted(null); setNotice("这条记忆已恢复。"); await resource.reload({ silent: true }); })}><RotateCcw size={14} />撤回删除</button></div> : null}
    <MemoryPanel section={resource.section} items={items} focus={selected} revisions={selectedId && revisions.section?.ok && revisions.section.value.memoryItemId === selectedId ? revisions.section.value.items : null} revisionsError={selectedId && revisions.section && !revisions.section.ok && !revisions.loading ? revisions.section.message : null} onRetryRevisions={() => void revisions.reload()}
      query={query} kind={kind} pinFilter={filter} busy={busy} error={error} notice={notice} confirmDelete={confirmDelete} confirmErase={confirmErase}
      createOpen={createOpen} createContent={createContent} createKind={createKind} correctionOpen={correctionOpen} correctionContent={correctionContent} cooperation={cooperation}
      ruleEditor={{ create: { disabled: busy !== null, appliesWhen: createAppliesWhen, onAppliesWhen: setCreateAppliesWhen,
        scope: { value: createScope, onChange: setCreateScope, allowGlobal: createKind === "preference" } },
        correction: { disabled: busy !== null, appliesWhen: correctionAppliesWhen, onAppliesWhen: setCorrectionAppliesWhen } }}
      onQuery={setQuery} onKind={setKind} onPinFilter={setFilter} onFocus={setSelectedId} onAction={memoryAction} onConfirmDelete={setConfirmDelete} onConfirmErase={setConfirmErase}
      onCreateOpen={open => { setCreateOpen(open); setError(null); setNotice(null); }} onCreateContent={setCreateContent} onCreateKind={value => { setCreateKind(value); if (value !== "preference") setCreateScope("workspace"); }}
      onCorrectionOpen={open => { if (open && selected) { setCorrectionContent(selected.content); setCorrectionAppliesWhen(selected.appliesWhen ?? ""); setCorrectionBase({ id: selected.memoryItemId, revision: selected.revision }); } setCorrectionOpen(open); }} onCorrectionContent={setCorrectionContent}
      onCreate={create} onCorrect={correct}
      onSummarize={() => void write("summarize", async () => { unwrapGatewayResult(await window.astella.companion.memory.summarizeRecent({ meta: resource.meta() })); setNotice("已开始整理近期对话；整理后的记忆会更新到这里。"); })} onRetry={() => void resource.reload()} />
  </>;
}
