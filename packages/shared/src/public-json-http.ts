import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { assertOutsideRegisteredTransactions } from "./workspace-transaction.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
// 2026-08-12（模型调用面审计）：生产路径此前只有 10s connect 超时，响应体
// 读取无任何上限——provider 半挂时请求无限挂起（http-pool 的 300s 只作用于
// undici dispatcher 路径，node:https 直连不经它）。总超时 = connect + 响应
// 体读取，默认 300s（长生成场景），可 AI_ENDPOINT_RESPONSE_TIMEOUT_MS 覆盖。
const TOTAL_RESPONSE_TIMEOUT_MS = envTimeoutMs("AI_ENDPOINT_RESPONSE_TIMEOUT_MS", 300_000);

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

type PinnedAddress = { address: string; family: 4 | 6 };

function allowsDockerDesktopSyntheticDns(): boolean {
  return process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS?.trim().toLowerCase() === "true";
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.some((byte) => byte < 0 || byte > 255)
    ? null
    : bytes as [number, number, number, number];
}

function parseIpv6(ip: string): number[] | null {
  let value = ip.split("%")[0];
  if (value.includes(".")) {
    const split = value.lastIndexOf(":");
    const bytes = split >= 0 ? parseIpv4(value.slice(split + 1)) : null;
    if (!bytes) return null;
    value = `${value.slice(0, split)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => half
    ? half.split(":").map((part) => /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : -1)
    : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if ([...left, ...right].some((part) => part < 0)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : null;
}

export function isNonPublicAIEndpointAddress(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isNonPublicAIEndpointAddress(mapped[1]);

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19) && !allowsDockerDesktopSyntheticDns()) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }

  const ipv6 = parseIpv6(normalized);
  if (!ipv6) return true;
  const first = ipv6[0];
  // Loopback (::1)
  if (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] <= 1) return true;
  // Link-local (fe80::/10), Unique Local Address (fc00::/7), Multicast (ff00::/8)
  // When AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS is true, also allow Clash/VPN
  // fake-IP IPv6 addresses (fdfe:dcba:9876::/64 pattern used by Clash).
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if ((first & 0xfe00) === 0xfc00) {
    // ULA range (fc00::/7). Clash fake-IP uses fdfe:dcba:9876::/64.
    // When Docker Desktop synthetic DNS is allowed, skip ULA addresses
    // instead of rejecting the entire hostname.
    if (allowsDockerDesktopSyntheticDns()) return false;
    return true;
  }
  // Only globally routed unicast space (2000::/3) is eligible.
  if ((first & 0xe000) !== 0x2000) return true;
  const second = ipv6[1];
  const third = ipv6[2];
  return (first === 0x2001 && (
    second === 0 || (second === 2 && third === 0) || second === 3 ||
    (second === 4 && third === 0x0112) || (second & 0xfff0) === 0x0010 ||
    (second & 0xfff0) === 0x0020 || second === 0x0db8
  )) || first === 0x2002 || (first === 0x3fff && (second & 0xf000) === 0);
}

async function resolvePublicAddress(hostname: string): Promise<PinnedAddress> {
  const clean = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!clean || clean === "localhost" || clean.endsWith(".local") || clean.endsWith(".internal")) {
    throw new Error("AI endpoint is not a public hostname");
  }
  const family = isIP(clean);
  if (family === 4 || family === 6) {
    if (isNonPublicAIEndpointAddress(clean)) throw new Error("AI endpoint resolved to a non-public address");
    return { address: clean, family };
  }
  // G-007: DNS 解析 hostname，检查 A/AAAA 记录。
  // 策略（与 parse-source.ts U5 修复一致）：过滤掉私有/内网地址，
  // 只从公网地址中选择。如果全部地址都是私有/内网，仍然拒绝。
  // CDN 域名 DNS 可能返回混合公网/内网地址（如负载均衡器内部地址），
  // 旧策略"任何一个私有就拒绝整个 hostname"会误杀合法 CDN 域名。
  const addresses = await dnsLookup(clean, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("AI endpoint hostname has no address");

  const publicAddresses = addresses.filter(
    (entry) => !isNonPublicAIEndpointAddress(entry.address),
  );

  if (publicAddresses.length === 0) {
    const blockedIps = addresses.map((a) => a.address).join(", ");
    throw new Error(
      `AI endpoint resolved to a non-public address — all resolved addresses are private: ${blockedIps}`,
    );
  }

  const selected = publicAddresses[0];
  if (selected.family !== 4 && selected.family !== 6) {
    throw new Error("AI endpoint has an unsupported address family");
  }
  return { address: selected.address, family: selected.family };
}

/**
 * Validate a custom AI endpoint URL without sending a request:
 * HTTPS-only, no inline credentials, and the hostname must resolve to a
 * public address. Used by transports (e.g. the DashScope fetch client) that
 * do not route through postJsonToPublicEndpoint's pinned request path.
 */
export async function assertPublicHttpsAIEndpoint(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("AI endpoints must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("AI endpoint URL credentials are not allowed");
  await resolvePublicAddress(parsed.hostname);
}

function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, _options, callback) => callback(null, pinned.address, pinned.family);
}

export interface PublicJsonResponse {
  status: number;
  statusText: string;
  body: unknown;
}

/**
 * P0-14：熔断器装在**全部** provider 的唯一出口上。
 *
 * openai-compatible.ts / opencode-go.ts / siliconflow.ts 三处都是
 * options.request ?? postJsonToPublicEndpoint，API 进程的 Critic 与 teaching
 * 调用也走这里。装在这一层，一处覆盖两个进程的全部模型 HTTP 调用；
 * 按 host 分键，所以一个上游挂掉不会连坐同进程里其它上游。
 */
import { CircuitOpenError, sharedAiCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.ts";

// ─── 全局出网重试（2026-10-06）────────────────────────────────────────────
//
// 用户决定：模型/平台不可用时**重试几次后报失败**。重试装在这一层（两个进程
// 的全部模型调用共用的唯一 HTTP 出口），判定只看"这一次请求发生了什么"：
//   - 抛错（DNS/连接被拒/TLS/连接超时/socket 重置）→ 可重试；
//   - 响应 429 / 500 / 502 / 503 / 504 → 可重试（响应体原样交给调用方前重试）；
//   - 4xx（除 429）是请求本身的问题，重试无意义 → 不重试；
//   - 调用方 abort、熔断拒绝（CircuitOpenError）、整体响应超时（挂起）→ 不重试。
// 重试耗尽后，最后一次的响应/异常**原样**交给调用方——错误分类与用户可见的
// 失败表达保持由上层负责，这一层只多花几次机会，不改变语义。

/** 总尝试次数（含首次）。 */
const EGRESS_RETRY_ATTEMPTS = 3;
/** 相邻尝试间的退避（最后一次失败后使用数组末项）。 */
const EGRESS_RETRY_BACKOFF_MS: readonly number[] = [300, 900];

/** 可重试的上游状态：限流与 5xx/网关错。 */
export function isRetryableEgressStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * 整体响应超时（TCP 已连但响应迟迟不返回/不推流）。**不重试**：
 * 它已经烧掉了调用方几乎全部预算，再试一次等于把等待翻倍。
 * 连接阶段的超时（10s 快速失败）是另一回事，那种可重试。
 */
export class EgressTotalTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressTotalTimeoutError";
  }
}

/** 这些异常重试没有意义：调用方已经不要结果了，或熔断正在要求快速失败。 */
export function isRetryUnsafeError(error: unknown): boolean {
  if (error instanceof CircuitOpenError || error instanceof EgressTotalTimeoutError) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if ((error as { code?: string }).code === "ABORT_ERR") return true;
  }
  return false;
}

/** abort 时可提前结束的等待。abort 后下一次尝试会立刻因中止而失败并停止重试。 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface EgressRetryOptions {
  /** 总尝试次数（含首次）。缺省 3。 */
  attempts?: number;
  /** 注入的等待实现（测试用）。 */
  sleep?: (ms: number) => Promise<void>;
}

function backoffFor(attemptIndex: number): number {
  return EGRESS_RETRY_BACKOFF_MS[Math.min(attemptIndex, EGRESS_RETRY_BACKOFF_MS.length - 1)]!;
}

/**
 * 有界重试的执行骨架（纯函数，HTTP 层与测试共用）。
 *
 * `shouldRetry` 可以异步（SSE 用它先把可重试状态的错误体读掉再重试）。
 * 最后一次尝试的结果**永远不再问 shouldRetry**：耗尽即原样交出。
 */
export async function runWithEgressRetry<T>(
  attempt: () => Promise<T>,
  shouldRetry: (result: T) => boolean | Promise<boolean>,
  options: EgressRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? EGRESS_RETRY_ATTEMPTS);
  const sleep = options.sleep ?? ((ms: number) => sleepWithSignal(ms));
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    const last = attemptIndex >= attempts - 1;
    let result: T;
    try {
      result = await attempt();
    } catch (error) {
      if (last || isRetryUnsafeError(error)) throw error;
      await sleep(backoffFor(attemptIndex));
      continue;
    }
    if (last || !(await shouldRetry(result))) return result;
    await sleep(backoffFor(attemptIndex));
  }
}

/** Preserve gateway HTTP failures even when the gateway sends an HTML error page. */
export function decodePublicJsonResponse(
  host: string,
  status: number,
  statusText: string,
  raw: string,
  breaker: Pick<CircuitBreaker, "recordFailure" | "recordSuccess"> = sharedAiCircuitBreaker,
): PublicJsonResponse {
  const upstreamFailure = status >= 500 || status === 429;
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch (cause) {
    if (status >= 200 && status < 300) {
      breaker.recordFailure(host);
      throw new Error(`AI endpoint returned invalid JSON (${status})`, { cause });
    }
    // Provider adapters classify non-success responses by status. HTML must not
    // hide a timeout/rate limit or become user-visible model output.
  }
  if (upstreamFailure) breaker.recordFailure(host);
  else breaker.recordSuccess(host);
  return { status, statusText, body };
}

export type PublicJsonRequester = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
) => Promise<PublicJsonResponse>;

export interface PublicStreamingResponse {
  status: number;
  statusText: string;
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and close the underlying socket. */
  cancel: () => void;
}

export type PublicStreamingRequester = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
) => Promise<PublicStreamingResponse>;

/** HTTPS-only JSON POST with DNS validation and connection-time IP pinning. */
export const postJsonToPublicEndpoint: PublicJsonRequester = async (
  url,
  headers,
  body,
  signal,
) => {
  const parsed = new URL(url);
  // W3-2 的 provider 层闸门：模型／转写／向量 HTTP 一律不许落在工作区事务里
  // （39c §5.2）。各进程在模块加载时把自己那份事务作用域读者登记进来
  // （worker `db.ts` / api `db/client.ts`），这里对全部读者逐个取当前值。
  assertOutsideRegisteredTransactions({
    boundary: "公共 AI HTTP 出口（模型/转写/向量请求）",
    caller: parsed.host,
  });
  if (parsed.protocol !== "https:") throw new Error("AI endpoints must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("AI endpoint URL credentials are not allowed");
  const encodedBody = Buffer.from(JSON.stringify(body));

  const attemptOnce = async (): Promise<PublicJsonResponse> => {
    // 每次尝试都重新解析并固定地址：重试时 DNS 可能已恢复或换到健康地址。
    const pinned = await resolvePublicAddress(parsed.hostname);
    const options: RequestOptions = {
      method: "POST",
      family: pinned.family,
      lookup: pinnedLookup(pinned),
      signal,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": String(encodedBody.length),
        "Accept-Encoding": "identity",
      },
    };
    if (!isIP(parsed.hostname)) {
      (options as RequestOptions & { servername: string }).servername = parsed.hostname;
    }

    // P0-14 熔断门卫：open 状态下直接抛，**一个字节都不发**。
    // 放在 DNS 解析之前是有意的：解析本身也是一次往返，而熔断要省的正是这段。
    // （2026-10-06：熔断拒绝属"别再试了"信号，重试层不会重试它。）
    sharedAiCircuitBreaker.assertCanAttempt(parsed.host);

    return new Promise<PublicJsonResponse>((resolve, reject) => {
      const request = httpsRequest(parsed, options, (response) => {
        response.once("error", (error) => {
          clearTimeout(totalTimer);
          sharedAiCircuitBreaker.recordFailure(parsed.host);
          reject(error);
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error(`AI endpoint response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          clearTimeout(totalTimer);
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(decodePublicJsonResponse(
              parsed.host, response.statusCode ?? 0, response.statusMessage ?? "", raw,
            ));
          } catch (error) {
            reject(error);
          }
        });
      });
      // A hung TCP/TLS connect (blocked container egress, required proxy, or a
      // fake-IP VPN resolver handing out 198.18.x.x) would otherwise silently
      // burn the caller's entire provider budget and read as a model timeout.
      // Fail fast with a pointed, distinguishable error instead.
      const connectTimer = setTimeout(() => {
        request.destroy(new Error(
          `AI endpoint TCP/TLS connection could not be established within ${CONNECT_TIMEOUT_MS}ms — check container network egress/proxy, or a fake-IP VPN DNS resolver (198.18.x.x)`,
        ));
      }, CONNECT_TIMEOUT_MS);
      // 2026-08-12：整体响应超时（connect + 响应体读取）——provider 半挂时
      // 不再无限挂起；触发后 destroy 走 request error 路径清理两个 timer。
      const totalTimer = setTimeout(() => {
        request.destroy(new EgressTotalTimeoutError(
          `AI endpoint request exceeded total timeout ${TOTAL_RESPONSE_TIMEOUT_MS}ms (connect + response body)`,
        ));
      }, TOTAL_RESPONSE_TIMEOUT_MS);
      request.on("socket", (socket) => {
        if (!socket.connecting) {
          clearTimeout(connectTimer);
          return;
        }
        socket.once("secureConnect", () => clearTimeout(connectTimer));
      });
      request.once("response", () => clearTimeout(connectTimer));
      request.once("error", (error) => {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        reject(error);
      });
      request.end(encodedBody);
    });
  };

  // 2026-10-06：全局出网重试（见文件顶部说明）。响应 429/5xx 与网络抛错重试，
  // 熔断拒绝/调用方 abort/整体超时不重试。
  return runWithEgressRetry(
    attemptOnce,
    (response) => isRetryableEgressStatus(response.status),
    { sleep: (ms) => sleepWithSignal(ms, signal) },
  );
};

/**
 * 给 SSE 响应体挂"流仍在推进"的进度回调，且**不消费**这个流。
 *
 * 必须用 `readable` 而不是 `data`：`data` 监听会把响应切到 flowing 模式，于是
 * **在读取方（`for await (const chunk of body)`）挂上来之前**到达的分片被这个监听
 * 直接吃掉。响应头与第一个分片常在同一个 I/O 回调里到达，所以丢的往往正是模型输出的
 * **第一个 token**：`好呀，…` → `呀，…`、`嗨～今天…` → `～今天…`。
 * 而 `content` 与交给读取方的增量累自同一批分片，缺的头两边一致，终态校验查不出来
 * （近两周 257 条回复里 27 条缺头，run 全部记为 succeeded）。
 * `readable` 与读取方走的是同一套机制，只观察、不取数据，所以既拿到逐分片的进度
 * 信号，又不会把内容从缓冲区里提前拿走。
 */
export function onSseBodyProgress(body: Readable, onTouch: () => void): void {
  body.on("readable", onTouch);
}

/** HTTPS-only streaming POST with the same DNS validation and connection-time IP pinning. */
export const postSseToPublicEndpoint: PublicStreamingRequester = async (
  url,
  headers,
  body,
  signal,
) => {
  const parsed = new URL(url);
  // 与 postJsonToPublicEndpoint 同一道闸（流式出口同样不许落在工作区事务里）。
  assertOutsideRegisteredTransactions({
    boundary: "公共 AI HTTP 出口（流式请求）",
    caller: parsed.host,
  });
  if (parsed.protocol !== "https:") throw new Error("AI endpoints must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("AI endpoint URL credentials are not allowed");
  const encodedBody = Buffer.from(JSON.stringify(body));

  const attemptOnce = async (): Promise<PublicStreamingResponse> => {
    const pinned = await resolvePublicAddress(parsed.hostname);
    const options: RequestOptions = {
      method: "POST",
      family: pinned.family,
      lookup: pinnedLookup(pinned),
      signal,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": String(encodedBody.length),
        "Accept-Encoding": "identity",
      },
    };
    if (!isIP(parsed.hostname)) {
      (options as RequestOptions & { servername: string }).servername = parsed.hostname;
    }

    return new Promise<PublicStreamingResponse>((resolve, reject) => {
      const request = httpsRequest(parsed, options, (response) => {
        clearTimeout(connectTimer);
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          body: response,
          cancel: () => {
            clearTimeout(totalTimer);
            response.destroy();
          },
        });
      });
      const connectTimer = setTimeout(() => {
        request.destroy(new Error(
          `AI endpoint TCP/TLS connection could not be established within ${CONNECT_TIMEOUT_MS}ms — check container network egress/proxy, or a fake-IP VPN DNS resolver (198.18.x.x)`,
        ));
      }, CONNECT_TIMEOUT_MS);
      // 2026-08-12+（15a 根因修复）：流式通道补整体响应超时（此前只有
      // connect 超时）。非流式 postJsonToPublicEndpoint 有 TOTAL_RESPONSE_TIMEOUT_MS
      // 兜底，流式漏了——"TCP 已连但 HTTP 响应头永不返回"时 Promise 永不
      // settle，worker 无限卡在 provider 调用 → run 永久 running → 前端永久
      // "伴星正在想"（且无 failed 事件）。totalTimer 在 resolve（响应头到达）
      // 后保留，同时覆盖"响应头到了但 body 永不推流"的挂起：触发 destroy →
      // error → reject → 调用方（chatCompletionStream）抛错 → 标记 run failed。
      // 2026-08-16（性能专项）：健康流正常结束或 cancel() 时清理 totalTimer 防
      // 泄漏；且每收到一个数据分片就重置该计时器（body-stall 语义），使
      // 合法长流（总时长 > TOTAL_RESPONSE_TIMEOUT_MS）不会被残留定时器误杀。
      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      const rearmTotalTimer = (): void => {
        clearTimeout(totalTimer);
        totalTimer = setTimeout(() => {
          request.destroy(new EgressTotalTimeoutError(
            `AI endpoint SSE request exceeded total timeout ${TOTAL_RESPONSE_TIMEOUT_MS}ms (connect + response body)`,
          ));
        }, TOTAL_RESPONSE_TIMEOUT_MS);
      };
      rearmTotalTimer();
      request.on("socket", (socket) => {
        if (!socket.connecting) {
          clearTimeout(connectTimer);
          return;
        }
        socket.once("secureConnect", () => clearTimeout(connectTimer));
      });
      request.once("response", (response) => {
        clearTimeout(connectTimer);
        // 正常收尾与显式取消都清掉残留定时器，避免每连接泄漏一个 300s 定时器。
        response.once("end", () => clearTimeout(totalTimer));
        response.once("close", () => clearTimeout(totalTimer));
        // body-stall：每次有分片可读说明流仍在推进，重置整体超时。
        onSseBodyProgress(response, rearmTotalTimer);
      });
      request.once("error", (error) => {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        reject(error);
      });
      request.end(encodedBody);
    });
  };

  // 2026-10-06 全局出网重试：建立连接前的网络错直接重试；可重试状态码（429/5xx）
  // 先把这个错误响应体读掉（错误体很小；超过 64KB 放弃读取直接关连接）再重试。
  // 响应一旦交给调用方（正文可能已被消费）就不再重试——见文件顶部的判定说明。
  return runWithEgressRetry(
    attemptOnce,
    async (response) => {
      if (!isRetryableEgressStatus(response.status)) return false;
      try {
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > 64 * 1024) break;
        }
      } catch {
        // 读错误体失败不影响重试。
      }
      response.cancel();
      return true;
    },
    { sleep: (ms) => sleepWithSignal(ms, signal) },
  );
};
