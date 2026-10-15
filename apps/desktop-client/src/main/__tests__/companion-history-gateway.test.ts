import { expect, it, vi } from "vitest";
import { listCompanionHistory } from "../desktop-gateway-ns-companion";
import type { GatewayTransport } from "../desktop-gateway-transport";

it("preserves the scoped initiative run filter through the main-process gateway", async () => {
  const request = vi.fn(async (..._args: unknown[]) => ({ status: 200,
    body: { version: 1, items: [], nextCursor: null } }));
  const transport = { ensureConnected: vi.fn(), request } as unknown as GatewayTransport;
  const runId = "11111111-1111-4111-8111-111111111111";
  await listCompanionHistory(transport, { runId, limit: 100, before: "signed+cursor" });
  const url = new URL(String(request.mock.calls[0][0]), "https://example.invalid");
  expect(url.searchParams.get("runId")).toBe(runId);
  expect(url.searchParams.get("limit")).toBe("100");
  expect(url.searchParams.get("before")).toBe("signed+cursor");
});
