/**
 * Platform configuration — config-file-driven platform registry.
 *
 * Replaces the scattered AI_PROVIDER_* env vars with a single JSON config file.
 * Users define platform instances with their own identifiers, map capabilities
 * to platform + model, and can add new platforms without changing code.
 *
 * Config file location:
 *   - AI_PLATFORMS_CONFIG env var (path to JSON file)
 *   - Default: config/ai-platforms.json (relative to CWD)
 *
 * Config file schema:
 * {
 *   "platforms": {
 *     "myqwen": {                          // user-defined identifier
 *       "type": "dashscope",               // protocol implementation
 *       "apiKey": "${DASHSCOPE_API_KEY}",  // env var interpolation
 *       "baseUrl": "https://...",
 *       "models": {                        // 模型档案（能力挂在模型上）
 *         "qwen-plus": {
 *           "contextWindowTokens": 131072,
 *           "maxOutputTokens": 8192,
 *           "vision": false,
 *           "reasoning": { "levels": ["none", "high"], "default": "high" }
 *         }
 *       },
 *       "options": { ... }                 // 仅网关怪癖（disableMaxTokens 等）
 *     },
 *     ...
 *   },
 *   "capabilities": {
 *     "agent_turn":      { "platform": "myqwen", "model": "qwen-plus" },
 *     "text_generation": { "platform": "free",   "model": "glm-4-9b" },
 *     "embedding":       { "platform": "free",   "model": "bge-m3" }
 *   }
 * }
 *
 * 读图没有独立槽位（2026-10-12）：模型档案里的 `vision` 决定这次用谁的眼睛——
 * 主模型声明能看就用主模型，否则用 text_generation 那台（副模型）声明能看时的眼睛，
 * 都不行就不读图并如实说明。
 *
 * 2026-10-06 起：capabilities 引用的模型应在对应平台的 `models` 里声明能力
 *（上下文/输出/识图/推理档位）——面板校验会拦截未声明的引用；手写文件绕过时
 * 使用 provider 缺省值并告警一次。
 *
 * Supported platform types: mock, dashscope, openai_compatible, siliconflow,
 * opencode_go and mimo_responses (OpenAI Responses API).
 * Adding a new platform type requires code (implementing the provider class +
 * registering the factory). Adding a new platform instance of an existing
 * type only requires editing the config file.
 */

import type { Capability } from "./provider-capabilities.ts";
// 2026-08-13：node:fs 依赖的 loadPlatformConfig/resolveSystemPlatform 已拆至
// platform-config-node.ts（服务端子路径）；本文件保持 web 客户端可打包。

// ─── Config schema ───────────────────────────────────────────────────────

/**
 * OpenAI Responses API 的 reasoning 档位（请求体 `reasoning.effort`）。
 *
 * 各模型支持范围不同，设成模型不支持的值会直接 400（实测于 OpenCode Go）：
 * - muse-spark-*：minimal/low/medium/high/xhigh/max（**不支持 none**）
 * - deepseek-v4.1-flash / v4-flash / v4-pro：支持 none（关闭思考）
 * - gpt-5.6-luna：**不支持 minimal**，支持 none
 * - MiMo Responses：官方文档声明 `none` 关闭思考，其他档位均开启（当前强度行为相同）
 * 因此「最低档」/「关闭」都没有通用值，只能按目标模型显式指定。
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Model-level wire dialect selected by multi-protocol agent adapters such as Pi. */
export type AgentModelProtocol = "openai-completions" | "openai-responses";

/** Provider-specific options (passed through to the provider constructor). */
export interface PlatformOptions {
  /** Disable the output token limit field in API requests（网关怪癖，如 tokenrhythm/siliconflow-chat）. */
  disableMaxTokens?: boolean;
  /** Output token limit field used by the platform; defaults to the OpenAI-compatible `max_tokens`. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** DashScope workspace ID (sent as X-DashScope-WorkSpace header). */
  workspace?: string;
  /** Extra request headers. */
  extraHeaders?: Record<string, string>;
  /**
   * 思考开关的网关方言。
   *
   * chat/completions 没有统一的思考开关字段。DashScope 系网关认
   * `enable_thinking`；Xiaomi MiMo Chat Completions 官方协议认
   * `thinking.type: enabled|disabled`；另有网关认 `reasoning_effort`。
   *
   * 发错方言的表现是"配置说关了、实际还在烧思考 token"，既不报错也查不出来，
   * 所以方言由平台显式声明；缺省 `enable_thinking`，现有平台行为不变。
   */
  thinkingParam?: ThinkingParamDialect;
}

/** 思考开关字段名（见 PlatformOptions.thinkingParam）。 */
export type ThinkingParamDialect = "enable_thinking" | "reasoning_effort" | "thinking_type";

/** Output token-limit field selector; endpoints may use the newer completion name. */
export type MaxTokensParam = NonNullable<PlatformOptions["maxTokensParam"]>;

/** 档位由低到高；"最接近关"的一档取声明 levels 里第一个命中的。 */
export const REASONING_EFFORT_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Per-call intent is resolved against the actual target model, including a
 * fallback with different levels. Prefer the next stronger supported level;
 * requesting none on a model without off selects its lowest declared level. */
export function resolveModelReasoningEffort(profile: ModelProfile | undefined,
  disableThinking = false, requested?: ReasoningEffort): ReasoningEffort | undefined {
  const reasoning = profile?.reasoning;
  if (!reasoning) return undefined;
  const wanted = requested ?? (disableThinking ? "none" : reasoning.default);
  const levels = REASONING_EFFORT_ORDER.filter(level => reasoning.levels.includes(level));
  return levels.find(level => REASONING_EFFORT_ORDER.indexOf(level) >= REASONING_EFFORT_ORDER.indexOf(wanted))
    ?? levels.at(-1);
}

/**
 * 这一发该带哪个思考字段——**方言与档位都由声明驱动**，调用方只说"要不要关"。
 *
 * `reasoning_effort` 方言按档案档位下发；布尔/类型方言只表达开关。调用方只说
 * "要不要关"，不需要知道请求字段长什么样。
 */
export function chatThinkingRequestFields(
  options: PlatformOptions | undefined,
  profile: ModelProfile | undefined,
  perCallDisableThinking: boolean,
  requestedEffort?: ReasoningEffort,
): Record<string, unknown> {
  const effort = resolveModelReasoningEffort(profile, perCallDisableThinking, requestedEffort);
  const disabled = effort === "none" || (effort === undefined && perCallDisableThinking);
  if (options?.thinkingParam === "thinking_type") {
    // MiMo Chat Completions: thinking is enabled by default. Its API exposes an
    // on/off switch rather than the effort levels accepted by its Responses API.
    return { thinking: { type: disabled ? "disabled" : "enabled" } };
  }
  if (options?.thinkingParam === "reasoning_effort") {
    return effort ? { reasoning_effort: effort } : disabled ? { reasoning_effort: "none" } : {};
  }
  if (disabled) return { enable_thinking: false };
  if (profile?.reasoning) return { enable_thinking: true };
  return {};
}

/**
 * 模型的思考/推理配置（2026-10-06 模型档案重设计）。
 *
 * 档位是**模型**的属性：各模型支持范围不同，设成不支持的值上游直接 400
 *（实测于 OpenCode Go：muse-spark 不接受 none、gpt-5.6-luna 不接受 minimal、
 * deepseek 全档可用）。因此这里声明该模型接受的 `levels` 与默认下发的 `default`。
 */
export interface ModelReasoningProfile {
  /** 该模型接受的全部档位（顺序不重要，判定按档位高低语义）。 */
  levels: ReasoningEffort[];
  /** 默认下发的档位；必须 ∈ levels（配置校验会拦）。 */
  default: ReasoningEffort;
}

/**
 * 模型档案：挂在平台下的模型能力声明（2026-10-06 配置重设计）。
 *
 * 上下文窗口 / 输出上限 / 能否识图 / 推理档位都是**模型**的属性，不是平台的——
 * 同一平台上换模型时这些值全都变（旧设计把它们写在平台 options 里，靠注释提醒
 * "换模型时必须同步改"，那是设计错了）。平台级 `options` 只保留网关怪癖。
 *
 * 缺省语义：数值缺省用 provider 内置默认（并在解析时告警提醒补声明）；
 * `vision` 缺省 false——不存在"默认能看图"，识图路由必须显式声明。
 */
export interface ModelProfile {
  /** Upstream wire dialect for this model when one platform exposes multiple APIs. */
  protocol?: AgentModelProtocol;
  /** Temperature support in the selected model/protocol. Omit for legacy always-supported behavior. */
  temperature?: "always" | "reasoning_none_only" | "unsupported";
  /** Responses message phases may arrive after text deltas; hold unclassified text until final payload. */
  supportsAssistantPhase?: boolean;
  /** 上下文窗口（token）。 */
  contextWindowTokens?: number;
  /** 输出上限（token）。 */
  maxOutputTokens?: number;
  /** 能否读图（接受图片输入）。缺省 false。 */
  vision?: boolean;
  /** 思考/推理配置；缺省 = 不下发任何思考字段（用网关默认）。 */
  reasoning?: ModelReasoningProfile;
}

/** A platform definition from the config file. */
export interface PlatformDefinition {
  /** Provider type (protocol implementation): mock, dashscope, openai_compatible, siliconflow. */
  type: string;
  /** API key (supports ${ENV_VAR} interpolation). */
  apiKey?: string;
  /** Base URL (supports ${ENV_VAR} interpolation). */
  baseUrl?: string;
  /** Default model for this platform. */
  model?: string;
  /**
   * 模型档案（2026-10-06）：capabilities 里引用的模型应当在这里声明能力。
   * 未声明的模型会使用 provider 缺省值，并在解析时告警一次。
   */
  models?: Record<string, ModelProfile>;
  /** Provider-specific options（仅网关怪癖；模型属性见 models） */
  options?: PlatformOptions;
}

/** A capability mapping from the config file. */
export interface CapabilityMapping {
  /** Platform identifier (references a key in platforms). */
  platform: string;
  /** Model to use for this capability. */
  model: string;
  /**
   * 这一槽相对模型档案的**思考档位覆盖**（2026-10-16）。
   *
   * 为什么挂在能力上而不是再抄一份平台/模型：同一台模型可以同时服务"要深思"和
   * "只要结构化抽取"的两种用途（伴星对话 vs 速看/脑图）。差异是**用途**的属性，
   * 不是模型的属性，而用途正是 capability。写在这里就不必复制一份模型档案
   * （复制品一定会在下一次改上下文/输出上限时漂移）。
   *
   * 约束：值必须 ∈ 该模型档案声明的 `reasoning.levels`。不在档位表里时
   * `resolveSystemPlatform` **丢弃覆盖并告警一次**（照档案默认下发）——设成上游
   * 不认的值会直接 400，比"没生效"更难查。配置面板对同一条做阻断校验。
   * 模型档案未声明 `reasoning` 时该字段无效（没有可覆盖的档位）。
   */
  reasoningEffort?: ReasoningEffort;
}

/**
 * TTS 引擎设置 —— config/ai-platforms.json 的可选 `tts` 节点。
 *
 * 设计 P1-7（2026-09-15 审计）：此前该节点**不在本契约内**（AIPlatformConfig 只有
 * platforms + capabilities），API 侧由 voice-providers/tts-config.ts 自行 cast 读取，
 * 于是"配置文件里有一个契约描述不到的节点"，两侧各自维护默认值。
 * 现在把它纳入契约：字段与优先级有单一出处，读取方按类型解析。
 *
 * 取值优先级：配置文件 `tts.qwen.*` 优先；缺 workspaceId 时回退
 * `DASHSCOPE_TTS_WORKSPACE_ID`，其余字段使用内置默认值。
 */
export interface TtsQwenSettings {
  /** DashScope TTS workspaceId（wss:// 端点标识）。 */
  workspaceId?: string;
  model?: string;
  voice?: string;
  /** 输出格式，默认 mp3。 */
  format?: string;
  sampleRate?: number;
  /** 指令控制（≤100 字符）。 */
  instruction?: string;
  /** 项目默认女声克隆得到的方言角色音色；支持方言的轮次优先使用它。 */
}

/** edge-tts（容器内）语音设置。 */
export interface TtsEdgeSettings {
  voice?: string;
  rate?: string;
}

export interface TtsEngineSettings {
  /** 引擎选择：qwen（默认）| edge。 */
  engine?: "qwen" | "edge";
  qwen?: TtsQwenSettings;
  edge?: TtsEdgeSettings;
}

/** The full config file schema. */
export interface AIPlatformConfig {
  /** Platform definitions keyed by user-defined identifier. */
  platforms: Record<string, PlatformDefinition>;
  /** Capability → platform + model mappings. */
  capabilities: Partial<Record<Capability, CapabilityMapping>>;
  /** TTS 引擎设置（可选；见 TtsEngineSettings 的优先级说明）。 */
  tts?: TtsEngineSettings;
}


// ─── Resolution ──────────────────────────────────────────────────────────

/**
 * Resolved platform config for a specific capability.
 * Contains everything needed to create a provider instance.
 */
export interface ResolvedPlatform {
  /** Provider type (protocol implementation). */
  type: string;
  /** Platform identifier from config. */
  platformId: string;
  /** API key (interpolated from config or env). */
  apiKey?: string;
  /** Base URL. */
  baseUrl?: string;
  /** Model for this capability. */
  model: string;
  /**
   * 该模型的能力档案（2026-10-06）。未声明时为 undefined，
   * provider 用内置缺省并在解析时告警。
   */
  modelProfile?: ModelProfile;
  /** Platform options（仅网关怪癖：disableMaxTokens / workspace / extraHeaders）. */
  options?: PlatformOptions;
}
