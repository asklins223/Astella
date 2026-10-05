import { expect, it, vi } from "vitest";
import { listCompanionThoughts } from "../desktop-gateway-ns-companion";
import type { GatewayTransport } from "../desktop-gateway-transport";

const cursor = "11111111-1111-4111-8111-111111111111";
it("thought history follows the authenticated connected transport, preserves the cursor and is read only", async () => {
  const ensureConnected = vi.fn(async () => undefined);
  const request = vi.fn(async () => ({ body: { version: 1, items: [], nextBefore: null } }));
  const transport = { ensureConnected, request } as unknown as GatewayTransport;
  expect(await listCompanionThoughts(transport, { version: 1, before: cursor, limit: 12 }, "read-thoughts")).toEqual({ version: 1, items: [], nextBefore: null });
  expect(ensureConnected).toHaveBeenCalledWith("read-thoughts");
  expect(request).toHaveBeenCalledWith(`/companion/thoughts?limit=12&before=${cursor}`, { method: "GET" }, true, true, "read-thoughts");
});
it("rejects a candidate leaking into the response before it can reach the journal", async () => {
  const transport = { ensureConnected: vi.fn(), request: vi.fn(async () => ({ body: { version: 1, nextBefore: null, items: [{
    id: cursor, text: "还没有表达过", status: "candidate", createdAt: "2026-10-05T00:00:00Z",
    deliveredAt: "2026-10-05T01:00:00Z", openedAt: null, expiresAt: "2026-10-06T01:00:00Z",
  }] } })) } as unknown as GatewayTransport;
  await expect(listCompanionThoughts(transport, { version: 1 })).rejects.toMatchObject({ code: "unsupported_contract" });
});
