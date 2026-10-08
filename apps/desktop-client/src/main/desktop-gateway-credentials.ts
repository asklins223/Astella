/**
 * 凭据存储的**形状**（不是一个实现）。**2026-09-30 从 `desktop-gateway.ts` 原样搬出。**
 *
 * 实现留在原处（主进程有安全存储那一支，测试有内存那一支）；这里只留接口，
 * 好让 `GatewayTransport` 依赖一个**形状**而不是某个具体实现。
 */
import type { GatewayErrorCode } from "@astella/shared/desktop-ipc-contracts";

/** 凭据存储的能力；实际加密是否可用在读写时确认，避免快照触发系统授权。 */
export type SessionCredentialStore = {
    /** False after encryption is found unavailable; reading this never prompts. */
    readonly available: boolean;
    /** Synchronous peek used by the runtime snapshot, before any adoption. */
    hasStored(): boolean;
    load(): Promise<string | null>;
    save(token: string): Promise<void>;
    clear(): Promise<void>;
  };
