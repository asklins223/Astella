import { BookOpen, Lightbulb, ScanText, Sprout } from "lucide-react";
import type { NoteLearningEntry } from "./use-notebook-learning-entry";

const COPY = {
  overview: { label: "速看", Icon: ScanText, purpose: "把整篇的重点整理在一起，每一处都带着可以核对的原文。", working: "正在整理这篇的重点", result: "完成后，重点与原文出处会放在这一页。" },
  recall: { label: "回想", Icon: Lightbulb, purpose: "先回想一个问题，想不起时看一点线索，再翻开对应的原文。", working: "正在准备回想问题", result: "问题准备好后，先自己想，线索和原文由你决定何时打开。" },
  expansion: { label: "往外学", Icon: Sprout, purpose: "从这篇出发找值得继续读的内容。草稿先给你看，再由你决定收下哪篇。", working: "正在整理相关笔记草稿", result: "完成后可以逐篇翻开、编辑和选择；确认收下才会存入笔记库。" },
} as const;

/** Real state, expected result, and a route back to the note occupy the task page. */
export function NotebookLearningPage(props: {
  readonly kind: NoteLearningEntry;
  readonly title: string;
  readonly version: number;
  readonly state: "empty" | "loading" | "queued" | "running" | "failed";
  readonly error?: string | null;
  readonly onPrepare: () => void;
  readonly onBody: () => void;
  readonly onRetry: () => void;
  readonly onSettings?: () => void;
}) {
  const copy = COPY[props.kind], Icon = copy.Icon;
  const working = props.state === "queued" || props.state === "running" || props.state === "loading";
  const needsSettings = props.error === "ai_consent_required" || props.error === "ai_data_policy_denied";
  const failureDescription = props.error === "ai_consent_required"
    ? "需要先开启 AI 使用权限，再重试生成。"
    : props.error === "ai_data_policy_denied"
      ? "账号的数据外发策略阻止了这次生成。请到 AI 数据同意设置核对外部模型和图片内容的开关。"
    : props.error && props.error !== "unknown" ? props.error
      : "原文还在，已有内容也会保留。可以重新试一次。";
  return <section className="notebook-learning-page" data-state={props.state} aria-label={`${copy.label}准备页`} aria-busy={working}>
    <div className="notebook-learning-page__object" aria-hidden="true"><BookOpen size={58} strokeWidth={1.4} /><Icon size={22} /></div>
    <div className="notebook-learning-page__content">
      <h2>{props.state === "empty" ? `这篇还没有${copy.label}内容` : props.state === "loading" ? "正在翻找已有内容" : props.state === "failed" ? `这次${copy.label}没能完成` : copy.working}</h2>
      <p className="notebook-learning-page__note">{props.title} <span>v{props.version}</span></p>
      <p>{props.state === "empty" ? copy.purpose : working ? copy.result : failureDescription}</p>
      {working ? <p className="notebook-learning-page__phase" role="status"><span aria-hidden="true" />{props.state === "loading" ? "正在取回这篇已有的内容…" : props.state === "queued" ? "任务已创建，正在等待处理。" : "后台正在生成，可以继续读原文或离开，回来后仍能查看结果。"}</p> : null}
      <div className="actions">
        {props.state === "empty" ? <button type="button" className="button primary" onClick={props.onPrepare}>{props.kind === "recall" ? "准备回想问题" : `生成${copy.label}内容`}</button>
          : props.state === "failed" ? <button type="button" className="button primary" onClick={needsSettings ? props.onSettings : props.onRetry}>{needsSettings ? "去设置" : "再试一次"}</button> : null}
        {props.state === "failed" && needsSettings ? <button type="button" className="button" onClick={props.onRetry}>设置好了，再试一次</button> : null}
        <button type="button" className="text-action" onClick={props.onBody}>继续读原文</button>
      </div>
    </div>
  </section>;
}
