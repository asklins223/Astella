/**
 * R2: Provider 能力接口拆分。
 *
 * 将胖 `AIProvider` 接口拆分为按能力维度的独立接口。
 * 新增能力（语音识别、文生图）只需定义新接口 + 注册 + 添加 task 映射，
 * 不需要修改任何现有 provider 代码。
 *
 * @see 原据 provider-registry-refactor.md（2026-09-29 已归档） §3.1
 */

import type {
  ProviderUsage,
  ProviderReasoningHandle,
  AgentTurnRequest,
  AgentTurnResult,
} from ".././contracts/agent/card-agent-contracts.ts";

// ─── 能力枚举 ──────────────────────────────────────────────────────────

/** 能力枚举 — 可扩展 */
export type Capability =
  | "text_generation"       // 文本生成（chat completion + JSON output）
  | "agent_turn"            // Agent 工具调用（native tool calls）
  /**
   * 伴星对话的**跨模型兜底**槽（方案 29 §9.6 / B8）。
   *
   * 为什么单独一个槽而不是复用 `text_generation`：`agent_turn` 主模型
   * （qwen3.8-flash）会高频返回退化补全（实测近 3 小时 32 条回复里 21 条不足
   * 6 字，且 `finishReason=stop`、无 maxTokens 截断日志）。同档思考重试救不回
   * 连续两次的退化，必须换一个**模型甚至换一家 provider**。
   * 复用 `text_generation` 会让这个兜底跟着摘要器一起被调走，两者耦合且没人
   * 会想到它们共享一个降级路径。
   */
  | "companion_fallback"    // 伴星退化时的备用对话模型
  /**
   * 笔记学习产物的**生成**槽（速看／脑图／原句讲解／拓展草稿）。
   *
   * 为什么不复用 `agent_turn`（2026-10-16 线上实测）：两条链的用户可见性相同，
   * 但**思考预算**不同。伴星对话要的是"想清楚再开口"（档位随模型档案，当前
   * medium 就够快）；速看是"把已读到的正文压成要点＋逐字引文"的结构化任务，
   * 同档思考会整段烧在推理上——线上一次速看落在 mimo-v2.6-flash/medium，
   * 单次 completion 9,411 token、墙上时间 242 s，而 10-09 同一操作在
   * deepseek-v4.1-flash 上是 9.5–16.1 s。把两件事塞进同一个槽，就只能二选一：
   * 要么伴星跟着降档，要么速看一直等 4 分钟。
   *
   * 档位**不在代码里写死**：`capabilities.note_generation.reasoningEffort`
   * （见 platform-config.ts）声明这一槽相对模型档案默认档的覆盖值，配置面板可改。
   */
  | "note_generation"       // 笔记学习产物的结构化生成（速看/脑图/讲解/拓展）
  | "embedding"             // 向量嵌入
  /**
   * 嵌入的本地兜底槽（2026-10-17）。SiliconFlow 不可用或并发打满时切到本地
   * BGE-M3 容器；模型 id 必须与主槽一致，否则已落库向量的 model_revision
   * 对不上，检索会静默退回关键词。
   */
  | "embedding_fallback"
  | "rerank"                // 重排序
  // ── 未来扩展 ──
  | "speech_recognition"    // 语音识别
  | "image_generation";     // 文生图

// ─── 共享类型定义 ──────────────────────────────────────────────────────

/** Chat 消息格式（OpenAI 兼容） */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Host observation/data at its actual transcript position, never a new
   * human utterance. Native adapters preserve its system identity. */
  hostObservation?: true;
  /** Original Responses assistant phase, when available. Never attached to user messages. */
  phase?: "commentary" | "final_answer";
  /**
   * 产出这条 assistant 消息时的 provider reasoning item。
   *
   * 网关在思考模式下把它当成"续写上一条 assistant"的凭据：以 assistant 收尾的
   * 请求（主动参与轮每一轮都是）必须把它交回去，只带 `encrypted_content` 同样 400。
   * 只有 provider 产出它时才有值；user/system 消息恒为 undefined。
   */
  reasoning?: ProviderReasoningHandle[];
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  >;
}

/** Chat 调用选项 */
export interface ChatOptions {
  /** Streaming adapters for Responses must preserve native calls, results and
   * opaque reasoning handles rather than reinterpret them as ordinary chat. */
  nativeAgentRequest?: AgentTurnRequest;
  temperature?: number;
  /** Fallback without a model profile; configured providers use its declared output ceiling. */
  maxTokens?: number;
  model?: string;
  responseFormat?: "json_object" | "text";
  /** 请求关闭 provider 思考模式，优先于档案默认档。
   * 生产伴星在纯闲聊时使用；其他轮次跟随模型档案默认档。
   * Responses 模型若未声明 none，只能降到声明的最低档，不能据此宣称已关闭。
   * 真实档位与消耗需看 provider 请求及返回用量。 */
  disableThinking?: boolean;
  /**
   * native tools 定义（2026-09-19 ④-b）。
   *
   * 只有流式 chat completion 需要它：带工具的一步也必须能把工具列表发给模型，
   * 否则模型永远不会返回 tool_calls（与 executeAgentTurn 的 `tools` + `tool_choice`
   * 同源，形状取自 AgentTurnRequest.tools）。
   */
  tools?: AgentTurnRequest["tools"];
  toolChoice?: "auto" | "required";
  /** Actual text, reasoning or native argument output. Heartbeats do not count. */
  onOutputActivity?: () => void;
  /** A named call is being generated; arguments may be incomplete. Display-only:
   * this signal never authorizes execution or claims that a write has started. */
  onToolCallStarted?: (slot: { index: number; id: string; name: string }) => void;
  /**
   * 流中**已完整**的工具调用被观察到时回调（40b §4.1-1 / R7，验收 A58）。
   *
   * 触发条件是**可判定的**而非猜测：调用名已拿到，且 `arguments` 已经拼成一个
   * 合法 JSON 对象。半截 JSON 即使恰好以 `}` 结尾也不算（见
   * `stream-tool-call-accumulator.ts` 的单测）。
   *
   * 缺省不传 ⇒ provider 不做任何额外工作。**这是默认关闭的姿态**：R7 按 §4.3
   * 是「无收益就撤回」的优化，开关留在调用方，不留在协议里。
   *
   * 回调**不得被 await**：它跑在 SSE 读取循环里，await 会把流停住。
   * 调用方应当把派发排进一个并发队列，等这一轮流结束后再收结果。
   */
  onToolCallSettled?: (slot: {
    index: number;
    id: string;
    name: string;
    argsText: string;
  }) => void;
  /**
   * 模型内部思考的原文增量（2026-10-13）。
   *
   * 只有真正实现 Responses 思考通道（`response.reasoning_text.delta`）的 provider
   * 会调它。**默认关闭**：不传就什么都不做，与之前的行为逐字相同。
   *
   * 用途只有一个——让等待有内容看。调用方拿到的是**未净化**的模型内部文本，
   * 不能当正文（不进可见文本管线、不进朗读、不进历史），所以它和 `onDelta`
   * 是两条完全独立的路。回调同样**不得被 await**（跑在 SSE 读取循环里）。
   */
  onReasoningDelta?: (deltaText: string) => void;
}

/** Chat 调用结果 */
export interface ChatResult {
  content: string;
  usage: ProviderUsage;
}

/** 重排序结果 */
export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/** 语音转写结果（未来） */
export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
}

/** 文生图结果（未来） */
export interface GeneratedImage {
  base64: string;
  mimeType: string;
}

// ─── 输入类型（从 worker 迁移到 shared，供能力接口引用） ──────────────

// ─── 能力接口 ──────────────────────────────────────────────────────────

/** 文本生成能力 */
export interface TextGenerationCapability {
  readonly modelId: string;
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
}

/** Agent 工具调用能力 */
export interface AgentTurnCapability {
  executeAgentTurn(
    request: AgentTurnRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult>;
}

/** 向量嵌入能力 */
export interface EmbeddingCapability {
  readonly embeddingModelId: string;
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

/** 重排序能力 */
export interface RerankCapability {
  rerank(
    params: { query: string; documents: string[]; topN?: number },
    signal?: AbortSignal,
  ): Promise<RerankResult[]>;
}

// ── 未来扩展示例 ──

/** 语音识别能力（未来） */
export interface SpeechRecognitionCapability {
  transcribe(
    input: { audio: Buffer; mimeType: string; language?: string },
    signal?: AbortSignal,
  ): Promise<TranscriptionResult>;
}

/** 文生图能力（未来） */
export interface ImageGenerationCapability {
  generateImage(
    input: { prompt: string; size?: string; n?: number },
    signal?: AbortSignal,
  ): Promise<GeneratedImage[]>;
}

/**
 * 能力实现联合类型。
 * createCapabilityProvider() 返回此类型，调用方按需 narrow 到具体能力接口。
 */
export type CapabilityImpl =
  | TextGenerationCapability
  | AgentTurnCapability
  | EmbeddingCapability
  | RerankCapability;
