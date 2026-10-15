/** Privacy-safe provider transport error. */
export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly providerCode: string | null;
  readonly code: string;

  constructor(input: {
    provider: string;
    status: number;
    providerCode?: string | number | null;
  }) {
    super(`${input.provider} request failed with HTTP ${input.status}`);
    this.name = "ProviderRequestError";
    this.provider = input.provider;
    this.status = input.status;
    this.providerCode = input.providerCode == null
      ? null
      : String(input.providerCode).slice(0, 80);
    // `code` 是失败入库后**唯一**保留下来的机器字段（jobs.last_error 走
    // safeErrorMessage，只投影 category/name/code，providerCode 字段到不了那里）。
    // 2026-10-14 实测：10 条 companion_agent dead 全是 provider_http_400，
    // 但网关在 body 里给的错误类型（如 invalid_request_error / MissingSessionID）
    // 一条都没留下，只能靠人肉重放猜。把网关错误类型归一化后拼进 code：
    // 只保留 [A-Za-z0-9_.-]（safeCode 的合法字符集），总长控制在 40 以内。
    const normalized = this.providerCode
      ?.replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "")
      .slice(0, 20);
    this.code = normalized
      ? `provider_http_${input.status}_${normalized}`
      : `provider_http_${input.status}`;
  }
}

/** Terminal protocol status only; never includes an upstream error body. */
export class ProviderStreamError extends Error {
  constructor(readonly provider: string,
    readonly code: "stream_incomplete" | "stream_failed" | "stream_empty" | "stream_too_large" | "stream_content_mismatch") {
    super(`${provider} ${code === "stream_empty" ? "returned empty streaming output" : code.replaceAll("_", " ")}`);
    this.name = "ProviderStreamError";
  }
}
