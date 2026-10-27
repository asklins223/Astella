import { createHash } from "node:crypto";

/** Called after authorization/projection; conditional reads must never skip actor checks. */
export function contentValidation(input: { method: string; url: string; status: number; ifNoneMatch?: string; existingTag?: string | number | string[] },
  payload: unknown): { etag: string; notModified: boolean } | null {
  if (input.method !== "GET" || input.status !== 200 || (typeof payload !== "string" && !Buffer.isBuffer(payload))) return null;
  const path = input.url.split("?")[0]!;
  if (path !== "/client-cache/notes/version" && !/^\/(?:v2\/notes(?:\/|$)|notes(?:\/|$)|search(?:\/|$)|v2\/learning-cards(?:\/|$)|companion\/conversations\/[^/]+\/messages$)/.test(path)) return null;
  const etag = String(input.existingTag ?? `"${createHash("sha256").update(payload).digest("hex")}"`);
  return { etag, notModified: (input.ifNoneMatch ?? "").split(",").map(value => value.trim()).includes(etag) };
}
