export * from "./platform/enums.ts";
export * from "./platform/schemas.ts";
export * from "./platform/domain-error.ts";
// 2026-08-13：content-hash 为服务端专用（node: 依赖），改从子路径 import，
// 不再经 index 全量导出（客户端 bundle 加载会触发 node: 缺失崩溃）。
export * from "./platform/job-queue-limits.ts";
export * from "./platform/provider-prompt-cache.ts";
export * from "./platform/safe-error.ts";
export * from "./contracts/agent/card-agent-contracts.ts";
export * from "./platform/provider-capabilities.ts";
export * from "./platform/provider-registry.ts";
// 2026-08-13（web 客户端打包修复）：task-router 依赖 platform-config-node
// （node:fs）——服务端专用，改从 @astella/shared/task-router 子路径 import，
// 不再经 index 全量导出（客户端加载会触发 node:fs 缺失崩溃）。
export * from "./platform/platform-config.ts";
export * from "./contracts/companion/companion-shell-contracts.ts";
export * from "./platform/auth-surface-manifest.ts";
// 2026-08-13：LearningRun V1 统一合同（文档 16 §12 冻结）——四对象 wire
// contract 唯一来源。
// 2026-08-13：Main ↔ Pet Bridge V2 合同（文档 16 §14 冻结）。
export * from "./contracts/companion/companion-bridge-contracts.ts";
// 2026-08-13：Journey V2 合同（文档 16 §10.1 冻结）。
export * from "./contracts/companion/companion-journey-contracts.ts";
// 2026-08-14：方案 20（learning-card-v2）Generation 域合同——纯 zod schema
// + 类型（无 node: 依赖，客户端安全）。hash 计算函数走
// 2026-08-14：方案 20 LearningCard V2 公共合同（Public Card/Reveal/Publication）。
// Plan 57：笔记内学习卡（一笔记一张卡、多题、固定题型、星级与依据）。
export * from "./contracts/learning/note-learning-card-contracts.ts";
export * from "./learning/note-learning-card-grading.ts";
export * from "./learning/note-learning-card-quality.ts";
export * from "./learning/note-learning-card-operation.ts";
// 2026-08-14：方案 20 LearningTargetSnapshotV2 合同（§16 Target Rebase）。
// Golden Slice Member V2 outer wire: public snapshot/result/return adapters.
export * from "./contracts/agent/formal-assessment-guard-contracts.ts";
export * from "./contracts/desktop/room-projection-contracts.ts";
export * from "./companion/companion-proactive-policy.ts";
export * from "./companion/companion-proactive-quota.ts";
export * from "./contracts/companion/companion-home-contracts.ts";
// 伴星中心（桌面页 20）读取合同：记忆 / 记忆星图 / 日记 / 人格档案 / 对话记录。
export * from "./contracts/companion/companion-memory-desktop-contracts.ts";
export * from "./contracts/companion/companion-observation-contracts.ts";
export * from "./companion/companion-observation-render.ts";
// Companion M2 语音朗读合同（companion.voice.speak → POST /voice/tts）。
export * from "./contracts/companion/companion-voice-contracts.ts";
export * from "./contracts/note/note-projection-contracts.ts";
export * from "./contracts/note/note-save-contracts.ts";
export * from "./contracts/agent/quality-evidence-contracts.ts";
export * from "./agent/capability-bundle.ts";
// Electron desktop boundary contracts are also available through the explicit
// subpath; exporting the same browser-safe module here keeps type-only tooling
// convenient without importing any server-only dependency.
export * from "./contracts/desktop/desktop-ipc-contracts.ts";
export * from "./contracts/companion/companion-character-contracts.ts";
export * from "./contracts/companion/companion-conversation-contracts.ts";
export * from "./contracts/companion/companion-file-contracts.ts";
export * from "./contracts/companion/companion-agent-contracts.ts";
export * from "./contracts/companion/companion-run-diagnostics.ts";
export * from "./agent/companion-agent-registry.ts";
export * from "./companion/companion-host-context.ts";
export * from "./agent/companion-tool-groups.ts";
export * from "./agent/companion-domain-tools.ts";
export * from "./companion/companion-persona.ts";
export * from "./companion/pet-persona-presets.ts";
// 2026-10-02：40b §1.4 第 1 条「登记每条要求」的可检验清单。纯数据 + 惰性
// node: 导入（无顶层 node: 依赖），所以 index 仍是浏览器安全入口。
export * from "./agent/companion-model-requirements.ts";
export * from "./companion/voice-expression-tags.ts";
export * from "./companion/tts-voice-catalog.ts";
export * from "./contracts/note/note-deepening-contracts.ts";
export * from "./contracts/desktop/desktop-surface-contracts.ts";
// 设计 P1-8（2026-09-15 审计）：伴星记忆类 job 的 payload 字段契约唯一来源
// （写入侧 API 与 4 个 worker handler 共用；纯类型/常量，无 node: 依赖）。
export * from "./companion/companion-memory-content.ts";
export * from "./companion/companion-memory-job-payload.ts";
export * from "./companion/companion-memory-temporal.ts";
// 稳定 P1（2026-09-15 审计）：作业 payload 契约按作业类型分型。非 companion
// （parse_source）用精确类型 + fail-closed 读取器；companion_* 仍由各自契约模块
// 负责。纯类型/常量/纯函数，无 node: 依赖。
export * from "./contracts/agent/job-payload-contracts.ts";

export type * from "./content/content-hash.ts";

export * from "./contracts/desktop/object-transfer-contracts.ts";
export { DEFAULT_AI_PROVIDER_TIMEOUT_MS, DEFAULT_AI_TASK_TIMEOUT_MS, AI_UNDECLARED_OUTPUT_TOKENS } from "./agent/ai-execution-budgets.ts";

export * from "./companion/companion-autonomy.ts";

export * from "./contracts/companion/companion-initiative-contracts.ts";
export * from "./companion/companion-default-participation.ts";
