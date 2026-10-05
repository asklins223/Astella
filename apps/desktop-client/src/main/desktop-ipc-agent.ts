import { z } from "zod";
import {agentLongGoalsV1Schema,agentLongGoalsQueryV1Schema} from "@ailearn/shared/agent-long-goal-contracts";
import { DESKTOP_IPC_CHANNELS, requestMetaSchema } from "@ailearn/shared/desktop-ipc-contracts";
import { agentRunV1Schema, agentRunListV1Schema, agentRunListQueryV1Schema, agentRunHistoryV1Schema, agentRunHistoryQueryV1Schema, createAgentRunV1Schema, reviseAgentRunV1Schema, controlAgentRunV1Schema } from "@ailearn/shared/agent-contracts";
import { agentMethodV1Schema, agentMethodListV1Schema, agentMethodHistoryV1Schema, agentMethodUsesV1Schema,
  agentMethodUseV1Schema, proposeAgentMethodV1Schema, reviseAgentMethodV1Schema, controlAgentMethodV1Schema,
  agentMethodFeedbackV1Schema } from "@ailearn/shared/agent-growth-contracts";
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
  channel(DESKTOP_IPC_CHANNELS.agentLongGoalsList,z.object({...base,query:agentLongGoalsQueryV1Schema.optional()}).strict(),(_event,_window,input)=>{
    authorize(input.meta);return request(`/agent/long-goals${queryString(input.query)}`,"GET",agentLongGoalsV1Schema,input.meta.requestId);
  },agentLongGoalsV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunsList, z.object({ ...base, query: agentRunListQueryV1Schema.optional() }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs${queryString(input.query)}`, "GET", agentRunListV1Schema, input.meta.requestId);
  }, agentRunListV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunHistory, z.object({ ...base, runId: uuid, query: agentRunHistoryQueryV1Schema.optional() }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs/${input.runId}/history${queryString(input.query)}`, "GET", agentRunHistoryV1Schema, input.meta.requestId);
  }, agentRunHistoryV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunGet, z.object({...base,runId:uuid}).strict(), (_event,_window,input)=>{
    authorize(input.meta);return request(`/agent/runs/${input.runId}`,"GET",agentRunV1Schema,input.meta.requestId);
  },agentRunV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunCreate, z.object({ ...base, request: createAgentRunV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request("/agent/runs", "POST", agentRunV1Schema, input.meta.requestId, input.request);
  }, agentRunV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunRevise, z.object({ ...base, runId: uuid, request: reviseAgentRunV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs/${input.runId}`, "PATCH", agentRunV1Schema, input.meta.requestId, input.request);
  }, agentRunV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentRunControl, z.object({ ...base, runId: uuid, request: controlAgentRunV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/runs/${input.runId}/control`, "POST", agentRunV1Schema, input.meta.requestId, input.request);
  }, agentRunV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentMethodsList, z.object(base).strict(), (_event, _window, input) => {
    authorize(input.meta); return request("/agent/methods", "GET", agentMethodListV1Schema, input.meta.requestId);
  }, agentMethodListV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentMethodPropose, z.object({ ...base, request: proposeAgentMethodV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request("/agent/methods", "POST", agentMethodV1Schema, input.meta.requestId, input.request);
  }, agentMethodV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentMethodRevise, z.object({ ...base, methodId: uuid, request: reviseAgentMethodV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/methods/${input.methodId}`, "PATCH", agentMethodV1Schema, input.meta.requestId, input.request);
  }, agentMethodV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentMethodControl, z.object({ ...base, methodId: uuid, request: controlAgentMethodV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/methods/${input.methodId}/control`, "POST", agentMethodV1Schema, input.meta.requestId, input.request);
  }, agentMethodV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentMethodHistory, z.object({ ...base, methodId: uuid }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/methods/${input.methodId}/history`, "GET", agentMethodHistoryV1Schema, input.meta.requestId);
  }, agentMethodHistoryV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentMethodUses, z.object({ ...base, methodId: uuid }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/methods/${input.methodId}/uses`, "GET", agentMethodUsesV1Schema, input.meta.requestId);
  }, agentMethodUsesV1Schema);
  channel(DESKTOP_IPC_CHANNELS.agentMethodFeedback, z.object({ ...base, useId: uuid, request: agentMethodFeedbackV1Schema }).strict(), (_event, _window, input) => {
    authorize(input.meta); return request(`/agent/method-uses/${input.useId}/feedback`, "POST", agentMethodUseV1Schema, input.meta.requestId, input.request);
  }, agentMethodUseV1Schema);
}
