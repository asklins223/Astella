/**
 * R3: 任务路由层 — 任务 → 能力映射。
 *
 * 不同任务可以路由到不同 provider/模型。
 * 当前用户可见任务统一经明确的能力路由选择 provider/model。
 *
 * @see 原据 provider-registry-refactor.md（2026-09-29 已归档） §3.3
 */

import type { Capability } from "./provider-capabilities.ts";
import { resolveSystemPlatform } from "./platform-config-node.ts";

/** AI 任务类型 — 可扩展 */
export type AITaskType =
  // ── 卡片生成 Agent ──
  | "card_generation"       // Supervisor Agent（高复杂度）
  | "text_extraction"      // Text/Code Extractor（高复杂度）
  | "deck_composition"     // Deck Composer（中复杂度）
  | "grounding_critic"     // Grounding Critic（中复杂度）
  | "repair"               // Repairer（中复杂度）
  // ── 其他 ──
  | "analyze_image"        // 图片分析
  | "embed"                // 向量嵌入
  | "rerank"               // 重排序
  // ── 未来 ──
  | "speech_recognition"   // 语音识别
  | "image_generation"     // 文生图
  // ── P2 companion（03 合同 §9.5 参数） ──
  | "companion_agent"       // 日常对话与受控工具 loop
  // ── 笔记学习任务 ──
  | "note_learning_mind_map"
  | "note_learning_overview" // 独立后台任务：读取整篇笔记并生成带原文依据的速看
  | "note_annotation_explain" // 独立后台任务：解释选区并保存到原文锚点
  | "note_dynamic_artifact" // 独立后台任务：为笔记内容自由创作可交互的演示页面
  | "note_expansion_draft" // 笔记拓展方向和草稿由同一持久后台任务生成
  | "note_learning_card" // Plan 57：出题与主观题批改/总评
  | "note_learning_grading"; // Plan 57：主观题批改与整卷总评

/**
 * 模型槽位语义（2026-08-13 按"用户体验"分级，而非任务复杂度）：
 *
 * 分级原则：**任何用户直接可见、或影响用户学习结论的任务 → agent_turn
 * （专业模型）**；text_generation（小模型槽）仅保留给**用户不可见的内部
 * 低影响任务**（当前无此类任务，槽位留空待用）。
 *
 * - agent_turn（专业模型，平台由 config/ai-platforms.json 的
 *   capabilities.agent_turn 决定，当前 tokenrhythm + qwen3.8-flash）：
 *   卡片生成、文本抽取、卡组编排、证据批判、修复、**题目生成、
 *   验证/评估/评分（决定掌握度与复习调度）、日常对话、桌宠动作建议**——
 *   全部用户可见/影响结论，一律专业模型（体验优先）。
 * - text_generation（轻量槽，GLM-4-9B 小模型）：
 *   **仅限用户不可见的内部辅助任务**（如日志/元数据分类）；质量不足以
 *   面向用户，当前无任务分配至此。
 * - note_generation（笔记产物槽，2026-10-16 线上实测后拆出）：速看／脑图／
 *   原句讲解／拓展草稿。同样是用户可见、同样要专业模型，但它们要的是**结构化
 *   抽取**（要点＋逐字引文）而不是开放思考。共用 agent_turn 时只能继承对话模型的
 *   思考档：线上一次速看在 mimo-v2.6-flash/medium 上单发 completion 9,411 token、
 *   242 s。拆槽后档位由 `capabilities.note_generation.reasoningEffort` 声明，
 *   默认 `low`——保留一段思考，但不让速看等四分钟。
 * - vision / embedding / rerank：各自专用能力。
 */
const TASK_CAPABILITY_MAP: Record<AITaskType, Capability> = {
  card_generation:    "agent_turn",
  text_extraction:     "agent_turn",
  deck_composition:    "agent_turn",
  grounding_critic:    "agent_turn",
  repair:              "agent_turn",
  companion_agent:     "agent_turn",
  note_learning_overview: "note_generation",
  note_learning_mind_map: "note_generation",
  note_annotation_explain: "note_generation",
  // 互动演示是整页 HTML/SVG 的自主创作，有自己的完成判据与预算（round-artifact
  // 那条链按 none 档直发），不跟着这一槽降档。
  note_dynamic_artifact: "agent_turn",
  note_expansion_draft: "note_generation",
  note_learning_card: "note_generation",
  note_learning_grading: "note_generation",
  // 读图不是一条独立能力（2026-10-12「不再单独配识图模型」）：它走副模型的
  // 普通 chat completion（消息里带 image_url），谁的眼睛由模型档案 vision 决定。
  analyze_image:       "text_generation",
  embed:               "embedding",
  rerank:              "rerank",
  speech_recognition:  "speech_recognition",
  image_generation:    "image_generation",
};

/** 任务复杂度等级 — 用于路由决策 */
export type TaskComplexity = "high" | "medium" | "low";

const TASK_COMPLEXITY: Record<AITaskType, TaskComplexity> = {
  card_generation:    "high",
  text_extraction:     "high",
  deck_composition:    "medium",
  grounding_critic:    "medium",
  repair:              "medium",
  analyze_image:       "medium",
  embed:               "low",
  rerank:              "low",
  speech_recognition:  "low",
  image_generation:    "medium",
  companion_agent:     "low",
  note_learning_overview: "high",
  note_learning_mind_map: "high",
  note_annotation_explain: "medium",
  note_dynamic_artifact: "high",
  note_expansion_draft: "high",
  note_learning_card: "high",
  note_learning_grading: "high",
};

/** 任务 → 所需能力 */
export function getCapabilityForTask(task: AITaskType): Capability {
  return TASK_CAPABILITY_MAP[task];
}

/** 任务 → 复杂度 */
export function getTaskComplexity(task: AITaskType): TaskComplexity {
  return TASK_COMPLEXITY[task];
}

/**
 * Resolve the system-level provider type for a capability.
 *
 * Delegates to resolveSystemPlatform() which reads from config/ai-platforms.json.
 *
 * This function returns just the provider type string (e.g., "dashscope",
 * "openai_compatible"). For the full config (apiKey, baseUrl, model, options),
 * use resolveSystemPlatform() from platform-config.ts.
 *
 * This function can be called in both API and worker processes.
 */
export function resolveSystemProviderForCapability(cap: Capability): string {
  const platform = resolveSystemPlatform(cap);
  return platform?.type ?? "mock";
}
