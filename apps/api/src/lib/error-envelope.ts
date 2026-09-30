/**
 * 统一错误信封（P1-9）。
 *
 * ## 为什么收口
 *
 * 全仓有 **32 处** `reply.code(err.statusCode).send({ error: err.code, message: … })`，
 * 分布在三种**线格式**（wire shape）上：
 *
 *   A. `{ error, message, ...recoveryData }`            learning-runs/run-routes
 *   B. `{ error, message }`                             card-generation-v2
 *   C. `{ version: 1, error, message, recoverable, requestId }`  companion-conversation
 *
 * ## 为什么不把三种统一成一种
 *
 * C 里的 `version: 1` / `recoverable` / `requestId` 是**桌面契约**的一部分
 * （companion 端点的响应 schema），去掉就破坏契约。强行"统一"会改坏一个对外合同。
 *
 * 所以这里统一的是**决策逻辑**，不是线格式：给定一个错误，算出
 * 「该回什么状态码 / body 长什么样」，而这段判断此前在 32 个地方各写一遍。
 *
 * ## 收口前最容易出错的那一处
 *
 * 三种线格式里**只有 A 会带上 `recoveryData`**，而且它是**展开**在顶层而不是嵌一层。
 * 而 A 的错误类是 `LearningRunServiceError extends DomainError` 且额外带
 * `recoveryData` 字段——而 `DomainError` 本身**没有**这个字段。
 * 所以判断「有没有 recoveryData」不能写成 `if (err.recoveryData)`，得先确认
 * 那个字段真的存在，否则 TS 会收窄错类型。
 *
 * 还有一个**脱敏**分歧：companion 那几处对 5xx 把 message 换成占位符，
 * 而 A/B 直接把 `err.message` 回给客户端。5xx 的 message 可能是内部细节
 * （连接串、上游报错原文），脱敏是有意的。本模块用 `maskServerErrors` 显式表达
 * 这个选择，而不是让它藏在某几处的三元里。
 */

import { DomainError } from "@ailearn/shared";

/** 能否读到一个 `recoveryData` 字段——不能靠 `err.recoveryData` 触发收窄。 */
function recoveryDataOf(err: DomainError): Record<string, unknown> | undefined {
  const candidate = (err as { recoveryData?: unknown }).recoveryData;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as Record<string, unknown>)
    : undefined;
}

export interface ErrorEnvelopeOptions {
  /** 5xx 时把 message 换成占位符（避免把内部细节回给客户端）。 */
  maskServerErrors?: boolean;
  /** 5xx 的占位文案。 */
  serverErrorMessage?: string;
  /** 展开到顶层的附加字段（例如 CAS 冲突的 currentRevision / expected）。 */
  recoveryData?: Record<string, unknown>;
}

const DEFAULT_SERVER_ERROR_MESSAGE = "服务器内部错误";

/**
 * 是否是"能变成一个像样的 4xx/5xx 响应"的领域错误。
 *
 * 只认 `DomainError` 及其子类：那是本项目约定的"带 code + statusCode"的那一族。
 * `asserts / never` 之类的第三方错误、以及 `FastifyError`（它自带 statusCode 但
 * 语义不同），都不走这里——交给上层 `setErrorHandler` 统一脱敏。
 */
export function asDomainError(err: unknown): DomainError | null {
  return err instanceof DomainError ? err : null;
}

/** 线的 body（A/B/C 共用的计算部分）。`extra` 决定线格式的差异。 */
export function buildErrorBody(
  err: DomainError,
  extra: { version?: number; recoverable?: boolean; requestId?: string },
  options: ErrorEnvelopeOptions = {},
): Record<string, unknown> {
  const masked = options.maskServerErrors === true && err.statusCode >= 500;
  const message = masked
    ? (options.serverErrorMessage ?? DEFAULT_SERVER_ERROR_MESSAGE)
    : err.message;
  return {
    ...(extra.version === undefined ? {} : { version: extra.version }),
    error: err.code,
    message,
    ...(extra.recoverable === undefined ? {} : { recoverable: extra.recoverable }),
    ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
    ...(options.recoveryData ?? recoveryDataOf(err) ?? {}),
  };
}

/** A 线：learning-runs 那族——`{ error, message, ...recoveryData }`。 */
export function buildServiceErrorBody(
  err: DomainError,
  options: ErrorEnvelopeOptions = {},
): Record<string, unknown> {
  return buildErrorBody(err, {}, options);
}

/** B 线：`{ error, message }`，不带任何附加字段。 */
export function buildSimpleErrorBody(
  err: DomainError,
  options: ErrorEnvelopeOptions = {},
): Record<string, unknown> {
  return buildErrorBody(err, {}, { ...options, recoveryData: options.recoveryData ?? {} });
}

/** C 线：companion 桌面契约那族——5xx 脱敏 + version/recoverable/requestId。 */
export function buildCompanionErrorBody(
  err: DomainError,
  input: { recoverable: boolean; requestId: string },
  options: ErrorEnvelopeOptions = {},
): Record<string, unknown> {
  return buildErrorBody(
    err,
    { version: 1, recoverable: input.recoverable, requestId: input.requestId },
    { maskServerErrors: true, ...options },
  );
}
