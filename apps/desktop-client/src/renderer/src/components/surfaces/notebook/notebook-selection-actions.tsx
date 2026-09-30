/**
 * 选中一段原文之后浮出来的那一排：讲讲这句 / 问伴星 / 收起。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 20 行、只有 2 个外部符号（`excerpt` 与本页的 props）。它是**选句之后唯一的那一排**，
 * 三颗动作挤在一个 `role="group"` 里——拆出来就更容易看出「主动作只有一颗」。
 *
 * ## 三条不许动
 *
 *  1. **`onPointerDown` 那个 `preventDefault()`**：不挡它，按钮会在指针按下的瞬间
 *     把选区收掉，于是 `onClick` 永远不触发——这一排**点不动**。
 *  2. **选区跨段时不给「讲讲这句」，改说「请选同一段里的句子」**。跨段的解释贴不回原文，
 *     给一颗点不动的按钮不如说清为什么。
 *  3. **「问伴星」与「收起」都不带主色**。这一屏的主动作是「讲讲这句」；
 *     同一排里出现第二颗同重按钮，分主次就失效了（`renderer-primary-action-guard` 盯着）。
 */
import type { ReactElement } from "react";
import { MessageCircle, X } from "lucide-react";

export function NotebookSelectionActions(props: {
  /** 选中的那句，最多印 90 字。 */
  readonly excerptText: string;
  /** 有没有落在同一段里的锚点。没有就不给「讲讲这句」。 */
  readonly hasAnchor: boolean;
  readonly busy: boolean | undefined;
  /** 有没保存的改动——有的话先存再讲。 */
  readonly dirty: boolean | undefined;
  readonly onExplain: (() => void) | undefined;
  readonly onAskCompanion: (() => void) | undefined;
  readonly onDismiss: (() => void) | undefined;
}): ReactElement {
  const {
    excerptText, hasAnchor, busy, dirty, onExplain, onAskCompanion, onDismiss,
  } = props;
  return (
    <div className="notebook-selection-actions" data-note-selection-action="true" role="group" aria-label="已选原文">
      <q className="notebook-selection-actions__excerpt">{excerptText}</q>
      {hasAnchor ? (
        <button type="button" className="notebook-selection-actions__main"
          disabled={busy || dirty || onExplain === undefined}
          title={dirty ? "先保存改动，再讲这句" : "把解释贴在原句旁边"}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onExplain}>
          {busy ? "正在准备…" : "讲讲这句"}
        </button>
      ) : <span className="notebook-selection-actions__reason">请选同一段里的句子，才能贴回原文。</span>}
      <button type="button" className="notebook-selection-actions__companion"
        onPointerDown={(event) => event.preventDefault()} onClick={onAskCompanion} disabled={onAskCompanion === undefined}>
        <MessageCircle size={14} aria-hidden="true" />问伴星
      </button>
      <button type="button" className="notebook-selection-actions__dismiss" aria-label="收起选句操作"
        onPointerDown={(event) => event.preventDefault()} onClick={onDismiss} disabled={onDismiss === undefined}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
