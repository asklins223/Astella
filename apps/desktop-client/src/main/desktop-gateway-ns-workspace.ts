/**
 * 网关的「空间与 AI 设置」那一族 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * ## 为什么它们现在能搬
 *
 * AST 实测：这一族对类状态的依赖**只剩同命名空间内部**。而且 1 个私有助手
 * **只被同族方法使用**——助手与通道方法整族一起搬；分开搬等于把它们拆散。
 *
 * 下面**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts`
 * 切出，只做三处改写——签名前加 `t: GatewayTransport`、`this.transport.` 换成 `t.`、
 * 同族方法互相调用改成直接按函数名。
 */
import { rawWorkspaceListSchema } from "./desktop-gateway-transport";
import {
  DesktopGatewayFailure,
} from "./desktop-gateway-failure";
import {
  GatewayTransport as GatewayTransportFromDesktopgatewaytransport,
} from "./desktop-gateway-transport";
import {
  AiDataPolicyV1,
  DissolvePreviewResultV1,
  DissolveWorkspaceResultV1,
  TransferWorkspaceOwnershipResultV1,
  WorkspaceAiSettingsV1,
  WorkspaceSummaryV1,
  dissolvePreviewResultV1Schema,
  dissolveWorkspaceResultV1Schema,
  transferWorkspaceOwnershipResultV1Schema,
  workspaceAiSettingsV1Schema,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  DesktopAiAuditPageV1,
  desktopAiAuditPageV1Schema,
} from "@ailearn/shared/desktop-surface-contracts";
import type {
  GatewayTransport,
} from "./desktop-gateway-transport";


export async function getWorkspaceAiSettings(t: GatewayTransport, requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/me/ai-settings", { method: "GET" }, true, true, requestId);
    const parsed = workspaceAiSettingsV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function dissolveWorkspace(t: GatewayTransport, workspaceId: string, requestId?: string): Promise<DissolveWorkspaceResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(`/workspaces/${workspaceId}`, {
      method: "DELETE",
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = dissolveWorkspaceResultV1Schema.safeParse({
      version: 1,
      workspaceId,
      counts: payload.counts ?? {},
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    t.currentSession = null;
    t.roomProjectionCache = null;
    return parsed.data;
  }

export async function fetchWorkspaceExport(t: GatewayTransport, requestId?: string): Promise<unknown> {
    await t.ensureConnected(requestId);
    const result = await t.request("/export/workspace", { method: "GET" }, true, true, requestId);
    return result.body;
  }

export async function getWorkspaceAiAuditLog(t: GatewayTransport, 
    limit: number,
    offset: number,
    requestId?: string,
  ): Promise<DesktopAiAuditPageV1> {
    await t.ensureConnected(requestId);
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const result = await t.request(
      `/workspace/ai-audit-log?limit=${encodeURIComponent(String(safeLimit))}&offset=${encodeURIComponent(String(safeOffset))}`,
      { method: "GET" },
      true,
      true,
      requestId,
    );
    const parsed = desktopAiAuditPageV1Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listWorkspaces(t: GatewayTransport, requestId?: string): Promise<{ workspaces: WorkspaceSummaryV1[] }> {
    await t.ensureConnected(requestId);
    const result = await t.request("/auth/workspaces", { method: "GET" }, true, true, requestId);
    const parsed = rawWorkspaceListSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return { workspaces: parsed.data.workspaces.map((workspace) => t.toWorkspaceSummary(workspace)) };
  }

export async function previewWorkspaceDissolve(t: GatewayTransport, workspaceId: string, requestId?: string): Promise<DissolvePreviewResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(`/workspaces/${workspaceId}/dissolve-preview`, {
      method: "GET",
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = dissolvePreviewResultV1Schema.safeParse({
      version: 1,
      workspaceId,
      counts: payload.counts ?? {},
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function transferWorkspaceOwnership(t: GatewayTransport, 
    workspaceId: string,
    toUserId: string,
    requestId?: string,
  ): Promise<TransferWorkspaceOwnershipResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request(`/workspaces/${workspaceId}/transfer-ownership`, {
      method: "POST",
      body: JSON.stringify({ toUserId }),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = transferWorkspaceOwnershipResultV1Schema.safeParse({
      version: 1,
      workspaceId,
      newOwnerUserId: payload.newOwnerUserId,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    t.currentSession = null;
    t.roomProjectionCache = null;
    return parsed.data;
  }

export async function updateAiConsent(t: GatewayTransport, consentVersion: string, requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await t.ensureConnected(requestId);
    await t.request("/me/ai-consent", {
      method: "PUT",
      body: JSON.stringify({ consentVersion }),
    }, true, true, requestId);
    // 写入后重新读取：界面显示的是服务端的当前状态，不在客户端拼一份。
    return getWorkspaceAiSettings(t, requestId);
  }

export async function updateAiDataPolicy(t: GatewayTransport, policy: AiDataPolicyV1, requestId?: string): Promise<WorkspaceAiSettingsV1> {
    await t.ensureConnected(requestId);
    await t.request("/me/ai-data-policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }, true, true, requestId);
    return getWorkspaceAiSettings(t, requestId);
  }
