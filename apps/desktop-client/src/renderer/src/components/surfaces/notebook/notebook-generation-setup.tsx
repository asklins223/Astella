/** A small making note: choose a purpose, then adjust only what you need. */
import { useLayoutEffect, useRef, type Dispatch, type ReactElement, type SetStateAction } from "react";
import {
  CARD_LIMITS,
  DETAIL_THRESHOLDS,
  FEEDBACK_REASONS,
  LEARNING_GOALS,
  STRATEGIES,
  type GenerationOptions,
} from "./notebook-generation-options.ts";
import { Brain, Check, ChevronDown, Compass, Lightbulb, NotebookPen, Sparkles } from "lucide-react";
import { cardStrategyPresentation } from "../review/card-strategy-presentation";
import type { DesktopCardGenerationFeedbackReasonV2 } from "@ailearn/shared/card-generation-desktop-contracts";
import { useNotebookPaperMotion } from "./use-notebook-paper-motion";
import { useNotebookTouch } from "./use-notebook-touch";
import { useRoomStore } from "../../../app/room-store";
import { useCardObjectSpring } from "../../motion/card-object-spring";

const goalDetails = {
  remember: { icon: Brain, hint: "把关键点记牢" },
  understand: { icon: Lightbulb, hint: "讲清原理和联系" },
  apply: { icon: Compass, hint: "放进情境里试试" },
  exam: { icon: NotebookPen, hint: "练习常见的问法" },
} as const;

export function GenerationSetup(props: {
  readonly options: GenerationOptions;
  readonly setOptions: Dispatch<SetStateAction<GenerationOptions>>;
  readonly startingGeneration: boolean;
  readonly generationFailure: string | null;
  readonly dirty: boolean;
  /** 「先看懂这一篇」那颗开关此刻通不通——对话框里那颗要跟着它禁用。 */
  readonly generationEnabled: boolean;
  /** 确认生成。点了之后由页面负责建轮次——对话框只负责收齐选项。 */
  readonly startGeneration: () => void;
  /** 「针对上次」那一行：一条已结束的生成记录（页面里是**派生值**，没有 setter）。 */
  readonly feedbackTarget: { readonly status: string; readonly updatedAt: string; readonly runId: string } | null;
  readonly feedbackNote: string;
  readonly setFeedbackNote: (value: string) => void;
  readonly feedbackReasons: readonly DesktopCardGenerationFeedbackReasonV2[];
  readonly setFeedbackReasons: Dispatch<SetStateAction<readonly DesktopCardGenerationFeedbackReasonV2[]>>;
  /** 摘要串与状态字都是页面级的纯函数，按函数传，不在这里重写一遍。 */
  readonly generationOptionSummary: (options: GenerationOptions) => string;
  readonly cardGenerationStatusLabel: (status: string) => string;
  readonly formatRelative: (value: string | null | undefined) => string;
  readonly closeGenerationSetup: () => void;
}): ReactElement {
  const paperRef = useRef<HTMLElement | null>(null);
  const purposeRef = useRef<HTMLDivElement>(null), cushionRef = useRef<HTMLDivElement>(null);
  const cushion = useCardObjectSpring(cushionRef, {}, { layoutPosition: true });
  const motionMode = useRoomStore(state => state.motionMode);
  const reducedMotion = useRoomStore(state => state.reducedMotion);
  const play = useNotebookPaperMotion();
  useNotebookTouch(paperRef);
  useLayoutEffect(() => { play(paperRef.current, "fold"); }, [play]);
  const {
    options, setOptions,
    startingGeneration, generationFailure, dirty,
    feedbackTarget,
    feedbackNote, setFeedbackNote,
    feedbackReasons, setFeedbackReasons,
    generationOptionSummary,
    cardGenerationStatusLabel,
    generationEnabled,
    startGeneration,
    formatRelative,
    closeGenerationSetup,
  } = props;
  useLayoutEffect(() => {
    const root = purposeRef.current;
    if (!root) return;
    const icon = root.querySelector<HTMLElement>("[aria-pressed='true'] .making-purpose__icon");
    if (!icon) return;
    const choice = icon.parentElement!;
    const update = () => cushion.current?.target({ x: choice.offsetLeft + icon.offsetLeft - 7, y: choice.offsetTop + icon.offsetTop - 7 });
    update();
    cushion.current?.kick({ rotate: 55, scale: -.55 });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(root);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [options.learningGoal, cushion]);
  const allStrategies = options.preferredStrategies.length === STRATEGIES.length;
  return <section className="generation-setup card-making-note" ref={paperRef} data-motion-mode={motionMode} data-reduced-motion={reducedMotion} role="dialog" aria-modal="true" aria-labelledby="generation-setup-title" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); closeGenerationSetup(); }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary")]
      .filter(element => !element.closest("details:not([open])") || element.matches("summary"));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }}>
    <header className="generation-setup__header">
      <span className="generation-setup__eyebrow">从这篇笔记，做一叠新卡</span>
      <h2 id="generation-setup-title">这次想怎么练？</h2>
      <p>选一个方向就可以开始。卡片写好后，再由你挑选收藏。</p>
      <button autoFocus type="button" className="generation-setup__close" aria-label="关闭生成方案" onClick={closeGenerationSetup}>×</button>
    </header>
    <fieldset className="generation-options" disabled={startingGeneration}>
      <legend className="sr-only">生成方案</legend>
      <div className="making-purpose" ref={purposeRef} role="group" aria-label="学习方向"><div ref={cushionRef} className="making-purpose__cushion" aria-hidden="true" />{LEARNING_GOALS.map(item => {
        const Icon = goalDetails[item.value].icon;
        return <button type="button" key={item.value} className="making-purpose__choice" aria-label={item.label} aria-pressed={options.learningGoal === item.value} onClick={() => setOptions(current => ({ ...current, learningGoal: item.value }))}>
          <span className="making-purpose__icon" aria-hidden="true"><Icon size={23} /></span>
          <strong>{item.label}</strong><small>{goalDetails[item.value].hint}</small>
          {options.learningGoal === item.value ? <Check size={15} className="making-purpose__check" aria-hidden="true" /> : null}
        </button>;
      })}</div>
      <p className="making-defaults">{DETAIL_THRESHOLDS.find(item => item.value === options.detailThreshold)?.label}出题 · 最多 {options.hardMaxCards} 张 · {allStrategies ? "按内容挑卡型" : `允许 ${options.preferredStrategies.length} 种卡型`}</p>
      <details className="making-adjustments">
        <summary><span><strong>微调这叠卡</strong><small>数量、详略与卡型</small></span><ChevronDown size={19} aria-hidden="true" /></summary>
        <div className="making-adjustments__body">
          <div className="generation-options__row" role="group" aria-label="卡片上限"><span className="generation-options__label">这一叠多大？</span>{CARD_LIMITS.map(limit => <button type="button" key={limit} className={options.hardMaxCards === limit ? "chip on" : "chip"} aria-pressed={options.hardMaxCards === limit} onClick={() => setOptions(current => ({ ...current, hardMaxCards: limit }))}>{limit} 张</button>)}</div>
          <div className="generation-options__row" role="group" aria-label="出题详略"><span className="generation-options__label">想挖多深？</span>{DETAIL_THRESHOLDS.map(item => <button type="button" key={item.value} className={options.detailThreshold === item.value ? "chip on" : "chip"} aria-pressed={options.detailThreshold === item.value} onClick={() => setOptions(current => ({ ...current, detailThreshold: item.value }))}>{item.label}</button>)}</div>
          <div className="generation-options__row" role="group" aria-label="学习卡型"><span className="generation-options__label">可以用哪些卡型？</span>
            <p className="making-strategy-help">系统会按笔记内容挑选；关掉某一种，这次就不用它。</p>
            <div className="making-strategies">{STRATEGIES.map(item => {
              const on = options.preferredStrategies.includes(item.value), presentation = cardStrategyPresentation[item.value];
              return <button type="button" key={item.value} className="making-strategies__choice" aria-label={item.label} aria-pressed={on} disabled={on && options.preferredStrategies.length === 1} title={on && options.preferredStrategies.length === 1 ? "至少留一种卡型" : presentation.cue} onClick={() => setOptions(current => ({ ...current, preferredStrategies: on ? current.preferredStrategies.filter(value => value !== item.value) : [...current.preferredStrategies, item.value] }))}>
                <i aria-hidden="true">{presentation.symbol}</i><span><strong>{item.label}</strong><small>{presentation.cue}</small></span><span className="making-strategies__tick" aria-hidden="true">{on ? <Check size={14} /> : null}</span>
              </button>;
            })}</div>
          </div>
          <p className="generation-options__summary">本次：{generationOptionSummary(options)}</p>
        </div>
      </details>
      {feedbackTarget ? <details className="making-adjustments making-feedback">
        <summary><span><strong>让这次更合心意</strong><small>给上次的卡留一点建议{feedbackReasons.length ? ` · 已选 ${feedbackReasons.length} 项` : " · 可选"}</small></span><ChevronDown size={19} aria-hidden="true" /></summary>
        <div className="making-adjustments__body">
          <p className="making-strategy-help">上次{cardGenerationStatusLabel(feedbackTarget.status)} · {formatRelative(feedbackTarget.updatedAt)}。选一条建议，这次会按反馈重新出题。</p>
          <div className="generation-options__row" role="group" aria-label="重新生成的反馈">{FEEDBACK_REASONS.map(item => {
            const on = feedbackReasons.includes(item.value);
            return <button type="button" key={item.value} className={on ? "chip on" : "chip"} aria-pressed={on} onClick={() => setFeedbackReasons(current => on ? current.filter(value => value !== item.value) : [...current, item.value])}>{item.label}</button>;
          })}</div>
          {feedbackReasons.length ? <label className="making-feedback__note"><span>再说具体一点 <small>可选</small></span><textarea className="generation-options__note" value={feedbackNote} maxLength={2000} placeholder="例如：多留一些能解释原因的卡，把重复的要点合起来。" aria-label="重新生成的补充说明" onChange={event => setFeedbackNote(event.currentTarget.value)} /></label> : null}
        </div>
      </details> : null}
    </fieldset>
    <footer className="generation-setup__footer">
      <p role={generationFailure ? "alert" : undefined}>{generationFailure ? `任务未开始：${generationFailure}` : dirty ? "笔记改动还没保存，保存后就可以开始。" : "从已保存的整篇笔记出题，写好后逐张挑选。"}</p>
      <div><button type="button" className="generation-setup__cancel" onClick={closeGenerationSetup}>再想想</button><button type="button" className="generation-setup__start" disabled={dirty || startingGeneration || !generationEnabled} onClick={startGeneration}><Sparkles size={17} aria-hidden="true" />{startingGeneration ? "正在创建任务…" : "开始生成"}</button></div>
    </footer>
  </section>;
}
