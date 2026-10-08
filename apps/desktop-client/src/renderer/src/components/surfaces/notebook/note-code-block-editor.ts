import { $prose, $view } from "@milkdown/kit/utils";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { CodeMirrorBlock, codeBlockConfig, codeBlockView, type CodeBlockConfig } from "@milkdown/kit/component/code-block";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView as CodeMirror, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Plugin } from "@milkdown/kit/prose/state";
import { undoCommand, redoCommand } from "y-prosemirror";
import { noteAiLockKey } from "./note-ai-lock";
import { copyText } from "../../../app/clipboard";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NoteMermaid } from "./note-mermaid";
export { codeBlockConfig };
export const noteCodeLanguages = languages;

/** The existing CodeMirror component supplies languages and editing; history belongs to our shared document. */
export function noteCodeBlockPlugins() {
  const views = new Set<() => void>();
  const nodeView = $view(codeBlockSchema.node, ctx => (node, view, getPos, decorations, innerDecorations) => {
    const writable = () => { const pos = getPos(); return view.editable && pos !== undefined && !(noteAiLockKey.getState(view.state) ?? []).some(lock => pos >= lock.from && pos < lock.to); };
    const readOnly = new Compartment(); let fromDocument = false, lastReadonly = !writable();
    let previewRoot: Root | null = null, previewElement: HTMLElement | null = null;
    const config: CodeBlockConfig = { ...ctx.get(codeBlockConfig.key), languages,
      copyText: "复制代码", searchPlaceholder: "搜索代码语言", noResultText: "没有找到这个语言", expandIcon: "⌄", searchIcon: "⌕", clearSearchIcon: "×", copyIcon: "",
      onCopy: text => { void copyText(text); },
      previewLabel: "图表预览", previewLoading: "正在绘制图表…", previewToggleButton: only => only ? "编辑图表" : "只看图表",
      renderPreview: (language, source) => {
        if (language.toLowerCase() !== "mermaid") return null;
        if (!previewElement) { previewElement = document.createElement("div"); previewRoot = createRoot(previewElement); }
        previewRoot!.render(createElement(NoteMermaid, { source })); return previewElement;
      },
      extensions: [lineNumbers(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle), CodeMirror.lineWrapping,
        Prec.highest(readOnly.of(EditorState.readOnly.of(lastReadonly))),
        EditorState.changeFilter.of(() => fromDocument || writable()),
        Prec.highest(keymap.of([
          { key: "Mod-z", run: () => { if (!writable()) return true; undoCommand(view.state, view.dispatch); return true; } },
          { key: "Mod-Shift-z", run: () => { if (!writable()) return true; redoCommand(view.state, view.dispatch); return true; } },
          { key: "Mod-y", run: () => { if (!writable()) return true; redoCommand(view.state, view.dispatch); return true; } },
          indentWithTab,
        ])),
      ],
    };
    const leaf = codeBlockView.view(node, view, getPos, decorations, innerDecorations);
    if (!(leaf instanceof CodeMirrorBlock)) return leaf;
    leaf.config = config;
    const update = leaf.update.bind(leaf);
    leaf.update = next => { fromDocument = true; try { return update(next); } finally { fromDocument = false; } };
    const refresh = () => {
      const next = !writable();
      if (next !== lastReadonly && leaf.cm) { lastReadonly = next; leaf.cm.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(next)) }); }
      leaf.dom.dataset.readonly = String(next);
    };
    views.add(refresh); const destroy = leaf.destroy.bind(leaf);
    leaf.destroy = () => { views.delete(refresh); destroy(); const root = previewRoot; previewRoot = null; if (root) queueMicrotask(() => root.unmount()); };
    return leaf;
  });
  return [codeBlockConfig, codeBlockView, nodeView, $prose(() => new Plugin({ view: () => ({ update: () => views.forEach(refresh => refresh()) }) }))];
}
