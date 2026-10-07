import { useEffect, useId, useState } from "react";
import { ZoomableReadingImage } from "../source/image-viewer";

let initialized: Promise<typeof import("mermaid")["default"]> | undefined;
function mermaidRuntime() {
  return initialized ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      maxTextSize: 50_000, maxEdges: 500, theme: "base", htmlLabels: false,
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels"],
      themeVariables: { fontFamily: '"Noto Sans SC Variable", sans-serif', primaryColor: "#edf2df", primaryTextColor: "#405346",
        primaryBorderColor: "#9fb69b", lineColor: "#738b77", secondaryColor: "#f9eed5", tertiaryColor: "#f5ddd0" } });
    return mermaid;
  });
}

// Mermaid sizes inline SVG with percentages. An image needs intrinsic dimensions
// so the shared lightbox can fit it to the viewport without shrinking to a thumbnail.
function imageSizedSvg(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/i, root => {
    const viewBox = /\bviewBox\s*=\s*(["'])(.*?)\1/i.exec(root)?.[2]?.trim().split(/[\s,]+/).map(Number);
    if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2]! <= 0 || viewBox[3]! <= 0) return root;
    return root.replace(/\s(?:width|height)\s*=\s*(["']).*?\1/gi, "").replace(/>$/, ` width="${viewBox[2]}" height="${viewBox[3]}">`);
  });
}

/** Render generated SVG as an image; the diagram has no access to the renderer's DOM or IPC. */
export function NoteMermaid({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [state, setState] = useState<{ source: string; src?: string; failed?: boolean }>({ source });
  useEffect(() => {
    let disposed = false;
    setState({ source });
    if (source.length > 50_000) { setState({ source, failed: true }); return; }
    void mermaidRuntime().then(runtime => runtime.render(`note-mermaid-${id}`, source)).then(({ svg }) => {
      if (!disposed) setState({ source, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(imageSizedSvg(svg))}` });
    }).catch(() => { if (!disposed) setState({ source, failed: true }); });
    return () => { disposed = true; };
  }, [source, id]);
  const current = state.source === source ? state : { source };
  return <div className="note-mermaid">
    <div data-note-decoration="true">
      {current.src ? <ZoomableReadingImage src={current.src} alt="Mermaid 图表" /> : <p className="small" role="status">{current.failed ? "图表没能绘制，请核对下面的 Mermaid 源码。" : "正在绘制图表…"}</p>}
    </div>
    <details open={Boolean(current.failed)}><summary data-note-decoration="true">Mermaid 源码</summary><pre className="code-block"><code>{source}</code></pre></details>
  </div>;
}
