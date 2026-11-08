import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { CodePaper } from "../../content/code-paper";
import { ReadableMath } from "../../content/readable-math";
import { renderCompanionMarkdown } from "./companion-markdown";
import { WebCitationText, type WebCitation } from "./companion-web-citations";

type Props = { children?: ReactNode; text?: string; source?: string; visibleCharacters?: number };
const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const prepared = new Map<string, { nodes: ReactNode[]; ends: number[]; lengths: number[] }>();

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement<Props>(node)) return "";
  if (node.type === CodePaper || node.type === ReadableMath) return node.props.source ?? "";
  if (node.type === WebCitationText) return node.props.text ?? "";
  if (node.type === "br") return "\n";
  return textOf(node.props.children);
}

/** 对收到的结构排版一次，只裁字形；不会把未显现的 **、# 或代码围栏打到屏幕上。 */
export function renderCompanionStreamingMarkdown(source: string, prefix: string, sources: readonly WebCitation[] = []): ReactNode[] {
  if (source === prefix) return renderCompanionMarkdown(source, sources);
  const key = JSON.stringify([source, sources]);
  let plan = prepared.get(key);
  if (!plan) {
    const nodes = renderCompanionMarkdown(source, sources);
    const ends: number[] = [], lengths: number[] = [];
    let at = 0;
    for (const { segment } of characters.segment(textOf(nodes))) {
      const found = source.indexOf(segment, at);
      if (found >= 0) at = found + segment.length;
      ends.push(at); lengths.push(segment.length);
    }
    plan = { nodes, ends, lengths }; prepared.set(key, plan);
    if (prepared.size > 64) prepared.delete(prepared.keys().next().value!);
  }
  let remaining = 0;
  for (let index = 0; index < plan.ends.length && plan.ends[index]! <= prefix.length; index++) remaining += plan.lengths[index]!;
  const take = (text: string) => {
    const visible = text.slice(0, remaining); remaining = Math.max(0, remaining - visible.length); return visible;
  };
  const trim = (node: ReactNode): ReactNode => {
    if (typeof node === "string" || typeof node === "number") return remaining ? take(String(node)) : null;
    if (Array.isArray(node)) return node.map(trim);
    if (!isValidElement<Props>(node) || remaining <= 0) return null;
    const element = node as ReactElement<Props>;
    if (node.type === "colgroup") return node;
    if (node.type === CodePaper) return cloneElement(element, { visibleCharacters: take(node.props.source ?? "").length });
    if (node.type === ReadableMath) {
      const text = node.props.source ?? "";
      const complete = remaining >= text.length; remaining = Math.max(0, remaining - text.length);
      return complete ? node : null;
    }
    if (node.type === WebCitationText) return cloneElement(element, { text: take(node.props.text ?? "") });
    if (node.type === "br") { remaining = Math.max(0, remaining - 1); return node; }
    if (node.type === "hr") return node;
    return cloneElement(element, { children: trim(node.props.children) });
  };
  return plan.nodes.map(trim);
}
