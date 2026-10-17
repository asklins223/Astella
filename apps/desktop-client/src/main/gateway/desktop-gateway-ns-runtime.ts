/**
 * 网关的「运行时」那一族方法 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * 本族原先依赖 `getConnectionState` / `connect` 两个类成员；2026-09-30 第四刀
 * 把它们搬进了 `GatewayTransport`，于是本族对类状态的依赖**归零**。
 *
 * 下面的代码**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts`
 * 切出，只做两处改写——签名前加 `t: GatewayTransport`，方法体里 `t.transport.` 换成 `t.`。
 */
import { z } from "zod";
import { DesktopGatewayFailure } from "./desktop-gateway-failure";
import { rawHealthSchema, rawReadinessSchema } from "./desktop-gateway-transport";
import type { ApiConnectionStateV1 } from "@astella/shared/desktop-ipc-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";

export function cancel(t: GatewayTransport, requestId: string): boolean {
    const controller = t.activeRequests.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

export async function getHealth(t: GatewayTransport, requestId?: string): Promise<{ status: "ok" | "degraded"; checkedAt: string; latencyMs: number; instanceId?: string; domainSchemaRevision: string }> {
    await t.ensureConnected(requestId);
    const startedAt = Date.now();
    const result = await t.request("/health", { method: "GET" }, false, true, requestId);
    const parsed = rawHealthSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    const readiness = await t.request("/ready", { method: "GET" }, false, false, requestId, undefined, true);
    const readinessParsed = rawReadinessSchema.safeParse(readiness.body);
    if (!readinessParsed.success || (readiness.status < 300 && readinessParsed.data.status !== "ready") || (readiness.status >= 300 && readinessParsed.data.status !== "not_ready")) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return {
      status: readinessParsed.data.status === "ready" ? "ok" : "degraded",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      instanceId: t.trust.state === "trusted" ? t.trust.instanceId : undefined,
      domainSchemaRevision: t.configuration?.config.expectedDomainSchemaRevision ?? "unknown",
    };
  }

export async function retryConnection(t: GatewayTransport, requestId?: string): Promise<ApiConnectionStateV1> {
    await t.connect(requestId);
    return t.getConnectionState();
  }
