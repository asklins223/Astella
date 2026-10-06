import { useEffect, useRef } from "react";
import type { NoteAnnotationAnchorV1 } from "@astella/shared/note-annotation-contracts";
import { noteExplanationBusy, noteExplanationLabel, type NoteCompanionExplanation } from "../../companion/note-companion-explanation";

export function NotebookAnnotationComposer(props: {
  readonly anchor: NoteAnnotationAnchorV1; readonly text: string; readonly saving: boolean; readonly error: string | null;
  readonly onChange: (text: string) => void; readonly onSave: () => void;
  readonly companionExplanation?: NoteCompanionExplanation;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return <section className="note-annotation-paper note-annotation-composer" aria-label="写自己的批注">
    <blockquote>{props.anchor.excerpt}</blockquote>
    {props.companionExplanation ? <p className="small note-companion-explanation__status" role="status">{noteExplanationLabel(props.companionExplanation)}。{noteExplanationBusy(props.companionExplanation)
      ? "你的批注会单独保存，伴星完成后不会覆盖这里的输入。" : "你的批注会单独保存。"}</p> : null}
    <label htmlFor="note-annotation-draft">记下你的理解</label>
    <textarea id="note-annotation-draft" ref={ref} value={props.text} maxLength={8_000} rows={5} disabled={props.saving}
      onChange={event => props.onChange(event.currentTarget.value)} placeholder="想法、疑问，或一个自己的例子…" />
    <p className="small">合起附页会保留这次输入。保存后会在原句留下一枚批注记号。</p>
    {props.error ? <p className="small" role="alert">{props.error}</p> : null}
    <button type="button" className="button primary" disabled={props.saving || !props.text.trim()} onClick={props.onSave}>{props.saving ? "正在贴回原句…" : "保存批注"}</button>
  </section>;
}
