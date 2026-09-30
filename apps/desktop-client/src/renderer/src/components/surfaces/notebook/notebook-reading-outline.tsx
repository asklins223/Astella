/**
 * 正文那栏左边的「从纸签跳读」小节目录。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 40 行、8 个外部符号。纸签的数量会随正文长度变多，所以它**天生带一个「收起 / 看看另外
 * N 枚」**——那一颗按钮与那条折叠是同一件事的一部分，不能只搬其中一半。
 *
 * ## 两条不许动
 *
 *  1. **`aria-label` 里那半句「有正文 / 只有标题」不能省**。读屏用户看不见那颗色块，
 *     而「这一节有没有正文」是判断值不值得跳过去的唯一线索。
 *  2. **`data-reading-section-ordinal` 是跳转的抓手**——去掉它，「回到正文原位」会退化成
 *     滚到大致位置。
 */
import type { ReactElement } from "react";

/** 一枚纸签。形状与 `notebook-round-copy` 里那份 `NotebookReadingSectionV1` 一致。 */
export type ReadingSectionV1 = {
  readonly startOrdinal: number;
  readonly title: string;
  readonly bodyBlockCount: number;
};

export function NotebookReadingOutline(props: {
  readonly sections: readonly ReadingSectionV1[];
  readonly visibleSections: readonly ReadingSectionV1[];
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly onToggleExpanded: () => void;
  readonly onJumpTo: (startOrdinal: number) => void;
  /** 一屏最多摆几枚纸签，超出就折叠。**由页面传进来**——那个数值是它的判据，不在这里另定一份。 */
  readonly pageSize: number;
}): ReactElement {
  const { sections, visibleSections, expanded, hiddenCount, pageSize, onToggleExpanded, onJumpTo } = props;
  return (
<nav className="notebook-reading-outline" aria-label="正文小节目录">
  <div className="notebook-reading-outline__heading">
    <span className="notebook-reading-outline__title">从纸签跳读</span>
    <span className="notebook-reading-outline__hint">{sections.length} 枚纸签 · 点选回到正文原位</span>
    {sections.length > pageSize ? (
      <button
        type="button"
        className="notebook-reading-outline__toggle"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        {expanded ? "收起后面的纸签" : `看看另外 ${hiddenCount} 枚纸签`}
      </button>
    ) : null}
  </div>
  <ol>
    {visibleSections.map((section, index) => {
      const contentLabel = section.bodyBlockCount > 0 ? "有正文" : "只有标题";
      return (
        <li key={section.startOrdinal}>
          <button
            type="button"
            className="notebook-reading-outline__bookmark"
            aria-label={`跳到${section.title}，${contentLabel}`}
            data-reading-section-ordinal={section.startOrdinal}
            onClick={() => onJumpTo(section.startOrdinal)}
          >
            <span className="notebook-reading-outline__name">
              <span className="notebook-reading-outline__number" aria-hidden="true">{index + 1}</span>
              <span>{section.title}</span>
            </span>
            <span className={`notebook-reading-outline__presence${section.bodyBlockCount === 0 ? " is-heading-only" : ""}`}>
              {contentLabel}
            </span>
          </button>
        </li>
      );
    })}
  </ol>
</nav>
  );
}
