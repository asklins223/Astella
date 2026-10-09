/**
 * 凭据存储的**形状**（不是一个实现）。**2026-09-30 从 `desktop-gateway.ts` 原样搬出。**
 *
 * 实现留在原处（主进程有本地文件那一支，测试有内存那一支）；这里只留接口，
 * 好让 `GatewayTransport` 依赖一个**形状**而不是某个具体实现。
 */
import type { GatewayErrorCode } from "@astella/shared/desktop-ipc-contracts";

/** 凭据存储的能力；实现把凭据落在 userData 的本地文件里。 */
export type SessionCredentialStore = {
    /** Synchronous peek used by the runtime snapshot, before any adoption. */
    hasStored(): boolean;
    load(): Promise<string | null>;
    save(token: string): Promise<void>;
    clear(): Promise<void>;
  };
