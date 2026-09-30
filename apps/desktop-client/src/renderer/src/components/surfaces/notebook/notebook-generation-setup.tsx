/**
 * 生成学习卡之前的那一步设置（`generation-setup` 那个对话框）。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 149 行、15 个外部符号，是那份文件里第二个依赖最少的区域（最少的已搬走）。
 * 关键是它**自带完整的状态面**：选项、反馈、理由、失败、进行中——都在这一个对话框里，
 * 不与页面别处共享，所以可以整体搬走而不用先把哪个 state 收成 hook。
 *
 * 依赖里那两个带括号的（`generationOptionSummary` / `cardGenerationStatusLabel`）
 * 是**页面级纯函数**，按函数传进去而不是重写——重写一遍摘要逻辑比搬 149 行 JSX 危险得多。
 *
 * ⚠️ JSX 逐字搬。`role="dialog"` / `aria-modal` / `onMouseDown` 那层遮罩点击关闭
 * （不是 `onClick`，避免在对话框内部按下又松开时误关）都是原样保留。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { Dispatch, ReactElement, SetStateAction } from "react";
import {
  CARD_LIMITS,
  DETAIL_THRESHOLDS,
  FEEDBACK_REASONS,
  LEARNING_GOALS,
  STRATEGIES,
  type GenerationOptions,
} from "./notebook-generation-options.ts";
import { Sparkles } from "lucide-react";
import type { DesktopCardGenerationFeedbackReasonV2 } from "@ailearn/shared/card-generation-desktop-contracts";

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
  return (
<section className="generation-setup" role="dialog" aria-modal="true" aria-labelledby="generation-setup-title" onKeyDown={(event) => {
  if (event.key === "Escape") { event.stopPropagation(); closeGenerationSetup(); }
  if (event.key !== "Tab") return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
}}>
<header className="generation-setup__header">
  <span className="generation-setup__eyebrow">从笔记到一叠新卡</span>
  <h2 id="generation-setup-title">安排这次出题</h2>
  <p>从已保存的整篇笔记出发。先选你想练的方向，生成后再逐张审核。</p>
  <button autoFocus type="button" className="generation-setup__close" aria-label="关闭生成方案" onClick={closeGenerationSetup}>×</button>
</header>
<fieldset className="generation-options">
  <legend>生成方案</legend>
  <div className="generation-options__row">
    <span className="generation-options__label">学习卡</span>
    {LEARNING_GOALS.map((item) => (
      <button
        key={item.value}
        type="button"
        className={options.learningGoal === item.value ? "chip on" : "chip"}
        aria-pressed={options.learningGoal === item.value}
        onClick={() => setOptions((current) => ({ ...current, learningGoal: item.value }))}
      >
        {item.label}
      </button>
    ))}
  </div>
  <div className="generation-options__row">
    <span className="generation-options__label">详略</span>
    {DETAIL_THRESHOLDS.map((item) => (
      <button
        key={item.value}
        type="button"
        className={options.detailThreshold === item.value ? "chip on" : "chip"}
        aria-pressed={options.detailThreshold === item.value}
        onClick={() => setOptions((current) => ({ ...current, detailThreshold: item.value }))}
      >
        {item.label}
      </button>
    ))}
  </div>
  <div className="generation-options__row">
    <span className="generation-options__label">卡片上限</span>
    {CARD_LIMITS.map((limit) => (
      <button
        key={limit}
        type="button"
        className={options.hardMaxCards === limit ? "chip on" : "chip"}
        aria-pressed={options.hardMaxCards === limit}
        onClick={() => setOptions((current) => ({ ...current, hardMaxCards: limit }))}
      >
        {limit} 张
      </button>
    ))}
  </div>
  <div className="generation-options__row">
    <span className="generation-options__label">学习卡型</span>
    {STRATEGIES.map((item) => {
      const on = options.preferredStrategies.includes(item.value);
      return (
        <button
          key={item.value}
          type="button"
          className={on ? "chip on" : "chip"}
          aria-pressed={on}
          // The run contract wants at least one strategy; the last one on
          // stays on rather than sending an empty list.
          disabled={on && options.preferredStrategies.length === 1}
          title={on && options.preferredStrategies.length === 1 ? "至少保留一种题型" : undefined}
          onClick={() => setOptions((current) => ({
            ...current,
            preferredStrategies: on
              ? current.preferredStrategies.filter((value) => value !== item.value)
              : [...current.preferredStrategies, item.value],
          }))}
        >
          {item.label}
        </button>
      );
    })}
  </div>
  {/* 让勾选成为筛选。顺序由 planner-service.allocateStrategies 按适配度定，
      与勾选顺序无关——这里说清，是因为默认值就是全勾选。 */}
  <p className="small">
    这些是每张卡的思考策略，不是作答按钮。默认允许全部七种；取消某种后，系统便不会采用它。
  </p>
  {feedbackTarget ? (
    <>
      <div className="generation-options__row">
        <span className="generation-options__label">针对上次</span>
        <span className="small">
          上次生成{cardGenerationStatusLabel(feedbackTarget.status)} · {formatRelative(feedbackTarget.updatedAt)}
          {feedbackReasons.length ? "" : "（选原因即按反馈重生成）"}
        </span>
      </div>
      <div className="generation-options__row">
        {FEEDBACK_REASONS.map((item) => {
          const on = feedbackReasons.includes(item.value);
          return (
            <button
              key={item.value}
              type="button"
              className={on ? "chip on" : "chip"}
              aria-pressed={on}
              onClick={() => setFeedbackReasons((current) => (on
                ? current.filter((value) => value !== item.value)
                : [...current, item.value]))}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {feedbackReasons.length ? (
        <div className="generation-options__row">
          <span className="generation-options__label">补充说明</span>
          <input
            className="generation-options__note"
            value={feedbackNote}
            maxLength={2000}
            placeholder="可选，写给下一次生成的说明"
            aria-label="重新生成的补充说明"
            onChange={(event) => setFeedbackNote(event.currentTarget.value)}
          />
        </div>
      ) : null}
    </>
  ) : null}
  <p className="small">
    本次：{generationOptionSummary(options)}
    {feedbackTarget && feedbackReasons.length
      ? ` · 按反馈重生成（${feedbackReasons
        .map((value) => FEEDBACK_REASONS.find((item) => item.value === value)?.label ?? value)
        .join("+")}）`
      : ""}
  </p>
</fieldset>
<footer className="generation-setup__footer">
  <p role={generationFailure ? "alert" : undefined}>{generationFailure ? `任务未开始：${generationFailure}` : dirty ? "请先保存当前改动，再从已保存版本开始生成。" : "生成在后台进行；候选写好后由你逐张决定。"}</p>
  <div>
    <button type="button" className="generation-setup__cancel" onClick={closeGenerationSetup}>再想想</button>
    <button type="button" className="generation-setup__start" disabled={dirty || startingGeneration || !generationEnabled} onClick={() => void startGeneration()}><Sparkles size={17} aria-hidden="true" />{startingGeneration ? "正在创建任务…" : "开始生成"}</button>
  </div>
</footer>
</section>
  );
}
