import { beforeEach, expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS, DESKTOP_IPC_CONTRACT_VERSION, type RequestMetaV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { registerAgentChannels } from "../desktop-ipc-agent";

const runId = "11111111-1111-4111-8111-111111111111";
const meta: RequestMetaV1 = { version: 1, contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "agent-history-ipc", correlationId: "agent-history-ipc", clientStartedAt: "2026-10-04T00:00:00Z", workspaceEpoch: 2 };
const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
const request = vi.fn(), ensureConnected = vi.fn(), requireM2Route = vi.fn();
const assertEpoch = vi.fn((value: RequestMetaV1, epoch: number) => { if (value.workspaceEpoch !== epoch) throw new Error("stale_workspace"); });
beforeEach(() => {
  vi.clearAllMocks(); handlers.clear();
  const deps: Parameters<typeof registerAgentChannels>[0] = {
    channel: (name, schema, operation) => { handlers.set(name, async input => operation({} as never, {} as never, schema.parse(input))); },
    gateway: { gatewayTransport: { request, ensureConnected } } as unknown as Parameters<typeof registerAgentChannels>[0]["gateway"],
    contract: {}, assertEpoch, getActiveWorkspaceEpoch: () => 2, requireM2Route,
  };
  registerAgentChannels(deps);
});
it("passes bounded pagination through the Agent gateway and keeps request identity", async () => {
  const list = { version: 1, items: [], nextCursor: null };
  request.mockResolvedValueOnce({ body: list });
  expect(await handlers.get(DESKTOP_IPC_CHANNELS.agentRunsList)!({ meta, query: { limit: 5, cursor: "abc+/=" } })).toEqual(list);
  expect(request).toHaveBeenCalledWith("/agent/runs?limit=5&cursor=abc%2B%2F%3D", { method: "GET" }, true, true, meta.requestId);
  const history = { version: 1, runId, currentRevision: 3, items: [], unrecordedRevisions: [1], nextBeforeRevision: null };
  request.mockResolvedValueOnce({ body: history });
  expect(await handlers.get(DESKTOP_IPC_CHANNELS.agentRunHistory)!({ meta, runId, query: { limit: 5, beforeRevision: 1 } })).toEqual(history);
  const url = new URL(request.mock.calls.at(-1)![0], "http://localhost");
  expect(url.pathname).toBe(`/agent/runs/${runId}/history`);
  expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "5", beforeRevision: "1" });
  expect(request.mock.calls.at(-1)!.slice(1)).toEqual([{ method: "GET" }, true, true, meta.requestId]);
  expect(ensureConnected).toHaveBeenLastCalledWith(meta.requestId);
  expect(requireM2Route).toHaveBeenLastCalledWith({}, "room.home");
});
it("rejects invalid query and stale workspace before calling the gateway, and rejects malformed history", async () => {
  const invoke = handlers.get(DESKTOP_IPC_CHANNELS.agentRunHistory)!;
  await expect(invoke({ meta, runId, query: { limit: 51 } })).rejects.toThrow();
  await expect(invoke({ meta: { ...meta, workspaceEpoch: 1 }, runId })).rejects.toThrow("stale_workspace");
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ body: { version: 1, runId, currentRevision: 3, items: [], unrecordedRevisions: [] } });
  await expect(invoke({ meta, runId })).rejects.toThrow();
});
