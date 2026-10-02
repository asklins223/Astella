import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Fit every word to a complete physical face, never clip or scroll card prose. */
export function CandidateCardFace({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  const body = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!body.current || !copy.current) return;
    const area = body.current, content = copy.current;
    const fit = () => {
      if (!area.clientHeight || !area.clientWidth) return;
      let low = 1, high = 20;
      for (let index = 0; index < 9; index++) {
        const size = (low + high) / 2;
        area.style.setProperty("--card-copy-size", `${size}px`);
        if (content.scrollHeight <= area.clientHeight && content.scrollWidth <= area.clientWidth) low = size;
        else high = size;
      }
      area.style.setProperty("--card-copy-size", `${low}px`);
      area.dataset.fitSize = low.toFixed(2);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(area);
    const changes = new MutationObserver(fit);
    changes.observe(content, { childList: true, subtree: true, characterData: true });
    let active = true;
    void document.fonts?.ready.then(() => { if (active) fit(); });
    return () => { active = false; observer?.disconnect(); changes.disconnect(); };
  }, []);
  return <div className="candidate-card__body" aria-label={label} ref={body}><div className="candidate-card__copy" ref={copy}>{children}</div></div>;
}
