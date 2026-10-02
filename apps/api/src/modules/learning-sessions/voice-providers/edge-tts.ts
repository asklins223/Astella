/**
 * edge-tts TTS provider（真实实现，基于 Docker 容器 HTTP 调用）。
 *
 * 不依赖宿主 CLI：edge-tts 作为独立 Docker 容器运行（docker/edge-tts/），
 * 暴露 OpenAI 协议端点 POST /v1/audio/speech；本 provider 经
 * EDGE_TTS_BASE_URL 调用容器。Compose 显式使用 http://edge-tts:8080；
 * 宿主 API 默认使用开发容器映射的 http://127.0.0.1:8088。
 *
 * 请求形状遵循 openai-compatible-tts 使用的 OpenAI 协议，
 * 因此 API 侧可无缝在 edge-tts 容器与自定义 OpenAI 协议 TTS 服务间切换。
 *
 * 真实请求验证（2026-08-08）：
 *   容器内 server.py 合成 zh-CN-XiaoxiaoNeural → audio/mpeg mp3 字节。
 */

import { DomainError } from "@ailearn/shared";

export interface EdgeTtsProviderOptions {
  /** 服务地址（优先于环境变量；宿主缺省使用开发容器的回环端口） */
  baseUrl?: string;
  /** 默认 voice（zh-CN） */
  voice?: string;
  /** 语速（edge-tts rate，如 +0% / -10%） */
  rate?: string;
  /** 容器鉴权共享 token（优先于 env EDGE_TTS_AUTH_TOKEN） */
  authToken?: string;
  timeoutMs?: number;
  /** 测试注入 fetch */
  fetchImpl?: typeof fetch;
}

export interface EdgeTtsSynthesizeResult {
  /** mp3 音频字节 */
  audio: Uint8Array;
  /** 实际使用的 voice */
  voice: string;
  /** OpenAI 协议响应 content-type */
  contentType: string;
}

const DEFAULT_HOST_PORT = 8088;
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_TIMEOUT_MS = 30_000;

function edgeTtsBaseUrl(override?: string): string {
  const configured = override?.trim() || process.env.EDGE_TTS_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  // Docker 的服务名不能从宿主解析。容器 API 由 Compose 注入内部地址；
  // 直接运行的 API 使用同一开发服务的回环映射，端口与 Compose 保持一致。
  const port = Number(process.env.EDGE_TTS_PORT ?? DEFAULT_HOST_PORT);
  const hostPort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_HOST_PORT;
  return `http://127.0.0.1:${hostPort}`;
}

/**
 * edge-tts 并发闸（AI P2，2026-09-15 审计）。
 *
 * edge 路径此前**没有任何并发限制**：三个调用点（voice-routes 的流式 / 伴星 /
 * 普通朗读）可以无限并发打到容器内的 edge-tts 服务。当前客户端按 ordinal 串行
 * 请求，所以问题尚未暴露——但服务端不该依赖客户端的良好行为。
 *
 * 选择"有界并发"（默认 4）而非 qwen 那样的**按用户串行**：edge-tts 是无状态
 * HTTP 服务（不像 qwen 需要复用 WS 连接、也没有每用户单连接的约束），按用户
 * 串行只会无谓拉长多段合成的总时长。两者共享同一个"有界总量"的思路，只是
 * 键的粒度不同（qwen 另有一层按用户串行，见 qwen-tts.ts）。
 * 可用 `EDGE_TTS_MAX_CONCURRENCY` 调整；非法值回退 4。
 *
 * 名额与**流式响应的生命周期**绑定（见 bindSlotToStream）：流式合成的容器侧工作发生在
 * 消费期间，不能在函数返回时就释放。
 */
const DEFAULT_MAX_CONCURRENCY = 4;

export function resolveEdgeTtsMaxConcurrency(
  raw: string | undefined = process.env.EDGE_TTS_MAX_CONCURRENCY,
): number {
  const parsed = Number(raw ?? DEFAULT_MAX_CONCURRENCY);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENCY;
}

let activeEdgeTtsRequests = 0;
const edgeTtsWaiters: Array<() => void> = [];

async function acquireEdgeTtsSlot(): Promise<void> {
  if (activeEdgeTtsRequests < resolveEdgeTtsMaxConcurrency()) {
    activeEdgeTtsRequests += 1;
    return;
  }
  // 无可用名额：挂起；releaseEdgeTtsSlot 会把名额**直接移交**过来（计数不变）。
  await new Promise<void>((resolveWaiter) => edgeTtsWaiters.push(resolveWaiter));
}

function releaseEdgeTtsSlot(): void {
  const next = edgeTtsWaiters.shift();
  if (next) {
    next(); // 名额移交，占用数不变
    return;
  }
  activeEdgeTtsRequests = Math.max(0, activeEdgeTtsRequests - 1);
}

/** 测试钩子：当前占用中的请求数。 */
export function edgeTtsActiveRequestCount(): number {
  return activeEdgeTtsRequests;
}

/** 测试钩子：清空等待队列与占用计数（避免用例之间互相影响）。 */
export function resetEdgeTtsGateForTests(): void {
  edgeTtsWaiters.length = 0;
  activeEdgeTtsRequests = 0;
}

/** 把流的名额释放绑定到流结束 / 出错 / 被取消。 */
function bindSlotToStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseEdgeTtsSlot();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce();
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        releaseOnce();
        controller.error(err);
      }
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export class EdgeTtsError extends DomainError {
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super({ name: "EdgeTtsError", code, message, statusCode: status });
    this.status = status;
  }
}

/**
 * 调 edge-tts 容器合成语音（OpenAI 协议 POST /v1/audio/speech）。
 * @param text 净化纯文本（不含 SSML/URL/脚本标记）
 * @param voice edge-tts voice id（如 zh-CN-XiaoxiaoNeural）
 * @param options 配置
 */
/**
 * 合成一段语音（受并发闸约束；实现见 edgeTtsSynthesizeUngated）。
 *
 * @param text 待合成文本
 * @param voice edge-tts voice id（如 zh-CN-XiaoxiaoNeural）
 * @param options 配置
 */
export async function edgeTtsSynthesize(
  text: string,
  voice: string,
  options: EdgeTtsProviderOptions = {},
): Promise<EdgeTtsSynthesizeResult> {
  await acquireEdgeTtsSlot();
  try {
    return await edgeTtsSynthesizeUngated(text, voice, options);
  } finally {
    releaseEdgeTtsSlot();
  }
}

async function edgeTtsSynthesizeUngated(
  text: string,
  voice: string,
  options: EdgeTtsProviderOptions = {},
): Promise<EdgeTtsSynthesizeResult> {
  if (typeof text !== "string" || text.trim() === "") {
    throw new EdgeTtsError("INVALID_ARGUMENT", "TTS 文本为空（fail closed）");
  }
  const baseUrl = edgeTtsBaseUrl(options.baseUrl);
  const effectiveVoice = voice || (options.voice ?? DEFAULT_VOICE);
  const rate = options.rate ?? "+0%";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // 容器鉴权 token：优先 options.authToken（测试注入/显式配置），兜底 env
  const authToken = options.authToken ?? process.env.EDGE_TTS_AUTH_TOKEN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // 容器鉴权（security_review MEDIUM）：共享 token 防内网任意调用
    if (authToken) headers["X-Edge-TTS-Token"] = authToken;
    response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "edge-tts",
        input: text,
        voice: effectiveVoice,
        rate,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // 不把 err.message / EDGE_TTS_BASE_URL / docker 配置提示透出（security_review MEDIUM
    // 延续：内部配置不进入客户端可见 message；排查细节应进服务端日志，不进响应体）。
        throw new EdgeTtsError(
      "NETWORK_ERROR",
      "语音合成服务暂时不可达（edge-tts 网络错误）",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await response.text().catch(() => ""); // 消费 body（内部细节不透出）
    throw new EdgeTtsError(
      "UPSTREAM_ERROR",
      `edge-tts HTTP ${response.status}（内部细节不向用户透出）`,
      response.status,
    );
  }
  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.length === 0) {
    throw new EdgeTtsError("EMPTY_AUDIO", "edge-tts 返回空音频（fail closed）");
  }
  return { audio, voice: effectiveVoice, contentType };
}

export interface EdgeTtsStreamResult {
  /** 上游 audio/mpeg 流（ReadableStream 透传，禁止 arrayBuffer 全量缓冲） */
  stream: ReadableStream<Uint8Array>;
  voice: string;
  contentType: string;
}

/**
 * P6 §13：edge-tts 流式合成（POST /v1/audio/speech/stream → chunked）。
 * 与 edgeTtsSynthesize 的区别：返回 ReadableStream 透传（不 arrayBuffer），
 * 供 /voice/tts/stream 边收边播；timeout 只覆盖「响应头到达前」（首字节），
 * 头到达后不再整体 abort（长句流式）。
 *
 * 2026-10-02（41a）：**这一条没有接到统一内核，而且是有理由的。**
 * 内核的预算模型是"一个有时限的步骤"——`withStepDeadline` 会在 `stepTimeoutMs`
 * 到达时判超时。流式合成交出去的是一条**用户还在听的** `ReadableStream`：客户端
 * 拿到响应头之后音频还在陆续到达，把它塞进一个会按时收口的步骤，等于让内核在
 * 她听到一半时把这一发判成超时。
 *
 * `/voice/tts` 那条**有界**路径（收齐字节才返回）已经接上了，见 `tts-engine.ts`
 * 的 `synthesizeTtsBytes`。要把流式也接上，先得给内核一个"步骤已完成、但产物
 * 还活着"的形状（例如把 `completion` 扩出流式判据、`commit` 延后到流结束）——
 * 那是内核合同本身的改动，不该藏在一个 provider 的接线里。
 */
export async function edgeTtsSynthesizeStream(
  text: string,
  voice: string,
  options: EdgeTtsProviderOptions = {},
): Promise<EdgeTtsStreamResult> {
  await acquireEdgeTtsSlot();
  let slotTransferred = false;
  try {
    const result = await edgeTtsSynthesizeStreamUngated(text, voice, options);
    // 名额随流走：流结束/出错/被取消时才释放。
    slotTransferred = true;
    return { ...result, stream: bindSlotToStream(result.stream) };
  } finally {
    if (!slotTransferred) releaseEdgeTtsSlot();
  }
}

async function edgeTtsSynthesizeStreamUngated(
  text: string,
  voice: string,
  options: EdgeTtsProviderOptions = {},
): Promise<EdgeTtsStreamResult> {
  if (typeof text !== "string" || text.trim() === "") {
    throw new EdgeTtsError("INVALID_ARGUMENT", "TTS 文本为空（fail closed）");
  }
  const baseUrl = edgeTtsBaseUrl(options.baseUrl);
  const effectiveVoice = voice || (options.voice ?? DEFAULT_VOICE);
  const rate = options.rate ?? "+0%";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const authToken = options.authToken ?? process.env.EDGE_TTS_AUTH_TOKEN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers["X-Edge-TTS-Token"] = authToken;
    response = await fetchImpl(`${baseUrl}/v1/audio/speech/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "edge-tts",
        input: text,
        voice: effectiveVoice,
        rate,
      }),
      signal: controller.signal,
    });
  } catch (err) {
        throw new EdgeTtsError(
      "NETWORK_ERROR",
      "语音合成服务暂时不可达（edge-tts 网络错误）",
    );
  } finally {
    clearTimeout(timer); // 头到达后不再整体超时（流式长句）
  }

  if (!response.ok) {
    await response.text().catch(() => "");
    throw new EdgeTtsError(
      "UPSTREAM_ERROR",
      `edge-tts HTTP ${response.status}（内部细节不向用户透出）`,
      response.status,
    );
  }
  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  if (!response.body) {
    throw new EdgeTtsError("EMPTY_AUDIO", "edge-tts 无响应体（fail closed）");
  }
  return { stream: response.body, voice: effectiveVoice, contentType };
}
