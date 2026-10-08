import { Check, CircleAlert, Quote, Sparkles } from "lucide-react";
import { noteExplanationBusy, noteExplanationLabel, type NoteCompanionExplanation } from "../../companion/note-companion-explanation";

export function NoteAnnotationQuote({ excerpt }: { readonly excerpt: string }) {
  return <div className="note-annotation-paper__quote">
    <span><Quote size={14} aria-hidden="true" />原文这一句</span>
    <blockquote>{excerpt}</blockquote>
  </div>;
}

export function NoteExplanationStatus({ item }: { readonly item: NoteCompanionExplanation }) {
  const Icon = item.phase === "saved" ? Check : noteExplanationBusy(item) ? Sparkles : CircleAlert;
  return <p className="note-companion-explanation__status" data-phase={item.phase} role="status">
    <Icon size={16} aria-hidden="true" />{noteExplanationLabel(item)}
  </p>;
}
