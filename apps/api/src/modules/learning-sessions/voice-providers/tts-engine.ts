/**
 * TTS 引擎选择与兜底（2026-09-19 语音链路改造）。
 *
 * 目标架构：**qwen（阿里百炼，WebSocket 原始协议 + 连接复用）为主，
 * edge-tts（容器 HTTP）兜底**。此前桌面伴星走的 `/voice/tts`（plain text）
 * 硬编码 edge——实测每段合成 2.3–2.5s，段间停顿与概率性中断都源于此；
 * qwen WS 引擎只挂在 ref 型 `/voice/tts/stream` 上，桌面根本够不着。
 *
 * 这里把"选引擎 + 失败降级"收敛成唯一入口：
 * - config `tts.engine === "qwen"` 且 workspaceId 已配置 → 走 qwen WS
 *   （按用户串行 + 全局有界并发 + 60s 连接复用，见 qwen-tts.ts）；
 * - qwen 任务失败（QwenTtsError / 网络错误）→ 记日志后自动降级 edge，
 *   不再让一次 WS 抖动直接变成一段听不到的语音；
 * - 语气标签（[excited] 等）是 qwen-audio 专属能力：qwen 原样传入，
 *   edge 合成前必须剥离（否则标签被当普通文字朗读出来）。
 */

import { stripVoiceExpressionTags } from "@ailearn/shared/voice-expression-tags";
import { createHash, randomUUID } from "node:crypto";
import { runAiTask, type AiStepResult, type AiTaskDefinition } from "@ailearn/shared/ai-task-kernel";
import { edgeTtsSynthesize, EdgeTtsError, type EdgeTtsProviderOptions } from "./edge-tts.ts";
import { loadTtsEngineConfig } from "./tts-config.ts";
import type { ResolvedTtsSelection } from "./tts-preference.ts";
import { qwenTtsSynthesizeStreamForUser, type QwenTtsOptions } from "./qwen-tts.ts";

/**
 * 2026-10-02（41a）：**有界**的合成路径接到统一内核。
 *
 * 为什么只包这一条、不包 `/voice/tts/stream`：内核的预算模型是"一个有时限的
 * 步骤"，`withStepDeadline` 会在 `stepTimeoutMs` 到达时 abort。而流式那两条
 * （`edgeTtsSynthesizeStream` / `qwenTtsSynthesizeStreamForUser` 直接被路由
 * 调用）交出去的是一条**用户还在听的** `ReadableStream`——把它塞进一个会按时
 * abort 的步骤，等于让内核在用户听到一半时掐断音频。那不是"接上内核"，
 * 是拿内核的形状去砸一条形状不一样的路。
 *
 * 这一条不同：它 `collectStream` 到**完整字节**才返回（句子级合成 30–60KB），
 * 整个操作是有界的，正好是内核那一步该有的形状。
 */
const TTS_TASK_ID = "voice_synthesis_bytes";
const TTS_PROMPT_VERSION = "tts-synthesize-bytes-v1";
/**
 * 预算上界 = qwen 默认 30s + edge 默认 30s + 8s 编排余量。
 * 上游各自的超时仍在各自 provider 里（那是它们的实现细节），内核这一层管的是
 * "整条合成最多占多久"，两者不是同一个数，也不该合并成一个。
 */
const TTS_TASK_DEADLINE_MS = 68_000;
const TTS_STEP_TIMEOUT_MS = 68_000;

export interface TtsBytesResult {
  audio: Uint8Array;
  /** 实际使用的引擎（降级后会是 "edge"）。 */
  engine: "qwen" | "edge";
  contentType: string;
}

export interface TtsEngineDeps {
  qwenSynthesize?: typeof qwenTtsSynthesizeStreamForUser;
  edgeSynthesize?: typeof edgeTtsSynthesize;
  loadConfig?: typeof loadTtsEngineConfig;
  /** 测试注入字节收集（缺省用 ReadableStream 全量读取）。 */
  collectStream?: (stream: ReadableStream<Uint8Array>) => Promise<Uint8Array>;
}

/** qwen 流 → 字节（句子级合成总量 30–60KB，缓冲无压力）。 */
async function defaultCollectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface SynthesizeTtsBytesArgs {
  text: string;
  /** edge 音色（仅 edge 引擎使用）；qwen 音色固定走 config，不混用。 */
  edgeVoice: string;
  /** edge 语速（如 "+10%"）；qwen 语速走 config。 */
  edgeRate?: string;
  /** qwen 按用户串行的队列键（workspaceId:userId）。 */
  queueKey: string;
  /** qwen 降级 edge 时的观测钩子（日志/测试断言）。 */
  onQwenFallback?: (error: unknown) => void;
  /**
   * 这次用哪个引擎、哪一身（见 tts-preference.ts 的 resolveTtsSelection）。
   *
   * 不传就退回 config 默认。传了则整条分支按它走：`engine === "edge"` 时**根本不
   * 碰 qwen**——用户明确挑了 edge，让 qwen 先试一遍再把 qwen 的音色播出去，等于
   * 设置里那个选择没有发生过。
   */
  selection?: ResolvedTtsSelection;
  deps?: TtsEngineDeps;
  /**
   * 这一次合成归属谁，以及「当前作用域有没有活动事务」那一个读数（41a 必填）。
   *
   * 做成可选就等于让「忘记核对作用域」成为一种能通过编译的形状，而那正是这一层
   * 存在的理由。两个生产调用点（`/voice/tts` 与伴星分段）都在会话中间件之后、
   * 任何业务事务之外，读数应当恒为 `undefined`——**恒真正是它该有的样子**：
   * 它防的是将来有人把合成搬进某个 `withWorkspaceTransaction` 里。
   */
  scope: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly currentActiveTransaction: () => unknown;
  };
}

/**
 * 按配置选引擎合成一段语音，返回完整字节。
 *
 * qwen 分支的流在「task-started」即开始产出（首包延迟低）；任何 qwen 阶段
 * 失败都降级 edge 重合成——调用方拿到的一定是可播放的字节，或一个抛出的
 * EdgeTtsError（由路由层统一映射 502）。
 */
export async function synthesizeTtsBytes(args: SynthesizeTtsBytesArgs): Promise<TtsBytesResult> {
  const deps = args.deps ?? {};
  const qwenSynthesize = deps.qwenSynthesize ?? qwenTtsSynthesizeStreamForUser;
  const edgeSynthesize = deps.edgeSynthesize ?? edgeTtsSynthesize;
  const loadConfig = deps.loadConfig ?? loadTtsEngineConfig;
  const collectStream = deps.collectStream ?? defaultCollectStream;
  const cfg = loadConfig();
  // 引擎与音色优先取这次的 selection（用户偏好），缺省才回 config。
  const engine = args.selection?.engine ?? cfg.engine;
  const qwenVoice = args.selection?.qwenVoice ?? cfg.qwen.voice;

  const edgeOptions: EdgeTtsProviderOptions = {
    ...(args.edgeRate ? { rate: args.edgeRate } : {}),
  };

  /**
   * 这一发失败时的**原始错误**。内核给的是分类与一句话，而路由那层按
   * `err instanceof EdgeTtsError` 映射 502（`edge-tts-gate.test.ts` 钉的就是
   * 「edge failed=0 与真实的 EdgeTtsError 同时成立」这条）。把原始对象原样带出来
   * 抛回去，那条映射一个字都不用改——不然就得在核心里重建一遍错误码，
   * 而重建的那份迟早与 provider 抛出的那份对不上。
   */
  let failureError: unknown = null;

  const task: AiTaskDefinition<{ engine: "qwen" | "edge" }, TtsBytesResult> = {
    id: TTS_TASK_ID,
    version: 1,
    mode: "structured",
    // 用户正等着听这一段 ⇒ 交互档名额（与 ASR 同一档）。
    resourceClass: "interactive_ai",
    budget: {
      // 一次合成最多两次上游调用：qwen 一次，失败再 edge 一次。
      maxModelCalls: 2,
      stepTimeoutMs: TTS_STEP_TIMEOUT_MS,
      taskDeadlineMs: TTS_TASK_DEADLINE_MS,
      // **不自动重试**：qwen→edge 那一跳本身就是这一发的降级设计，
      // 再让内核重来一次就是第三次计费，而且失败原因多半不会变。
      maxAutoRetries: 0,
    },
    completion: {
      kind: "custom",
      // 有界判据：拿到了非空字节就算这一段做完（不是"���便什么时候算完"）。
      satisfied: (output) => output.audio.length > 0,
      unmetReason: "语音合成没有产出任何字节",
    },
    usageContext: { modelId: engine === "qwen" ? cfg.qwen.model : "edge-tts", promptVersion: TTS_PROMPT_VERSION, resourceClass: "interactive_ai" },
    prepare: async () => ({ engine }),
    // `step` 这一层**刻意不用**：两个 provider 各自带自己的传输超时
    // （edge 30s / qwen 30s），真正拆掉 socket 的是那两个。
    // 内核的步预算不是空的——`withStepDeadline` 用 `Promise.race` 与计时器赛跑，
    // 所以「这一发最多占多久」由内核兜住；两层的职责是「谁掐传输」与
    // 「谁兜住整步」的区别，不是重复。
    //
    // 把 `step.signal` 透进两个 provider 需要改它们的签名（`edgeTtsSynthesize`
    // 现在自建 AbortController + timer），那是另一次改动，不夹在这次里。
    execute: async (prepared, _step): Promise<AiStepResult<TtsBytesResult>> => {
      try {
        if (prepared.engine === "qwen" && cfg.qwen.workspaceId) {
          const qwenOptions: QwenTtsOptions = {
            workspaceId: cfg.qwen.workspaceId,
            apiKey: process.env.DASHSCOPE_API_KEY ?? "",
            voice: qwenVoice,
            model: cfg.qwen.model,
            format: cfg.qwen.format,
            sampleRate: cfg.qwen.sampleRate,
            ...(cfg.qwen.instruction ? { instruction: cfg.qwen.instruction } : {}),
          };
          try {
            const result = await qwenSynthesize(args.queueKey, args.text, qwenOptions);
            const audio = await collectStream(result.stream);
            if (audio.length === 0) throw new Error("qwen tts returned empty audio");
            return { ok: true as const, output: { audio, engine: "qwen" as const, contentType: result.contentType } };
          } catch (error) {
            args.onQwenFallback?.(error);
            // 落到 edge 兜底。
          }
        }

        const edge = await edgeSynthesize(stripVoiceExpressionTags(args.text), args.edgeVoice, edgeOptions);
        if (edge.audio.length === 0) {
          const empty = new EdgeTtsError("EMPTY_AUDIO", "edge-tts 返回空音频（fail closed）");
          failureError = empty;
          return { ok: false as const, class: "output_shape" as const, message: empty.message };
        }
        return { ok: true as const, output: { audio: edge.audio, engine: "edge" as const, contentType: edge.contentType } };
      } catch (error) {
        failureError = error;
        return {
          ok: false as const,
          class: "transport" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    // 恒等提交：语音产物由路由那层按既有流程响应/落盘，公共层不替它写库。
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
      workspaceId: args.scope.workspaceId,
      userId: args.scope.userId,
      // 输入快照就是"这一段要念什么 + 念给谁 + 用哪身"：同一段文本同一音色才可复用。
      inputSnapshotRef: {
        kind: "task",
        id: args.queueKey,
        hash: ttsInputHash(args.text, args.edgeVoice, args.edgeRate ?? "+0%", engine),
      },
      permissionLevel: "server",
    },
    attempt: {
      taskId: task.id,
      taskVersion: task.version,
      attemptId: randomUUID(),
      leaseToken: `tts:${args.scope.workspaceId}:${args.queueKey}`,
      idempotencyKey: `tts:${args.scope.workspaceId}:${args.queueKey}`,
      workspaceId: args.scope.workspaceId,
      userId: args.scope.userId,
    },
    currentActiveTransaction: args.scope.currentActiveTransaction,
    reportDevelopmentError: (message) => process.stderr.write(`[dev-error] ${message}\n`),
  });

  if (receipt.outcome === "committed" && receipt.output) return receipt.output;
  // 失败：把原始错误原样抛回去，路由的 502 映射与 edge-tts 错误码一字不变。
  throw failureError instanceof Error
    ? failureError
    : new EdgeTtsError("UPSTREAM_ERROR", `语音合成没有完成（${receipt.failure?.class ?? receipt.outcome}）`);
}

/**
 * 输入快照哈希：文本 + edge 音色/语速 + 选中的引擎。四者任一不同都是另一次合成。
 *
 * 判据是「同一份输入才允许复用旧结果」——同一段文字换个音色念，出来的是另一段
 * 音频，拿上一次的检查点当这一次的，就是把「她刚才那句」说成另一句。
 */
function ttsInputHash(text: string, voice: string, rate: string, engine: string): string {
  return createHash("sha256")
    .update([text, voice, rate, engine].join(" "))
    .digest("hex");
}
