import { z } from "zod";
import { DESKTOP_IPC_CHANNELS, requestMetaSchema } from "@ailearn/shared/desktop-ipc-contracts";
import { agentRunV1Schema, agentRunListV1Schema, agentRunListQueryV1Schema, agentRunHistoryV1Schema, agentRunHistoryQueryV1Schema, createAgentRunV1Schema, reviseAgentRunV1Schema, controlAgentRunV1Schema } from "@ailearn/shared/agent-contracts";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import type { CompanionChannelDeps } from "./desktop-ipc-companion";

export function registerAgentChannels(deps: Pick<CompanionChannelDeps, "channel" | "gateway" | "assertEpoch" | "getActiveWorkspaceEpoch" | "contract" | "requireM2Route">) {
  const { channel, gateway, assertEpoch, getActiveWorkspaceEpoch, requireM2Route, contract } = deps;
  const base = { meta: requestMetaSchema }, uuid = z.string().uuid();
  function authorize(meta: z.infer<typeof requestMetaSchema>) {
    requireM2Route(contract, "room.home"); assertEpoch(meta, getActiveWorkspaceEpoch());
  }
  async function request<T>(path: string, method: "GET" | "POST" | "PATCH", schema: z.ZodType<T>, requestId: string, body?: unknown) {
    const t = gateway.gatewayTransport;
    await t.ensureConnected(requestId);
    const result = await t.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) }, true, true, requestId);
    const parsed = schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }
  const queryString = (query: Record<string, unknown> | undefined) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) params.set(key, String(value));
    return params.size ? `?${params}` : "";
  };
  channel(DESKTOP_IPC_CHANNELS.agentRunsList, z.object({ ...base, query: agentRunListQueryV1Schema.optional() }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs${queryString(input.query)}`, "GET", agentRunListV1Schema, input.meta.requestId);
  }, agentRunListV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunHistory, z.object({ ...base, runId: uuid, query: agentRunHistoryQueryV1Schema.optional() }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs/${input.runId}/history${queryString(input.query)}`, "GET", agentRunHistoryV1Schema, input.meta.requestId);
  }, agentRunHistoryV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunCreate, z.object({ ...base, request: createAgentRunV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request("/agent/runs", "POST", agentRunV1Schema, input.meta.requestId, input.request);
  }, agentRunV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunRevise, z.object({ ...base, runId: uuid, request: reviseAgentRunV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs/${input.runId}`, "PATCH", agentRunV1Schema, input.meta.requestId, input.request);
  }, agentRunV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunControl, z.object({ ...base, runId: uuid, request: controlAgentRunV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs/${input.runId}/control`, "POST", agentRunV1Schema, input.meta.requestId, input.request);
  }, agentRunV1Schema);
}
