import { useRef, useState } from "react";
import type { AgentRunV1 } from "@astella/shared/agent-contracts";
import type { AgentMethodV1 } from "@astella/shared/agent-growth-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { publishCompanionRecordsChanged } from "./companion-events";
import { renderCompanionMarkdown } from "./companion-markdown";

export function CompanionGoalMethod({run,scope,onOpen}:{run:AgentRunV1;scope:number;onOpen:()=>void}) {
  const [open,setOpen]=useState(false), [title,setTitle]=useState(""), [appliesWhen,setAppliesWhen]=useState("");
  const [method,setMethod]=useState<AgentMethodV1|null>(null), [error,setError]=useState<string|null>(null), [busy,setBusy]=useState(false);
  const locked=useRef(false), current=()=>useRoomStore.getState().workspaceScopeRevision===scope;
  const write=async(action:()=>Promise<AgentMethodV1>)=>{
    if(locked.current || !current()) return;
    locked.current=true; setBusy(true);setError(null);
    try { const saved=await action(); if(current()){setMethod(saved);publishCompanionRecordsChanged();} }
    catch(failure){if(current())setError(gatewayErrorMessage(failure));}
    finally {locked.current=false;if(current())setBusy(false);}
  };
  const visit=()=>{if(!method || !current())return;const room=useRoomStore.getState();room.setCompanionCenterTarget({tab:"memory",focusMethodId:method.methodId});room.invoke("open-companion-center");onOpen();};
  if(run.status!=="completed" || !run.operations.some(operation=>operation.status==="succeeded")) return null;
  return <section className="companion-goal-method" aria-label="留下合作方法">
    {!open ? <button type="button" className="companion-goal-journal__back" onClick={()=>setOpen(true)}>把这次合作留成方法</button> : method ? <>
      <h4>{method.state==="active" ? "这条方法已留下" : "先核对这次的做法"}</h4><strong>{method.title}</strong><p>适用于：{method.appliesWhen}</p>
      <ol>{method.steps.map((step,index)=><li key={index}>{renderCompanionMarkdown(step)}</li>)}</ol>
      <p>这是做事的指引；下次仍需读取新材料，以你当时的要求为准。</p>
      <div className="companion-goal-controls">
        {method.availability==="pending" ? <button type="button" className="companion-goal-primary" disabled={busy} onClick={()=>void write(async()=>unwrapGatewayResult(await window.astella.agent.controlMethod({meta:createRequestMeta(),methodId:method.methodId,request:{expectedRevision:method.revision,action:"confirm"}})))}>{busy ? "正在保存…" : "确认采用"}</button> : null}
        <button type="button" disabled={busy} onClick={visit}>查看与修订方法</button><button type="button" disabled={busy} onClick={()=>setOpen(false)}>收起</button>
      </div>
    </> : <form className="companion-goal-edit" onSubmit={event=>{event.preventDefault();void write(async()=>unwrapGatewayResult(await window.astella.agent.proposeMethod({meta:createRequestMeta(),request:{runId:run.runId,expectedRunRevision:run.revision,title:title.trim(),appliesWhen:appliesWhen.trim()}})));}}>
      <label>给这套做法起个名字<input value={title} maxLength={120} disabled={busy} onChange={event=>setTitle(event.currentTarget.value)} placeholder="例如：用演示和练习理解新概念" /></label>
      <label>什么时候希望这样合作<textarea value={appliesWhen} maxLength={200} disabled={busy} onChange={event=>setAppliesWhen(event.currentTarget.value)} placeholder="写清适用的内容或情境" /></label>
      <small>先从真实生成记录整理，核对后再确认采用。</small><div><button type="submit" disabled={busy || !title.trim() || !appliesWhen.trim()}>{busy ? "正在整理…" : "整理成方法"}</button><button type="button" disabled={busy} onClick={()=>setOpen(false)}>取消</button></div>
    </form>}
    {error ? <p className="companion-goal-error" role="alert">{error}</p> : null}
  </section>;
}
