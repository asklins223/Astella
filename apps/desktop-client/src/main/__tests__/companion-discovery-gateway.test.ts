import { expect, it, vi } from "vitest";
import { annotateCompanionDiscovery, collectCompanionDiscovery, uncollectCompanionDiscovery } from "../desktop-gateway-ns-companion";
import type { GatewayTransport } from "../desktop-gateway-transport";

it("all discovery mutations keep the HTTP metadata envelope, including calls without a request id", async () => {
  const request = vi.fn(async (_path: string, _init: RequestInit) => ({ status: 200, body: {} }));
  const transport = { ensureConnected: vi.fn(), request } as unknown as GatewayTransport;
  const identity = { kind: "kept_ai_suggestion", source: "assistant_reply", sourceId: "11111111-1111-4111-8111-111111111111" } as const;
  const collect = { ...identity, author: "assistant" as const, body: "这段原话。" };
  await collectCompanionDiscovery(transport, collect, "keep-request");
  await uncollectCompanionDiscovery(transport, identity, "remove-request");
  const annotation = { entryId: identity.sourceId, annotation: "我的想法" };
  await annotateCompanionDiscovery(transport, annotation);
  expect(request.mock.calls.map(call => [call[0], JSON.parse((call[1] as RequestInit).body as string)])).toEqual([
    ["/companion/discovery", { meta: { requestId: "keep-request" }, request: collect }],
    ["/companion/discovery/uncollect", { meta: { requestId: "remove-request" }, request: identity }],
    ["/companion/discovery/annotate", { meta: {}, request: annotation }],
  ]);
});
