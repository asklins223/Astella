import { HighlightStyle, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tags } from "@lezer/highlight";

/**
 * 代码的墨色表：一个语法标签对应一个 CSS class。
 *
 * 笔记的三个视图（阅读、编辑、源码）与伴星递来的代码纸共用这一份——阅读与聊天用
 * `highlightCode` 把源码切成带 class 的片段，编辑器把同一张表交给 CodeMirror 的
 * `syntaxHighlighting`。发出去的是同一批类名，颜色就只有 `code-paper.css` 一个来源，
 * 不会出现「同一段代码换个地方另一种长相」。
 *
 * 颜色本身在 `--code-*` 里：日纸、夜纸与伴星那张暖纸各一套，都按自己的纸底核过 4.5:1。
 */
const codeTokenStyles = [
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier, tags.self], class: "code-keyword" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], class: "code-type" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], class: "code-call" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName, tags.definition(tags.propertyName)], class: "code-property" },
  { tag: [tags.string, tags.special(tags.string)], class: "code-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.constant(tags.variableName)], class: "code-number" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: "code-comment" },
  { tag: [tags.meta, tags.macroName, tags.annotation], class: "code-meta" },
  { tag: [tags.escape, tags.regexp, tags.color], class: "code-escape" },
];

/** 同一张表：既当 CodeMirror 的 highlighter，也当 `highlightCode` 的 highlighter。 */
export const codeHighlighter = HighlightStyle.define(codeTokenStyles);

/** 语言表也只有一份：编辑器挑语言、阅读侧认围栏，问的是同一张单子。 */
export const codeLanguages = languages;

/** 一块代码里连续的那一段：自己的 class 与在**整块源码**里的字符起点。 */
export type CodeSlice = {
  readonly text: string;
  readonly classes: string;
  readonly start: number;
};

export type CodeHighlight = {
  /** 这份结果是对着哪串字算出来的：流式回复里字还在长，旧切片就不能接着画。 */
  readonly source: string;
  /** 纸沿上那行小字：认出语言就说官方名，认不出就照抄围栏里写的那几个字。 */
  readonly label: string;
  /** `null` = 这门语言解析不了，照原文画。 */
  readonly lines: readonly (readonly CodeSlice[])[] | null;
};

/**
 * 在编辑器之外把一块代码切成片段，交给不跑 CodeMirror 的那几处纸面（阅读态、聊天）。
 *
 * 解析器按语言动态加载，第一次要等一个 chunk，所以调用方先照原文画、颜色随后补。
 */
export async function highlightCodeBlock(source: string, fence: string | undefined): Promise<CodeHighlight> {
  // 围栏里写的常常是缩写（```py、```rs、```md），而语言表的 alias 只收了部分；
  // 把它当扩展名再问一次，认出来的就是编辑器里同一门语言。
  const description = fence
    ? LanguageDescription.matchLanguageName(codeLanguages, fence, true)
      ?? LanguageDescription.matchFilename(codeLanguages, `note.${fence.toLowerCase()}`)
    : null;
  const label = description?.name ?? fence ?? "纯文本";
  if (!description) return { source, label, lines: null };
  const support = await description.load().catch(() => null);
  if (!support) return { source, label, lines: null };
  const lines: CodeSlice[][] = [];
  let current: CodeSlice[] = [];
  let offset = 0;
  highlightCode(source, support.language.parser.parse(source), codeHighlighter,
    (text, classes) => { current.push({ text, classes, start: offset }); offset += text.length; },
    () => { lines.push(current); current = []; offset += 1; });
  lines.push(current);
  return { source, label, lines };
}
