/**
 * 「拓展」那一簇的 7 个 state：列表那一半 + 任务那一半 + 复核保存。
 *
 * ## 为什么只收 state、不收 handler（2026-09-29）
 *
 * `loadNoteExpansions` / `openNoteExpansionTask` / `persistNoteExpansionReview` /
 * `confirmNoteExpansionDrafts` / `startNoteExpansionTask` 五个 handler 各自要读
 * `note` / `epochRef` / `reload` —— 全是页面级的。搬进来就要把这些一起搬。
 *
 * ## 两条不许动
 *
 *  1. **`rows` 与 `task` 是两半，不是一件事**：`rows` 是「这一篇接出去过哪些链接」，
 *     `task` 是「正在生成哪些拓展」。合在一个 state 里会出现「读完列表顺手清了任务」。
 *  2. **`reviewSaving` 单独一格**：收下选中的那几篇要落盘再回读，屏上在那期间必须
 *     说得出「在存」。它与 `taskStarting`（在生成）不是同一件事，不能共用一格。
 */
import { useState } from "react";
import type { NoteExpansionLinkV1, NoteExpansionTaskV1 } from "@ailearn/shared/note-expansion-contracts";

export function useNotebookExpansionState() {
  const [expansionRows, setExpansionRows] = useState<{
    noteId: string;
    items: NoteExpansionLinkV1[];
    /** 这一族的游标是 `{ createdAt, expansionId }`——**不是** `string`。
     *  照着用法反推会写成 string，于是翻页那一处报出指向错误方向的错。 */
    nextCursor: { createdAt: string; expansionId: string } | null;
  } | null>(null);
  const [expansionLoading, setExpansionLoading] = useState(false);
  const [expansionError, setExpansionError] = useState<string | null>(null);
  const [expansionTask, setExpansionTask] = useState<NoteExpansionTaskV1 | null>(null);
  const [expansionTaskStarting, setExpansionTaskStarting] = useState(false);
  const [expansionReviewSaving, setExpansionReviewSaving] = useState(false);
  const [expansionTaskError, setExpansionTaskError] = useState<string | null>(null);

  return {
    expansionRows, setExpansionRows,
    expansionLoading, setExpansionLoading,
    expansionError, setExpansionError,
    expansionTask, setExpansionTask,
    expansionTaskStarting, setExpansionTaskStarting,
    expansionReviewSaving, setExpansionReviewSaving,
    expansionTaskError, setExpansionTaskError,
  };
}
