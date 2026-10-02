/** Confirmed links have their own pagination; task reads cannot replace them. */
import { useState } from "react";
import type { NoteExpansionLinkV1 } from "@ailearn/shared/note-expansion-contracts";

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

  return {
    expansionRows, setExpansionRows,
    expansionLoading, setExpansionLoading,
    expansionError, setExpansionError,
  };
}
