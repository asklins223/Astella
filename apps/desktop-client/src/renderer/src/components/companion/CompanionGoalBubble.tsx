import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, BookOpenText, Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, Settings2, X } from "lucide-react";
import { useCompanionFloatingPlacement } from "./use-companion-floating-placement";
import { CompanionGoalControls } from "./CompanionGoalControls";
import { CompanionCardTasks } from "./CompanionCardTasks";
import { isCompanionComposition } from "./companion-composer-key";
import { agentGoalActive, type AgentGoalsController } from "./use-agent-goals";
import { artifactLabel, goalHeadline, goalNextHint, goalStatusText, goalTitle, latestGoalArtifacts, openAgentArtifact } from "./agent-goal-presentation";

export function CompanionGoalBubble({ anchorRef, motionMode, blocked, open, selectedId, goals, onOpen, onClose, onSelect, onDetails, onChat }: {
  anchorRef: RefObject<HTMLDivElement | null>; motionMode: "full" | "lite" | "off"; blocked: boolean;
  open: boolean; selectedId: string | null; goals: AgentGoalsController; onOpen: () => void; onClose: () => void;
  onSelect: (id: string) => void; onDetails: (id: string) => void; onChat: () => void;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [moreResults, setMoreResults] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null), adjustRef = useRef<HTMLButtonElement>(null), floatingRef = useRef<HTMLDivElement>(null), headRef = useRef<HTMLDivElement>(null), titleRef = useRef<HTMLHeadingElement>(null);
  const visible = open && !blocked;
  const selected = goals.items.find(run => run.runId === selectedId) ?? goals.items.find(agentGoalActive) ?? goals.items[0];
  const index = selected ? goals.items.indexOf(selected) : 0;
  const artifacts = selected ? latestGoalArtifacts(selected) : [];
  const activeCount = goals.items.filter(agentGoalActive).length;
  const initialLoading = !selected && goals.loading;
  const initialError = !selected && Boolean(goals.error);
  const { side } = useCompanionFloatingPlacement(anchorRef, floatingRef, headRef, visible, 310);
  useEffect(() => { setAdjusting(false); setMoreResults(false); }, [selected?.runId, visible]);
  // Keep the opened task selected when it finishes while another task is active.
  useEffect(() => { if (visible && selected && selectedId !== selected.runId) onSelect(selected.runId); }, [visible, selected?.runId, selectedId, onSelect]);
  useEffect(() => { if (visible) titleRef.current?.focus({ preventScroll: true }); }, [visible, selected?.runId]);
  useEffect(() => {
    if (!visible) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isCompanionComposition(event)) return;
      event.preventDefault(); event.stopPropagation();
      if (adjusting) { setAdjusting(false); adjustRef.current?.focus({ preventScroll: true }); }
      else { onClose(); buttonRef.current?.focus({ preventScroll: true }); }
    };
    // A pending action can temporarily release button focus; the bubble still
    // owns Escape before the room's shortcut can navigate away.
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [visible, adjusting, onClose]);
  const close = () => { onClose(); buttonRef.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={buttonRef} className="companion-goal-tab" type="button" aria-label="查看伴星手边的事" aria-expanded={visible} disabled={blocked}
      onClick={() => { if (visible) close(); else { onOpen(); void goals.refresh(); } }}>
      {activeCount ? <LoaderCircle size={15} className="companion-hud__spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
      <span>{activeCount ? `手边 ${activeCount} 件事` : "手边的事"}</span>
    </button>
    {createPortal(<div ref={floatingRef} className="companion-hud--floating companion-goal-float" data-companion-owned="true" data-motion={motionMode}
      data-side={side} data-blocked={!visible || undefined}>
      <div ref={headRef} className="companion-hud__head">
        {visible ? <section className="companion-hud__output companion-goal-bubble" aria-label="伴星手边的事" aria-busy={initialLoading}>
          <header className="companion-goal-bubble__header"><span>{selected ? goalStatusText[selected.status] : "交给我的事"}</span>
            <button type="button" aria-label="收起任务气泡" onClick={close}><X size={16} /></button></header>
          <div className="companion-goal-bubble__body">
            <h2 ref={titleRef} tabIndex={-1}>{selected ? goalHeadline(selected) : initialLoading ? "正在加载任务…" : initialError ? "任务记录没有加载成功" : "把一件事交给我"}</h2>
            {selected ? <>
              <p className="companion-goal-bubble__intent" title={selected.goal}>{goalTitle(selected)}</p>
              {selected.artifacts.length ? <div className="companion-goal-bubble__results" aria-label="做好的成果">
                {artifacts.slice(0, moreResults ? artifacts.length : 3).map(artifact => <button type="button" key={artifact.id} onClick={() => { if (openAgentArtifact(artifact, goals.scope)) close(); }}>
                  <Check size={13} /><span>{artifactLabel(artifact, selected)}</span><ArrowUpRight size={13} />
                </button>)}
                {artifacts.length > 3 ? <button type="button" className="companion-goal-bubble__more-results" aria-expanded={moreResults}
                  onClick={() => setMoreResults(value => !value)}>{moreResults ? "收起更多成果" : `其余 ${artifacts.length - 3} 份成果`}</button> : null}
              </div> : null}
              <CompanionCardTasks operations={selected.operations} artifacts={selected.artifacts} scope={goals.scope} onOpen={close} />
              <p className="companion-goal-bubble__hint" role="status">{goalNextHint(selected)}</p>
              {adjusting ? <CompanionGoalControls run={selected} goals={goals} onNewGoal={onChat} /> : null}
            </> : !initialLoading && !initialError ? <><p className="companion-goal-bubble__hint">告诉我想做什么，例如整理笔记、解释问题，或准备学习卡。</p>
              <button type="button" className="companion-goal-primary" onClick={onChat}>说说要做什么</button></> : null}
            {goals.error ? <p className="companion-goal-error" role="alert">{goals.error}<button type="button" onClick={() => void goals.refresh()}>重新读取</button></p> : null}
          </div>
          <footer className="companion-goal-bubble__footer">
            {selected ? <><button ref={adjustRef} type="button" aria-expanded={adjusting} onClick={() => setAdjusting(value => !value)}><Settings2 size={14} />调整<ChevronDown size={12} /></button>
              <button type="button" onClick={() => onDetails(selected.runId)}><BookOpenText size={14} />去手记看完整记录</button></> : null}
          </footer>
          {goals.items.length > 1 ? <nav className="companion-goal-bubble__paging" aria-label="切换手边的事">
            <button type="button" aria-label="上一件事" disabled={index === 0 || Boolean(goals.pending)} onClick={() => onSelect(goals.items[index-1].runId)}><ChevronLeft size={14} /></button>
            <span>{index+1} / {goals.items.length}</span>
            <button type="button" aria-label="下一件事" disabled={index === goals.items.length-1 || Boolean(goals.pending)} onClick={() => onSelect(goals.items[index+1].runId)}><ChevronRight size={14} /></button>
          </nav> : null}
        </section> : null}
      </div>
    </div>, document.body)}
  </>;
}
