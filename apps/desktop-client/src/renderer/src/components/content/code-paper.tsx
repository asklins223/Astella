import { Fragment, useEffect, useState, type ReactNode } from "react";
import { highlightCodeBlock, type CodeHighlight } from "./code-tokens";
import { copyText } from "../../app/client/clipboard";

/**
 * 代码纸：语言与复制留在纸沿，正文只有颜色变化。
 *
 * 笔记的阅读态与伴星递来的代码共用这一张。字与行都不动——高亮只是把同一串字
 * 切成一段段 class，所以读起来不会被控件抢走重心，复制到的也还是原文。
 *
 * `renderText` 是给笔记那侧的口子：批注与「概念句」高亮的偏移只有一份来源，
 * 代码被切成片段也得按**整块源码**的字符起点交接，不能各算各的。
 */
export type CodeTextRender = (text: string, at: number) => ReactNode;

/** 解析回来之前先照原文画：第一帧就得有字，颜色是随后补上的那一层。 */
export function useCodeHighlight(source: string, fence?: string): CodeHighlight | null {
  const [highlight, setHighlight] = useState<CodeHighlight | null>(null);
  useEffect(() => {
    let live = true;
    // 不清旧结果：伴星的回复是一个字一个字进来的，每来一次就清空会让颜色一直闪。
    // 旧切片对不对得上由 `CodeLines` 按 source 判，判不过就照原文画。
    void highlightCodeBlock(source, fence).then((next) => { if (live) setHighlight(next); });
    return () => { live = false; };
  }, [source, fence]);
  return highlight;
}

/** 一行行带 class 的片段；行与行之间那个换行是文本本身，不另起元素。 */
export function CodeLines({ highlight, source, start = 0, renderText, visibleCharacters = source.length }: {
  readonly highlight: CodeHighlight | null;
  readonly source: string;
  readonly start?: number;
  readonly renderText?: CodeTextRender;
  readonly visibleCharacters?: number;
}): ReactNode {
  const text = renderText ?? ((value: string) => value);
  const limit = Math.max(0, Math.min(source.length, visibleCharacters));
  const lines = highlight && source.startsWith(highlight.source) ? highlight.lines : null;
  if (!lines || !highlight) return text(source.slice(0, limit), start);
  const rawLines = highlight.source.split("\n");
  let lineEnd = -1;
  return <>{lines.map((line, index) => {
    lineEnd += rawLines[index]!.length + 1;
    return <Fragment key={index}>
      {line.map(piece => {
        const visible = piece.text.slice(0, Math.max(0, limit - piece.start));
        return visible ? <span key={piece.start} className={piece.classes || undefined}>{text(visible, start + piece.start)}</span> : null;
      })}
      {index < lines.length - 1 && limit > lineEnd ? "\n" : null}
    </Fragment>;
  })}{limit > highlight.source.length ? text(source.slice(highlight.source.length, limit), start + highlight.source.length) : null}</>;
}

export function CodePaper({ source, fence, start = 0, renderText, visibleCharacters }: {
  readonly source: string;
  readonly fence?: string;
  readonly start?: number;
  readonly renderText?: CodeTextRender;
  /** 高亮只解析收到的源码，逐字显示只裁既有 token，不重启解析器。 */
  readonly visibleCharacters?: number;
}) {
  const highlight = useCodeHighlight(source, fence);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const timer = setTimeout(() => setCopied("idle"), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  // 语言名与颜色出自同一次匹配：换了语言的这一帧先空着，别拿上一门的名字顶着。
  const fresh = highlight && source.startsWith(highlight.source) ? highlight : null;
  return <figure className="code-paper" data-language={fence}>
    <figcaption className="code-paper__rail" data-note-decoration="true">
      <span className="code-paper__language">{fresh?.label ?? fence ?? "纯文本"}</span>
      <button type="button" className="code-paper__copy" aria-label="复制这段代码" onClick={async () => {
        setCopied(await copyText(source) ? "done" : "failed");
      }}>{copied === "done" ? "已复制" : copied === "failed" ? "复制失败" : "复制"}</button>
    </figcaption>
    <pre className="code-body"><code><CodeLines highlight={highlight} source={source} start={start} renderText={renderText} visibleCharacters={visibleCharacters} /></code></pre>
  </figure>;
}
