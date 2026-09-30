/**
 * 「这一轮」那一簇的 6 个 state：题面草稿、那颗预设的来源、编辑态、在途、失败、丢的那句。
 *
 * ## 为什么只收 state、不收 handler（2026-09-29）
 *
 * `openNoteRound` / `submitRoundQuestion` / `endNoteRound` / `applyLostDraft` 四个 handler
 * 各自要读 `note` / `openRound` / `epochRef` / `reload` / `setLeaf`——全是页面级的。
 * 搬进来就要把这些一起搬，那不是拆分是重新设计。
 *
 * ## 两条不许动
 *
 *  1. **`roundStarter` 记住「这句是哪一颗预设放的」**，来源那一档（suggested / rewritten /
 *     authored）靠它判，**不靠猜用户改没改**。清空它等于把一句改过的作答记成用户自己写的。
 *  2. **`roundLostDraft` 是一份独立的草稿**，不是 `roundDraft` 的备份。丢的那轮与当前这一轮
 *     是两件事——所以它有自己的 `{ question, starter }` 形状，不复用上面那两格。
 */
import { useState } from "react";
import type { GatewayFailureKind } from "../../../app/desktop-client";
import type { RoundBusyV1 } from "./notebook-round-copy.ts";

export function useNotebookRoundState() {
  const [roundDraft, setRoundDraft] = useState("");
  const [roundStarter, setRoundStarter] = useState<string | null>(null);
  const [roundEditing, setRoundEditing] = useState(false);
  const [roundBusy, setRoundBusy] = useState<RoundBusyV1>(null);
  const [roundFailure, setRoundFailure] = useState<{ kind: GatewayFailureKind; message: string } | null>(null);
  const [roundLostDraft, setRoundLostDraft] = useState<{ question: string; starter: string | null } | null>(null);

  return {
    roundDraft, setRoundDraft,
    roundStarter, setRoundStarter,
    roundEditing, setRoundEditing,
    roundBusy, setRoundBusy,
    roundFailure, setRoundFailure,
    roundLostDraft, setRoundLostDraft,
  };
}
