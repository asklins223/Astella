/**
 * 隐藏等待期到底有没有可下发内容（2026-10-13）。
 *
 * 两个问题，按顺序回答：
 * 1. 这个网关给不给**推理摘要**（`reasoning_summary: "auto"`，也就是 OpenAI/Claude/Gemini
 *    那条"把思考摘要流式下发"的路）？只记事件类型/字节数/时刻——**不保存任何明文思考**。
 * 2. 隐藏那段窗口有多长，思考占了多少。设 `LIVE_REASONING_EFFORTS=high,medium,low,none`
 *    时同题按档各跑一次，产出 `thinkingWindowMs`（第一条思考增量→第一个可见正文增量）
 *    与可见正文原文（正文是给用户核对质量的，思考一律不落）。
 *
 * 运行（从 workers/ai-worker）：
 *   REAL_MODEL_BATCH=1 node --env-file=../../.env --import tsx scripts/reasoning-summary-probe.ts
 *   REAL_MODEL_BATCH=1 LIVE_REASONING_EFFORTS=high,medium,none node --env-file=../../.env --import tsx scripts/reasoning-summary-probe.ts
 */
import process from "node:process";
import { resolve } from "node:path";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import type { ReasoningEffort } from "@astella/shared/platform-config";
import { loadPlatformConfig, resolveSystemPlatform } from "@astella/shared/platform-config-node";
import { postSseToPublicEndpoint, type PublicStreamingRequester } from "@astella/shared/public-json-http";
import { OpenCodeGoProvider } from "../src/lib/providers/opencode-go.ts";

interface EventTally { count: number; firstMs: number | null; bytes: number }

if (process.env.REAL_MODEL_BATCH !== "1") {
  console.error("Refusing paid request: set REAL_MODEL_BATCH=1 explicitly for this probe.");
  process.exitCode = 1;
} else {
  process.env.AI_PLATFORMS_CONFIG ??= resolve(import.meta.dirname, "../../../config/ai-platforms.json");
  const route = resolveSystemPlatform("agent_turn");
  if (!route?.apiKey) throw new Error("agent_turn provider is not configured");
  if (route.type !== "opencode_go") throw new Error(`此探针按 Responses SSE 形状写死，当前路由是 ${route.type}`);
  const profile = route.modelProfile ?? {};
  const declaredReasoning = profile.reasoning;
  if (!declaredReasoning) throw new Error("agent_turn 模型未声明推理档位，档位对照没有意义");

  const question = process.env.LIVE_REASONING_QUESTION
    ?? "一个敞口容器里的水一直加热，为什么温度会先停在沸点上不去？请给出条件与推理。";
  const request: AgentTurnRequest = {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: "你是物理助教。先想清楚条件，再回答。",
    messages: [{ role: "user", content: question }],
    tools: [],
    disableThinking: false,
    maxTokens: 4000,
    temperature: 0.3,
  };

  /** 只透传不改内容：边转发边按行记事件类型（明文思考一律不保存）。 */
  const makeStreamRequest = (tally: (type: string, bytes: number) => void): PublicStreamingRequester =>
    async (url, headers, body, signal) => {
        const response = await postSseToPublicEndpoint(url, headers, {
          ...(body as Record<string, unknown>),
          // 显式向网关要摘要式推理（Responses 的文本格式参数）。不认就 4xx，
          // 那本身是要的结论，所以不静默降级重试。
          text: { format: { type: "text" }, reasoning_summary: "auto" },
        } as never, signal);
        const observe = (raw: string): void => {
          const trimmed = raw.trim();
          if (!trimmed.startsWith("data:")) return;
          const payload = trimmed.slice(5).trim();
          try {
            tally(String((JSON.parse(payload) as { type?: string }).type ?? "untyped"), payload.length);
          } catch { tally("unparsed", payload.length); }
        };
        // 这个 requester 的 body 是异步可迭代（provider 自己也是 `for await` 读的），
        // 所以用生成器边转发边按行记事件类型，不缓冲整条流。
        const source = response.body as unknown as AsyncIterable<Uint8Array>;
        const teed = (async function* (): AsyncGenerator<Uint8Array> {
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const value of source) {
            buffer += decoder.decode(value, { stream: true });
            let line: number;
            while ((line = buffer.indexOf("\n")) >= 0) {
              observe(buffer.slice(0, line));
              buffer = buffer.slice(line + 1);
            }
            yield value;
          }
          observe(buffer + decoder.decode());
        })();
        return { ...response, body: teed };
      };

  /** 每个档位一个新 provider：档案在构造期注入，没有可改的 setter。 */
  const providerFor = (effort: string, tally: (type: string, bytes: number) => void): OpenCodeGoProvider =>
    new OpenCodeGoProvider({
      apiKey: route.apiKey ?? "", baseUrl: route.baseUrl ?? "", model: route.model ?? "",
      modelProfile: { ...profile, reasoning: { ...declaredReasoning, default: effort as ReasoningEffort } },
      sessionId: "reasoning-summary-probe",
      platformOptions: loadPlatformConfig()?.platforms[route.platformId]?.options,
      streamRequest: makeStreamRequest(tally),
    });

  const runOne = async (effort: string | null): Promise<Record<string, unknown>> => {
    const events = new Map<string, EventTally>();
    const at = performance.now();
    const tally = (type: string, bytes: number): void => {
      const seen = events.get(type) ?? { count: 0, firstMs: null, bytes: 0 };
      seen.count += 1;
      seen.firstMs ??= Math.round(performance.now() - at);
      seen.bytes += bytes;
      events.set(type, seen);
    };
    let firstVisibleTextMs: number | null = null;
    try {
      const result = await providerFor(effort ?? declaredReasoning.default, tally).chatCompletionStream!([], {
        maxTokens: request.maxTokens, temperature: request.temperature, disableThinking: false,
        responseFormat: "text", nativeAgentRequest: request, tools: [],
      }, AbortSignal.timeout(180_000), delta => { firstVisibleTextMs ??= Math.round(performance.now() - at); void delta; });
      const reasoning = events.get("response.reasoning_text.delta");
      const summaries = [...events.keys()].filter(name => name.includes("summary"));
      return {
        effort: effort ?? "档案默认", status: "succeeded",
        // 思考占掉的窗口：第一条思考增量 → 第一个可见正文增量。
        thinkingWindowMs: reasoning?.firstMs != null && firstVisibleTextMs !== null
          ? firstVisibleTextMs - reasoning.firstMs : null,
        firstVisibleTextMs, totalMs: Math.round(performance.now() - at),
        reasoningDeltas: reasoning?.count ?? 0, reasoningBytes: reasoning?.bytes ?? 0,
        // 摘要通道是否存在：有 `*_summary_*` 事件才谈得上"下发摘要"。
        summaryEvents: summaries, answerChars: result.content.length, answer: result.content,
      };
    } catch (error) {
      return { effort: effort ?? "档案默认", status: "failed",
        failure: error instanceof Error ? `${error.name}/${error.message}`.slice(0, 160) : String(error),
        firstVisibleTextMs, totalMs: Math.round(performance.now() - at),
        summaryEvents: [...events.keys()].filter(name => name.includes("summary")) };
    }
  };

  const efforts = (process.env.LIVE_REASONING_EFFORTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (efforts.length === 0) {
    const events = new Map<string, EventTally>();
    const at = performance.now();
    const tally = (type: string, bytes: number): void => {
      const seen = events.get(type) ?? { count: 0, firstMs: null, bytes: 0 };
      seen.count += 1;
      seen.firstMs ??= Math.round(performance.now() - at);
      seen.bytes += bytes;
      events.set(type, seen);
    };
    let firstVisibleTextMs: number | null = null;
    try {
      const result = await providerFor(declaredReasoning.default, tally).chatCompletionStream!([], {
        maxTokens: request.maxTokens, temperature: request.temperature, disableThinking: false,
        responseFormat: "text", nativeAgentRequest: request, tools: [],
      }, AbortSignal.timeout(180_000), delta => { firstVisibleTextMs ??= Math.round(performance.now() - at); void delta; });
      console.log(JSON.stringify({ ok: true, firstVisibleTextMs, totalMs: Math.round(performance.now() - at),
        answerChars: result.content.length,
        events: Object.fromEntries(events.entries()),
        summaryEventsAvailable: [...events.keys()].filter(name => name.includes("summary")) }, null, 2));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, failure: error instanceof Error
        ? `${error.name}/${error.message}`.slice(0, 200) : String(error),
      firstVisibleTextMs, events: Object.fromEntries(events.entries()) }, null, 2));
      process.exitCode = 1;
    }
  } else {
    const samples: Record<string, unknown>[] = [];
    for (const effort of efforts) {
      if (!declaredReasoning.levels.includes(effort as ReasoningEffort)) throw new Error(`undeclared reasoning effort: ${effort}`);
      samples.push(await runOne(effort));
    }
    console.log(JSON.stringify({ model: route.model, question, samples }, null, 2));
  }
}
