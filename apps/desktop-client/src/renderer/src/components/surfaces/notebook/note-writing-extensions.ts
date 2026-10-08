import { $nodeSchema, $markSchema, $remark, $prose, $inputRule } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { markRule } from "@milkdown/kit/prose";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import { noteWritingExtensions, noteSourceMarkdown, noteEquationLabels, noteEquationValue, noteMarkdownTree, type NoteMarkdownNode } from "@astella/shared/note-markdown";
import { createNoteMathPreview } from "../../content/readable-math";
import { getWritingFile, writingImage } from "./note-writing-assets";
export const noteSourceSchema = $nodeSchema("note_source", () => ({
  content: "text*", group: "block", code: true, defining: true,
  attrs: { noteStyle: { default: null }, kind: { default: "math" }, label: { default: "" }, sourceRef: { default: null }, imageAssetId: { default: null } },
  parseDOM: [{ tag: "div[data-note-source]", getAttrs: dom => ({ kind: (dom as HTMLElement).dataset.noteSource, label: (dom as HTMLElement).dataset.label ?? "" }) }],
  toDOM: node => ["div", { "data-note-source": node.attrs.kind, "data-label": node.attrs.label }, ["pre", ["code", 0]]],
  parseMarkdown: { match: node => ["math", "yaml", "footnoteDefinition", "noteToc"].includes(node.type),
    runner(state, node, type) {
      const kind = node.type === "footnoteDefinition" ? "footnote" : node.type === "noteToc" ? "toc" : node.type;
      state.openNode(type, { kind, label: node.identifier ?? "" });
      const text = kind === "footnote" ? String(node.noteFootnoteSource ?? "") : String(node.value ?? "");
      if (text) state.addText(text); state.closeNode();
    } },
  toMarkdown: { match: node => node.type.name === "note_source", runner: (state, node) => { state.addNode("html", undefined, noteSourceMarkdown(node.attrs.kind, node.textContent, node.attrs.label)); } },
}));
export const noteReferenceSchema = $nodeSchema("note_ref", () => ({
  inline: true, group: "inline", atom: true, attrs: { label: { default: "1" } },
  parseDOM: [{ tag: "sup[data-note-ref]", getAttrs: dom => ({ label: (dom as HTMLElement).dataset.noteRef }) }],
  toDOM: node => ["sup", { "data-note-ref": node.attrs.label, "aria-label": `脚注 ${node.attrs.label}` }, `[${node.attrs.label}]`],
  parseMarkdown: { match: node => node.type === "footnoteReference", runner: (state, node, type) => { state.addNode(type, { label: node.identifier }); } },
  toMarkdown: { match: node => node.type.name === "note_ref", runner: (state, node) => { state.addNode("html", undefined, `[^${node.attrs.label}]`); } },
}));
const marks = [["noteHighlight", "mark", /==([^=]+)==$/], ["noteSubscript", "sub", /(?<!~)~([^~\s]+)~$/], ["noteSuperscript", "sup", /\^([^\^\s]+)\^$/]] as const;
const schemas = marks.map(([name, tag]) => $markSchema(name, () => ({
  parseDOM: [{ tag }], toDOM: () => [tag, 0],
  parseMarkdown: { match: node => node.type === name, runner: (state, node, type) => { state.openMark(type); state.next(node.children); state.closeMark(type); } },
  toMarkdown: { match: mark => mark.type.name === name, runner: (state, mark) => { state.withMark(mark, name); } },
})));
/**
 * 写作扩展的 schema 部分。单独导出是为了让「编辑器认不认服务端窄规格」那条绑定测试
 * 装的是**产品这一份**，而不是手搓的近似物——名字对不上时红的是真链路。
 */
export const noteWritingSchemas = [noteSourceSchema, noteReferenceSchema, ...schemas];
export function noteWritingExtensionPlugins() {
  const refreshers = new Set<() => void>();
  return [$remark("note-display-math", () => remarkMath), $remark("note-frontmatter", () => function(this: unknown) { return Reflect.apply(remarkFrontmatter, this, [["yaml"]]); }), $remark("note-writing-extensions", () => noteWritingExtensions),
    $remark("note-toc-node", () => () => (tree: { children?: unknown[] }) => { const walk = (node: { type?: string; children?: unknown[] }) => { if (node.type === "paragraph" && node.children?.length === 1 && String((node.children[0] as { value?: string }).value).trim().toLowerCase() === "[toc]") node.type = "noteToc"; node.children?.forEach(child => walk(child as never)); }; walk(tree); }),
    $remark("note-inline-math-source", () => () => (tree: { children?: unknown[] }, file: { value: unknown }) => {
      const source = String(file.value); const walk = (parent: { children?: unknown[] }) => { parent.children = parent.children?.map(value => { const node = value as { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: unknown[] };
        if (node.type === "inlineMath") return { type: "text", value: node.position ? source.slice(node.position.start.offset ?? 0, node.position.end.offset ?? 0) : `$${node.value ?? ""}$`, position: node.position }; walk(node); return node; }); }; walk(tree);
    }), ...noteWritingSchemas, ...marks.map(([, , regexp], index) => $inputRule(ctx => markRule(regexp, schemas[index]!.type(ctx)))),
    $prose(() => new Plugin({ props: { nodeViews: { note_ref(initial, view) {
      let node = initial; const dom = document.createElement("sup"), button = document.createElement("button"); dom.contentEditable = "false"; dom.append(button); button.type = "button";
      const refresh = () => { dom.dataset.noteRef = node.attrs.label; const labels = new Set<string>(); view.state.doc.descendants(ref => { if (ref.type.name === "note_ref") labels.add(ref.attrs.label); });
        button.textContent = `[${Math.max(1, [...labels].indexOf(node.attrs.label) + 1)}]`; button.setAttribute("aria-label", `前往脚注 ${node.attrs.label}`); }; refresh(); refreshers.add(refresh);
      button.addEventListener("mousedown", event => event.preventDefault()); button.addEventListener("click", () => { let target: number | null = null; view.state.doc.descendants((candidate, pos) => { if (candidate.type.name === "note_source" && candidate.attrs.kind === "footnote" && candidate.attrs.label === node.attrs.label) target = pos + 1; }); if (target !== null) { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)).scrollIntoView()); view.focus(); const element = view.nodeDOM(target - 1); if (element instanceof HTMLElement) element.scrollIntoView?.({ block: "nearest" }); } });
      return { dom, update(next) { if (next.type !== node.type) return false; node = next; refresh(); return true; }, stopEvent: event => dom.contains(event.target as Node), ignoreMutation: () => true, destroy: () => refreshers.delete(refresh) };
    }, note_source(initial, view, getPos) {
      let node = initial;
      const dom = document.createElement("div"); dom.className = "note-source-block";
      const header = document.createElement("div"); header.className = "note-source-block__header"; header.contentEditable = "false";
      const label = document.createElement("input"); label.setAttribute("aria-label", "脚注标识");
      const caption = document.createElement("span"), preview = document.createElement("div"), pre = document.createElement("pre"), contentDOM = document.createElement("code");
      preview.className = "note-source-block__preview"; preview.contentEditable = "false"; pre.className = "note-source-block__source";
      pre.append(contentDOM); header.append(caption, label); dom.append(header, preview, pre);
      const update = () => {
        const pos = getPos(), kind = String(node.attrs.kind); dom.dataset.kind = kind;
        const inside = pos !== undefined && view.state.selection.from >= pos && view.state.selection.to <= pos + node.nodeSize;
        dom.dataset.editing = String(inside || kind === "yaml");
        caption.textContent = ({ math: "公式 · ⌘/Ctrl+Enter 退出", yaml: "YAML 元数据", footnote: "脚注", toc: "正文目录" } as Record<string, string>)[kind] ?? kind;
        label.hidden = kind !== "footnote"; label.disabled = !view.editable; if (document.activeElement !== label) label.value = node.attrs.label;
        preview.replaceChildren();
        if (kind === "math") { const equations: string[] = []; let number = 1; view.state.doc.descendants((candidate, at) => { if (candidate.type.name === "note_source" && candidate.attrs.kind === "math") { equations.push(candidate.textContent); if (at === pos) number = equations.length; } }); const math = createNoteMathPreview(noteEquationValue(node.textContent, noteEquationLabels(equations), number), true); if (math) preview.append(math); else preview.textContent = node.textContent || "点击输入公式"; }
        else if (kind === "footnote") {
          const render = (part: NoteMarkdownNode): globalThis.Node => {
            if (part.type !== "element") return document.createTextNode(part.type === "text" ? part.value : "");
            if (part.properties.dataNoteMath !== undefined) return createNoteMathPreview(String(part.properties.dataNoteMath), part.properties.dataNoteMathDisplay !== undefined) ?? document.createTextNode(part.children.map(child => child.type === "text" ? child.value : "").join(""));
            const element = document.createElement(part.tagName);
            for (const [key, value] of Object.entries(part.properties)) if (["href", "alt", "title", "style", "width", "height", "align", "type", "checked"].includes(key) && value !== false) element.setAttribute(key, String(value));
            if (element instanceof HTMLInputElement) element.disabled = true;
            if (part.tagName === "img" && part.properties.src) {
              const src = String(part.properties.src);
              if (window.astella?.noteWriting) void writingImage(src, getWritingFile(view.dom)).then(image => { if (element.isConnected) element.setAttribute("src", `data:${image.mime};base64,${image.base64}`); }).catch(() => element.setAttribute("alt", `${part.properties.alt ?? "图片"}（无法读取）`));
              else if (/^(?:https?:|data:image\/)/.test(src)) element.setAttribute("src", src);
            }
            part.children.forEach(child => element.append(render(child))); return element;
          };
          noteMarkdownTree(node.textContent).children.forEach(part => preview.append(render(part)));
        }
        else if (kind === "toc") { view.state.doc.descendants((heading, at) => {
          if (heading.type.name !== "heading") return; const link = document.createElement("button"); link.type = "button"; link.textContent = heading.textContent;
          link.style.paddingInlineStart = `${(heading.attrs.level - 1) * 16}px`; link.addEventListener("click", () => { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at + 1))).scrollIntoView()); view.focus(); const element = view.nodeDOM(at); if (element instanceof HTMLElement) element.scrollIntoView?.({ block: "start" }); }); preview.append(link);
        }); if (!preview.childNodes.length) preview.textContent = "添加标题后自动生成目录"; }
      };
      label.addEventListener("change", () => { const pos = getPos(); if (pos === undefined || !view.editable) return;
        const clean = label.value.replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 80); if (!clean) { label.value = node.attrs.label; return; }
        const tr = view.state.tr, previous = node.attrs.label; tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: clean });
        tr.doc.descendants((ref, at) => { if (ref.type.name === "note_ref" && ref.attrs.label === previous) tr.setNodeMarkup(at, undefined, { ...ref.attrs, label: clean }); }); view.dispatch(tr);
      });
      preview.addEventListener("click", event => { if ((event.target as HTMLElement).closest("a")) event.preventDefault(); });
      preview.addEventListener("mousedown", event => { if ((event.target as HTMLElement).closest("button")) return; const pos = getPos(); if (pos === undefined) return;
        event.preventDefault(); view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1)))); view.focus(); });
      update(); refreshers.add(update); view.dom.addEventListener("note-local-file-change", update);
      return { dom, contentDOM, update(next) { if (next.type !== node.type) return false; node = next; update(); return true; },
        stopEvent: event => header.contains(event.target as globalThis.Node) || preview.contains(event.target as globalThis.Node),
        ignoreMutation: mutation => mutation.type !== "selection" && !contentDOM.contains(mutation.target), destroy() { refreshers.delete(update); view.dom.removeEventListener("note-local-file-change", update); } };
    } }, handleDOMEvents: { keydown(view, raw) {
      const event = raw as KeyboardEvent; if (event.isComposing || view.composing || !view.editable) return false;
      const { $from } = view.state.selection;
      if ($from.parent.type.name !== "note_source" || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return false;
      const end = $from.after(), tr = view.state.tr.insert(end, view.state.schema.nodes.paragraph!.create());
      view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1))).scrollIntoView()); event.preventDefault(); return true;
    } } }, view: () => ({ update() { refreshers.forEach(refresh => refresh()); } }) })),
  ];
}
