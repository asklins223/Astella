/**
 * MiMo ASR provider（真实实现，2026-10-12 接入）。
 *
 * 接小米 MiMo 开放平台的 `mimo-v2.5-asr`。**它不走 `/v1/audio/transcriptions`**
 * ——官方契约是聊天端点上的一个音频输入块（实测 2026-10-12）：
 *
 *   POST https://api.xiaomimimo.com/v1/chat/completions
 *   Authorization: Bearer <MIMO_API_KEY>
 *   {
 *     "model": "mimo-v2.5-asr",
 *     "messages": [{ "role": "user", "content": [
 *       { "type": "input_audio", "input_audio": { "data": "data:audio/wav;base64,$B64" } }
 *     ]}],
 *     "asr_options": { "language": "auto" | "zh" | "en" },
 *     "stream": false
 *   }
 *   → choices[0].message.content 就是转写文本
 *
 * 真跑读数（2026-10-12，macOS `say` 合成的 16k 单声道中文 wav，188202 字节）：
 *   - `language:"zh"` → 200，content 与原文一字不差；
 *   - 纯 base64 + `format:"wav"` 同样 200（两种入参形式都可用，这里用 data URL）；
 *   - `stream:true` 是标准 OpenAI SSE，`delta.content` 逐字增量——后续手机端
 *     统一 WebSocket 协议要的"真流式"就是把这份增量往下转发（注意：上游要的是
 *     **整段音频**，流的是转写结果，没有分片音频的 WebSocket 端点）。
 *
 * 上游约束（官方文档 + 实测）：只收 wav/mp3；base64 串 ≤10 MB；`language` 只认
 * auto/zh/en。这两条在**发请求之前**就拦掉——举着手机录完音的人不该为一次注定
 * 400 的上传等一轮网络往返。
 *
 * 契约与错误码跟它替换掉的那条链路（siliconflow-asr.ts，2026-10-12 退役）同族：
 * 路由只按 `code` 归一化文案，换 provider 不改客户端能认的语汇；新增的
 * `UNSUPPORTED_AUDIO_FORMAT` 是旧链路没有的形状问题（旧链路把它交给上游 4xx）。
 */

import { createHash, randomUUID } from "node:crypto";
import { runAiTask, type AiTaskDefinition } from "@astella/shared/ai-task-kernel";
import { DomainError } from "@astella/shared";
import { resolveOpenAIChatCompletionsUrl } from "@astella/shared/ai-endpoints";
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";

/** 上游只认这两种容器（官方文档列出，实测 wav 通过）。 */
const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/** 官方上限：base64 串不超过 10 MB（≈7.5 MB 原始音频）。 */
const MAX_BASE64_CHARS = 10 * 1024 * 1024;

/** 单次尝试的硬上限（与退役链路同值：用户举着麦克风等）。 */
const DEFAULT_TIMEOUT_MS = 30_000;
const ASR_TASK_DEADLINE_MS = 55_000;
const MIMO_ASR_PROMPT_VERSION = "mimo-asr-v1";

/** `asr_options.language` 的合法取值；上游只认这三个。 */
export type MimoAsrLanguage = "auto" | "zh" | "en";

/**
 * 上游语言参数的夹取。调用方给的是自己的语言标签（伴星语音那条固定 `zh-CN`），
 * 直接透传会 400；认不出的一律落 `auto`，由上游自己判——猜成 `en` 会让中文录音
 * 被按英文模型解。
 */
export function mimoAsrLanguage(raw: string | null | undefined): MimoAsrLanguage {
  if (!raw) return "auto";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return "auto";
}

/** 由文件名推 MIME；上游不认的容器在出网前就拦下。 */
function mimeOf(filename: string): string | null {
  const extension = filename.toLowerCase().split("?")[0]?.split(".").pop() ?? "";
  return AUDIO_MIME_BY_EXTENSION[extension] ?? null;
}

/** MiMo API 错误（服务端细节不透出到 UI，仅内部记录）。 */
export class MimoAsrError extends DomainError {
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super({ name: "MimoAsrError", code, message, statusCode: status });
    this.status = status;
  }
}

function isTransientAsrStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 这段音频的指纹（身份只由字节决定）。 */
export function mimoAsrAudioSha256(audio: Uint8Array): string {
  return createHash("sha256").update(audio).digest("hex");
}

/** 转写这一步的幂等键：只由音频字节决定，重试才认得出"还是那段录音"。 */
export function mimoAsrIdempotencyKey(audioSha256: string): string {
  return `voice-transcribe:${audioSha256}`;
}

export interface MimoAsrOptions {
  /** 平台配置来源。缺省从 config/ai-platforms.json 的 speech_recognition 槽解析。 */
  url?: string;
  apiKey?: string;
  model?: string;
  /** 上游 `asr_options.language`；不传走 auto（上游自动判语种）。 */
  language?: string;
  timeoutMs?: number;
  /** 发请求那一步（测试注入；默认走下面的 `postJson`）。 */
  requester?: MimoAsrRequester;
  /** 调用方取消信号，与内核 step.signal **合并**，不是二选一。 */
  signal?: AbortSignal;
  /** 这一次转写属于谁（必填、无默认——理由见退役链路同名字段）。 */
  scope: MimoAsrCallScope;
  /** 「当前作用域有没有活动事务」的读数（必填，把这条路径钉成事务外）。 */
  currentActiveTransaction: () => unknown;
}

export interface MimoAsrCallScope {
  workspaceId: string;
  userId: string;
}

/** 一次 JSON POST。默认实现是裸 fetch（理由见 `postJson`）。 */
export type MimoAsrRequester = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export interface MimoAsrResult {
  text: string;
  rawText: string;
}

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1/chat/completions";
const DEFAULT_MODEL = "mimo-v2.5-asr";

/**
 * 默认出口。与退役链路同一处置：**不接公网地址闸**——`baseUrl` 只能由配置给，
 * 不是用户输入；而代理／合成 DNS 环境下那道闸会把整条活着的语音路径判死
 * （2026-09-25 在 siliconflow 上实测过一次）。
 */
const postJson: MimoAsrRequester = async (url, init) => globalThis.fetch(url, {
  method: "POST",
  headers: init.headers,
  body: init.body,
  signal: init.signal,
});

/**
 * 从 `config/ai-platforms.json` 的 `capabilities.speech_recognition` 解析这一次该用
 * 谁。没映射就返回 null，调用方按"没有远程识别"处理——**不猜**一个平台。
 *
 * baseUrl 存的是平台根（`https://…/v1`），端点要自己接：直接拿根去发会 404
 *（2026-10-12 首次真跑就是这么撞出来的），所以走 `resolveOpenAIChatCompletionsUrl`。
 */
export function resolveMimoAsrConfig(): { url: string; apiKey: string; model: string } | null {
  const platform = resolveSystemPlatform("speech_recognition");
  if (!platform?.baseUrl || !platform.apiKey || !platform.model || platform.type === "mock") return null;
  return {
    url: resolveOpenAIChatCompletionsUrl(platform.baseUrl),
    apiKey: platform.apiKey,
    model: platform.model,
  };
}

interface MimoAsrRequestBody {
  body: string;
}

/**
 * 调 MiMo 语音识别（整段音频 → 转写文本）。
 *
 * @param audioBuffer 音频字节（wav / mp3；其余容器在出网前被拒）
 * @param filename 上传文件名，仅用于推断容器格式
 */
export async function mimoTranscribe(
  audioBuffer: Uint8Array,
  filename: string,
  options: MimoAsrOptions,
): Promise<MimoAsrResult> {
  const resolved = resolveMimoAsrConfig();
  const apiKey = options.apiKey ?? resolved?.apiKey;
  if (!apiKey) {
    throw new MimoAsrError(
      "MISSING_API_KEY",
      "speech_recognition 未配置（fail closed：不静默跳过语音识别）",
    );
  }
  const mime = mimeOf(filename);
  if (!mime) {
    // 上游只收 wav/mp3。拦在出网前：一次注定 400 的上传不该花掉用户一整轮等待。
    throw new MimoAsrError(
      "UNSUPPORTED_AUDIO_FORMAT",
      `MiMo ASR 只接受 wav/mp3，收到的是 ${filename}`,
    );
  }
  const encoded = Buffer.from(audioBuffer).toString("base64");
  if (encoded.length > MAX_BASE64_CHARS) {
    throw new MimoAsrError(
      "UNSUPPORTED_AUDIO_FORMAT",
      `MiMo ASR 的 base64 上限是 10MB，这一段是 ${(encoded.length / (1024 * 1024)).toFixed(1)}MB`,
    );
  }

  const url = options.url ?? resolved?.url ?? DEFAULT_BASE_URL;
  const model = options.model ?? resolved?.model ?? DEFAULT_MODEL;
  const language = mimoAsrLanguage(options.language);
  const stepTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requester = options.requester ?? postJson;
  const audioSha256 = mimoAsrAudioSha256(audioBuffer);

  // 请求体在出网前一次性组好：两次尝试发的是同一段录音的同一份字节，
  // 不是"重新录一遍"。
  const requestBody: MimoAsrRequestBody = {
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: `data:${mime};base64,${encoded}` } }],
      }],
      asr_options: { language },
      stream: false,
    }),
  };

  let lastUpstreamStatus: number | undefined;

  const task: AiTaskDefinition<MimoAsrRequestBody, { text: string }> = {
    id: "voice_transcription",
    version: 1,
    mode: "structured",
    resourceClass: "interactive_ai",
    budget: {
      maxModelCalls: 2,
      stepTimeoutMs,
      taskDeadlineMs: ASR_TASK_DEADLINE_MS,
      maxAutoRetries: 1,
    },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: model, promptVersion: MIMO_ASR_PROMPT_VERSION, resourceClass: "interactive_ai" },
    prepare: async () => requestBody,
    execute: async (input, step) => {
      let response: Response;
      try {
        response = await requester(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: input.body,
          // 内核步预算 ∩ 调用方取消：两个来源都要能掐掉这一次请求。
          signal: options.signal ? AbortSignal.any([step.signal, options.signal]) : step.signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return (step.signal.aborted || options.signal?.aborted)
          ? { ok: false as const, class: "timeout" as const, message: `MiMo ASR 超时：${message}` }
          : { ok: false as const, class: "transport" as const, message: `MiMo ASR 网络错误：${message}` };
      }
      if (!response.ok) {
        await response.text().catch(() => ""); // 消费 body（内部细节不透出）
        lastUpstreamStatus = response.status;
        return isTransientAsrStatus(response.status)
          ? { ok: false as const, class: "transport" as const, message: `MiMo ASR HTTP ${response.status}` }
          : { ok: false as const, class: "invalid_input" as const, message: `MiMo ASR HTTP ${response.status}` };
      }
      let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
      try {
        parsed = (await response.json()) as typeof parsed;
      } catch (err) {
        return { ok: false as const, class: "output_shape" as const, message: `响应不是合法 JSON：${String(err)}` };
      }
      const text = typeof parsed.choices?.[0]?.message?.content === "string"
        ? parsed.choices[0].message.content.trim()
        : "";
      if (text === "") {
        return { ok: false as const, class: "output_shape" as const, message: "MiMo ASR 返回空 transcript" };
      }
      return { ok: true as const, output: { text } };
    },
    // 恒等提交：pending voice artifact 的写入仍在路由的第二段短事务里，
    // 不借这个外壳搬家。
    commit: async (_ctx, _attempt, output) => ({
      outcome: "committed" as const,
      output,
      usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
      failure: null,
      preservedValidResult: false,
      resumedFromCheckpoint: false,
      modelCalls: 0,
    }),
  };

  const receipt = await runAiTask(task, {
    ctx: {
      workspaceId: options.scope.workspaceId,
      userId: options.scope.userId,
      inputSnapshotRef: { kind: "audio", id: audioSha256, hash: audioSha256 },
      permissionLevel: "server",
    },
    attempt: {
      taskId: task.id,
      taskVersion: task.version,
      attemptId: randomUUID(),
      leaseToken: `voice-transcribe:${audioSha256.slice(0, 16)}`,
      idempotencyKey: mimoAsrIdempotencyKey(audioSha256),
      workspaceId: options.scope.workspaceId,
      userId: options.scope.userId,
    },
    currentActiveTransaction: options.currentActiveTransaction,
    reportDevelopmentError: (message) => process.stderr.write(`[dev-error] ${message}\n`),
  });

  const transcript = receipt.output;
  if (!transcript || (receipt.outcome !== "committed" && receipt.outcome !== "resumed_and_committed")) {
    const failure = receipt.failure;
    // 路由只按 `code` 归一化文案，语汇沿用旧链路那四个（另加一个格式错误）。
    if (failure?.class === "output_shape") {
      throw new MimoAsrError(
        "EMPTY_TRANSCRIPT",
        `MiMo ASR 没有给出可用转写（fail closed）：${failure.message}`,
      );
    }
    if (lastUpstreamStatus !== undefined) {
      throw new MimoAsrError(
        "UPSTREAM_ERROR",
        `MiMo ASR HTTP ${lastUpstreamStatus}（内部细节不向用户透出）`,
        lastUpstreamStatus,
      );
    }
    throw new MimoAsrError(
      "NETWORK_ERROR",
      `MiMo ASR 网络错误：${failure?.class ?? "unknown"}: ${failure?.message ?? "request failed"}`,
    );
  }
  return { text: transcript.text, rawText: transcript.text };
}
