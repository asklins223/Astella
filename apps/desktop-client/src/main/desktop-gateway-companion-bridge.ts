/**
 * 伴星桥：助手向服务端登记「我此刻在读哪一页」的那条通道，外加投递租约。
 *
 * ## 2026-09-30 从 `DesktopGateway` 搬出
 *
 * `desktop-gateway.ts` 当时 4995 行 / 200 个成员。这一簇有**自己的定时续约与世代号**
 * （`companionBridgeRenewTimer` / `companionBridgeGeneration`）、**自己的状态**与
 * **自己的租约表**——它是一个**自成一体的小子系统**，继续挂在那个类上只会让它更难读。
 *
 * ## 为什么是它先搬
 *
 * auth 的 `login` / `register` / `logout` / `reauthenticate` 四个方法要调
 * `clearCompanionBridgeContext` / `clearCompanionRuntimeState`，而它们属于这一簇。
 * **命名空间要等它依赖的私有状态先有落脚点**——这就是那一步。
 *
 * ## 构造器为什么是 `(transport, emit)` 两个参数
 *
 * `transport` —— 会话与请求（`token` / `request` / 两个会话 id 都在它上面）。
 * `emit`     —— 桥状态快照往事件总线的出口。**这是桥唯一与外部的耦合**，
 *              做成显式参数而不是让它反过来引用整个网关。
 *
 * 下面**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts` 切出，
 * 只做三处改写——`this.transport.` 展开、`this.deviceSessionId` 之类改成走传输层、
 * `private` 改成公开（网关要调）。
 */
import {
  randomUUID,
} from "node:crypto";
import {
  isDeepStrictEqual,
} from "node:util";
import {
  AssistantContextSnapshotV2,
  MainPageContextInputV2,
  assistantContextRenewResultV2Schema,
  assistantContextSnapshotV2Schema,
  assistantDeliveryV2Schema,
  mainPageContextInputV2Schema,
} from "@astella/shared/companion-bridge-contracts";
import {
  CompanionActivityAckRequestV1,
  CompanionActivityDeliveryV1,
} from "@astella/shared/companion-memory-desktop-contracts";
import {
  safeUuid,
} from "./desktop-gateway-uuid";
import {
  DesktopGatewayFailure,
} from "./desktop-gateway-failure";
import { AssistantDeliveryV2 } from "@astella/shared/companion-bridge-contracts";
import { companionActivityDeliveryV1Schema } from "@astella/shared/companion-memory-desktop-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";

export function projectCompanionDelivery(delivery: AssistantDeliveryV2 & { expired?: boolean }): CompanionActivityDeliveryV1 {
  const payload = delivery.payloadRef;
  const label = payload.kind === "system_event"
    ? payload.text ?? "伴星状态已更新"
    : payload.kind === "memory_item"
      ? payload.contentPreview ?? "有一条记忆候选等待查看"
      : payload.kind === "proposal"
        ? "有一项操作等待你确认"
        : payload.kind === "action_result"
          ? "伴星操作已有结果"
          : "收到一条伴星消息";
  const target: CompanionActivityDeliveryV1["target"] = payload.kind === "message"
    ? { kind: "dialogue", messageId: payload.messageId }
    : payload.kind === "proposal" || payload.kind === "action_result"
      ? { kind: "proposal", proposalId: payload.proposalId }
      : payload.kind === "memory_item"
        ? { kind: "memory", memoryId: payload.memoryItemId }
        : { kind: "none" };
  return companionActivityDeliveryV1Schema.parse({
    version: 1,
    deliveryId: delivery.deliveryId,
    inboxSequence: delivery.inboxSequence,
    state: delivery.state,
    kind: delivery.kind,
    label,
    target,
    expired: delivery.expired ?? new Date(delivery.expiresAt).getTime() <= Date.now(),
    createdAt: delivery.createdAt,
    expiresAt: delivery.expiresAt,
  });
}

export class CompanionBridge {
  constructor(private readonly transport: GatewayTransport) {}

companionBridgeContext: { readonly page: MainPageContextInputV2; snapshot: AssistantContextSnapshotV2 } | null = null;

readonly companionDeliveryLeases = new Map<string, { readonly inboxSequence: number; readonly leaseToken: string }>();

companionBridgeRenewTimer: ReturnType<typeof setInterval> | null = null;

companionBridgeGeneration = 0;

clearCompanionBridgeLocalState(): void {
    this.companionBridgeGeneration += 1;
    if (this.companionBridgeRenewTimer) clearInterval(this.companionBridgeRenewTimer);
    this.companionBridgeRenewTimer = null;
    this.companionBridgeContext = null;
  }

companionBridgeState(active: boolean, snapshot?: AssistantContextSnapshotV2) {
    return {
      version: 1 as const,
      active,
      revision: snapshot?.revision ?? null,
      expiresAt: snapshot?.expiresAt ?? null,
    };
  }

async renewCompanionBridgeContext(generation: number): Promise<void> {
    const current = this.companionBridgeContext;
    if (!current || generation !== this.companionBridgeGeneration) return;
    const result = await this.transport.request(
      `/companion/bridge/contexts/${current.snapshot.contextId}/renew`,
      {
        method: "POST",
        body: JSON.stringify({
          contextId: current.snapshot.contextId,
          pageInstanceId: current.snapshot.pageInstanceId,
          expectedRevision: current.snapshot.revision,
        }),
      },
      true,
      true,
    );
    const parsed = assistantContextRenewResultV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (generation !== this.companionBridgeGeneration || !this.companionBridgeContext) return;
    this.companionBridgeContext.snapshot = {
      ...this.companionBridgeContext.snapshot,
      revision: parsed.data.revision,
      expiresAt: parsed.data.expiresAt,
    };
  }

async setCompanionBridgeContext(
    pageInput: MainPageContextInputV2,
    requestId?: string,
  ) {
    await this.transport.ensureConnected(requestId);
    const page = mainPageContextInputV2Schema.parse(pageInput);
    const current = this.companionBridgeContext;
    if (current && isDeepStrictEqual(current.page, page)) {
      return this.companionBridgeState(true, current.snapshot);
    }
    await this.clearCompanionBridgeContext(requestId).catch(() => this.clearCompanionBridgeLocalState());
    const generation = this.companionBridgeGeneration;
    const contextId = randomUUID();
    const pageInstanceId = randomUUID();
    const result = await this.transport.request(
      "/companion/bridge/contexts",
      {
        method: "POST",
        body: JSON.stringify({
          contextId,
          deviceSessionId: this.transport.deviceSessionId,
          pageInstanceId,
          accountSessionId: this.transport.companionAccountSessionId,
          page,
        }),
      },
      true,
      true,
      requestId,
    );
    const parsed = assistantContextSnapshotV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (generation !== this.companionBridgeGeneration) return this.companionBridgeState(false);
    this.companionBridgeContext = { page, snapshot: parsed.data };
    this.companionBridgeRenewTimer = setInterval(() => {
      void this.renewCompanionBridgeContext(generation).catch(() => {
        const page = this.companionBridgeContext?.page;
        this.clearCompanionBridgeLocalState();
        // 续租失败不能只清本地状态：渲染层按内容去重发布，屏上没变就不会再推一次，
        // 于是这一页对她永久消失（30 秒租约到期后没有生产者）。手里这份 page 就是
        // 屏幕当前状态，重新 publish 一次才是自愈。
        if (page) void this.setCompanionBridgeContext(page).catch(() => undefined);
      });
    }, 10_000);
    return this.companionBridgeState(true, parsed.data);
  }

async clearCompanionBridgeContext(requestId?: string) {
    const current = this.companionBridgeContext;
    this.clearCompanionBridgeLocalState();
    if (!current || !this.transport.token) return this.companionBridgeState(false);
    await this.transport.request(
      `/companion/bridge/contexts/${current.snapshot.contextId}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          contextId: current.snapshot.contextId,
          pageInstanceId: current.snapshot.pageInstanceId,
          expectedRevision: current.snapshot.revision,
        }),
      },
      true,
      true,
      requestId,
    );
    return this.companionBridgeState(false);
  }

clearCompanionRuntimeState(): void {
    this.companionDeliveryLeases.clear();
    this.clearCompanionBridgeLocalState();
  }

async claimCompanionDeliveryLease(
    deliveryId: string,
    inboxSequence: number,
    requestId?: string,
  ): Promise<void> {
    const lease = { inboxSequence, leaseToken: randomUUID() };
    const claim = await this.transport.request(
      `/companion/deliveries/${deliveryId}/lease`,
      {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          deviceSessionId: this.transport.deviceSessionId,
          leaseToken: lease.leaseToken,
          idempotencyKey: randomUUID(),
        }),
      },
      true,
      true,
      requestId,
    );
    const claimed = assistantDeliveryV2Schema.safeParse(claim.body);
    if (!claimed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    this.companionDeliveryLeases.set(deliveryId, lease);
  }

async presentCompanionDelivery(
    deliveryId: string,
    inboxSequence: number,
    requestId?: string,
  ): Promise<CompanionActivityDeliveryV1> {
    await this.transport.ensureConnected(requestId);
    const id = safeUuid(deliveryId);
    const lease = this.companionDeliveryLeases.get(id);
    if (!lease || lease.inboxSequence !== inboxSequence) {
      await this.claimCompanionDeliveryLease(id, inboxSequence, requestId);
    }
    const shown = await this.ackCompanionDelivery({ deliveryId: id, inboxSequence, transition: "displayed" }, requestId);
    return shown;
  }

async ackCompanionDelivery(
    input: CompanionActivityAckRequestV1,
    requestId?: string,
  ): Promise<CompanionActivityDeliveryV1> {
    await this.transport.ensureConnected(requestId);
    const id = safeUuid(input.deliveryId);
    const lease = this.companionDeliveryLeases.get(id);
    if (!lease || lease.inboxSequence !== input.inboxSequence) {
      throw new DesktopGatewayFailure("conflict", "resync_first");
    }
    const sendAck = (leaseToken: string) => this.transport.request(
      `/companion/deliveries/${id}/ack`,
      {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          deliveryId: id,
          inboxSequence: input.inboxSequence,
          deviceSessionId: this.transport.deviceSessionId,
          leaseToken,
          transition: input.transition,
          idempotencyKey: randomUUID(),
        }),
      },
      true,
      true,
      requestId,
    );
    let result;
    try {
      result = await sendAck(lease.leaseToken);
    } catch (error) {
      if (!(error instanceof DesktopGatewayFailure) || error.code !== "conflict") throw error;
      this.companionDeliveryLeases.delete(id);
      await this.claimCompanionDeliveryLease(id, input.inboxSequence, requestId);
      const renewed = this.companionDeliveryLeases.get(id);
      if (!renewed) throw new DesktopGatewayFailure("conflict", "resync_first");
      result = await sendAck(renewed.leaseToken);
    }
    const parsed = assistantDeliveryV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (input.transition === "acted" || input.transition === "dismissed") {
      this.companionDeliveryLeases.delete(id);
    }
    return projectCompanionDelivery(parsed.data);
  }
}
