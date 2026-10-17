import type { useCompanionPageContext } from "../companion-session/companion-chat-session-page";

type Page = Pick<ReturnType<typeof useCompanionPageContext>, "hudPage" | "activeNoteId" | "activeNoteVersionId"
  | "activeRunId" | "activeSourceId" | "pageReadableView">;

/** A content watermark, not an identity or security hash. Counter refreshes only renew context. */
function viewRevision(view: NonNullable<Page["pageReadableView"]>["view"]): string {
  let hash = 2166136261;
  for (const character of JSON.stringify(view)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `view:${(hash >>> 0).toString(16)}`;
}

export function companionAwarenessPageState(page: Page): { ready: boolean; revision: string | null } {
  if (["note-read", "note-edit", "note-learning"].includes(page.hudPage))
    return { ready: Boolean(page.activeNoteId && page.activeNoteVersionId), revision: page.activeNoteVersionId };
  const view = page.pageReadableView?.view;
  if (page.hudPage === "source-detail")
    return { ready: Boolean(page.activeSourceId && view?.pageId === "source_detail"),
      revision: view?.pageId === "source_detail" ? viewRevision(view) : null };
  if (["assessment", "result"].includes(page.hudPage))
    return { ready: Boolean(page.activeRunId && view?.pageId === page.hudPage),
      revision: view?.pageId === page.hudPage ? viewRevision(view) : null };
  return { ready: true, revision: null };
}
