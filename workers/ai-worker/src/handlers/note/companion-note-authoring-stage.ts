/** Resolve and read before drafting an edit. No prose/tool arguments need a
 * long reasoning pass while the source identity is still unknown. */
export function companionNoteEditPrerequisite(input: {
  requestedActions: readonly string[]; hasPageNote: boolean;
  /** A complete host prefetch already supplied the version and full body. */
  hostNotePrefetched?: boolean;
  successfulTools: readonly { name: string; arguments: Record<string, unknown>; data: Record<string, unknown> }[];
}): "search" | "read" | null {
  if (!input.requestedActions.includes("notes.write.edit")) return null;
  if (input.hostNotePrefetched === true) return null;
  if (input.successfulTools.some(tool => tool.name === "notes.read.read" && tool.arguments.includeBlocks === true)) return null;
  const search = input.successfulTools.find(tool => tool.name === "notes.read.search");
  if (input.hasPageNote || (Array.isArray(search?.data.notes) && search.data.notes.length > 0)) return "read";
  return search ? null : "search";
}
