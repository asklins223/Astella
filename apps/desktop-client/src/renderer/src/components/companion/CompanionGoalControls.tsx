import { useEffect, useState } from "react";
import { Pause, Pencil, Play, Square } from "lucide-react";
import type { AgentRunV1 } from "@ailearn/shared/agent-contracts";
import { agentGoalActive, type AgentGoalsController } from "./use-agent-goals";

/** The same revision-fenced actions serve the bubble and the journal. */
export function CompanionGoalControls({ run, goals, onNewGoal }: {
  run: AgentRunV1; goals: AgentGoalsController; onNewGoal: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(run.goal);
  const [draftRevision, setDraftRevision] = useState(run.revision);
  const changing = Boolean(goals.pending);
  const exhausted = run.modelCalls >= run.maxModelCalls;
  useEffect(() => { setEditing(false); setDraft(run.goal); setDraftRevision(run.revision); }, [run.runId, goals.scope]);
  if (editing) return <form className="companion-goal-edit" onSubmit={event => {
    event.preventDefault(); void goals.change(run, { goal: draft.trim() }).then(ok => { if (ok) setEditing(false); });
  }}>
    <label>这次想怎样调整<textarea autoFocus value={draft} maxLength={8000} rows={3} disabled={changing}
      onChange={event => setDraft(event.target.value)} /></label>
    <small>{draftRevision !== run.revision ? "这件事刚刚有了新要求，你的草稿仍在。核对后可以再次提交。" : "旧要求未完成的部分会停止，成果保留。"}</small>
    <div><button type="submit" className="companion-goal-primary" disabled={changing || !draft.trim()}>{changing ? "正在更新…" : "按新要求继续"}</button>
      <button type="button" disabled={changing} onClick={() => setEditing(false)}>取消修改</button></div>
  </form>;
  return <div className="companion-goal-controls">
    {exhausted ? <button type="button" onClick={onNewGoal}><Pencil size={14} />交代新任务</button>
      : <button type="button" disabled={changing} onClick={() => { setDraft(run.goal); setDraftRevision(run.revision); setEditing(true); }}><Pencil size={14} />修改要求</button>}
    {agentGoalActive(run) ? <button type="button" disabled={changing} onClick={() => void goals.change(run, "pause")}><Pause size={14} />暂停</button>
      : ["paused", "failed"].includes(run.status) && !exhausted ? <button type="button" disabled={changing} onClick={() => void goals.change(run, "resume")}><Play size={14} />继续处理</button> : null}
    {agentGoalActive(run) || run.status === "paused" ? <button type="button" disabled={changing} onClick={() => void goals.change(run, "cancel")}><Square size={13} />停止这件事</button> : null}
  </div>;
}
