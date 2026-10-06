/**
 * 生成卡片之后那张「哪里没对、想改哪一处」的反馈表单，它自己的两格状态。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `NotebookSurface` 还有 71 个 hook，**比硬红线（70）多 1**。这是 `feedback` 簇——
 * 两个 state 只服务于同一张表单，收进来正好压到线下。
 *
 * ## 两条不许动
 *
 *  1. **切篇 / 换目标时两个都清空**（页面在 2788 那一发里调 `reset`）：勾选的档位属于
 *     刚才那一次生成，带到下一次就是给**没看过的那一版**打了标签。
 *  2. **`reasons` 是「这一版哪里没对」，`note` 是「用户自己写的理由」**——两者是
 *     两条独立的话。合成一格就只能说「不�� + 备注」，而分开时服务端能把备注挂到
 *     具体的那个 reason 上去。
 */
import { useState } from "react";
import type { DesktopCardGenerationFeedbackReasonV2 } from "@astella/shared/card-generation-desktop-contracts";

export function useNotebookGenerationFeedback() {
  const [reasons, setReasons] = useState<readonly DesktopCardGenerationFeedbackReasonV2[]>([]);
  const [note, setNote] = useState("");

  /** 换了一版生成结果或换了一篇：勾选与备注都作废。 */
  const reset = () => {
    setReasons([]);
    setNote("");
  };

  /** 勾一个档位。**再点一次是取消**——所以这里判 `includes` 而不是记一套 Map。 */
  const toggle = (reason: DesktopCardGenerationFeedbackReasonV2) => {
    setReasons((current) => current.includes(reason)
      ? current.filter((item) => item !== reason)
      : [...current, reason]);
  };

  return { reasons, setReasons, note, setNote, toggle, reset };
}
