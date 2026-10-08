import { useMemo } from "react";
import { renderToString } from "katex";

const mathCache = new Map<string, string | null>();
export function noteMathHtml(value: string, display: boolean): string | null {
  if (value.length > 10_000) return null;
  const key = `${display}:${value}`;
  if (mathCache.has(key)) return mathCache.get(key)!;
  let html: string | null = null;
  try { html = renderToString(value, { displayMode: display, output: "html", trust: false, throwOnError: true, strict: "ignore", maxExpand: 1000, maxSize: 20 }); } catch { /* Keep invalid formulas editable as source. */ }
  mathCache.set(key, html); if (mathCache.size > 128) mathCache.delete(mathCache.keys().next().value!);
  return html;
}

/** The editor's DOM widget uses the same bounded renderer as the reading component. */
export function createNoteMathPreview(value: string, display: boolean): HTMLElement | null {
  const html = noteMathHtml(value, display);
  if (!html) return null;
  const element = document.createElement("span");
  element.setAttribute("role", "math"); element.setAttribute("aria-label", value);
  element.innerHTML = html;
  return element;
}

/** Notes and conversations share bounded KaTeX rendering. Only its generated HTML
 * reaches the DOM; original source is retained for notebook selection offsets. */
export function ReadableMath(props: { source: string; value: string; display: boolean }) {
  const html = useMemo(() => noteMathHtml(props.value, props.display), [props.value, props.display]);
  if (!html) return <span className="note-math-error" title="公式语法暂时无法排版，保留原文供核对">{props.source}</span>;
  return <span className="note-math" data-display={props.display || undefined} role="math" aria-label={props.value}>
    <span className="note-math__source" aria-hidden="true">{props.source}</span>
    <span data-note-decoration="true" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
  </span>;
}
