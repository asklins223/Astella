import { useEffect, useState } from "react";
import { Pause, Pencil, Play, Square } from "lucide-react";
import type { AgentRunV1 } from "@astella/shared/agent-contracts";
import { agentGoalActive, type AgentGoalsController } from "./use-agent-goals";
import { useCompanionResource } from "../surfaces/companion/use-companion-resource";
import { CompanionSelect } from "../surfaces/companion/companion-select";

/** The same revision-fenced actions serve the bubble and the journal. */
export function CompanionGoalControls({ run, goals, onNewGoal }: {
  run: AgentRunV1; goals: AgentGoalsController; onNewGoal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(run.goal);
  const [draftRevision, setDraftRevision] = useState(run.revision);
  const [bindingChoice, setBindingChoice] = useState("keep");
  const [selectedBinding, setSelectedBinding] = useState<{ ref: NonNullable<AgentRunV1["longGoal"]>; content: string } | null>(null);
  const longGoals = useCompanionResource(meta => window.astella.agent.listLongGoals({ meta, query: { memoryId: run.longGoal?.memoryId, limit: 1 } }), [run.runId, run.revision], editing && Boolean(run.longGoal));
  const latest = longGoals.section?.ok ? longGoals.section.value.items.find(item => item.ref.memoryId === run.longGoal?.memoryId) : undefined;
  const bindingChanged = bindingChoice === "current" && (!latest || !selectedBinding
    || selectedBinding.ref.memoryId !== latest.ref.memoryId || selectedBinding.ref.revision !== latest.ref.revision);
  const changing = Boolean(goals.pending);
  const exhausted = run.modelCalls >= run.maxModelCalls;
  useEffect(() => { setEditing(false); setDraft(run.goal); setDraftRevision(run.revision); }, [run.runId, goals.scope]);
  if (editing) return <form className="companion-goal-edit" onSubmit={event => {
    event.preventDefault();
    if (changing || !draft.trim() || bindingChanged) return;
    void goals.change(run, { goal: draft.trim(),
      ...(bindingChoice === "none" ? { longGoal: null } : bindingChoice === "current" && selectedBinding && !bindingChanged ? { longGoal: selectedBinding.ref } : {}),
    }).then(ok => { if (ok) setEditing(false); });
  }}>
    <label>这次想怎样调整<textarea autoFocus value={draft} maxLength={8000} rows={3} disabled={changing}
      onChange={event => setDraft(event.target.value)} /></label>
    <small>{draftRevision !== run.revision ? "这件事刚刚有了新要求，你的草稿仍在。核对后可以再次提交。" : "旧要求未完成的部分会停止，成果保留。"}</small>
    {run.longGoal ? <details className="companion-goal-binding"><summary>长期目标的依据</summary>
      <label>按哪个目标继续<CompanionSelect ariaLabel="按哪个目标继续" paper value={bindingChoice} disabled={changing}
        options={[{value:"keep",label:`保留原先第 ${run.longGoal.revision} 版`},
          ...(latest ? [{value:"current",label:`确认使用当前第 ${latest.ref.revision} 版`}] : []),
          {value:"none",label:"解除关联，只按这次要求做"}]} onChange={value => {
          setBindingChoice(value);
          if (value === "current" && latest) setSelectedBinding({ ref: latest.ref, content: latest.content });
        }} /></label>
      {bindingChoice === "current" && selectedBinding ? <p>{selectedBinding.content}</p> : null}
      {bindingChanged && latest ? <p role="alert">目标又有了修改，请重新核对。
        <button type="button" disabled={changing} onClick={() => setSelectedBinding({ ref: latest.ref, content: latest.content })}>核对并使用第 {latest.ref.revision} 版</button>
      </p> : null}
      {longGoals.failure || (longGoals.section && !longGoals.section.ok) ? <p role="alert">目标暂时读不到。<button type="button" onClick={() => void longGoals.reload()}>重新核对</button></p>
        : longGoals.loading ? <p>正在核对目标…</p> : !latest ? <p>原先的目标已停用或撤回，可以解除关联后继续。</p> : null}
    </details> : null}
    <div><button type="submit" className="companion-goal-primary" disabled={changing || !draft.trim() || bindingChanged}>{changing ? "正在更新…" : "按新要求继续"}</button>
      <button type="button" disabled={changing} onClick={() => setEditing(false)}>取消修改</button></div>
  </form>;
  return <div className="companion-goal-controls">
    {exhausted ? <button type="button" onClick={onNewGoal}><Pencil size={14} />交代新任务</button>
      : <button type="button" disabled={changing} onClick={() => { setDraft(run.goal); setDraftRevision(run.revision); setBindingChoice("keep"); setSelectedBinding(null); setEditing(true); }}><Pencil size={14} />修改要求</button>}
    {agentGoalActive(run) ? <button type="button" disabled={changing} onClick={() => void goals.change(run, "pause")}><Pause size={14} />暂停</button>
      : ["paused", "failed"].includes(run.status) && !exhausted ? <button type="button" disabled={changing} onClick={() => void goals.change(run, "resume")}><Play size={14} />继续处理</button> : null}
    {agentGoalActive(run) || run.status === "paused" ? <button type="button" disabled={changing} onClick={() => void goals.change(run, "cancel")}><Square size={13} />停止这件事</button> : null}
  </div>;
}
