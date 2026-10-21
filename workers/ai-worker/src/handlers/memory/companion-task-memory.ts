/** Bind temporary learning memories to the current persisted note identity.
 * Missing or malformed identities never make task memories visible globally. */
export interface CompanionTaskEntityRef {
  readonly entityType: "note" | "card";
  readonly entityId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function taskEntityFromPersistedPageContext(pageContext: unknown): CompanionTaskEntityRef | null {
  if (!pageContext || typeof pageContext !== "object") return null;
  const context = (pageContext as { context?: unknown }).context;
  if (!context || typeof context !== "object") return null;
  const page = context as { pageKind?: unknown; noteId?: unknown };
  if (page.pageKind !== "note" || typeof page.noteId !== "string" || !UUID_PATTERN.test(page.noteId)) return null;
  return { entityType: "note", entityId: page.noteId };
}
