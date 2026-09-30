/**
 * 「回想」那一簇的 5 个 state。
 *
 * ## 为什么只收 state、不收 handler（2026-09-29）
 *
 * `loadNoteRecallRecords` / `actOnActiveRecall` / `startNoteRecall` / `resumeRecall`
 * 四个 handler 各自要读 `note` / `activeNoteRef` / `epochRef` / `reload` / `setLeaf`——
 * 全是页面级的。搬进来就要把这些一起搬，那不是拆分是重新设计。
 *
 * 所以这里**只收这一簇的 state**：它们是这一族动作真正私有的东西，
 * 而 handler 是「拿这些 state 去发请求」的动作，两者边界清楚。
 *
 * ## 两条不许动
 *
 *  1. **`busy` 是一格、四个动作共用**（`start` / `hint` / `reveal` / `report`）。
 *     分成四格的话，「给提示」在途时「开始回想」还能点，会起两个 run。
 *  2. **`reflection` 换一篇要清空**（`setRecallReflection("")`）——那一句属于刚才那篇。
 */
import { useState } from "react";
import type { NoteRecallRecordV1 } from "@ailearn/shared/note-recall-contracts";

/** 四档共用一颗闸——见文件头第 1 条。 */
export type RecallBusyV1 = "start" | "hint" | "reveal" | "report" | null;

export function useNotebookRecallState() {
  const [rows, setRows] = useState<{ noteId: string; items: NoteRecallRecordV1[]; nextCursor: string | null } | null>(null);
  const [busy, setBusy] = useState<RecallBusyV1>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reflection, setReflection] = useState("");

  return { rows, setRows, busy, setBusy, loading, setLoading, error, setError, reflection, setReflection };
}
