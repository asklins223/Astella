import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  gunzipSync,
  inflateSync,
  inflateRawSync,
  brotliDecompressSync,
} from "node:zlib";
import { logger } from "../lib/logger.ts";
import * as schema from "@astella/shared/db-schema";
import { safeErrorMessage, SourceStatus } from "@astella/shared";
import { MAX_SOURCE_TEXT_BYTES } from "@astella/shared/object-transfer-contracts";
// 稳定 P1（2026-09-15 审计）：parse_source payload 的精确契约 + fail-closed 读取器
// （与 API 生产端 source/service.ts 同源），替代此前的 `as string | undefined` 弱读。
import { readParseSourceJobPayload } from "@astella/shared/job-payload-contracts";
import { isStorageConfigured, uploadSourceImage, getObjectBytes } from "../lib/object-storage.ts";
import {
  parseContent,
  segmentsToBlocks,
  extractTitleFromBlocks,
  type ParsedBlock,
} from "@astella/shared/markdown-parser";
import {
  assertJobLease,
  isJobLeaseActive,
  lockJobLease,
  throwIfJobAborted,
  withJobTransaction,
} from "../lib/job-lease.ts";
import type { JobPayload } from "./index.ts";
import { extractHtmlTitle, extractTextFromHtml } from "./parse-source-html.ts";

// R-014: URL 抓取限制
const FETCH_TIMEOUT_MS = 20_000; // 从 15s 延长到 20s
// 原始 HTTP 响应体（解压后）的大小上限。微信公众号等内容密集型页面的原始 HTML
// （含大量内联样式、脚本）解压后常达 3–5MB；extractTextFromHtml 会剥离标签和噪声，
// 清洗后文本远小于此值。设为 5MB 以容纳大型网页同时仍提供安全上限。
const FETCH_MAX_BYTES = 5_000_000; // 5MB
const FETCH_MAX_REDIRECTS = 5;
const FETCH_ALLOWED_PROTOCOLS = ["http:", "https:"];

// User-Agent：使用真实浏览器 UA 避免被反爬风控拦截（如 Bilibili 返回验证码页面）。
// 通过环境变量 SOURCE_FETCH_USER_AGENT 可覆盖，支持特定场景定制。
const FETCH_USER_AGENT =
  process.env.SOURCE_FETCH_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Phase A: 通过环境变量控制 Accept-Encoding，支持运行时回滚
// 默认 "gzip, deflate, br, identity"；回滚设为 "identity" 即恢复原行为
const FETCH_ACCEPT_ENCODING =
  process.env.SOURCE_FETCH_ACCEPT_ENCODING ?? "gzip, deflate, br, identity";

// Phase A: 重试次数通过环境变量控制，支持运行时回滚
// NaN 防护：Number("abc") 返回 NaN，循环 `attempt <= NaN` 恒 false 会导致 lastError 为 null，
// 最终 throw null 而非 Error 对象。必须用 isFinite 校验后回退默认值。
const _parsedRetry = Number(process.env.SOURCE_FETCH_RETRY_COUNT ?? 1);
const FETCH_RETRY_COUNT = Number.isFinite(_parsedRetry) && _parsedRetry >= 0 ? _parsedRetry : 1;

/**
 * An archived source is terminal for parse jobs. Every database write also
 * repeats this guard in SQL; keeping the predicate exported makes the state
 * rule explicit and independently testable.
 */
export function canAdvanceSourceParse(status: string): boolean {
  return status !== SourceStatus.ARCHIVED;
}

/**
 * `parse_source` 判死时的收尾（审计 F32 的第三条，也是 F27 剩下的那半）。
 *
 * 采集失败的现场此前只有 `jobs` 那一行知道：`sources.status` 停在 `draft`/`processing`，
 * 列表把它显示成「待解析 / 正在解析」，用户等一个永远不来的 worker；而"解析失败"
 * 这个筛选因此永远是 0（审计现场：14 条 dead job 一个都数不到）。失败必须落在
 * 用户看得见的那张表上。
 *
 * 只动"还没解析成"的两态：另一次重试已经把它推到 `ready`、或用户已经归档，
 * 都不该被这一次失败改回去。原因（脱敏后的那一句）落在 metadata.parseFailure 里，
 * 详情页据此说清"上一次为什么没成"，而不是只给一个红点。
 *
 * 收尾本身失败只记日志：job 已经进终态，这里再抛只会让调用方以为连终态都没写成。
 */
export async function markSourceParseFailed(job: JobPayload, message: string): Promise<void> {
  let sourceId: string;
  try {
    ({ sourceId } = readParseSourceJobPayload(job.payload));
  } catch {
    // 坏载荷连"这一篇是哪一篇"都读不出来，没有可写的对象。
    return;
  }
  try {
    await withJobTransaction(job, async (tx) => {
      const [row] = await tx
        .select({ id: schema.sources.id, metadata: schema.sources.metadata })
        .from(schema.sources)
        .where(and(
          eq(schema.sources.id, sourceId),
          eq(schema.sources.workspaceId, job.workspaceId),
        ))
        .for("update");
      if (!row) return;
      const reason = safeErrorMessage(message).slice(0, 200);
      await tx
        .update(schema.sources)
        .set({
          status: SourceStatus.FAILED,
          metadata: {
            ...((row.metadata ?? {}) as Record<string, unknown>),
            parseFailure: { at: new Date().toISOString(), reason },
          },
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.sources.id, sourceId),
          eq(schema.sources.workspaceId, job.workspaceId),
          inArray(schema.sources.status, [SourceStatus.DRAFT, SourceStatus.PROCESSING]),
        ));
    });
  } catch (err) {
    logger.warn({ err, jobId: job.id, sourceId }, "marking source parse-failed failed (job is already terminal)");
  }
}

/**
 * Parse an IPv4 address into bytes. Invalid text is treated as non-public by
 * the caller rather than being allowed to reach the network.
 */
function parseIpv4Bytes(ip: string): [number, number, number, number] | null {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  if (bytes.some((byte) => byte < 0 || byte > 255)) return null;
  return bytes as [number, number, number, number];
}

function parseIpv6Hextets(ip: string): number[] | null {
  let value = ip.split("%")[0];
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const bytes = parseIpv4Bytes(value.slice(lastColon + 1));
    if (!bytes) return null;
    const high = (bytes[0] << 8) | bytes[1];
    const low = (bytes[2] << 8) | bytes[3];
    value = `${value.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
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
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

/**
 * Docker Desktop / 代理工具（Clash fake-ip 等）可能在 198.18.0.0/15 范围合成
 * DNS 答案。此环境变量为 true 时放行该范围，与 public-json-http.ts 行为一致。
 */
function allowsDockerDesktopSyntheticDns(): boolean {
  return process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS?.trim().toLowerCase() === "true";
}

/**
 * G-007: SSRF 防护 — IP 级别非公网地址检测。
 * 检查 IPv4 和 IPv6 地址是否属于私有、保留、环回、链路本地等范围。
 */
export function isPrivateIpAddress(ip: string): boolean {
  const normalizedIp = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const mappedMatch = normalizedIp.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedMatch) {
    return isPrivateIpAddress(mappedMatch[1]);
  }

  // IPv4
  const ipv4 = parseIpv4Bytes(normalizedIp);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 127) return true;                         // 127.0.0.0/8 (loopback)
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    if (a === 192 && b === 0 && c === 0) return true;   // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true;   // TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19) && !allowsDockerDesktopSyntheticDns()) return true; // benchmark network (RFC 2544) / Docker Desktop synthetic DNS
    if (a === 198 && b === 51 && c === 100) return true;  // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;   // TEST-NET-3
    if (a >= 224) return true;                           // multicast / reserved
    return false;
  }

  // IPv6
  const hextets = parseIpv6Hextets(normalizedIp);
  if (!hextets) return true;
  const first = hextets[0];
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] <= 1) return true; // :: / ::1
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8

  // IPv4-mapped and deprecated IPv4-compatible forms written with hexadecimal
  // hextets (URL parsing canonicalizes ::ffff:127.0.0.1 to ::ffff:7f00:1).
  const leadingZeroes = hextets.slice(0, 5).every((part) => part === 0);
  if (leadingZeroes && (hextets[5] === 0 || hextets[5] === 0xffff)) {
    const embedded = [
      hextets[6] >> 8,
      hextets[6] & 0xff,
      hextets[7] >> 8,
      hextets[7] & 0xff,
    ].join(".");
    return isPrivateIpAddress(embedded);
  }

  // Only globally routed unicast space (2000::/3) is eligible. This rejects
  // discard-only, NAT64/local translation and currently reserved ranges by
  // default instead of assuming every syntactically valid IPv6 is public.
  if ((first & 0xe000) !== 0x2000) return true;

  const second = hextets[1];
  const third = hextets[2];
  if (first === 0x2001 && second === 0x0000) return true; // Teredo 2001::/32
  if (first === 0x2001 && second === 0x0002 && third === 0) return true; // benchmarking /48
  if (first === 0x2001 && second === 0x0003) return true; // AMT /32
  if (first === 0x2001 && second === 0x0004 && third === 0x0112) return true; // AS112 /48
  if (first === 0x2001 && (second & 0xfff0) === 0x0010) return true; // ORCHID /28
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return true; // ORCHIDv2 /28
  if (first === 0x2001 && second === 0x0db8) return true; // documentation /32
  if (first === 0x2002) return true; // 6to4 can encode private IPv4 targets
  if (first === 0x3fff && (second & 0xf000) === 0) return true; // documentation /20
  return false;
}

/**
 * G-007: SSRF 防护 — 通过 DNS 解析检查 hostname 是否指向私有/内网地址。
 * 替代旧的字符串黑名单，防止 localhost.、[::1]、Docker 服务名等绕过。
 */
export type PinnedAddress = { address: string; family: 4 | 6 };
export type AddressResolver = (hostname: string) => Promise<PinnedAddress>;
type PinnedResponse = {
  status: number;
  statusText: string;
  location?: string;
  contentType: string;
  body: Buffer;
};
export type PinnedRequester = (
  parsed: URL,
  pinned: PinnedAddress,
  signal: AbortSignal,
) => Promise<PinnedResponse>;
export type FetchUrlDependencies = {
  resolveAddress?: AddressResolver;
  request?: PinnedRequester;
  /**
   * 每个 hop 在**外发之前**被调用一次，拿到的是该 hop 已经解析好的 URL。
   *
   * 放在这里而不是让调用方自己先看一眼，是因为重定向链上的每一跳都可能落到
   * 调用方不允许的地方：只校验初始 URL 等于把第二个 hop 交给运气。
   */
  validateUrl?: (url: URL) => void;
  /**
   * 响应成功（2xx）、**读取正文之前**被调用一次，参数是原始 content-type 头。
   *
   * 在读取之前而不是之后，是为了让"PDF / 图片 / 二进制"这类内容**根本没被读进
   * 内存**——`readAgentPublicDocument` 要的就是这个：它不解析二进制，也没有浏览器。
   */
  acceptContentType?: (contentType: string) => void;
  /**
   * 置为 true 时返回值带上**实际**的 url 与 content-type（含重定向后的最终 URL）。
   * 默认 / 未置位时返回形状与此前完全一致，老调用方不受影响。
   */
  includeResponseMetadata?: boolean;
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("URL fetch aborted", { cause: signal.reason });
}

/** Race an otherwise non-cancellable operation (notably DNS lookup) with a signal. */
async function awaitWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  const task = operation();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Resolve once, reject the whole answer set if any address is non-public, and
 * return the exact address that the HTTP client must use. The request must not
 * perform another system DNS lookup after this function returns.
 */
async function resolvePublicAddress(hostname: string): Promise<PinnedAddress> {
  const cleanHostname = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

  // 常见私有 hostname 模式
  if (cleanHostname === "localhost" || cleanHostname.endsWith(".local") || cleanHostname.endsWith(".internal")) {
    throw new Error(`blocked: private/internal host (${hostname})`);
  }

  // 如果已经是 IP 地址，直接检查
  const literalFamily = isIP(cleanHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isPrivateIpAddress(cleanHostname)) {
      throw new Error(`blocked: private/internal host (${hostname})`);
    }
    return { address: cleanHostname, family: literalFamily };
  }

  // G-007: DNS 解析 hostname，检查 A/AAAA 记录。
  // 策略：过滤掉私有/内网地址，只从公网地址中选择。
  // 安全性：createPinnedLookup 固定连接 IP，被跳过的私有地址永远不会被连接。
  // 如果全部地址都是私有/内网，仍然拒绝（SSRF 防护不变）。
  // 修复 U5：CDN 域名 DNS 可能返回混合公网/内网地址（如负载均衡器内部地址），
  // 旧策略"任何一个私有就拒绝整个 hostname"会误杀合法 CDN 域名。
  try {
    const addresses = await dnsLookup(cleanHostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new Error(`blocked: hostname has no address (${hostname})`);
    }

    const publicAddresses = addresses.filter(
      (addr) => !isPrivateIpAddress(addr.address),
    );

    if (publicAddresses.length === 0) {
      // 所有地址都是私有/内网——仍然拒绝（SSRF 防护不变）
      const blockedIps = addresses.map((a) => a.address).join(", ");
      throw new Error(
        `blocked: private/internal host (${hostname}) — all resolved addresses are private: ${blockedIps}`,
      );
    }

    // 部分地址被跳过时记录日志，便于诊断 CDN 误杀问题
    if (publicAddresses.length < addresses.length) {
      const skipped = addresses
        .filter((a) => isPrivateIpAddress(a.address))
        .map((a) => a.address)
        .join(", ");
      logger.warn(
        { hostname, skippedPrivateIps: skipped, publicCount: publicAddresses.length, totalCount: addresses.length },
        "SSRF check skipped private DNS addresses, using public ones",
      );
    }

    const selected = publicAddresses[0];
    if (selected.family !== 4 && selected.family !== 6) {
      throw new Error(`blocked: unsupported address family (${selected.family})`);
    }
    return { address: selected.address, family: selected.family };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("blocked:")) throw err;
    throw new Error(`blocked: DNS resolution failed (${hostname})`, { cause: err });
  }
}

/** 日志用 URL 脱敏：只保留 protocol+host+pathname，剥离 query/hash（来源 URL 可能携带敏感参数）。 */
function stripUrlSensitiveParts(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // 非标准 URL（如文件路径/相对串）截断到 200 字符
    return rawUrl.slice(0, 200);
  }
}

function getHeader(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function createPinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, _options, callback) => {
    callback(null, pinned.address, pinned.family);
  };
}

/**
 * 解压 buffer，支持 gzip / deflate / br。
 * deflate 先尝试标准 zlib wrapper（inflateSync），Z_DATA_ERROR 时 fallback 到 raw deflate（inflateRawSync）。
 * 部分老服务器返回 `x-gzip`（等价于 `gzip`），在 contentEncoding 赋值时归一化为 `gzip`。
 */
export function decompressBuffer(compressed: Buffer, encoding: string): Buffer {
  if (encoding === "gzip" || encoding === "x-gzip") {
    return gunzipSync(compressed, { maxOutputLength: FETCH_MAX_BYTES });
  }
  if (encoding === "br") {
    return brotliDecompressSync(compressed, { maxOutputLength: FETCH_MAX_BYTES });
  }
  if (encoding === "deflate") {
    try {
      return inflateSync(compressed, { maxOutputLength: FETCH_MAX_BYTES });
    } catch (err) {
      // 很多服务器把 raw deflate（无 zlib header）误标为 deflate。
      // inflateSync 期望 zlib wrapper，遇到 raw deflate 会抛 Z_DATA_ERROR，
      // 此时 fallback 到 inflateRawSync。
      // 注意：Node.js zlib 错误的 code 在 err.code（如 "Z_DATA_ERROR"），
      // err.message 是人类可读描述（如 "incorrect header check"），不含 Z_DATA_ERROR。
      const errCode = (err as NodeJS.ErrnoException).code;
      if (err instanceof Error && (errCode === "Z_DATA_ERROR" || /Z_DATA_ERROR/.test(err.message))) {
        return inflateRawSync(compressed, { maxOutputLength: FETCH_MAX_BYTES });
      }
      throw err;
    }
  }
  throw new Error(`unsupported content encoding: ${encoding}`);
}

/**
 * Issue one GET request to a previously validated address. The URL hostname is
 * retained for the Host header and HTTPS SNI/certificate validation, while the
 * custom lookup callback always returns the pinned IP. This closes the DNS
 * validation/connect TOCTOU window.
 */
async function requestPinnedUrl(
  parsed: URL,
  pinned: PinnedAddress,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const options: RequestOptions = {
    method: "GET",
    family: pinned.family,
    lookup: createPinnedLookup(pinned),
    signal,
    headers: {
      // 使用真实浏览器 UA 避免被反爬风控拦截（如 Bilibili 验证码页面）。
      // 通过 SOURCE_FETCH_USER_AGENT 环境变量可覆盖。
      "User-Agent": FETCH_USER_AGENT,
      Accept: "text/html,text/plain,application/json,*/*",
      // 中文优先，覆盖大多数用户场景
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      // 浏览器 Sec-Fetch 指示符，部分反爬系统检查这些头
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      // Phase A: 支持压缩响应，通过环境变量控制可回滚
      "Accept-Encoding": FETCH_ACCEPT_ENCODING,
    },
  };
  if (parsed.protocol === "https:" && !isIP(parsed.hostname)) {
    // RequestOptions is shared by http/https at runtime. Keep the original DNS
    // name for TLS SNI and certificate hostname verification.
    (options as RequestOptions & { servername: string }).servername = parsed.hostname;
  }

  return new Promise((resolve, reject) => {
    const onResponse = (response: IncomingMessage) => {
      // Install this before any early return (including redirects) so a socket
      // error while draining the response is never emitted without a listener.
      response.once("error", reject);
      const status = response.statusCode ?? 0;
      const statusText = response.statusMessage ?? "";
      const location = getHeader(response, "location");

      if (status >= 300 && status < 400 && location) {
        response.resume();
        resolve({ status, statusText, location, contentType: "", body: Buffer.alloc(0) });
        return;
      }

      // 归一化：部分老服务器返回 `x-gzip`（等价于 `gzip`），统一为 `gzip` 简化后续分支判断
      const rawEncoding = (getHeader(response, "content-encoding") ?? "identity").toLowerCase();
      const contentEncoding = rawEncoding === "x-gzip" ? "gzip" : rawEncoding;

      if (contentEncoding === "identity") {
        // identity：Content-Length 预检 + 流上限制（双重防护）
        const rawLength = getHeader(response, "content-length");
        const contentLength = rawLength === undefined ? 0 : Number(rawLength);
        if (Number.isFinite(contentLength) && contentLength > FETCH_MAX_BYTES) {
          response.destroy();
          reject(new Error(`content too large: ${contentLength} bytes (max ${FETCH_MAX_BYTES})`));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > FETCH_MAX_BYTES) {
            response.destroy(new Error(`content exceeded max size (${FETCH_MAX_BYTES} bytes)`));
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          resolve({
            status,
            statusText,
            contentType: getHeader(response, "content-type") ?? "",
            body: Buffer.concat(chunks),
          });
        });
      } else if (contentEncoding === "gzip" || contentEncoding === "deflate" || contentEncoding === "br") {
        // gzip / deflate / br：先收集完整压缩 buffer，再解压
        // 压缩后大小预检：允许压缩后 2x FETCH_MAX_BYTES（压缩比通常 < 10x）
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > FETCH_MAX_BYTES * 2) {
            response.destroy(new Error(`compressed content too large (${totalBytes} bytes)`));
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          const compressed = Buffer.concat(chunks);
          try {
            const decompressed = decompressBuffer(compressed, contentEncoding);
            // 解压后大小检查（防解压炸弹）
            if (decompressed.length > FETCH_MAX_BYTES) {
              reject(new Error(`decompressed content too large: ${decompressed.length} bytes (max ${FETCH_MAX_BYTES})`));
              return;
            }
            // 可观测性：记录压缩编码和响应大小，便于量化压缩编码分布和解压比
            logger.info(
              { url: stripUrlSensitiveParts(parsed.href), contentEncoding, compressedBytes: compressed.length, decompressedBytes: decompressed.length },
              "URL response decompressed",
            );
            resolve({
              status,
              statusText,
              contentType: getHeader(response, "content-type") ?? "",
              body: decompressed,
            });
          } catch (err) {
            reject(new Error(`decompression failed (${contentEncoding}): ${err instanceof Error ? err.message : String(err)}`));
          }
        });
        // 压缩分支不重复注册 response.once("error") ——
        // 上方的 response.once("error", reject) 已对所有响应生效
      } else {
        response.destroy();
        reject(new Error(`unsupported content encoding: ${contentEncoding}`));
        return;
      }
    };

    const request = parsed.protocol === "https:"
      ? httpsRequest(parsed, options, onResponse)
      : httpRequest(parsed, options, onResponse);
    request.once("error", reject);
    request.end();
  });
}

/**
 * fetchUrlContent 的返回类型，包含提取的文本和可选的 HTML 标题。
 */
export interface FetchedContent {
  text: string;
  title: string | null;
  /** 仅当 `dependencies.includeResponseMetadata === true` 时出现：重定向后的实际 URL。 */
  url?: string;
  /** 同上：响应的实际 content-type 头。 */
  contentType?: string;
}

/**
 * R-014: 受控 HTTP 抓取 — 含 SSRF 防护、超时、大小限制和重定向控制。
 * 原有逻辑重命名为 fetchUrlContentOnce，由 fetchUrlContent 重试包装器调用。
 */
export async function fetchUrlContentOnce(
  url: string,
  signal?: AbortSignal,
  dependencies: FetchUrlDependencies = {},
): Promise<FetchedContent> {
  const resolveAddress = dependencies.resolveAddress ?? resolvePublicAddress;
  const request = dependencies.request ?? requestPinnedUrl;
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    const parsed = new URL(currentUrl);
    if (!FETCH_ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("URL credentials are not allowed");
    }
    // 调用方的额外准入（每个 hop 一次）。放在 DNS 解析与外发之前：
    // 这一跳一旦不满足调用方的范围要求，就不该产生任何网络请求。
    dependencies.validateUrl?.(parsed);

    const ac = new AbortController();
    const timeout = setTimeout(
      () => ac.abort(new Error(`URL fetch timed out after ${FETCH_TIMEOUT_MS}ms`)),
      FETCH_TIMEOUT_MS,
    );
    const abortFromParent = () => ac.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      // Resolve and validate immediately before this hop, then force the
      // socket to use that exact address. DNS is not natively cancellable, so
      // race it with the same per-hop deadline used by the request.
      const pinned = await awaitWithAbort(() => resolveAddress(parsed.hostname), ac.signal);
      const res = await awaitWithAbort(() => request(parsed, pinned, ac.signal), ac.signal);

      if (res.status >= 300 && res.status < 400 && res.location) {
        if (redirectCount >= FETCH_MAX_REDIRECTS) {
          throw new Error(`too many redirects (max ${FETCH_MAX_REDIRECTS})`);
        }
        const location = res.location;
        const redirectUrl = new URL(location, currentUrl).href;
        const redirectParsed = new URL(redirectUrl);
        if (!FETCH_ALLOWED_PROTOCOLS.includes(redirectParsed.protocol)) {
          throw new Error(`redirect to unsupported protocol: ${redirectParsed.protocol}`);
        }
        redirectCount++;
        currentUrl = redirectUrl;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // content-type 准入在读取正文之前：不被接受的类型根本不会进入内存。
      dependencies.acceptContentType?.(res.contentType);

      const decoder = new TextDecoder("utf-8", { fatal: false });
      const rawText = decoder.decode(res.body);

      // extractHtmlTitle 必须在 extractTextFromHtml 之前调用——
      // 后者会剥离所有 HTML 标签，剥离后无法再提取 <title>。
      if (res.contentType.toLowerCase().includes("text/html") || res.contentType.toLowerCase().includes("application/xhtml+xml")) {
        const title = extractHtmlTitle(rawText);
        const text = extractTextFromHtml(rawText, currentUrl, ac.signal);
        return dependencies.includeResponseMetadata
          ? { text, title, url: currentUrl, contentType: res.contentType }
          : { text, title };
      }
      return dependencies.includeResponseMetadata
        ? { text: rawText, title: null, url: currentUrl, contentType: res.contentType }
        : { text: rawText, title: null };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

/**
 * R-014: 受控 HTTP 抓取（含重试包装）。
 * 仅对瞬时错误（超时、连接重置、DNS 失败）重试，不重试 HTTP 4xx。
 */
export async function fetchUrlContent(
  url: string,
  signal?: AbortSignal,
  dependencies: FetchUrlDependencies = {},
): Promise<FetchedContent> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= FETCH_RETRY_COUNT; attempt++) {
    try {
      return await fetchUrlContentOnce(url, signal, dependencies);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // 仅对瞬时错误重试（超时、连接重置、DNS 失败），不重试 HTTP 4xx
      // ECONNRESET 等网络错误在 Node 中是 err.code 属性，不是 message 字符串。
      const errCode = (err as NodeJS.ErrnoException).code;
      const isTransient =
        lastError.message.includes("timed out")
        || errCode === "ECONNRESET"
        || errCode === "ECONNREFUSED"
        || errCode === "EAI_AGAIN"  // DNS 临时失败
        || lastError.message.includes("DNS resolution failed")
        || lastError.message.includes("socket hang up");
      if (!isTransient || attempt === FETCH_RETRY_COUNT) break;
      // 重试触发时记录日志（URL 只记 origin+pathname，剥离 query/hash——
      // 来源 URL 可能携带敏感参数；错误只记类别不记原文，与日志脱敏策略一致）。
      logger.warn(
        {
          url: stripUrlSensitiveParts(url),
          attempt: attempt + 1,
          errCode: errCode ?? "unknown",
          errCategory: lastError instanceof Error
            ? (lastError as { name?: string }).name
            : typeof lastError === "string" ? "string" : "unknown",
        },
        "URL fetch retry triggered",
      );
      // 短暂等待后重试（绑定 signal，job 被 abort 时立即中断延迟）
      // 双向清理：timer 正常触发后移除 abort listener，避免 listener 泄漏
      // 预检 signal 是否已 abort——AbortSignal 只触发一次 abort 事件，
      // 若进入延迟前 signal 已 abort，addEventListener 不会回调，导致无谓等待。
      await new Promise<void>((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        const onAbort = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 1000 * (attempt + 1));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  throw lastError;
}

/**
 * 从解析后的内容中提取标题。
 * - URL 来源：优先使用 fetchUrlContent 已提取的 HTML 标题（fetchedTitle），回退到 blocks 提取
 * - 其余来源：直接复用 extractTitleFromBlocks
 *
 * @param blocks 调用方已通过 parseContent + segmentsToBlocks 计算好的 blocks，避免重复解析
 * @param sourceType 来源类型
 * @param origin 来源地址（URL 来源的最终回退：hostname）
 * @param fetchedTitle fetchUrlContent 从原始 HTML 中提取的标题（URL 来源优先使用）
 * 返回 null 表示未提取到，调用方应保留原标题
 */
export function extractSourceTitle(
  blocks: ParsedBlock[],
  sourceType: string,
  origin?: string | null,
  fetchedTitle?: string | null,
): string | null {
  // URL 来源：内容已被 extractTextFromHtml 剥离了 HTML 标签，
  // 不能从中提取 <title>。必须使用 fetchUrlContent 在剥离前提取的 fetchedTitle。
  if (sourceType === "url" && fetchedTitle) {
    return fetchedTitle;
  }

  // 通用：复用已有 extractTitleFromBlocks（直接用传入的 blocks，不再重复 parseContent）
  // 不依赖 extractTitleFromBlocks 返回的 "无标题笔记" 字符串做判断，
  // 改为先检查 blocks 是否真正有内容。
  if (blocks.length > 0 && blocks.some((b) => b.content.trim())) {
    const title = extractTitleFromBlocks(blocks);
    if (title) return title.slice(0, 100);
  }

  // URL 来源的最终回退：hostname
  if (sourceType === "url" && origin) {
    try {
      return new URL(origin).hostname;
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * 根据实际内容特征修正来源类型。
 * 仅在原始类型与内容特征明显不符时修正。
 *
 * @param typeSource "manual" 表示用户手动选择了类型（不可覆盖），
 *                  "auto" 或 undefined 表示自动检测（可修正）。
 *                  该值由 createSource service 写入 metadata.typeSource。
 */
export function correctSourceType(
  content: string,
  originalType: string,
  typeSource?: string,
): "text" | "markdown" | "code" | "url" {
  // 用户手动选择的类型优先级最高，不修正
  if (typeSource === "manual") {
    return originalType as "text" | "markdown" | "code" | "url";
  }

  // URL 类型不可修正：URL 抓取到的 HTML 纯文本可能命中代码或 Markdown 特征，
  // 但将其修正为 code/markdown 会导致 parseContent 用错误的分段策略处理。
  if (originalType === "url") {
    return "url";
  }

  const text = content.trim();
  if (!text) return originalType as "text" | "markdown" | "code" | "url";

  // 代码特征（含与 detectSourceType 对齐的关键字集）
  // from 已移除——英文文本 "from the beginning" 等会误判，且 ES module 导入中
  // from 总是与 import/export 同时出现，两者已在关键字列表中。
  // public/private/protected 已移除——作为独立关键字在英文文本中过于常见
  //（"public transport"、"private matter"），会导致 codeScore=1，
  // 阻断 code→text 回退（需 codeScore===0），使 detectSourceType 的误判无法修正。
  // type 已移除——与 from/public/private/protected 同类问题，是常见英文单词
  //（"type of music"、"type your name"），作为独立关键字会导致 codeScore=1，
  // 阻断 code→text 回退。TypeScript 的 type 定义通常伴随 const/import 等出现，
  // 移除 type 不影响多行代码文件的 codeScore >= 2 判定。
  // 保留 interface/enum：这些关键字在英文文本中极少出现在行首，
  // 且是 TypeScript 类型定义的强信号。
  // 第一条 codeIndicator 与 detectSourceType 的关键字集完全对齐（IR1）：
  // - 使用 \b 词边界替代尾随空格，使 def\tfoo / package\tmain 等 tab 分隔的代码也能匹配，
  //   同时防止 classical / define / packages 等英文单词误匹配
  // - 包含 if __name__（Python 入口模式），避免 detectSourceType 检测为 code
  //   但 correctSourceType 的 codeScore=0 导致 code→text 误降级
  const codeIndicators = [
    /^(function|const|let|var|class|import|export|def|#include|package|public class|if __name__)\b/m,
    /^(interface|enum)\b/m,
    /```[\s\S]*?```/,  // 代码块
    /^(if|for|while|switch|try|catch)\s*\(/m,
    /;\s*$/m,  // 行尾半角分号 — 仅匹配半角分号 ;（U+003B），不匹配全角分号
  ];
  const codeScore = codeIndicators.filter((re) => re.test(text)).length;

  // Markdown 特征
  const mdIndicators = [
    /^#{1,6}\s/m,       // 标题
    /^[-*+]\s/m,        // 无序列表
    /^\d+\.\s/m,        // 有序列表
    /^>\s/m,            // 引用
    /\[.+?\]\(.+?\)/,   // 链接
    /!\[.*?\]\(.+?\)/,  // 图片
    /```/,              // 代码块标记
    /^\|.*\|/m,         // 表格
  ];
  const mdScore = mdIndicators.filter((re) => re.test(text)).length;

  // 仅对自动检测的 text 类型做修正
  if (originalType === "text") {
    if (codeScore >= 2 && codeScore > mdScore) return "code";
    if (mdScore >= 2) return "markdown";
  }
  // 含 ``` 的 markdown mdScore 至少 1（命中 /```/），
  // 改为只看 codeScore 是否远超 mdScore
  if (originalType === "markdown" && codeScore >= 3 && codeScore > mdScore + 1) return "code";
  if (originalType === "code") {
    // ER1: 误判回退 — detectSourceType 的 /^[a-zA-Z_$]/ 正则可能误判英文文本为 code
    if (codeScore === 0 && mdScore === 0) return "text";
    if (mdScore >= 2 && mdScore > codeScore) return "markdown";
  }

  return originalType as "text" | "markdown" | "code" | "url";
}

/**
 * R-014: 图片下载限制
 */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_MAX_BYTES = 5_000_000; // 5MB
const IMAGE_ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * 下载单张图片并上传到 MinIO，返回可访问的 objectKey。
 * 复用 resolvePublicAddress 进行 SSRF 防护。
 */
async function downloadAndUploadImage(
  imageUrl: string,
  workspaceId: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsed = new URL(imageUrl);
  if (!FETCH_ALLOWED_PROTOCOLS.includes(parsed.protocol)) return null;

  const pinned = await resolvePublicAddress(parsed.hostname);
  const options: RequestOptions = {
    method: "GET",
    family: pinned.family,
    lookup: createPinnedLookup(pinned),
    signal,
    headers: {
      "User-Agent": FETCH_USER_AGENT,
      Accept: "image/*,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  };
  if (parsed.protocol === "https:" && !isIP(parsed.hostname)) {
    (options as RequestOptions & { servername: string }).servername = parsed.hostname;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      req.destroy(new Error(`image fetch timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`));
    }, IMAGE_FETCH_TIMEOUT_MS);

    const req = parsed.protocol === "https:"
      ? httpsRequest(parsed, options, (response) => {
        response.once("error", () => { clearTimeout(timeout); resolve(null); });
        const contentType = (getHeader(response, "content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!IMAGE_ALLOWED_TYPES.has(contentType)) {
          response.destroy();
          clearTimeout(timeout);
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > IMAGE_MAX_BYTES) {
            response.destroy();
            clearTimeout(timeout);
            resolve(null);
            return;
          }
          chunks.push(buf);
        });
        response.once("end", async () => {
          clearTimeout(timeout);
          try {
            const body = Buffer.concat(chunks);
            if (body.length < 100) { resolve(null); return; }
            const objectKey = await uploadSourceImage(workspaceId, sourceId, body, contentType);
            resolve(objectKey);
          } catch {
            resolve(null);
          }
        });
      })
      : httpRequest(parsed, options, (response) => {
        response.once("error", () => { clearTimeout(timeout); resolve(null); });
        const contentType = (getHeader(response, "content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!IMAGE_ALLOWED_TYPES.has(contentType)) {
          response.destroy();
          clearTimeout(timeout);
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > IMAGE_MAX_BYTES) {
            response.destroy();
            clearTimeout(timeout);
            resolve(null);
            return;
          }
          chunks.push(buf);
        });
        response.once("end", async () => {
          clearTimeout(timeout);
          try {
            const body = Buffer.concat(chunks);
            if (body.length < 100) { resolve(null); return; }
            const objectKey = await uploadSourceImage(workspaceId, sourceId, body, contentType);
            resolve(objectKey);
          } catch {
            resolve(null);
          }
        });
      });
    req.once("error", () => { clearTimeout(timeout); resolve(null); });
    req.end();
  });
}

/**
 * 扫描文本中的 markdown 图片引用，下载图片并上传到 MinIO，替换 URL。
 * 仅处理外部 URL（非 /api/uploads/ 路径），跳过已上传的图片。
 * 如果存储未配置或下载失败，保留原始 URL 不变。
 */
export async function fetchAndUploadSourceImages(
  text: string,
  workspaceId: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!isStorageConfigured()) return text;

  // 匹配 ![alt](url) 中 url 不以 /api/uploads/ 开头的图片
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...text.matchAll(imagePattern)];
  const externalImages = matches.filter(
    (m) => !m[2].startsWith("/api/uploads/") && !m[2].startsWith("data:"),
  );
  if (externalImages.length === 0) return text;

  // 去重：同一 URL 只下载一次
  const urlToKey = new Map<string, string | null>();
  const uniqueExternalUrls = [...new Set(externalImages.map((m) => m[2]))];
  // PERF: 外部图片按 URL 去重后以有界并发（~4）并行下载，替代原来的串行
  // await（网络 I/O 每张图片一次 RTT，顺序下载会线性拉长 parse_source 时长）。
  // 各 URL 独立：单张失败记录 null 并继续，abort 信号仍逐调用传播。
  const DOWNLOAD_CONCURRENCY = 4;
  let nextImageIndex = 0;
  const downloadWorkers = Array.from(
    { length: Math.min(DOWNLOAD_CONCURRENCY, uniqueExternalUrls.length) },
    async () => {
      while (nextImageIndex < uniqueExternalUrls.length) {
        const url = uniqueExternalUrls[nextImageIndex++];
        if (signal?.aborted) break;
        try {
          logger.info({ sourceId, imageUrl: url }, "downloading source image");
          const objectKey = await downloadAndUploadImage(url, workspaceId, sourceId, signal);
          urlToKey.set(url, objectKey);
          if (objectKey) {
            logger.info({ sourceId, imageUrl: url, objectKey }, "source image uploaded");
          }
        } catch (err) {
          logger.warn({ sourceId, imageUrl: url, err }, "source image download failed");
          urlToKey.set(url, null);
        }
      }
    },
  );
  await Promise.all(downloadWorkers);

  // 替换文本中的 URL
  let result = text;
  for (const [url, objectKey] of urlToKey) {
    if (objectKey) {
      result = result.replaceAll(`](${url})`, `](/api/uploads/${objectKey})`);
    }
  }
  return result;
}

/**
 * parse_source job handler。
 * 纯规则分段（V0.3 不调模型）：
 * - text：按双换行分段
 * - markdown：按标题和段落分段，保留代码块完整性
 * - code：整段作为一个 segment
 * - url：R-014 已实现 HTTP 抓取，会获取 URL 正文并分段
 */
export async function runParseSource(job: JobPayload) {
  // payload 契约校验（fail closed）：缺失/类型不对抛 JobPayloadContractError，
  // 该错误在 isNonRetryableError 中被归类为**不可重试**——坏载荷不会因为重试而变好，
  // 重试只会空转三次租约再把同一条错误往后推。此前是普通 Error + 真值判断，
  // 既可重试又对 "sourceId 是数字" 这类脏数据毫无防备。
  // 注意：解构出的布尔**不能**叫 fetchUrlContent——本文件导出的抓取函数同名，
  // 会在 runParseSource 作用域内把它遮蔽掉（tsc 立刻报 "Type Boolean has no call signatures"）。
  const { sourceId, fetchUrlContent: fetchUrlContentFlag } = readParseSourceJobPayload(job.payload);
  await assertJobLease(job);
  logger.info({ sourceId }, "running parse_source");

  // 这一次读取必须跑在带工作区上下文的事务里：`sources` 的
  // `sec01_v1_sources_tenant_guard` 只放行 `workspace_id = current_setting('app.workspace_id')`，
  // 没有“上下文未设置即放行”那一支。裸 `db` 句柄读它不会报错，只会返回 0 行，
  // 于是每一次采集都在下面抛 "not found in workspace"、重试三次后 job 直接 dead，
  // 而界面上永远显示“正在解析”。（dev worker 早已是受限角色，所以本地必现。）
  const source = await withJobTransaction(job, (tx) =>
    tx.query.sources.findFirst({
      where: and(
        eq(schema.sources.id, sourceId),
        eq(schema.sources.workspaceId, job.workspaceId),
      ),
    }),
  );
  if (!source) throw new Error(`source ${sourceId} not found in workspace`);

  // R-014: 检查 source 是否已归档，避免旧 job 把归档来源改回 ready。
  // The conditional UPDATE below repeats this check atomically, because an
  // archive may commit after this initial read.
  if (!canAdvanceSourceParse(source.status)) {
    logger.info({ sourceId }, "source is archived, skipping parse");
    return;
  }

  // Every state transition is workspace-scoped and refuses to move an
  // archived row. RETURNING also refreshes the source snapshot after any lock
  // wait, so later parsing does not rely on the initial TOCTOU-prone read.
  const [processingSource] = await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, job);
    const rows = await tx
      .update(schema.sources)
      .set({ status: SourceStatus.PROCESSING, updatedAt: new Date() })
      .where(
        and(
          eq(schema.sources.id, sourceId),
          eq(schema.sources.workspaceId, job.workspaceId),
          ne(schema.sources.status, SourceStatus.ARCHIVED),
        ),
      )
      .returning();
    throwIfJobAborted(job);
    return rows;
  });
  if (!processingSource) {
    logger.info({ sourceId }, "source was archived before processing started, skipping parse");
    return;
  }

  let failureProjection: { body: string; metadata: Record<string, unknown> } | null = null;

  try {
    const metadata = (processingSource.metadata ?? {}) as Record<string, unknown>;
    if (metadata.rawContent != null && typeof metadata.rawContent !== "string") {
      throw new Error("source metadata.rawContent must be a string");
    }
    if (metadata.url != null && typeof metadata.url !== "string") {
      throw new Error("source metadata.url must be a string");
    }
    let rawContent = metadata.rawContent ?? "";
    if (typeof metadata.storageObjectKey === "string") {
      const key = metadata.storageObjectKey;
      if (!key.startsWith(`${job.workspaceId}/files/`) || key.includes("..") || key.includes("\\")) throw new Error("invalid source object reference");
      const bytes = await getObjectBytes(key, MAX_SOURCE_TEXT_BYTES);
      if (bytes.length !== metadata.storageByteLength || createHash("sha256").update(bytes).digest("hex") !== metadata.storageSha256)
        throw new Error("stored source integrity mismatch");
      rawContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }

    const url = metadata.url ?? processingSource.origin ?? "";

    // R-014: 如果标记了 fetchUrlContent，执行 HTTP 抓取
    if (fetchUrlContentFlag && url && !rawContent.trim()) {
      logger.info({ sourceId, url: stripUrlSensitiveParts(url) }, "fetching URL content");
      try {
        const fetched = await fetchUrlContent(url, job.signal);
        rawContent = fetched.text;

        // 下载页面内嵌图片并上传到 MinIO，替换文本中的图片 URL
        rawContent = await fetchAndUploadSourceImages(
          rawContent, job.workspaceId, sourceId, job.signal,
        );

        // Merge fetched content while holding the source row lock. If archive
        // won the race, do not restore metadata or continue toward ready.
        const metadataStored = await withJobTransaction(job, async (tx) => {
          await lockJobLease(tx, job);
          const [lockedSource] = await tx
            .select()
            .from(schema.sources)
            .where(
              and(
                eq(schema.sources.id, sourceId),
                eq(schema.sources.workspaceId, job.workspaceId),
              ),
            )
            .for("update");
          if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

          const [updated] = await tx
            .update(schema.sources)
            .set({
              metadata: {
                ...((lockedSource.metadata ?? {}) as Record<string, unknown>),
                rawContent: rawContent,
                // 必须写入 fetchedTitle，否则事务内 extractSourceTitle 无法获取 URL 来源的网页标题
                fetchedTitle: fetched.title,
                fetchedAt: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.sources.id, sourceId),
                eq(schema.sources.workspaceId, job.workspaceId),
                ne(schema.sources.status, SourceStatus.ARCHIVED),
              ),
            )
            .returning({ id: schema.sources.id });
          throwIfJobAborted(job);
          return Boolean(updated);
        });

        if (!metadataStored) {
          logger.info({ sourceId }, "source was archived during URL fetch, skipping parse");
          return;
        }

        logger.info({ sourceId, contentLength: fetched.text.length }, "URL content fetched");
      } catch (fetchErr) {
        logger.error({ sourceId, url: stripUrlSensitiveParts(url), err: fetchErr }, "URL fetch failed");
        const fetchError = fetchErr instanceof Error ? fetchErr.message : "unknown";
        failureProjection = {
          body: url,
          metadata: { type: processingSource.type, fetchError },
        };
        throw new Error(
          `URL fetch failed: ${fetchErr instanceof Error ? fetchErr.message : "unknown error"}`,
          { cause: fetchErr },
        );
      }
    }

    // 如果仍然没有内容，设为 ready 但标记需要后续处理
    if (!rawContent.trim()) {
      // Ready and its search projection share the same row lock/transaction.
      // Whichever operation wins against archive determines the final state:
      // worker first => archive subsequently deletes the projection; archive
      // first => this transaction observes archived and writes nothing.
      const committed = await withJobTransaction(job, async (tx) => {
        await lockJobLease(tx, job);
        const [lockedSource] = await tx
          .select()
          .from(schema.sources)
          .where(
            and(
              eq(schema.sources.id, sourceId),
              eq(schema.sources.workspaceId, job.workspaceId),
            ),
          )
          .for("update");
        if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

        const [updated] = await tx
          .update(schema.sources)
          .set({ status: SourceStatus.READY, updatedAt: new Date() })
          .where(
            and(
              eq(schema.sources.id, sourceId),
              eq(schema.sources.workspaceId, job.workspaceId),
              ne(schema.sources.status, SourceStatus.ARCHIVED),
            ),
          )
          .returning({ id: schema.sources.id });
        if (!updated) return false;

        const lockedMetadata = (lockedSource.metadata ?? {}) as Record<string, unknown>;
        const projectionBody = [lockedSource.origin, lockedMetadata.url]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join("\n");
        const indexedAt = new Date();
        await tx
          .insert(schema.searchDocuments)
          .values({
            workspaceId: job.workspaceId,
            objectType: "source",
            objectId: sourceId,
            title: lockedSource.title,
            body: projectionBody,
            metadata: { type: lockedSource.type, needsContentFetch: true },
            indexedAt,
          })
          .onConflictDoUpdate({
            target: [
              schema.searchDocuments.workspaceId,
              schema.searchDocuments.objectType,
              schema.searchDocuments.objectId,
            ],
            set: {
              title: lockedSource.title,
              body: projectionBody,
              metadata: { type: lockedSource.type, needsContentFetch: true },
              indexedAt,
            },
          });
        throwIfJobAborted(job);
        return true;
      });

      if (!committed) {
        logger.info({ sourceId }, "source was archived before ready commit, skipping projection");
        return;
      }
      logger.info({ sourceId }, "source ready (no content to parse)");
      return;
    }

    // ─── 以下计算全部在事务内基于 lockedSource 进行，不在事务外预计算 ───
    // 原代码在事务外用 processingSource 预计算 segments 和 sourceBody，
    // 然后直接用于事务内写入。但事务外预计算存在 TOCTOU 窗口（processingSource 与 lockedSource
    // 可能不同），且预计算结果在事务内完全未被引用——事务内全部基于 lockedSource 重算。
    // 因此删除事务外的 segments/sourceBody 预计算，避免对 500KB 内容的无意义双倍解析。

    // ─── ready 提交事务（改造原有第 665–742 行的事务）───
    const committed = await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, job);
      const [lockedSource] = await tx
        .select()
        .from(schema.sources)
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
          ),
        )
        .for("update");
      if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

      // 基于 lockedSource 重新计算 correctedType 和 finalTitle
      //（lockedSource 可能与 processingSource 不同，例如另一个事务改过 metadata）
      const lockedTypeSource = (lockedSource.metadata ?? {}).typeSource as string | undefined;
      // 从事务内 lockedSource.metadata 重读 rawContent，与 typeSource/fetchedTitle 保持一致。
      const lockedRawContent = ((lockedSource.metadata ?? {}).rawContent as string) ?? rawContent;
      const lockedCorrectedType = correctSourceType(lockedRawContent, lockedSource.type, lockedTypeSource);
      // 始终基于 lockedCorrectedType 重新解析，不回退到事务外的 finalSegments。
      const lockedFinalSegments = parseContent(
        lockedRawContent,
        lockedCorrectedType as "text" | "markdown" | "code" | "url",
      );
      const lockedSourceBody = lockedFinalSegments.map((s) => s.text).join("\n");

      // 标题提取：传入已计算的 lockedBlocks（避免重复 parseContent）
      const lockedBlocks = segmentsToBlocks(
        lockedFinalSegments,
        lockedCorrectedType as "text" | "markdown" | "code" | "url",
      );
      const lockedFetchedTitle = (lockedSource.metadata ?? {}).fetchedTitle as string | null | undefined;
      const extractedTitle = extractSourceTitle(
        lockedBlocks,
        lockedCorrectedType,
        lockedSource.origin,
        lockedFetchedTitle,
      );
      const manualTitle = (lockedSource.metadata ?? {}).titleSource === "manual";
      const finalTitle = manualTitle ? lockedSource.title : extractedTitle || lockedSource.title;

      // 可观测性：记录标题来源和是否提取成功
      logger.info(
        {
          sourceId,
          titleSource: manualTitle ? "manual" : lockedFetchedTitle ? "html_title" : extractedTitle ? "blocks" : "fallback",
          titleLength: finalTitle.length,
        },
        "source title extracted",
      );

      // 可观测性：记录类型修正
      if (lockedCorrectedType !== lockedSource.type) {
        logger.info(
          { sourceId, originalType: lockedSource.type, correctedType: lockedCorrectedType, typeSource: lockedTypeSource },
          "source type corrected",
        );
      }

      // 写入 segments（用 lockedFinalSegments）
      await tx
        .delete(schema.sourceSegments)
        .where(
          and(
            eq(schema.sourceSegments.sourceId, sourceId),
            eq(schema.sourceSegments.workspaceId, job.workspaceId),
          ),
        );

      if (lockedFinalSegments.length > 0) {
        await tx.insert(schema.sourceSegments).values(
          lockedFinalSegments.map((seg, idx) => ({
            sourceId,
            workspaceId: job.workspaceId,
            ordinal: idx,
            text: seg.text,
            charStart: seg.charStart,
            charEnd: seg.charEnd,
            segmentType: seg.segmentType,
          })),
        );
      }

      // 更新 source：status + 修正后的 type + 提取的 title
      const [updated] = await tx
        .update(schema.sources)
        .set({
          status: SourceStatus.READY,
          type: lockedCorrectedType,
          title: finalTitle,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
            ne(schema.sources.status, SourceStatus.ARCHIVED),
          ),
        )
        .returning({ id: schema.sources.id });
      if (!updated) return false;

      // 搜索索引也用 finalTitle 和 lockedCorrectedType
      const indexedAt = new Date();
      await tx
        .insert(schema.searchDocuments)
        .values({
          workspaceId: job.workspaceId,
          objectType: "source",
          objectId: sourceId,
          title: finalTitle,
          body: lockedSourceBody,
          metadata: { type: lockedCorrectedType },
          indexedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.searchDocuments.workspaceId,
            schema.searchDocuments.objectType,
            schema.searchDocuments.objectId,
          ],
          set: {
            title: finalTitle,
            body: lockedSourceBody,
            metadata: { type: lockedCorrectedType },
            indexedAt,
          },
        });
      throwIfJobAborted(job);
      return true;
    });

    if (!committed) {
      logger.info({ sourceId }, "source was archived before segment commit, skipping parse result");
      return;
    }

    logger.info(
      { sourceId },
      "source parsed successfully",
    );
  } catch (err) {
    // A timed-out/aborted handler must never project a failure from an old
    // attempt after the worker has released its lease for retry.
    if (!await isJobLeaseActive(job)) {
      logger.warn({ sourceId, err }, "skipping parse failure projection after lease loss");
      throw err;
    }
    // Failed and its optional fetch-error projection use the same source row
    // lock. If archive won the race, both writes are skipped and the archived
    // source remains absent from search.
    const committed = await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, job);
      const [lockedSource] = await tx
        .select()
        .from(schema.sources)
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
          ),
        )
        .for("update");
      if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

      const [updated] = await tx
        .update(schema.sources)
        .set({ status: SourceStatus.FAILED, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
            ne(schema.sources.status, SourceStatus.ARCHIVED),
          ),
        )
        .returning({ id: schema.sources.id });
      if (!updated) return false;

      if (failureProjection) {
        const indexedAt = new Date();
        await tx
          .insert(schema.searchDocuments)
          .values({
            workspaceId: job.workspaceId,
            objectType: "source",
            objectId: sourceId,
            title: lockedSource.title,
            body: failureProjection.body,
            metadata: failureProjection.metadata,
            indexedAt,
          })
          .onConflictDoUpdate({
            target: [
              schema.searchDocuments.workspaceId,
              schema.searchDocuments.objectType,
              schema.searchDocuments.objectId,
            ],
            set: {
              title: lockedSource.title,
              body: failureProjection.body,
              metadata: failureProjection.metadata,
              indexedAt,
            },
        });
      }
      throwIfJobAborted(job);
      return true;
    });

    if (!committed) {
      logger.info({ sourceId }, "source was archived during parse failure, preserving archived state");
      return;
    }
    throw err;
  }
}
