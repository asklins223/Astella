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
 *     "vision":          { "platform": "myqwen", "model": "qwen-vl-plus" },
 *     "embedding":       { "platform": "free",   "model": "bge-m3" }
 *   }
 * }
 *
 * 2026-10-06 起：capabilities 引用的模型应在对应平台的 `models` 里声明能力
 *（上下文/输出/识图/推理档位）——面板校验会拦截未声明的引用；手写文件绕过时
 * 使用 provider 缺省值并告警一次。
 *
 * Supported platform types: mock, dashscope, openai_compatible, siliconflow,
 * opencode_go (OpenAI Responses API).
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
 * 因此「最低档」/「关闭」都没有通用值，只能按目标模型显式指定。
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Provider-specific options (passed through to the provider constructor). */
export interface PlatformOptions {
  /** Disable max_tokens field in API requests（网关怪癖，如 tokenrhythm/siliconflow-chat）. */
  disableMaxTokens?: boolean;
  /** DashScope workspace ID (sent as X-DashScope-WorkSpace header). */
  workspace?: string;
  /** Extra request headers. */
  extraHeaders?: Record<string, string>;
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
}

/**
 * TTS 引擎设置 —— config/ai-platforms.json 的可选 `tts` 节点。
 *
 * 设计 P1-7（2026-09-15 审计）：此前该节点**不在本契约内**（AIPlatformConfig 只有
 * platforms + capabilities），API 侧由 voice-providers/tts-config.ts 自行 cast 读取，
 * 于是"配置文件里有一个契约描述不到的节点"，两侧各自维护默认值。
 * 现在把它纳入契约：字段与优先级有单一出处，读取方按类型解析。
 *
 * 取值优先级（workerId 为例，其余字段同理）：
 *   配置文件 tts.qwen.* > 环境变量 DASHSCOPE_TTS_WORKSPACE_ID > 默认值。
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
