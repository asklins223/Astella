import { useMemo } from "react";
import { renderToString } from "katex";

/** Visual TeX and the source character stream have separate jobs. */
export function NoteMath(props: { source: string; value: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      if (props.value.length > 10_000) return null;
      return renderToString(props.value, { displayMode: props.display, output: "html", trust: false,
        throwOnError: true, strict: "ignore", maxExpand: 1000, maxSize: 20 });
    } catch { return null; }
  }, [props.value, props.display]);
  if (!html) return <span className="note-math-error" title="公式语法暂时无法排版，保留原文供核对">{props.source}</span>;
  return <span className="note-math" data-display={props.display || undefined} role="math" aria-label={props.value}>
    <span className="note-math__source" aria-hidden="true">{props.source}</span>
    <span data-note-decoration="true" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
  </span>;
}
