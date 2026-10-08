import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { AgentGoalsController } from "./use-agent-goals";
import { CompanionGoalControls } from "./CompanionGoalControls";
import { artifactBatchLabel, goalHeadline, goalNextHint, goalStatusText, goalTitle, openAgentArtifact, operationLabel, operationStatusText } from "./agent-goal-presentation";
import { renderCompanionMarkdown } from "./companion-markdown";
import { CompanionGoalRevisions } from "./CompanionGoalRevisions";
import { CompanionGoalMethod } from "./CompanionGoalMethod";
import { CompanionCardTasks } from "./CompanionCardTasks";

/** Task records live inside our conversation book, using the same projection as the bubble. */
export function CompanionGoalJournal({ goals, targetId, onChat, onArtifactOpen }: {
  goals: AgentGoalsController; targetId: string | null; onChat: () => void; onArtifactOpen: () => void;
}) {
  const [selectedId, setSelectedId] = useState(targetId);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requested = useRef<string | null>(null);
  const run = goals.items.find(item => item.runId === selectedId);
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
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    const list = headingRef.current?.closest<HTMLElement>(".companion-history__list");
    if (list) list.scrollTop = 0;
  }, [selectedId]);
  if (!run) return <section className="companion-goal-journal" aria-label="交给伴星的事">
    <h3 ref={headingRef} tabIndex={-1}>交给我的事</h3><p className="companion-goal-journal__intro">要求、进展和成果，和我们的对话一起留在这里。</p>
    {goals.items.length ? <ol className="companion-goal-journal__index">{goals.items.map(item => <li key={item.runId}><button type="button" onClick={() => setSelectedId(item.runId)}>
      <span><small data-state={item.status}>{goalStatusText[item.status]} · {new Date(item.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small><strong>{goalTitle(item)}</strong>
        {item.artifacts.length ? <em>{item.artifacts.length} 份成果已保留</em> : null}</span><ChevronRight size={17} />
    </button></li>)}</ol> : goals.loading ? <p role="status">正在加载任务记录…</p> : !goals.error ? <p>还没有交给我的任务。可以在轻聊里告诉我想做什么。</p> : null}
    {goals.nextCursor ? <button type="button" className="companion-goal-journal__back" disabled={goals.moreLoading} onClick={() => void goals.loadMore()}>{goals.moreLoading ? "正在加载更早的任务…" : goals.moreError ? "重试加载更早的任务" : "更早的任务"}</button> : null}
    {goals.moreError ? <p className="companion-goal-error" role="alert">{goals.moreError}</p> : null}
    {goals.error ? <p className="companion-goal-error" role="alert">{goals.error}<button type="button" onClick={() => void (selectedId ? goals.ensure(selectedId) : goals.refresh())}>重新读取</button></p> : null}
  </section>;
  return <section className="companion-goal-journal" aria-label="这件事的完整记录">
    <button type="button" className="companion-goal-journal__back" onClick={() => setSelectedId(null)}><ChevronLeft size={15} />任务列表</button>
    <div className="companion-goal-journal__eyebrow"><span data-state={run.status}>{goalStatusText[run.status]}</span><span>第 {run.revision} 次要求</span></div>
    <h3 ref={headingRef} tabIndex={-1}>{goalHeadline(run)}</h3>
    <p className="companion-goal-journal__intent">{run.goal}</p>
    {!hasCurrentArtifact ? delivery : null}
    {run.artifacts.length ? <section className="companion-goal-journal__results" aria-label="做好的成果"><h4>已经做好的</h4>
      {run.artifacts.map(artifact => <button type="button" key={artifact.id} onClick={() => { if (openAgentArtifact(artifact, goals.scope)) onArtifactOpen(); }}>
        <Check size={17} /><span><strong>{artifactBatchLabel(artifact, run)}</strong><small>{run.operations.some(operation => operation.result?.kind === "artifact" && operation.result.artifact.id === artifact.id) ? artifact.kind === "card_candidates" ? "按这次要求准备 · 由你审核与保存" : "按这次要求生成" : "之前做好的 · 保留在这里"}</small></span><ArrowUpRight size={16} />
      </button>)}
    </section> : null}
    <CompanionCardTasks operations={run.operations} artifacts={run.artifacts} scope={goals.scope} onOpen={onArtifactOpen} />
    <div className="companion-goal-journal__next"><p>{goalNextHint(run)}</p><CompanionGoalControls run={run} goals={goals} onNewGoal={onChat} /></div>
    {hasCurrentArtifact ? delivery : null}
    <CompanionGoalMethod key={`${goals.scope}:${run.runId}:${run.revision}`} run={run} scope={goals.scope} onOpen={onArtifactOpen} />
    <details className="companion-goal-journal__process"><summary>查看生成记录 · {run.operations.length} 项</summary>
      <p>使用了 {run.inputs.length} 份已保存的笔记版本。</p>
      {run.operations.length ? <ol>{run.operations.map(operation => <li key={operation.operationId}>
        <strong>{operationLabel(operation.capability)}</strong><span>{operation.status === "succeeded" && operation.result?.kind === "no_cards_recommended" ? "这次不建议制卡" : operationStatusText[operation.status]}</span>
        {operation.error ? <p>{operation.error}</p> : null}
      </li>)}</ol> : <p>{run.status === "completed" ? "这次没有启动生成。" : "还没有开始生成。"}</p>}
      {run.error ? <p className="companion-goal-error">{run.error}</p> : null}
    </details>
    {run.revision > 1 ? <CompanionGoalRevisions key={`${goals.scope}:${run.runId}`} run={run} scope={goals.scope} onArtifactOpen={onArtifactOpen} /> : null}
    {goals.error ? <p className="companion-goal-error" role="alert">{goals.error}<button type="button" onClick={() => void goals.refresh()}>重新读取</button></p> : null}
  </section>;
}
