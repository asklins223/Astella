import { AVATAR_MAX_BYTES } from "@astella/shared/desktop-ipc-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";
import { ImageByteStore, type ImageBytes } from "./image-byte-store";

export const AVATAR_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export class AvatarImageStore extends ImageByteStore {
  constructor(directory: string, maxBytes = AVATAR_CACHE_MAX_BYTES) {
    super(directory, maxBytes, AVATAR_MAX_BYTES);
  }
}
let store: AvatarImageStore | null = null;
export function createAvatarImageStore(directory: string): AvatarImageStore { return store = new AvatarImageStore(directory); }
export function getAvatarImageStore(): AvatarImageStore | null { return store; }

/** 头像读取只允许本人；缓存按部署与账号隔离，与空间无关。 */
export function avatarCacheScope(t: GatewayTransport, objectKey: string): string | null {
  const session = t.currentSession;
  if (!t.token || session?.status !== "authenticated" || !session.user
    || objectKey.split("/")[1] !== session.user.userId) return null;
  return JSON.stringify([t.configuration?.config.apiOrigin, session.user.userId]);
}
export async function primeAvatarCache(t: GatewayTransport, objectKey: string, image: ImageBytes): Promise<void> {
  const scope = avatarCacheScope(t, objectKey);
  if (scope) await store?.prime(scope, objectKey, image);
}
