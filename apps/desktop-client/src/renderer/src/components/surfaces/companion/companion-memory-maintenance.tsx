import type { CompanionMemoryItemV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { ArrowLeft,RotateCcw } from "lucide-react";
import { useEffect,useRef,useState } from "react";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatDate } from "../notebook/surface-data";
import { MEMORY_KIND_LABEL } from "./companion-center-model";
import { CenterFeedback,SectionState } from "./companion-center-primitives";
import { publishCompanionRecordsChanged,useCompanionResource } from "./use-companion-resource";

export function CompanionMemoryMaintenance(props: { refreshKey: number; onBack: () => void; onRestore: (id: string) => void }) {
  const [mode, setMode] = useState<"recycle" | "conflicts">("recycle");
  const recycle = useCompanionResource(meta => window.astella.companion.memory.recycleList({ meta }), [props.refreshKey], mode === "recycle");
  const conflicts = useCompanionResource(meta => window.astella.companion.memory.conflicts({ meta }), [props.refreshKey], mode === "conflicts");
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [eraseId, setEraseId] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const eraseTriggers = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { if (eraseId) cancelRef.current?.focus(); }, [eraseId]);
  const closeErase = () => { if (eraseId) eraseTriggers.current.get(eraseId)?.focus(); setEraseId(null); };
  const recycled = recycle.section?.ok ? recycle.section.value.items : [];
  const groups = conflicts.section?.ok ? Object.values(conflicts.section.value.items.reduce<Record<string, CompanionMemoryItemV1[]>>((result, item) => {
    if (item.conflictGroup) (result[item.conflictGroup] ??= []).push(item); return result;
  }, {})).filter(group => group.length > 1) : [];
  usePageReadableView({ pageId: "companion", title: "伴星中心", statusLine: mode === "recycle" ? "记忆回收区" : "检查记忆冲突",
    ...(error || notice ? { notice: (error ?? notice)!.slice(0, 160) } : {}),
    items: (mode === "recycle" ? recycled : groups.flat()).slice(0, 12).map((item, index) => ({ ordinal: index + 1, label: item.content.slice(0, 120), state: mode === "recycle" ? "已删除" : "待核对" })) });
  const write = async (key: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(key); setError(null); setNotice(null);
    try { await action(); publishCompanionRecordsChanged(); }
    catch (cause) { setError(gatewayErrorMessage(cause)); }
    finally { lock.current = false; setBusy(null); }
  };
  const keep = (group: CompanionMemoryItemV1[], item: CompanionMemoryItemV1) => void write(item.memoryItemId, async () => {
    try {
      for (const other of group) if (other.memoryItemId !== item.memoryItemId) unwrapGatewayResult(await window.astella.companion.memory.resolveConflict({ meta: conflicts.meta(), memoryId: item.memoryItemId, removeId: other.memoryItemId }));
      setNotice("已保留这条记忆，其余冲突条目进入回收区。");
    } finally { await conflicts.reload({ silent: true }); }
  });
  return <div className="cc-maintenance" onKeyDown={event => { if (event.key === "Escape" && eraseId && busy === null) { event.preventDefault(); event.stopPropagation(); closeErase(); } }}><div className="cc-page-tools"><button type="button" className="cc-link" onClick={props.onBack}><ArrowLeft size={15} />返回记忆列表</button><strong>整理与回收</strong></div>
    <div className="cc-segments" role="group" aria-label="记忆管理分区"><button type="button" aria-pressed={mode === "recycle"} onClick={() => setMode("recycle")}>回收区</button><button type="button" aria-pressed={mode === "conflicts"} onClick={() => setMode("conflicts")}>检查冲突</button></div>
    <CenterFeedback error={error} notice={notice} />
    {mode === "recycle" ? <><p className="cc-muted">删除后的记忆会留在这里 30 天。恢复后她会重新使用它，彻底清除会同时删除旧版本。</p>
      {!recycle.section ? <SectionState message={recycle.loading ? "正在读取回收区" : "回收区暂时读不到"} detail={recycle.failure ?? undefined} /> : !recycle.section.ok ? <SectionState message="回收区暂时读不到" detail={recycle.section.message} onRetry={() => void recycle.reload()} /> : !recycled.length ? <SectionState message="回收区是空的" detail="删除的记忆会暂时保留在这里。" /> : <div className="cc-recycle-list">{recycled.map(item => <article key={item.id}><span className="cc-kicker">{MEMORY_KIND_LABEL[item.kind]} · 删除于 {formatDate(item.deletedAt)}</span><p>{item.content}</p><small>保留至 {formatDate(item.purgeAfter)}</small><div className="cc-actions"><button type="button" className="cc-link" disabled={busy !== null} onClick={() => void write(item.id, async () => { unwrapGatewayResult(await window.astella.companion.memory.restoreDeleted({ meta: recycle.meta(), memoryId: item.id })); props.onRestore(item.id); })}><RotateCcw size={14} />恢复这条记忆</button><button ref={element => { if (element) eraseTriggers.current.set(item.id, element); else eraseTriggers.current.delete(item.id); }} type="button" className="cc-link is-danger" aria-expanded={eraseId === item.id} disabled={busy !== null} onClick={() => setEraseId(eraseId === item.id ? null : item.id)}>彻底清除</button></div>{eraseId === item.id ? <div className="cc-confirm"><p>这条记忆与全部旧版本会永久删除，无法恢复。</p><div className="cc-actions"><button type="button" className="cc-button is-danger" disabled={busy !== null} onClick={() => void write(item.id, async () => { unwrapGatewayResult(await window.astella.companion.memory.erase({ meta: recycle.meta(), memoryId: item.id })); setEraseId(null); setNotice("已彻底清除这条记忆。"); await recycle.reload({ silent: true }); })}>确认彻底清除</button><button ref={cancelRef} type="button" className="cc-link" disabled={busy !== null} onClick={closeErase}>取消</button></div></div> : null}</article>)}</div>}
    </> : <><p className="cc-muted">核对表达同一件事、内容却不一致的记忆，选择每组要保留的一条。</p>
      {!conflicts.section ? <SectionState message={conflicts.loading ? "正在检查记忆冲突" : "冲突暂时读不到"} detail={conflicts.failure ?? undefined} /> : !conflicts.section.ok ? <SectionState message="冲突暂时读不到" detail={conflicts.section.message} onRetry={() => void conflicts.reload()} /> : !groups.length ? <SectionState message="没有待核对的冲突" /> : groups.map((group, index) => <section className="cc-conflict-group" key={group[0].conflictGroup}><h3>第 {index + 1} 组 · 选择要保留的记忆</h3>{group.map(item => <button type="button" key={item.memoryItemId} disabled={busy !== null} onClick={() => keep(group, item)}><span>{item.content}</span><small>保留此条</small></button>)}</section>)}
      <details className="cc-details"><summary>记忆查找出了问题？</summary><p>可以重新整理检索索引。这个操作不会改动记忆正文。</p><button type="button" className="cc-link" disabled={busy !== null} onClick={() => void write("rebuild", async () => { unwrapGatewayResult(await window.astella.companion.memory.rebuildEmbeddings({ meta: conflicts.meta() })); setNotice("已开始整理记忆检索索引。"); })}>整理记忆检索索引</button></details>
    </>}
  </div>;
}
