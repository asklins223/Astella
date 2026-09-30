import type { CompanionFeedNoteAnchor, CompanionNoteIntent } from "./companion-feed";

export type NoteReplySaveTarget =
  | { readonly kind: "annotation"; readonly key: string }
  | { readonly kind: "overview"; readonly key: string }
  | { readonly kind: "recall"; readonly key: string }
  | { readonly kind: "recall_hint"; readonly key: string }
  | { readonly kind: "expansion"; readonly key: string };

export interface NoteReplySaveAttempt {
  readonly target: NoteReplySaveTarget;
  readonly previousMessageId: string | null;
}

export function resolveNoteReplySaveTarget(
  anchor: CompanionFeedNoteAnchor | null,
  intent: CompanionNoteIntent | null,
): NoteReplySaveTarget | null {
  if (anchor) {
    const point = anchor.anchor;
    return {
      kind: "annotation",
      key: [
        anchor.noteId,
        point.noteVersionId,
        point.startBlockOrdinal,
        point.startOffset,
        point.endBlockOrdinal,
        point.endOffset,
        point.excerpt,
      ].join(":"),
    };
  }
  if (intent?.kind === "overview") {
    return { kind: "overview", key: `${intent.noteId}:${intent.noteVersionId}` };
  }
  if (intent?.kind === "recall") {
    return { kind: "recall", key: `${intent.noteId}:${intent.noteVersionId}` };
  }
  if (intent?.kind === "recall_hint" && intent.recallId) {
    return { kind: "recall_hint", key: `${intent.noteId}:${intent.noteVersionId}:${intent.recallId}` };
  }
  if (intent?.kind === "expansion") {
    return { kind: "expansion", key: `${intent.noteId}:${intent.noteVersionId}` };
  }
  return null;
}

export function beginNoteReplySaveAttempt(
  target: NoteReplySaveTarget,
  previousMessageId: string | null,
): NoteReplySaveAttempt {
  return { target, previousMessageId };
}

export function isReadyNoteReplyForSave(
  attempt: NoteReplySaveAttempt | null,
  activeTarget: NoteReplySaveTarget | null,
  phase: string,
  messageId: string | null,
): boolean {
  return Boolean(attempt
    && activeTarget?.kind === attempt.target.kind
    && activeTarget.key === attempt.target.key
    && phase === "ready"
    && messageId
    && messageId !== attempt.previousMessageId);
}
