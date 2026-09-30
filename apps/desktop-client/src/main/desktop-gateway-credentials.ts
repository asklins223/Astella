/**
 * 凭据存储的**形状**（不是一个实现）。**2026-09-30 从 `desktop-gateway.ts` 原样搬出。**
 *
 * 实现留在原处（主进程有安全存储那一支，测试有内存那一支）；这里只留接口，
 * 好让 `GatewayTransport` 依赖一个**形状**而不是某个具体实现。
 */
import type { GatewayErrorCode } from "@ailearn/shared/desktop-ipc-contracts";

/** 平台现在能不能把凭据加密落盘。 */
export type SessionCredentialStore = {
    /** Whether the platform can encrypt a credential at rest right now. */
    readonly available: boolean;
    /** Synchronous peek used by the runtime snapshot, before any adoption. */
    hasStored(): boolean;
    load(): Promise<string | null>;
    save(token: string): Promise<void>;
    clear(): Promise<void>;
  };
