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
    this.code = `provider_http_${input.status}`;
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
