import { noteEquationLabels, noteEquationValue } from "@astella/shared/note-markdown";
import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { noteMathHtml, createNoteMathPreview } from "../../content/readable-math";

/** Formulas show their source while the caret/selection touches them, and render after leaving. */
export function noteEditorMathPreview() {
  return $prose(() => new Plugin({ props: { decorations(state) {
    const decorations: Decoration[] = []; const equations: string[] = []; state.doc.descendants(node => { if (node.type.name === "note_source" && node.attrs.kind === "math") equations.push(node.textContent); }); const labels = noteEquationLabels(equations);
    state.doc.descendants((node, pos, parent) => {
      if (!node.isText || parent?.type.name === "code_block" || node.marks.some(mark => mark.type.name === "inlineCode")) return;
      const text = node.text!;
      for (const match of text.matchAll(/\$\$([^]*?)\$\$|(?<![\\$])\$(?![\s\d])([^$\n]+?)(?<!\s)\$(?!\$)/g)) {
        const from = pos + match.index, to = from + match[0].length;
        if (state.selection.from <= to && state.selection.to >= from) continue;
        const value = noteEquationValue(match[1] ?? match[2]!, labels), display = match[1] !== undefined, html = noteMathHtml(value, display);
        if (!html) continue;
        decorations.push(Decoration.inline(from, to, { class: "note-editor-math-source" }));
        decorations.push(Decoration.widget(from, view => {
          const element = createNoteMathPreview(value, display)!; element.className = "note-editor-math-preview";
          element.dataset.display = String(display); element.dataset.noteDecoration = "true"; element.contentEditable = "false";
          element.addEventListener("mousedown", event => { event.preventDefault(); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + (display ? 2 : 1)))); view.focus(); });
          return element;
        }, { key: `${from}:${match[0]}`, side: -1 }));
      }
    });
    return DecorationSet.create(state.doc, decorations);
  } } }));
}
