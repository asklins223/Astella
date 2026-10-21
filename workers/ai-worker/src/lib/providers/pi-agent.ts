/**
 * Pi's protocol adapter for Astella's existing Agent provider contract.
 *
 * Pi normalizes the model API and message/event formats. Astella still owns the
 * supervised run, permissions, tool execution, budgeting, and persistence.
 */
import { randomUUID } from "node:crypto";
import {
  Type,
  type AssistantMessage as PiAssistantMessage,
  type Context as PiContext,
  type Model as PiModel,
  type SimpleStreamOptions,
  type Tool as PiTool,
  type ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { streamSimple as streamChat } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import type { PublicStreamingRequester } from "@astella/shared/public-json-http";
import { createPiHttpTransport } from "./pi-http-transport.ts";
import { PiWireObservation } from "./pi-wire-observation.ts";
import { decodeMimoUnionArguments } from "./mimo-tool-arguments.ts";
import type {
  AgentTurnRequest,
  AgentTurnResult,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ModelProfile,
  PlatformOptions,
  ProviderCapability,
  ProviderRuntimeConfig,
  ProviderUsage,
} from "@astella/shared";
import type { AIProvider } from "../ai-provider.ts";
import { registerFactory } from "../provider-factory.ts";
import { ProviderRequestError, ProviderStreamError } from "../provider-request-error.ts";
import { AgentOutputError } from "../non-retryable-errors.ts";
import { profileFingerprint } from "./profile-fingerprint.ts";
import { modelOutputTokenLimit } from "./model-output-budget.ts";
import { countModelTextTokens } from "../model-tokenizers.ts";
import { resolveOpenCodeGoEndpoint, resolveMiMoResponsesEndpoint } from "./opencode-go.ts";

type PiApi = "openai-completions" | "openai-responses";
type PiWireModel = PiModel<PiApi>;
type PiProtocolProviderId = "opencode_go" | "mimo_responses";
type ImageInput = { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
type PiImage = { type: "image"; data: string; mimeType: string };

const DEFAULT_CONTEXT_TOKENS = 128_000;
const DEFAULT_OUTPUT_TOKENS = 8_192;
const OPEN_CODE_USER_AGENT = "astella-ai-worker/1.0";
const REMOTE_IMAGE_MARKER = "__ASTELLA_IMAGE_";
const EFFORT_ORDER: NonNullable<ModelProfile["reasoning"]>["levels"] = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeImage(url: string, index: number): { image: PiImage; marker: string; value: string } {
  const dataUri = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(url);
  const remote = /^https?:\/\//i.test(url);
  if (!dataUri && !remote) throw new Error("Pi provider accepts image data URLs or public HTTP(S) image URLs");
  const mimeType = dataUri?.[1] ?? "image/jpeg";
  const marker = `${REMOTE_IMAGE_MARKER}${index}__`;
  return { image: { type: "image", data: marker, mimeType }, marker, value: url };
}

function textFromContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function contentToPi(
  content: string | ImageInput[],
  imageReplacements: Map<string, { value: string; detail?: "auto" | "low" | "high" }>,
): string | Array<{ type: "text"; text: string } | PiImage> {
  if (typeof content === "string") return content;
  return content.flatMap<{ type: "text"; text: string } | PiImage>((part) => {
    if (part.type === "text") return [{ type: "text" as const, text: part.text }];
    const converted = safeImage(part.image_url.url, imageReplacements.size);
    imageReplacements.set(converted.marker, { value: converted.value, detail: part.image_url.detail });
    return [converted.image];
  });
}

function restoreImageMarkers(value: unknown, replacements: Map<string, { value: string; detail?: "auto" | "low" | "high" }>): unknown {
  if (Array.isArray(value)) return value.map((item) => restoreImageMarkers(item, replacements));
  const source = record(value);
  if (!source) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if ((key === "url" || key === "image_url") && typeof child === "string") {
      const replacement = [...replacements.entries()].find(([marker]) => child === marker || child.endsWith(`;base64,${marker}`));
      if (replacement) {
        const [marker, image] = replacement;
        output[key] = child.replace(new RegExp(`data:image\\/[a-z0-9.+-]+;base64,${marker}`, "i"), image.value)
          .replace(marker, image.value);
        if (image.detail && image.detail !== "auto") output.detail = image.detail;
        continue;
      }
    }
    output[key] = restoreImageMarkers(child, replacements);
  }
  return output;
}

function reasoningText(handle: Record<string, unknown>): string {
  if (typeof handle.thinking === "string") return handle.thinking;
  if (!Array.isArray(handle.content)) return "";
  return handle.content.flatMap((part) => {
    const item = record(part);
    return item?.type === "reasoning_text" && typeof item.text === "string" ? [item.text] : [];
  }).join("");
}

function reasoningHandles(message: PiAssistantMessage): AgentTurnResult["reasoning"] {
  const handles: NonNullable<AgentTurnResult["reasoning"]> = [];
  for (const block of message.content) {
    if (block.type !== "thinking") continue;
    if (block.thinkingSignature) {
      try {
        const parsed: unknown = JSON.parse(block.thinkingSignature);
        const item = record(parsed);
        if (item) {
          handles.push(item);
          continue;
        }
      } catch {
        // Non-JSON provider signatures are carried as an opaque string below.
      }
      handles.push({ piThinkingSignature: block.thinkingSignature, thinking: block.thinking });
    } else if (block.thinking) {
      handles.push({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: block.thinking }] });
    }
  }
  return handles.length ? handles : undefined;
}

function phaseFromMessage(message: PiAssistantMessage): "commentary" | "final_answer" | undefined {
  for (const block of [...message.content].reverse()) {
    if (block.type !== "text" || !block.textSignature) continue;
    try {
      const signature: unknown = JSON.parse(block.textSignature);
      const phase = record(signature)?.phase;
      if (phase === "commentary" || phase === "final_answer") return phase;
    } catch {
      // Older Pi signatures may be plain IDs and carry no phase.
    }
  }
  return undefined;
}

function providerUsage(message: PiAssistantMessage): ProviderUsage {
  const usage = message.usage;
  return {
    totalTokens: usage.totalTokens,
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completionTokens: usage.output,
    cacheHitTokens: usage.cacheRead,
    cacheMissTokens: usage.input + usage.cacheWrite,
    requestId: message.responseId ?? null,
  };
}

function apiFor(providerId: PiProtocolProviderId, model: string, profile?: ModelProfile): PiApi {
  if (providerId === "mimo_responses") return "openai-responses";
  if (profile?.protocol) {
    if (profile.protocol !== "openai-completions" && profile.protocol !== "openai-responses") {
      throw new Error("Pi adapter supports openai-completions and openai-responses protocols");
    }
    return profile.protocol;
  }
  // Older hand-written configs remain deterministic: most OpenCode Go models
  // use Chat Completions; Muse Spark is the known Responses-only family.
  return model.startsWith("muse-spark-") ? "openai-responses" : "openai-completions";
}

function piReasoning(profile: ModelProfile | undefined, disableThinking: boolean | undefined):
  NonNullable<SimpleStreamOptions["reasoning"]> | undefined {
  const reasoning = profile?.reasoning;
  if (!reasoning) return undefined;
  let effort = reasoning.default;
  if (disableThinking) {
    effort = EFFORT_ORDER.find((level) => reasoning.levels.includes(level)) ?? reasoning.levels[0];
  }
  return effort === "none" ? undefined : effort;
}

function thinkingLevelMap(profile: ModelProfile | undefined): PiWireModel["thinkingLevelMap"] {
  const levels = profile?.reasoning?.levels ?? [];
  const result: NonNullable<PiWireModel["thinkingLevelMap"]> = {};
  for (const level of levels) {
    if (level === "none") result.off = "none";
    else result[level] = level;
  }
  if (result.off === undefined) {
    const lowest = EFFORT_ORDER.find((level) => level !== "none" && levels.includes(level));
    if (lowest) result.off = lowest === "max" ? "max" : lowest;
  }
  return result;
}

function convertContext(
  systemPrompt: string,
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | ImageInput[];
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    reasoning?: Array<Record<string, unknown>>;
    phase?: "commentary" | "final_answer";
    hostObservation?: boolean;
  }>,
  tools: AgentTurnRequest["tools"],
  imageReplacements: Map<string, { value: string; detail?: "auto" | "low" | "high" }>,
  historyModel: { api: PiApi; provider: string; id: string },
): PiContext {
  const systemParts = [systemPrompt.trim()];
  for (const message of messages) {
    if (message.role === "system" && !message.hostObservation) systemParts.push(textFromContent(message.content));
  }

  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
  }
  const piMessages: PiContext["messages"] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    const timestamp = Date.now() + messageIndex;
    if (message.role === "system") {
      if (message.hostObservation) piMessages.push({ role: "system", content: textFromContent(message.content), timestamp });
      continue;
    }
    if (message.role === "user") {
      piMessages.push({ role: "user", content: contentToPi(message.content, imageReplacements), timestamp });
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = message.toolCallId ?? `missing-tool-call-${messageIndex}`;
      const parts = contentToPi(message.content, imageReplacements);
      piMessages.push({
        role: "toolResult",
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? "tool",
        content: typeof parts === "string" ? [{ type: "text", text: parts }] : parts,
        isError: false,
        timestamp,
      });
      continue;
    }
    const content: PiAssistantMessage["content"] = [];
    for (const handle of message.reasoning ?? []) {
      const thinking = reasoningText(handle);
      const signature = typeof handle.piThinkingSignature === "string"
        ? historyModel.api === "openai-completions" ? handle.piThinkingSignature
          : JSON.stringify({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: thinking }] })
        : JSON.stringify(handle);
      content.push({ type: "thinking", thinking, thinkingSignature: signature });
    }
    if (typeof message.content === "string") {
      if (message.content) content.push({
        type: "text", text: message.content,
        textSignature: JSON.stringify({ v: 1, id: `msg_${messageIndex}`, ...(message.phase ? { phase: message.phase } : {}) }),
      });
    } else {
      for (const part of message.content) {
        if (part.type === "text") content.push({
          type: "text", text: part.text,
          textSignature: JSON.stringify({ v: 1, id: `msg_${messageIndex}`, ...(message.phase ? { phase: message.phase } : {}) }),
        });
        else content.push({
          type: "text", text: `[Image supplied in prior assistant output: ${part.image_url.url}]`,
        });
      }
    }
    for (const call of message.toolCalls ?? []) {
      content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments as PiToolCall["arguments"] });
    }
    piMessages.push({
      role: "assistant", content, api: historyModel.api, provider: historyModel.provider, model: historyModel.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: message.toolCalls?.length ? "toolUse" : "stop", timestamp,
    });
  }
  const piTools: PiTool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
  }));
  return { systemPrompt: systemParts.filter(Boolean).join("\n\n"), messages: piMessages, tools: piTools };
}

function textAndCalls(message: PiAssistantMessage): {
  content: string | null;
  toolCalls: AgentTurnResult["toolCalls"];
  finishReason: string;
  phase?: "commentary" | "final_answer";
  reasoning?: AgentTurnResult["reasoning"];
  usage: ProviderUsage;
  providerRequestId: string | null;
} {
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const calls = message.content.flatMap((block) => block.type === "toolCall" ? [{
    id: block.id.split("|")[0] || randomUUID(),
    name: block.name,
    arguments: block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)
      ? block.arguments as Record<string, unknown> : {},
  }] : []);
  const finishReason = message.stopReason === "toolUse" ? "tool_calls"
    : message.stopReason === "length" ? "length" : "stop";
  return {
    content: text || null,
    toolCalls: calls,
    finishReason,
    ...(phaseFromMessage(message) ? { phase: phaseFromMessage(message) } : {}),
    ...(reasoningHandles(message) ? { reasoning: reasoningHandles(message) } : {}),
    usage: providerUsage(message),
    providerRequestId: message.responseId ?? null,
  };
}

export class PiAgentProvider implements AIProvider {
  readonly id: string;
  readonly modelId: string;
  readonly visionModelId: string;
  readonly promptVersion: string;
  readonly chatCompletionStreamToolCalls = true;
  private readonly api: PiApi;
  private readonly model: PiWireModel;
  private readonly apiKey: string;
  private readonly modelProfile?: ModelProfile;
  private readonly platformOptions?: PlatformOptions;
  private readonly streamRequest?: PublicStreamingRequester;
  private readonly maxOutputTokens: number;

  constructor(input: {
    providerId: PiProtocolProviderId;
    apiKey: string;
    baseUrl: string;
    model: string;
    sessionId?: string;
    modelProfile?: ModelProfile;
    platformOptions?: PlatformOptions;
    streamRequest?: PublicStreamingRequester;
  }) {
    this.id = input.providerId;
    this.apiKey = input.apiKey;
    this.modelId = input.model;
    this.modelProfile = input.modelProfile;
    this.platformOptions = input.platformOptions;
    this.api = apiFor(input.providerId, input.model, input.modelProfile);
    this.promptVersion = `v1-pi-${this.api}`;
    this.maxOutputTokens = modelOutputTokenLimit(input.modelProfile, DEFAULT_OUTPUT_TOKENS) ?? DEFAULT_OUTPUT_TOKENS;
    this.visionModelId = input.modelProfile?.vision ? input.model : "";
    this.streamRequest = input.streamRequest;

    const baseUrl = input.providerId === "opencode_go"
      ? resolveOpenCodeGoEndpoint(input.baseUrl).replace(/\/responses(?:\?.*)?$/, "")
      : resolveMiMoResponsesEndpoint(input.baseUrl).replace(/\/responses(?:\?.*)?$/, "");
    const sessionId = input.sessionId || randomUUID();
    const compat = this.api === "openai-completions" && input.providerId === "opencode_go"
      && input.model.toLowerCase().startsWith("deepseek-")
      ? {
        thinkingFormat: "deepseek" as const,
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
      }
      : undefined;
    this.model = {
      id: input.model,
      name: input.model,
      api: this.api,
      provider: input.providerId === "opencode_go" ? "opencode-go" : "mimo-responses",
      baseUrl,
      reasoning: Boolean(input.modelProfile?.reasoning),
      thinkingLevelMap: thinkingLevelMap(input.modelProfile),
      input: input.modelProfile?.vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: input.modelProfile?.contextWindowTokens ?? DEFAULT_CONTEXT_TOKENS,
      maxTokens: this.maxOutputTokens,
      ...(input.providerId === "opencode_go" ? { headers: {
        "x-opencode-session": sessionId,
        "User-Agent": OPEN_CODE_USER_AGENT,
      } } : {}),
      compat: { ...compat, supportsMidConvoSystemMessages: true, supportsDeveloperRole: false },
    } as PiWireModel;
  }

  private requestModel(modelId?: string): PiWireModel {
    return modelId && modelId !== this.modelId ? { ...this.model, id: modelId, name: modelId } : this.model;
  }

  /** All completion methods share the same Pi stream, transport and validation. */
  private async run(
    messages: Parameters<typeof convertContext>[1],
    options: ChatOptions,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
  ): Promise<AgentTurnResult> {
    signal?.throwIfAborted();
    const native = options.nativeAgentRequest;
    const tools = native?.tools ?? options.tools ?? [];
    const choice = native?.toolChoice ?? options.toolChoice;
    const model = this.requestModel(native?.model ?? options.model);
    const images = new Map<string, { value: string; detail?: "auto" | "low" | "high" }>();
    const context = convertContext(native?.systemPrompt ?? "", native?.messages ?? messages,
      tools, images, { api: this.api, provider: model.provider, id: model.id });
    // A required DeepSeek tool step must disable thinking on this gateway.
    const history = native?.messages ?? messages;
    let continuationStart = history.length;
    while (continuationStart > 0 && ["assistant", "system"].includes(history[continuationStart - 1]!.role)) continuationStart--;
    const missingContinuationReasoning = history.slice(continuationStart).some(message => message.role === "assistant"
      && textFromContent(message.content).trim() && !(message.reasoning ?? []).some(handle => reasoningText(handle).trim()));
    const disableThinking = (native?.disableThinking ?? options.disableThinking)
      || (this.id === "opencode_go" && this.api === "openai-responses" && tools.length > 0 && missingContinuationReasoning)
      || (this.id === "opencode_go" && this.api === "openai-completions"
        && model.id.startsWith("deepseek-") && choice === "required" && tools.length > 0
        && this.modelProfile?.reasoning?.levels.includes("none"));
    const temperature = native?.temperature ?? options.temperature;
    const wire = new PiWireObservation(this.id, this.api, tools.length > 0, onDelta,
      this.modelProfile?.supportsAssistantPhase);
    const transport = createPiHttpTransport({ providerId: this.id,
      endpoint: `${model.baseUrl}/${this.api === "openai-responses" ? "responses" : "chat/completions"}`,
      request: this.streamRequest });
    const streamOptions: SimpleStreamOptions = {
      apiKey: this.apiKey, fetch: transport.fetch, maxRetries: 0, cacheRetention: "none", signal,
      maxTokens: this.maxOutputTokens,
      reasoning: piReasoning(this.modelProfile, disableThinking),
      headers: {
        ...(this.platformOptions?.workspace ? { "X-DashScope-WorkSpace": this.platformOptions.workspace } : {}),
        ...this.platformOptions?.extraHeaders,
      },
      onProviderStreamEvent: (event) => wire.observe(event),
      onPayload: (payload) => {
        const body = { ...record(payload) };
        // Astella owns the budget. Pi's approximate token estimate must not
        // silently shrink the host's declared output ceiling.
        delete body.max_tokens;
        delete body.max_completion_tokens;
        delete body.max_output_tokens;
        if (!this.platformOptions?.disableMaxTokens) {
          body[this.api === "openai-responses" ? "max_output_tokens" : this.platformOptions?.maxTokensParam ?? "max_tokens"] = this.maxOutputTokens;
        }
        const effort = this.api === "openai-responses" ? record(body.reasoning)?.effort
          : record(body.thinking)?.type === "disabled" ? "none" : body.reasoning_effort;
        delete body.temperature;
        if (this.modelProfile?.temperature !== "unsupported"
          && !(this.modelProfile?.temperature === "reasoning_none_only" && effort !== "none")
          && typeof temperature === "number" && Number.isFinite(temperature)) {
          body.temperature = Math.min(2, Math.max(0, temperature));
        }
        if (options.responseFormat === "json_object") {
          if (this.api === "openai-responses") body.text = { format: { type: "json_object" } };
          else body.response_format = { type: "json_object" };
        }
        if (choice === "required" && tools.length > 0) {
          body.tool_choice = this.id === "opencode_go" && this.api === "openai-responses"
            && effort !== undefined && effort !== "none" ? "auto" : "required";
        }
        if (this.id === "mimo_responses") {
          delete body.store;
          delete body.prompt_cache_key;
          delete body.prompt_cache_retention;
          // MiMo implements automatic selection only. Return its real result;
          // the host checks action receipts and corrects omissions before delivery.
          if (tools.length) body.tool_choice = "auto";
          else delete body.tool_choice;
        }
        return restoreImageMarkers(body, images);
      },
    };
    const stream = this.api === "openai-responses"
      ? streamResponses(model as PiModel<"openai-responses">, normalizeContext(context), streamOptions)
      : streamChat(model as PiModel<"openai-completions">, normalizeContext(context), streamOptions);
    let finalMessage: PiAssistantMessage | undefined;
    try {
      for await (const event of stream) {
        if (((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") && event.delta.length > 0)
          || event.type === "toolcall_end") options.onOutputActivity?.();
        if (event.type === "text_delta") wire.textDelta(event.delta);
        else if (event.type === "thinking_delta") options.onReasoningDelta?.(event.delta);
        else if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
          const call = event.partial.content[event.contentIndex];
          if (call?.type === "toolCall" && call.name) wire.toolStarted(event.contentIndex, call, options);
        } else if (event.type === "toolcall_end") wire.toolSettled(event.contentIndex, event.toolCall, options);
        else if (event.type === "done") finalMessage = event.message;
        else if (event.type === "error") finalMessage = event.error;
      }
      signal?.throwIfAborted();
      if (transport.failure) throw transport.failure;
      wire.validate();
      if (!finalMessage || finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
        throw new ProviderStreamError(this.id, "stream_failed");
      }
      if (finalMessage.stopReason === "length") {
        throw new AgentOutputError("output_truncated", "model response exhausted its output limit");
      }
      const observed = wire.result(textAndCalls(finalMessage));
      // Terminal/wire integrity is checked before this explicit provider codec.
      // The authoritative tool schema and execution guards remain in the host.
      const result = this.id === "mimo_responses" ? { ...observed,
        toolCalls: observed.toolCalls.map(call => ({ ...call,
          arguments: decodeMimoUnionArguments(call.arguments,
            tools.find(tool => tool.name === call.name)?.parameters) as Record<string, unknown>,
        })),
      } : observed;
      if (this.id !== "mimo_responses" && choice === "required" && tools.length > 0 && result.toolCalls.length === 0) {
        throw new ProviderRequestError({ provider: this.id, status: 400, providerCode: "MODEL_TOOL_CHOICE_NOT_SUPPORTED" });
      }
      if (!result.content?.trim() && result.toolCalls.length === 0) {
        throw new ProviderStreamError(this.id, "stream_empty");
      }
      wire.publishRemaining(result.content ?? "");
      return result;
    } finally { transport.close(); }
  }

  executeAgentTurn(request: AgentTurnRequest, signal?: AbortSignal,
    observation?: { onOutputActivity?: () => void }): Promise<AgentTurnResult> {
    return this.run([], { nativeAgentRequest: request, responseFormat: "text", onOutputActivity: observation?.onOutputActivity }, signal);
  }

  async chatCompletion(messages: ChatMessage[], options: ChatOptions, signal?: AbortSignal): Promise<ChatResult> {
    const result = await this.run(messages, { ...options, responseFormat: options.responseFormat ?? "json_object" }, signal);
    return { content: result.content ?? "", usage: result.usage ?? {} };
  }

  async chatCompletionStream(messages: ChatMessage[], options: ChatOptions,
    signal: AbortSignal | undefined, onDelta: (delta: string) => void):
    Promise<Awaited<ReturnType<NonNullable<AIProvider["chatCompletionStream"]>>>> {
    const result = await this.run(messages, options, signal, onDelta);
    return { ...result, content: result.content ?? "" };
  }

  getCapabilities(): ProviderCapability {
    const contextWindowTokens = this.modelProfile?.contextWindowTokens ?? DEFAULT_CONTEXT_TOKENS;
    const reservedOutputTokens = this.maxOutputTokens;
    return {
      providerId: this.id,
      modelId: this.modelId,
      visionModelId: this.visionModelId,
      toolMode: "native_tools",
      contextWindowTokens,
      reservedOutputTokens,
      maxInputTokens: contextWindowTokens - reservedOutputTokens,
      maxOutputTokens: this.maxOutputTokens,
      outputLimitEnforced: !(this.platformOptions?.disableMaxTokens ?? false),
      fingerprint: `${this.id}:${this.modelId}:pi-agent:${this.api}:${profileFingerprint(this.modelProfile)}`,
    };
  }

  resolveOutputTokenLimit(): number | undefined {
    return modelOutputTokenLimit(this.modelProfile, this.maxOutputTokens);
  }

  countTextTokens(text: string): Promise<number | null> {
    return countModelTextTokens(this.modelId, text);
  }
}

export function createPiProvider(providerId: PiProtocolProviderId, config: ProviderRuntimeConfig): PiAgentProvider | null {
  if (!config.apiKey) return null;
  const model = config.model ?? (providerId === "mimo_responses" ? "mimo-v2.6-flash" : "muse-spark-1.3-contributor");
  const baseUrl = config.baseUrl ?? (providerId === "mimo_responses"
    ? "https://api.xiaomimimo.com/v1"
    : "https://opencode.ai/inference/go/v1");
  return new PiAgentProvider({
    providerId,
    apiKey: config.apiKey,
    baseUrl,
    model,
    ...(config.sessionId ? { sessionId: config.sessionId } : {}),
    ...(config.modelProfile ? { modelProfile: config.modelProfile } : {}),
    ...(config.options ? { platformOptions: config.options } : {}),
  });
}

registerFactory("opencode_go", "agent_turn", (config) => createPiProvider("opencode_go", config));
registerFactory("opencode_go", "text_generation", (config) => createPiProvider("opencode_go", config));
registerFactory("mimo_responses", "agent_turn", (config) => createPiProvider("mimo_responses", config));

registerFactory("mimo_responses", "text_generation", (config) => createPiProvider("mimo_responses", config));
