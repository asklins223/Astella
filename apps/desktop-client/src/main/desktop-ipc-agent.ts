import { z } from "zod";
import { DESKTOP_IPC_CHANNELS, requestMetaSchema } from "@ailearn/shared/desktop-ipc-contracts";
import { agentRunV1Schema, agentRunListV1Schema, createAgentRunV1Schema, reviseAgentRunV1Schema, controlAgentRunV1Schema } from "@ailearn/shared/agent-contracts";
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
  channel(DESKTOP_IPC_CHANNELS.agentRunsList, z.object(base).strict(), (_event, _window, input) => {
    authorize(input.meta); return request("/agent/runs", "GET", agentRunListV1Schema, input.meta.requestId);
  }, agentRunListV1Schema);
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
