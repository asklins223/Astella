import type { GatewayTransport } from "./desktop-gateway-transport";
import { getNoteImageStore, type NoteImageBytes } from "./note-image-store";
import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";

export function noteImageCacheScope(t: GatewayTransport, objectKey: string): string | null {
  const session = t.currentSession;
  if (!t.token || session?.status !== "authenticated" || !session.user || !session.workspace
    || objectKey.split("/")[0] !== session.workspace.workspaceId) return null;
  return JSON.stringify([t.configuration?.config.apiOrigin, session.user.userId]);
}

export async function primeNoteImageCache(t: GatewayTransport, url: string, image: NoteImageBytes): Promise<void> {
  const key = sourceImageObjectKeyFromUrl(url);
  const scope = key && noteImageCacheScope(t, key);
  if (scope && key) await getNoteImageStore()?.prime(scope, key, image);
}
