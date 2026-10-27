import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import { prefetchCompanionNote, companionSemanticNoteReadTarget, type CompanionNotePrefetchResult } from "../note/companion-note-prefetch.ts";
import { appendAgentEvent } from "./companion-agent-events.ts";

/** Bind real host reads to the run's progress stream without moving event writes
 * into the note reader's transaction or introducing an upward note → agent edge. */
export function createCompanionNoteObservation(event: AgentEventContext, recovered: boolean,
  page?: { pageKind?: string; noteId?: unknown; noteVersionId?: unknown }) {
  const input = { workspaceId: event.ctx.workspaceId, userId: event.read.userId, runId: event.read.runId,
    recovered, noteId: page?.noteId, noteVersionId: page?.noteVersionId, userText: event.read.userText,
    onRead: async (note: { noteId: string; title: string; truncated: boolean }) => {
      await appendAgentEvent(event, "agent.tool", { tool: {
        toolCallId: `host-note-read:${event.read.runId}:${note.noteId}`, name: "notes.read.read",
        toolVersion: 1, riskClass: "read", status: "succeeded", source: "host_prefetch",
        safeLabel: "读取手记", safeSummary: `已读取《${note.title}》${note.truncated ? " · 只读开头" : ""}`,
      } });
    } };
  const allowed = event.constraints.noteLibraryReadEnabled !== false;
  return {
    hasResolvedTarget: (attention: AgentTurnInterpretationV1) => Boolean(page?.noteId
      || companionSemanticNoteReadTarget(attention.subjects)),
    currentPage: () => allowed && page?.pageKind === "note"
      ? prefetchCompanionNote({ ...input, toolUse: "read", candidateOperations: ["notes.read.read"] }) : null,
    read: async (attention: AgentTurnInterpretationV1): Promise<CompanionNotePrefetchResult> => allowed
      ? prefetchCompanionNote({ ...input, toolUse: attention.toolUse,
        candidateOperations: attention.candidateOperations, subjects: attention.subjects })
      : { prefetched: false, message: null },
  };
}
