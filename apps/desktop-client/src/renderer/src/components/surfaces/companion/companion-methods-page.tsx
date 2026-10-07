import { useEffect, useRef, useState } from "react";
import type { AgentMethodV1 } from "@astella/shared/agent-growth-contracts";
import { gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import { CenterFeedback, CenterSearch, SectionState } from "./companion-center-primitives";
import { publishCompanionRecordsChanged, useCompanionRecordsRefresh, useCompanionResource } from "./use-companion-resource";

const stateLabels: Record<AgentMethodV1["availability"],string> = {
  available:"已采用", pending:"等待确认", disabled:"暂时停用", source_changed:"依据需核对",
  capability_changed:"做法需复验", previous_version:"以前的版本",
};
type Draft = { methodId:string; revision:number; title:string; appliesWhen:string; steps:string; exceptions:string; reason:string };
const lines = (value:string) => value.split("\n").map(line=>line.trim()).filter(Boolean);

/** The paper owns full methods; the companion bubble only points here. */
export function CompanionMethodsPage({refreshKey,requestedId,onFocusConsumed}:{refreshKey:number;requestedId?:string|null;onFocusConsumed?:()=>void}) {
  const scope=useRoomStore(state=>state.workspaceScopeRevision);
  const resource=useCompanionResource(meta=>window.astella.agent.listMethods({meta}),[refreshKey,scope]);
  useCompanionRecordsRefresh(resource.reload);
  const [selectedId,setSelectedId]=useState<string|null>(null), [query,setQuery]=useState("");
  const [draft,setDraft]=useState<Draft|null>(null), [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null), [notice,setNotice]=useState<string|null>(null);
  const generation=useRef(0), writing=useRef(false);
  useEffect(()=>{ generation.current++; writing.current=false; setBusy(false); setSelectedId(null); setDraft(null); setQuery(""); setError(null); setNotice(null); },[scope]);
  const items=resource.section?.ok ? resource.section.value.items : [];
  const selected=items.find(method=>method.methodId===selectedId) ?? null;
  useEffect(()=>{ if(requestedId) {setSelectedId(requestedId);setQuery("");} },[requestedId]);
  useEffect(()=>{
    if(!requestedId || !resource.section?.ok || resource.loading) return;
    if(!items.some(method=>method.methodId===requestedId)) setNotice("这条方法现在不在清单里，请核对空间与来源。");
    onFocusConsumed?.();
  },[requestedId,resource.section,resource.loading,onFocusConsumed]);
  const history=useCompanionResource(async meta=>{
    const result=await window.astella.agent.getMethodHistory({meta,methodId:selectedId!});
    return result.ok ? {...result,data:{...result.data,methodId:selectedId}} : result;
  },[selectedId,selected?.revision,refreshKey,scope],selectedId!==null);
  const uses=useCompanionResource(async meta=>{
    const result=await window.astella.agent.getMethodUses({meta,methodId:selectedId!});
    return result.ok ? {...result,data:{...result.data,methodId:selectedId}} : result;
  },[selectedId,selected?.revision,refreshKey,scope],selectedId!==null);
  const write=async(action:()=>Promise<unknown>,success:string)=>{
    if(writing.current) return;
    const current=generation.current;
    writing.current=true; setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      if(current!==generation.current || useRoomStore.getState().workspaceScopeRevision!==scope) return;
      setNotice(success); publishCompanionRecordsChanged();
      await resource.reload({silent:true}); await uses.reload({silent:true});
    } catch(failure) {
      if(current===generation.current) {
        setError(gatewayErrorMessage(failure));
        await resource.reload({silent:true});
      }
    } finally { if(current===generation.current) { writing.current=false; setBusy(false); } }
  };
  const control=(action:"confirm"|"disable"|"restore")=>{
    if(!selected) return;
    const method=selected;
    void write(async()=>unwrapGatewayResult(await window.astella.agent.controlMethod({meta:resource.meta(),methodId:method.methodId,
      request:{expectedRevision:method.revision,action}})),action==="disable" ? "已停用，后续合作不会再采用这条方法。" : "已确认采用；仍以你当下的要求和新材料为准。");
  };
  const save=()=>{
    if(!draft || !selected || selected.methodId!==draft.methodId) return;
    const edits=draft;
    void write(async()=>{
      unwrapGatewayResult(await window.astella.agent.reviseMethod({meta:resource.meta(),methodId:edits.methodId,
        request:{expectedRevision:edits.revision,title:edits.title,appliesWhen:edits.appliesWhen,steps:lines(edits.steps),exceptions:lines(edits.exceptions),reason:edits.reason}}));
      if(useRoomStore.getState().workspaceScopeRevision===scope) setDraft(null);
    },"修订已保存，旧版本和来源保留。");
  };
  if(!resource.section) return <SectionState loading={resource.loading} message={resource.failure ? "方法暂时读不到" : "正在加载合作方法…"} detail={resource.failure ?? undefined} onRetry={resource.failure ? ()=>void resource.reload() : undefined} />;
  if(!resource.section.ok) return <SectionState message="方法暂时读不到" detail={resource.section.message} onRetry={()=>void resource.reload()} />;
  const visible=items.filter(method=>`${method.title} ${method.appliesWhen}`.toLowerCase().includes(query.trim().toLowerCase()));
  const editing=draft?.methodId===selectedId ? draft : null;
  return <section className="cc-methods" aria-label="我们的方法">
    <div className="cc-rule-intro"><h3>我们的方法</h3><p>从真实合作留下做法，由你确认、修订或停用。</p></div>
    <CenterFeedback error={error} notice={notice} />
    <CenterSearch value={query} onChange={setQuery} placeholder="找一种做事方法…" label="筛选合作方法" />
    <div className={`cc-methods-workspace${selected ? " has-selection" : ""}`}>
      <div className="cc-methods-index" aria-label="方法清单">
        {visible.length ? visible.map(method=><button key={method.methodId} type="button" aria-pressed={method.methodId===selectedId} disabled={busy} onClick={()=>{setSelectedId(method.methodId);setError(null);setNotice(null);}}>
          <small>{stateLabels[method.availability]} · 第 {method.revision} 版</small><strong>{method.title}</strong><span>{method.appliesWhen}</span>
        </button>) : <SectionState message={query ? "还没找到这条方法" : "还没有保存合作方法"} detail={query ? "试试其他关键词。" : "任务做好后，可以在我们的对话手记里，把这次合作留成方法。整理出的候选也会在这里等待你确认。"} />}
      </div>
      {selected ? <article className="cc-method-detail" aria-label="方法详情">
        <header><span className="cc-kicker">这个书房的合作方法</span><span className="cc-badge">{stateLabels[selected.availability]}</span></header>
        {editing ? <form className="cc-form" onSubmit={event=>{event.preventDefault();save();}}>
          <label>方法名称<input value={editing.title} maxLength={120} disabled={busy} onChange={event=>setDraft({...editing,title:event.currentTarget.value})} /></label>
          <label>什么时候适用<textarea value={editing.appliesWhen} maxLength={200} disabled={busy} onChange={event=>setDraft({...editing,appliesWhen:event.currentTarget.value})} /></label>
          <label>怎么合作（每行一步）<textarea value={editing.steps} maxLength={8000} disabled={busy} onChange={event=>setDraft({...editing,steps:event.currentTarget.value})} /></label>
          <label>例外与边界（每行一条）<textarea value={editing.exceptions} maxLength={4000} disabled={busy} onChange={event=>setDraft({...editing,exceptions:event.currentTarget.value})} /></label>
          <label>为什么修订<textarea value={editing.reason} maxLength={500} disabled={busy} onChange={event=>setDraft({...editing,reason:event.currentTarget.value})} /></label>
          {selected.revision!==editing.revision ? <p role="status">方法已经有新版本；你的草稿保留着，保存时会核对版本。</p> : null}
          <div className="cc-actions"><button className="cc-link" type="button" disabled={busy} onClick={()=>setDraft(null)}>取消修订</button><button className="cc-button is-primary" type="submit" disabled={busy || !editing.title.trim() || !editing.appliesWhen.trim() || !lines(editing.steps).length || !editing.reason.trim()}>{busy ? "正在保存…" : "保存修订"}</button></div>
        </form> : <>
          <h3>{selected.title}</h3><p className="cc-method-condition">适用于：{selected.appliesWhen}</p>
          <ol className="cc-method-steps">{selected.steps.map((step,index)=><li key={index}>{renderCompanionMarkdown(step)}</li>)}</ol>
          {selected.exceptions.length ? <details className="cc-details"><summary>例外与边界</summary><ul>{selected.exceptions.map((exception,index)=><li key={index}>{renderCompanionMarkdown(exception)}</li>)}</ul></details> : null}
          <p className="cc-method-reason">{selected.changeReason ?? "当前要求优先；方法不会自动启动任务。"}</p>
          <div className="cc-actions">
            {selected.availability==="pending" ? <button className="cc-button is-primary" type="button" disabled={busy} onClick={()=>control("confirm")}>确认采用</button> : null}
            {selected.state==="disabled" ? <button className="cc-button" type="button" disabled={busy} onClick={()=>control("restore")}>恢复采用</button> : <button className="cc-link" type="button" disabled={busy} onClick={()=>control("disable")}>暂时不用</button>}
            <button className="cc-button" type="button" disabled={busy} onClick={()=>setDraft({methodId:selected.methodId,revision:selected.revision,title:selected.title,appliesWhen:selected.appliesWhen,steps:selected.steps.join("\n"),exceptions:selected.exceptions.join("\n"),reason:""})}>修订做法</button>
          </div>
        </>}
        <details className="cc-details"><summary>来源与旧版本</summary>
          <p>依据 {selected.evidence.length} 条真实来源整理。第 {selected.revision} 版，更新于 {new Date(selected.updatedAt).toLocaleDateString("zh-CN")}。</p>
          <ul>{selected.evidence.map((ref,index)=><li key={index}>{ref.memoryId ? `已保存记忆 · 第 ${ref.memoryRevision ?? "待核对"} 版` : ref.runId ? `已经完成的合作 · 第 ${ref.runRevision ?? "待核对"} 次要求` : "已记录的事件"}{ref.note ? `：${ref.note}` : ""}</li>)}</ul>
          {history.loading ? <p>正在加载旧版本…</p> : history.section?.ok && history.section.value.methodId===selectedId ? history.section.value.items.map(item=><details key={item.revision}><summary>第 {item.revision} 版 · {item.title}</summary><p>{item.appliesWhen}</p><ol>{item.steps.map((step,index)=><li key={index}>{renderCompanionMarkdown(step)}</li>)}</ol><p>{item.changeReason}</p></details>) : <SectionState message="旧版本暂时读不到" onRetry={()=>void history.reload()} />}
        </details>
        <details className="cc-details"><summary>后续合作与反馈 · 本版查阅 {selected.consultedCount} 次</summary>
          <p>查阅表示伴星读取过这条方法；好不好用，由真实合作和你的反馈核对。</p>
          {uses.loading ? <p>正在加载使用记录…</p> : uses.section?.ok && uses.section.value.methodId===selectedId ? uses.section.value.items.length ? uses.section.value.items.map(use=><div className="cc-method-use" key={use.useId}>
            <span>{use.contextKind==="agent_goal" ? "任务中查阅" : "对话中查阅"} · 第 {use.methodRevision} 版 · {new Date(use.createdAt).toLocaleDateString("zh-CN")}</span>
            <div className="cc-actions">{(["helpful","unhelpful"] as const).map(feedback=><button type="button" className="cc-link" key={feedback} disabled={busy} aria-pressed={use.feedback===feedback} onClick={()=>void write(async()=>unwrapGatewayResult(await window.astella.agent.feedbackMethod({meta:resource.meta(),useId:use.useId,request:{feedback}})),"这次合作的反馈已留下。")}>{feedback==="helpful" ? "这次有帮助" : "这次不合适"}</button>)}</div>
          </div>) : <p>还没有后续使用记录。</p> : <SectionState message="使用记录暂时读不到" onRetry={()=>void uses.reload()} />}
        </details>
      </article> : null}
    </div>
  </section>;
}
