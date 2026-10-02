/**
 * 保存那一发的**状态**与**两条自动保存 effect**。
 *
 * ## 为什么只收状态与 effect、不收 `save` 那个 callback（2026-09-29）
 *
 * `save` 要读 `applyDraft` / `flush` / `titleValue` / `saving` —— 全是页面级的
 * **文档增量**与**本地标题**。搬进来就得把这些一起搬，那不是拆分是重新设计。
 *
 * 所以边界划在「**谁改 state、谁决定什么时候改**」上：两个 state 归这里，
 * 「自动保存什么时候发」「输入之后清掉粘住的错」这两条**时机判据**也归这里——
 * 它们是这一簇真正的行为，而 `save` 只是被它们调用的那个动作。
 *
 * ## 三条不许动
 *
 *  1. **失败的保存是粘住的**：那个 effect **不许重新武装**，否则每一轮
 *     `AUTOSAVE_DELAY_MS` 都会把保存提示在「正在保存…」与失败提示之间翻一次——
 *     实窗量到的就是那个抖动。
 *  2. **自动保存那个 effect 的依赖里不能有 `save` 或 `note` 对象**。这一屏每几秒就有一次
 *     静默回读带来一个新的 `data`，`save` 因此换身份，定时器被「清理—重挂」反复归零——
 *     实窗量到的正是这个：文档明明脏着（标签写着「草稿」），自动保存却永远不触发，
 *     本机那几句话从来没有交出去过。走 `saveRef`（每个渲染都刷新）就不需要那些身份。
 *  3. **「又开始编辑了」清错那个 effect 按 `draft` 这个对象当键**——它只在真输入时变；
 *     保存失败本身不动草稿，所以那句错会一直挂在那里。
 */
import { useEffect, useState } from "react";

/** 自动保存的间隔。**由页面传进来**——它与 `objective-state-copy` 那边的那一档同源。 */
export const AUTOSAVE_DELAY_MS = 1_200;

export function useNotebookSaveState(input: {
  readonly canSave: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** 草稿对象：**只在真输入时换身份**，失败时不动，所以它能当「又开始编辑了」的键。 */
  readonly draft: unknown;
  /** 每渲染刷新一次的 `save`，自动保存只通过它调用（见文件头第 2 条）。
      页面那个 ref 声明成 `() => void`，所以这里也按 `() => void` 收。 */
  readonly saveRef: { current: () => void };
  readonly delayMs?: number;
}) {
  const { canSave, dirty, saving, draft, saveRef, delayMs = AUTOSAVE_DELAY_MS } = input;

  const [saveState, setSaveState] = useState<"idle" | "saving" | "committed" | "error">("idle");
  const [saveFailure, setSaveFailure] = useState<string | null>(null);

  // Debounced autosave: the save-line reports the server receipt, never a local guess.
  useEffect(() => {
    if (!canSave || !dirty || saving || saveState === "error") {
      return undefined;
    }
    const timer = window.setTimeout(() => { void saveRef.current(); }, delayMs);
    return () => window.clearTimeout(timer);
  }, [canSave, dirty, saveState, saving, saveRef, delayMs]);

  // Editing again after a failed save clears the sticky error so autosave can
  // resume. Keyed on the draft object, which only changes on real input — the
  // failed save itself leaves the draft untouched and the error stays put.
  useEffect(() => {
    setSaveState((current) => (current === "error" ? "idle" : current));
  }, [draft]);

  return { saveState, setSaveState, saveFailure, setSaveFailure };
}
