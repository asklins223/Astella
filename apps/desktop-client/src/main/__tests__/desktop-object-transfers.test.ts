import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { fetchObjectDownload, uploadRemoteObject, validateObjectUrl } from "../desktop-object-transfers";
import type { GatewayTransport } from "../desktop-gateway-transport";

afterEach(() => vi.unstubAllGlobals());
const profile = { version: 1, mode: "remote", origins: ["https://objects.example.test"] };
function transport() {
  return { token: "private-api-session", workspaceEpoch: 1, configuration: { config: { apiOrigin: "https://api.example.test" } },
    activeRequests: new Map(), request: vi.fn(async (path: string) => {
      if (path === "/storage/transfers/config") return { body: profile };
      if (path === "/storage/transfers") return { body: { version: 1, transferId: "11111111-1111-4111-8111-111111111111",
        url: "https://objects.example.test/staging?signature=test", method: "PUT", headers: { "Content-Type": "image/png" }, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
      return { body: { url: "/api/uploads/committed-image" } };
    }) } as unknown as GatewayTransport;
}
describe("direct object transfers", () => {
  it("uses API only for authorization and receipt; credentials never reach storage", async () => {
    const t = transport(); const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const result = await uploadRemoteObject(t, { purpose: "companion_image", fileName: "test.png", mimeType: "image/png" }, Buffer.from("image"));
    expect(result?.body).toEqual({ url: "/api/uploads/committed-image" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("manual");
  });
  it("local mode leaves upload bytes on the original container path", async () => {
    const t = transport(); vi.mocked(t.request).mockResolvedValue({ body: { ...profile, mode: "local", origins: [] }, status: 200, headers: new Headers() });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await uploadRemoteObject(t, { purpose: "avatar", fileName: "test.png", mimeType: "image/png" }, Buffer.from("image"))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects an unexpected destination and truncated or corrupt object download", async () => {
    expect(() => validateObjectUrl("https://attacker.example.test/file", profile.origins)).toThrow();
    const bytes = Buffer.from("original");
    const descriptor = { version: 1 as const, kind: "object_download" as const, url: "https://objects.example.test/file?signature=test",
      contentType: "text/plain", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), expiresAt: new Date().toISOString() };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("modified", { headers: { "Content-Type": "text/plain" } })));
    const response = await fetchObjectDownload(transport(), descriptor);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});
