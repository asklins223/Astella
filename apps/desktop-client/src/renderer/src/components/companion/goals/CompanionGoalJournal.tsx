import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { AgentGoalsController } from "./use-agent-goals";
import { agentGoalActive } from "./use-agent-goals";
import { CompanionGoalControls } from "./CompanionGoalControls";
import { artifactBatchLabel, goalHasNextStep, goalNextHint, goalProgressLine, goalStatusText, goalTitle, goalUpdatedLabel, previewAgentArtifact, operationLabel, operationStatusText } from "./agent-goal-presentation";
import { renderCompanionMarkdown } from "../content/companion-markdown";
import { CompanionGoalRevisions } from "./CompanionGoalRevisions";
import { CompanionGoalMethod } from "./CompanionGoalMethod";
import { useCompanionResultPreview } from "../journal/companion-result-preview";
import { useJournalDisclosure } from "../journal/companion-journal-view-state";

/** Task records live inside our conversation book, using the same projection as the bubble. */
export function CompanionGoalJournal({ goals, targetId, onArtifactOpen }: {
  goals: AgentGoalsController; targetId: string | null; onArtifactOpen: () => void;
}) {
  const [selectedId, setSelectedId] = useState(targetId);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requested = useRef<string | null>(null);
  const run = goals.items.find(item => item.runId === selectedId);
  const active = Boolean(run && agentGoalActive(run));
  const nextStep = Boolean(run && goalHasNextStep(run));
  const fullGoal = run?.goal.replace(/\s+/g, " ").trim() ?? "";
  const shortGoal = run ? goalTitle(run) : "";
  const [processOpen, toggleProcess] = useJournalDisclosure(`goal:${goals.scope}:${selectedId}:process`, active);
  const hasCurrentArtifact = run?.operations.some(operation => operation.result?.kind === "artifact");
  const delivery = run?.summary ? <section className="companion-goal-journal__summary"><h4>这次的交付说明</h4><div className="companion-record__body">{renderCompanionMarkdown(run.summary)}</div></section> : null;
  useEffect(() => { setSelectedId(targetId); }, [targetId, goals.scope]);
  useEffect(() => {
    if (!selectedId || run || goals.loading) return;
    const key = `${goals.scope}:${selectedId}`;
    if (requested.current === key) return;
    requested.current = key;
    void goals.ensure?.(selectedId);
  }, [selectedId, goals.scope, goals.loading, run, goals.ensure]);
  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    const list = headingRef.current?.closest<HTMLElement>(".companion-history__list");
    const key = `goal:${goals.scope}:${selectedId ?? "index"}`;
    const positions = useCompanionResultPreview.getState().positions;
    if (list) list.scrollTop = positions.get(key) ?? 0;
    const remember = () => { if (list) positions.set(key, list.scrollTop); };
    list?.addEventListener("scroll", remember, { passive: true });
    return () => list?.removeEventListener("scroll", remember);
  }, [selectedId, goals.scope]);
  if (!run) return <section className="companion-goal-journal" aria-label="交给伴星的事">
    <h3 ref={headingRef} tabIndex={-1}>交给我的事</h3><p className="companion-goal-journal__intro">要求、进展和成果，和我们的对话一起留在这里。</p>
    {goals.items.length ? <ol className="companion-goal-journal__index">{goals.items.map(item => <li key={item.runId}><button type="button" aria-label={`打开任务：${goalTitle(item)}`} onClick={() => setSelectedId(item.runId)}>
      <span><small data-state={item.status}>{goalStatusText[item.status]} · {new Date(item.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small><strong>{goalTitle(item)}</strong>
        <em>{goalProgressLine(item)}</em></span><span className="companion-goal-journal__open">打开<ChevronRight size={16} /></span>
    </button></li>)}</ol> : goals.loading ? <p role="status">正在加载任务记录…</p> : !goals.error ? <p>还没有交给我的任务。可以在轻聊里告诉我想做什么。</p> : null}
    {goals.nextCursor ? <button type="button" className="companion-goal-journal__back" disabled={goals.moreLoading} onClick={() => void goals.loadMore()}>{goals.moreLoading ? "正在加载更早的任务…" : goals.moreError ? "重试加载更早的任务" : "更早的任务"}</button> : null}
    {goals.moreError ? <p className="companion-goal-error" role="alert">{goals.moreError}</p> : null}
    {goals.error ? <p className="companion-goal-error" role="alert">{goals.error}<button type="button" onClick={() => void (selectedId ? goals.ensure(selectedId) : goals.refresh())}>重新读取</button></p> : null}
  </section>;
  return <section className="companion-goal-journal" aria-label="这件事的完整记录">
    <button type="button" className="companion-goal-journal__back" onClick={() => setSelectedId(null)}><ChevronLeft size={15} />任务列表</button>
    <div className="companion-goal-journal__eyebrow"><span data-state={run.status}>{goalStatusText[run.status]}</span><span>第 {run.revision} 次要求{goalUpdatedLabel(run) ? ` · ${goalUpdatedLabel(run)}` : ""}</span></div>
    <h3 ref={headingRef} tabIndex={-1}>{shortGoal}</h3>
    {fullGoal !== shortGoal ? <p className="companion-goal-journal__intent">{run.goal}</p> : null}
    {!active ? <p className="companion-goal-journal__progress" data-state={run.status}>{goalProgressLine(run)}</p> : null}
    {!active && nextStep ? <div className="companion-goal-journal__next"><h4>下一步</h4><p>{goalNextHint(run)}</p><CompanionGoalControls run={run} goals={goals} /></div> : null}
    {!hasCurrentArtifact ? delivery : null}
    {run.artifacts.length ? <section className="companion-goal-journal__results" aria-label="做好的成果"><h4>成果 <span>{run.artifacts.length}</span></h4>
      {run.artifacts.map(artifact => <button type="button" key={artifact.id} onClick={event => { if (previewAgentArtifact(artifact, goals.scope, run.runId, artifactBatchLabel(artifact, run), event.currentTarget)) onArtifactOpen(); }}>
        <Check size={17} /><span><strong>{artifactBatchLabel(artifact, run)}</strong><small>{run.operations.some(operation => operation.result?.kind === "artifact" && operation.result.artifact.id === artifact.id) ? "按这次要求生成" : "之前做好的 · 保留在这里"}</small></span><ArrowUpRight size={16} />
      </button>)}
    </section> : null}
    {hasCurrentArtifact ? delivery : null}
    <CompanionGoalMethod key={`${goals.scope}:${run.runId}:${run.revision}`} run={run} scope={goals.scope} onOpen={onArtifactOpen} />
    <details open={processOpen} className="companion-goal-journal__process"><summary onClick={event => { event.preventDefault(); toggleProcess(); }}>生成记录 · {run.operations.length} 项</summary>
      <p>使用了 {run.inputs.length} 份已保存的笔记版本。</p>
      {run.operations.length ? <ol>{run.operations.map(operation => <li key={operation.operationId}>
        <strong>{operationLabel(operation.capability)}</strong><span>{operationStatusText[operation.status]}</span>
        {operation.error ? <p>{operation.error}</p> : null}
      </li>)}</ol> : <p>{run.status === "completed" ? "这次没有启动生成。" : "还没有开始生成。"}</p>}
      {run.error ? <p className="companion-goal-error">{run.error}</p> : null}
    </details>
    {active || !nextStep ? <div className="companion-goal-journal__active-controls"><span>调整这件事</span><CompanionGoalControls run={run} goals={goals} /></div> : null}
    {run.revision > 1 ? <CompanionGoalRevisions key={`${goals.scope}:${run.runId}`} run={run} scope={goals.scope} onArtifactOpen={onArtifactOpen} /> : null}
    {goals.error ? <p className="companion-goal-error" role="alert">{goals.error}<button type="button" onClick={() => void goals.refresh()}>重新读取</button></p> : null}
  </section>;
}
