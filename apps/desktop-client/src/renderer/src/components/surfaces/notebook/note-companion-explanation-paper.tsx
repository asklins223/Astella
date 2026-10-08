import { feedSelectionToCompanion } from "../../companion/companion-feed";
import { dismissNoteExplanation, noteExplanationBusy, openNoteExplanation, saveNoteExplanation, type NoteCompanionExplanation } from "../../companion/note-companion-explanation";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import { NoteAnnotationQuote, NoteExplanationStatus } from "./note-annotation-paper";
import { PencilLine, RotateCcw, Square } from "lucide-react";

export function NoteCompanionExplanationPaper(props: {
  readonly item: NoteCompanionExplanation;
  readonly onStop: () => void;
  readonly onWrite: () => void;
  readonly onDismiss: () => void;
}) {
  const { item } = props;
  const unfinished = item.phase === "stopped" || item.phase === "interrupted";
  return <section className="note-annotation-paper note-companion-explanation" aria-label="伴星原句解释" aria-busy={noteExplanationBusy(item)}>
    <NoteAnnotationQuote excerpt={item.target.anchor.excerpt} />
    <NoteExplanationStatus item={item} />
    <p className="small">{item.phase === "preparing" || item.phase === "explaining" ? "完整解释会自动贴成批注。你可以继续阅读，也可以在这句上另写自己的批注。"
      : item.phase === "saving" ? "解释已生成，正在等待批注保存回执。"
      : item.phase === "save-error" ? "完整解释还在这里。重试只保存这一份解释。"
      : unfinished ? item.text ? "以下是未完成的内容，没有写成批注。" : "没有留下批注，可以随时重新解释。"
      : item.annotation?.versionState === "older" ? "笔记版本已更新，这条解释留在旧版记录中。" : "解释已保存，合起附页后仍能从原句打开。"}</p>
    {item.error ? <p className="small" role="alert">{item.error}</p> : null}
    {item.text ? <div className="note-annotation-paper__explanation" data-incomplete={unfinished || undefined}>{renderCompanionMarkdown(item.text)}</div> : null}
    <div className="note-annotation-paper__actions">
      <button type="button" className="button note-annotation-paper__write" onClick={props.onWrite}><PencilLine size={16} aria-hidden="true" />另写自己的批注</button>
      {item.phase === "preparing" || item.phase === "explaining" ? <button type="button" className="text-action" onClick={props.onStop}><Square size={13} aria-hidden="true" />停止解释</button> : null}
      {item.phase === "stopped" && item.stopUnconfirmed ? <button type="button" className="text-action" onClick={props.onStop}><Square size={13} aria-hidden="true" />重试停止</button> : null}
      {item.phase === "save-error" ? <button type="button" className="button" onClick={() => void saveNoteExplanation(item.id)}>重试保存批注</button> : null}
      {unfinished ? <button type="button" className="button" onClick={() => {
        const nextId = feedSelectionToCompanion({ text: item.target.anchor.excerpt, source: "selection", noteAnchor: item.target,
          initialPrompt: "请用通俗易懂的话重新完整解释这段；如果举个具体例子会更清楚，也请举例。" });
        if (nextId) openNoteExplanation(nextId);
      }}><RotateCcw size={16} aria-hidden="true" />重新解释</button> : null}
      {!noteExplanationBusy(item) && item.phase !== "saved" ? <button type="button" className="text-action" onClick={() => { dismissNoteExplanation(item.id); props.onDismiss(); }}>收起这次状态</button> : null}
    </div>
  </section>;
}
