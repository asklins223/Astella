import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type Ref } from "react";
import { BookOpen, ChevronDown, RotateCcw } from "lucide-react";
import { markdownToBlocks } from "@ailearn/shared/markdown-parser";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import type { NoteRecallCardV1, RecallActionV1, RecallBusyV1, RecallSelfReportV1 } from "./notebook-recall-contract";
import { recallQuestionText } from "./recall-question-text";
import { ReadingBlockContent } from "./notebook-reading-block";
import { useNotebookPaperMotion, useNotebookPaperPresence } from "./use-notebook-paper-motion";

/** A question is the focus. Durable reveal receipts never unfold this visit's comparison. */
export function NoteRecallPaper(props: {
  readonly recall: NoteRecallCardV1;
  readonly busy: RecallBusyV1;
  readonly failure: string | null;
  readonly reflection: string;
  readonly paperRef: Ref<HTMLElement>;
  readonly onCollapse: () => void;
  readonly onAct: (action: RecallActionV1) => Promise<void>;
  readonly onReflectionChange: (value: string) => void;
  readonly onLocateSection: (ordinal: number) => void;
  readonly onNew?: () => void;
  readonly presentation?: "practice" | "history";
  readonly workspaceEpoch?: number;
}): ReactElement {
  const { recall, busy } = props;
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [reporting, setReporting] = useState<RecallSelfReportV1 | null>(null);
  const wantsAnswer = useRef(false), wantsHint = useRef(false);
  const questionRef = useRef<HTMLHeadingElement | null>(null);
  const stampRef = useRef<HTMLParagraphElement | null>(null);
  const previousReport = useRef(recall.selfReport);
  const play = useNotebookPaperMotion();
  const comparison = useNotebookPaperPresence(comparisonOpen && recall.answer ? recall.answer : null, "comparison", "fold", play);
  const clue = useNotebookPaperPresence(hintOpen && recall.hint ? recall.hint : null, "hint", "fold", play);
  const broadSnapshot = !recall.sectionOrdinal && (recall.answer?.length ?? 0) > 1200;
  useLayoutEffect(() => { questionRef.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (!comparisonOpen || !comparison.ref.current) return;
    comparison.ref.current.focus({ preventScroll: true });
    comparison.ref.current.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, [comparisonOpen, Boolean(comparison.value)]);
  useEffect(() => {
    if (wantsAnswer.current && recall.answer) { wantsAnswer.current = false; setComparisonOpen(true); }
    if (wantsHint.current && recall.hint) { wantsHint.current = false; setHintOpen(true); }
  }, [recall.answer, recall.hint]);
  useEffect(() => { if (props.failure) { wantsAnswer.current = false; wantsHint.current = false; } }, [props.failure]);
  useLayoutEffect(() => {
    if (recall.selfReport && !previousReport.current) {
      play(stampRef.current, "stamp");
      stampRef.current?.focus({ preventScroll: true });
      stampRef.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    }
    previousReport.current = recall.selfReport;
  }, [recall.selfReport, play]);
  const reveal = () => {
    if (recall.answer) setComparisonOpen(true);
    else { wantsAnswer.current = true; void props.onAct({ kind: "reveal" }); }
  };
  const hint = () => {
    if (recall.hint) setHintOpen(!hintOpen);
    else { wantsHint.current = true; void props.onAct({ kind: "hint" }); }
  };
  const report = async (value: RecallSelfReportV1) => {
    setReporting(value);
    try { await props.onAct({ kind: "self_report", value, ...(props.reflection.trim() ? { reflection: props.reflection.trim() } : {}) }); }
    finally { setReporting(null); }
  };
  const snapshot = (text: string) => <div className="note-transcript">{markdownToBlocks(text).map((block, ordinal) => <ReadingBlockContent key={ordinal} block={{ ...block, ordinal }} mark={null} workspaceEpoch={props.workspaceEpoch} />)}</div>;
  return <article className="note-recall-paper" aria-label="这篇笔记的回想" ref={props.paperRef} data-phase={comparisonOpen ? "comparison" : "thinking"}>
    <header><span>笔记 v{recall.noteVersionNumber}{recall.versionState === "older" ? " · 旧版" : ""}{props.presentation === "history" ? " · 当时留下的问题" : ""}</span>
      <button type="button" className="text-action" onClick={props.onCollapse}>{props.presentation === "history" ? "回学习记录" : "回正文"}</button></header>
    <h2 className="note-recall-paper__question" ref={questionRef} tabIndex={-1} data-task-focus>{recallQuestionText(recall.question)}</h2>
    <p className="note-recall-paper__instruction">不用急着作答。想起几个关键词，再翻开对照。</p>
    {recall.selfReport === null ? <details className="note-recall-paper__reflection">
      <summary><PencilMark />记几个关键词 <span>可不写</span></summary>
      <label className="sr-only" htmlFor="note-recall-reflection">先记下你想起的内容（可不写）</label>
      <textarea id="note-recall-reflection" maxLength={2000} value={props.reflection} onChange={event => props.onReflectionChange(event.currentTarget.value)} placeholder="你刚才想起了什么？" />
    </details> : null}
    {clue.value ? <aside className="note-recall-paper__hint" ref={clue.ref} inert={clue.closing} aria-hidden={clue.closing || undefined}><strong>一点线索</strong>{renderCompanionMarkdown(clue.value)}</aside> : null}
    <div className="note-recall-paper__actions">
      {!comparisonOpen ? <button type="button" className="button primary" disabled={busy !== null} onClick={reveal}><BookOpen size={16} aria-hidden="true" />{busy === "reveal" ? "正在翻开…" : "翻开原文对照"}</button>
        : <button type="button" className="text-action" onClick={() => setComparisonOpen(false)}>合起对照</button>}
      {!comparisonOpen && (recall.hint || !recall.answer) ? <button type="button" className="text-action" disabled={busy !== null || (!recall.hint && recall.versionState === "older")} onClick={hint}>{busy === "hint" ? "正在取线索…" : hintOpen ? "收起线索" : "看一点线索"}</button> : null}
      {props.onNew ? <button type="button" className="text-action" disabled={busy !== null} onClick={props.onNew}><RotateCcw size={13} aria-hidden="true" />{busy === "start" ? "正在准备新问题…" : "重新生成回想"}</button> : null}
    </div>
    {props.failure ? <p className="note-recall-paper__error" role="alert">这一步没记下来：{props.failure}</p> : null}
    {comparison.value ? <section className="note-recall-paper__answer" aria-label="原文对照" tabIndex={-1} ref={comparison.ref} inert={comparison.closing} aria-hidden={comparison.closing || undefined}>
      <header><strong>原文对照</strong><span>笔记 v{recall.noteVersionNumber}{recall.sectionTitle ? ` · ${recall.sectionTitle}` : ""}</span>
        {recall.versionState === "current" && recall.sectionOrdinal ? <button type="button" className="text-action" onClick={() => props.onLocateSection(recall.sectionOrdinal! - 1)}>回到原文</button> : null}</header>
      {recall.versionState === "older" ? <small>笔记后来改过，这里保留的是当时的原文快照。</small> : null}
      {broadSnapshot ? <><p className="note-recall-paper__instruction">这条旧记录保存了整篇原文，没有标定问题对应的段落。可以换一处回想，也可以按需查看当时的快照。</p><details><summary>查看当时完整原文快照</summary>{snapshot(comparison.value)}</details></> : snapshot(comparison.value)}
      {recall.answerTruncated ? <small>这一段较长，这里保留了其中一段摘录。</small> : null}
      {recall.selfReport === null ? <div className="note-recall-paper__report" role="group" aria-label="这次想起来多少">
        <span>对照以后，刚才想起来多少？</span><div>{([ ["remembered", "基本想起来了"], ["partly", "想起了一部分"], ["not_yet", "还得重看"] ] as const).map(([value, label]) => <button key={value} type="button" className="button" disabled={busy !== null} onClick={() => void report(value)}>{busy === "report" && reporting === value ? "正在记下…" : label}</button>)}</div>
      </div> : null}
    </section> : null}
    {recall.selfReport ? <p className="note-recall-paper__saved" ref={stampRef} role="status" tabIndex={-1}>已记下 · {recall.selfReport === "remembered" ? "基本想起来了" : recall.selfReport === "partly" ? "想起了一部分" : "还得重看"}{props.reflection ? `\n${props.reflection}` : ""}</p> : null}
  </article>;
}
function PencilMark() { return <ChevronDown size={13} aria-hidden="true" />; }
