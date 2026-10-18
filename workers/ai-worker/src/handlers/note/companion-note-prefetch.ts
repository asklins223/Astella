/**
 * Host pre-read for the note the user is looking at.
 *
 * MiMo's Responses adapter rewrites `tool_choice: "required"` to `"auto"`, so the
 * interpreter saying "read" never guaranteed a read: the model could answer from
 * a note it read earlier in the conversation and still claim it had just read
 * this one. The host now loads the first page before generation and hands it
 * over as a host observation; continuation still uses `companion_read_note`.
 */

import type { AgentTurnRequest } from "@astella/shared";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { logger } from "../../lib/logger.ts";
import { loadNoteReadPage } from "../tools/companion-read-tools.ts";

/** First page size handed to the model. Continuation pages keep the normal cap. */
const PREFETCH_MAX_CHARS = 3_000;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

export interface CompanionNotePrefetchInput {
  workspaceId: string;
  userId: string;
  runId: string;
  /** True when the run resumed from a checkpoint; the note was already handed over. */
  recovered: boolean;
  toolUse: "none" | "read" | "act" | "uncertain";
  candidateOperations: readonly string[];
  /** Page identifiers for the note on screen, when the page context carries them. */
  noteId?: unknown;
  noteVersionId?: unknown;
}

export interface CompanionNotePrefetchResult {
  /** True when the note was read and pushed, so the step does not need a read receipt. */
  prefetched: boolean;
  /** The fast entry must not treat a bounded first page as the whole note. */
  truncated?: boolean;
  /** The observation to append to the request, when there is one. */
  message: AgentTurnRequest["messages"][number] | null;
}

/**
 * Both current-page read operations mean "the answer lives in this note". The
 * interpreter picks `companion_read_current_page` for "这一页" phrasings; if only
 * `companion_read_note` counted, the note stayed out of context.
 */
export function namesCurrentNoteRead(candidateOperations: readonly string[]): boolean {
  return candidateOperations.includes("companion_read_note")
    || candidateOperations.includes("companion_read_current_page");
}

export async function prefetchCompanionNote(
  input: CompanionNotePrefetchInput,
): Promise<CompanionNotePrefetchResult> {
  const miss: CompanionNotePrefetchResult = { prefetched: false, message: null };
  const readsCurrentNote = namesCurrentNoteRead(input.candidateOperations);
  logger.info({
    runId: input.runId, recovered: input.recovered, toolUse: input.toolUse,
    readsCurrentNote, noteId: input.noteId ?? null, noteVersionId: input.noteVersionId ?? null,
  }, "companion note prefetch decision inputs");
  if (input.recovered || (input.toolUse !== "read" && input.toolUse !== "uncertain") || !readsCurrentNote) {
    return miss;
  }
  const noteId = input.noteId;
  const noteVersionId = input.noteVersionId;
  if (typeof noteId !== "string" || !UUID_PATTERN.test(noteId)) return miss;
  try {
    const note = await withWorkerWorkspaceTransaction(
      { workspaceId: input.workspaceId, userId: input.userId },
      tx => loadNoteReadPage(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        noteId,
        ...(typeof noteVersionId === "string" ? { noteVersionId } : {}),
        startOrdinal: 1,
        startOffset: 0,
        maxChars: PREFETCH_MAX_CHARS,
      }),
    );
    if (!note || note.page.body.trim().length === 0) return miss;
    const range = note.truncated
      ? `（第 1–${note.page.endOrdinal} 块，共 ${note.totalBlocks} 块；后面还没读）`
      : `（共 ${note.totalBlocks} 块）`;
    logger.info({ runId: input.runId, noteId, chars: note.page.body.length, truncated: note.truncated },
      "companion note prefetched by host before generation");
    return {
      prefetched: true,
      truncated: note.truncated,
      message: {
        role: "system",
        hostObservation: true,
        content: [
          "<prefetched_note>",
          `《${note.title}》${range}`,
          note.page.body,
          "</prefetched_note>",
          "这是宿主在你开口前读到的当前笔记正文。直接据此回答，不要描述读取过程，也不要说没读到。"
          + "需要续读时再用 companion_read_note（同版本、按 nextStartOrdinal 继续）。",
        ].join("\n"),
      },
    };
  } catch (error) {
    logger.warn({ runId: input.runId, noteId, err: error },
      "companion note prefetch failed; leaving the read to the model");
    return miss;
  }
}
