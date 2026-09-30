/**
 * 结算纸上那张「翻开本次发现」的小卡。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 剩下 1800 行是一整个巨型条件（`result || terminal ? … : …`），
 * 整体 70 个外部符号、不可切。但里面**有几块是自足的**——这块只依赖 3 个外部符号。
 *
 * ## 三条不能动的东西
 *
 *  1. **两面用同一个 `aria-expanded` + `aria-live="polite"` 驱动。** 翻面不是替换一张图，
 *     是一句话：读者要知道「我刚才翻开了一张写着什么��卡」。
 *  2. **`data-motif` 与 className 里的 `is-revealed`** 是 CSS 翻面的抓手；去掉任一个，
 *     动画会退化成瞬切。
 *  3. 那句「每轮从真实评分里抽一张，**不编造奖励**」是产品承诺，不是装饰。
 *     它是这一块**为什么敢画成一张卡**的根据。
 */
import type { ReactElement } from "react";
import { Sparkles } from "lucide-react";

/** 一张发现卡的内容。**由页面从真实评分证据里抽好再传进来**，组件不自己抽。 */
export type LearningDiscoveryCardV1 = {
  readonly motif: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly detail: string;
};

export function LearningRunDiscovery(props: {
  readonly card: LearningDiscoveryCardV1;
  readonly revealed: boolean;
  readonly onReveal: () => void;
}): ReactElement {
  const { card, revealed, onReveal } = props;
  return (
    <section className="learning-run-discovery" data-motif={card.motif} aria-label="本次学习发现卡">
      <button
        type="button"
        className={`learning-run-discovery__card${revealed ? " is-revealed" : ""}`}
        onClick={onReveal}
        aria-expanded={revealed}
      >
        {revealed ? (
          <span className="learning-run-discovery__front" aria-live="polite">
            <small>{card.eyebrow}</small>
            <strong>{card.title}</strong>
            <span>{card.detail}</span>
            <em>来自本次真实评分证据 · 不计经验值</em>
          </span>
        ) : (
          <span className="learning-run-discovery__back">
            <Sparkles size={19} aria-hidden="true" />
            <strong>翻开本次发现</strong>
            <small>每轮从真实评分里抽一张，不编造奖励</small>
          </span>
        )}
      </button>
    </section>
  );
}
