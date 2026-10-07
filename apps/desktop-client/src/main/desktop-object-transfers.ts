import { createHash } from "node:crypto";
import { objectTransferConfigurationSchema, objectTransferDownloadSchema, objectTransferUploadSchema,
  OBJECT_TRANSFER_HEADER, type ObjectTransferRequest, type ObjectTransferDownload } from "@astella/shared/object-transfer-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";

type Profile = { version: 1; mode: "local" | "remote"; origins: string[] };
const profiles = new WeakMap<GatewayTransport, { identity: string; at: number; profile: Promise<Profile> }>();
export async function objectTransferProfile(t: GatewayTransport): Promise<Profile> {
  if (t.configuration?.config.mode === "local_loopback") return { version: 1, mode: "local", origins: [] };
  const identity = `${t.configuration?.config.apiOrigin}:${t.workspaceEpoch}:${t.token}`;
  const previous = profiles.get(t);
  if (previous?.identity === identity && Date.now() - previous.at < 60_000) return previous.profile;
  const profile = t.request("/storage/transfers/config", { method: "GET" }, true, true).then(result => {
    const parsed = objectTransferConfigurationSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  });
  profiles.set(t, { identity, at: Date.now(), profile });
  void profile.catch(() => { if (profiles.get(t)?.profile === profile) profiles.delete(t); });
  return profile;
}

export function validateObjectUrl(value: string, origins: readonly string[]): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin))
    throw new DesktopGatewayFailure("api_untrusted", "user_action");
}

/** API authorizes a final receipt; external PUT carries no API token or cookies. */
export async function uploadRemoteObject(t: GatewayTransport,
  request: Omit<ObjectTransferRequest, "byteLength" | "sha256">, bytes: Buffer, requestId?: string): Promise<{ body: unknown } | null> {
  const identity = t.token;
  const epoch = t.workspaceEpoch;
  const profile = await objectTransferProfile(t);
  if (profile.mode === "local") return null;
  if (identity !== t.token || epoch !== t.workspaceEpoch) throw new DesktopGatewayFailure("cancelled", "never");
  const prepared = await t.request("/storage/transfers", { method: "POST", body: JSON.stringify({ ...request,
    byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) }, true, true, requestId);
  if (identity !== t.token || epoch !== t.workspaceEpoch) throw new DesktopGatewayFailure("cancelled", "never");
  const parsed = objectTransferUploadSchema.safeParse(prepared.body);
  if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
  validateObjectUrl(parsed.data.url, profile.origins);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  if (requestId) t.activeRequests.set(requestId, controller);
  try {
    const response = await fetch(parsed.data.url, { method: "PUT", headers: parsed.data.headers, body: new Uint8Array(bytes),
      signal: controller.signal, credentials: "omit", redirect: "manual" });
    await response.body?.cancel();
    if (!response.ok) throw new DesktopGatewayFailure("safe_internal_error", "safe_retry", { httpStatus: response.status });
    if (identity !== t.token || epoch !== t.workspaceEpoch) throw new DesktopGatewayFailure("cancelled", "never");
  } catch (error) {
    if (error instanceof DesktopGatewayFailure) throw error;
    if (controller.signal.aborted) throw new DesktopGatewayFailure("cancelled", "never");
    throw new DesktopGatewayFailure("safe_internal_error", "safe_retry");
  } finally {
    clearTimeout(timeout);
    if (requestId && t.activeRequests.get(requestId) === controller) t.activeRequests.delete(requestId);
  }
  const completed = await t.request(`/storage/transfers/${parsed.data.transferId}/complete`, { method: "POST" }, true, true, requestId);
  if (identity !== t.token || epoch !== t.workspaceEpoch) throw new DesktopGatewayFailure("cancelled", "never");
  return completed;
}

export async function fetchObjectDownload(t: GatewayTransport, descriptor: ObjectTransferDownload,
  signal?: AbortSignal): Promise<Response> {
  const profile = await objectTransferProfile(t);
  validateObjectUrl(descriptor.url, profile.origins);
  const response = await fetch(descriptor.url, { method: "GET", signal, credentials: "omit", redirect: "manual" });
  if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith(descriptor.contentType.toLowerCase())) {
    await response.body?.cancel();
    throw new DesktopGatewayFailure("safe_internal_error", "safe_retry", { httpStatus: response.status });
  }
  let received = 0;
  const hash = createHash("sha256");
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > descriptor.byteLength) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      hash.update(chunk); controller.enqueue(chunk);
    },
    flush() {
      if (received !== descriptor.byteLength || (descriptor.sha256 && hash.digest("hex") !== descriptor.sha256))
        throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    },
  }));
  return new Response(body, { status: response.status, headers: response.headers });
}

export async function resolveObjectResponse(t: GatewayTransport, response: Response,
  maxBytes: number, signal?: AbortSignal): Promise<{ response: Response; descriptor: ObjectTransferDownload | null }> {
  if (response.headers.get(OBJECT_TRANSFER_HEADER) !== "1") return { response, descriptor: null };
  const descriptor = objectTransferDownloadSchema.parse(await response.json());
  if (descriptor.byteLength > maxBytes) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
  return { response: await fetchObjectDownload(t, descriptor, signal), descriptor };
}

export function verifyDownloadedObject(bytes: Uint8Array, descriptor: ObjectTransferDownload | null): void {
  if (descriptor && (bytes.byteLength !== descriptor.byteLength || (descriptor.sha256
    && createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256)))
    throw new DesktopGatewayFailure("unsupported_contract", "user_action");
}
