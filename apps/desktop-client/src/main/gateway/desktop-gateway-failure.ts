/**
 * 网关的失败类型。**2026-09-30 从 `desktop-gateway.ts` 原样搬出。**
 *
 * 它原先与 `DesktopGateway` 同文件，而那个文件里**每个方法抛的都是它**——
 * 一个被 264 个方法引用的类型放在一个 6379 行文件的中段，读的人几乎不可能一眼看到。
 * 错误类型是**整个传输层与每一个命名空间共用的词汇**，自己一个文件是对的。
 */
import type { GatewayErrorCode } from "@astella/shared/desktop-ipc-contracts";

export class DesktopGatewayFailure extends Error {
  readonly code: GatewayErrorCode;
  readonly retry: "never" | "user_action" | "safe_retry" | "resync_first";
  readonly httpStatus?: number;
  readonly retryAfter?: string;
  readonly localEffect?: "credential_cleared" | "request_cancelled";

  constructor(
    code: GatewayErrorCode,
    retry: "never" | "user_action" | "safe_retry" | "resync_first",
    options: { httpStatus?: number; retryAfter?: string; localEffect?: "credential_cleared" | "request_cancelled" } = {},
  ) {
    super(code);
    this.name = "DesktopGatewayFailure";
    this.code = code;
    this.retry = retry;
    this.httpStatus = options.httpStatus;
    this.retryAfter = options.retryAfter;
    this.localEffect = options.localEffect;
  }
}
