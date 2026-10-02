import { Quote } from "lucide-react";
import { feedSelectionToCompanion } from "./companion-feed";
import { noteExplanationLabel, openNoteExplanation, saveNoteExplanation, type NoteCompanionExplanation } from "./note-companion-explanation";

/** The quote travels with its reply, using the bubble's placement and lifetime. */
export function CompanionNoteExplanationContext({ item }: { readonly item: NoteCompanionExplanation }) {
  return <div className="companion-hud__selection-context" data-phase={item.phase}>
    <Quote size={13} aria-hidden="true" />
    <button type="button" className="companion-hud__selection-quote" title={item.target.anchor.excerpt}
      aria-label={`查看原句解释：${item.target.anchor.excerpt}`} onClick={() => openNoteExplanation(item.id)}>{item.target.anchor.excerpt}</button>
    <span role="status">{noteExplanationLabel(item)}</span>
    {item.phase === "save-error" ? <button type="button" className="text-action" onClick={() => void saveNoteExplanation(item.id)}>重试保存批注</button> : null}
    {item.phase === "interrupted" ? <button type="button" className="text-action" onClick={() => feedSelectionToCompanion({ text: item.target.anchor.excerpt, source: "selection", noteAnchor: item.target,
      initialPrompt: "请用通俗易懂的话重新完整解释这段；如果举个具体例子会更清楚，也请举例。" })}>重试这段解释</button> : null}
  </div>;
}
