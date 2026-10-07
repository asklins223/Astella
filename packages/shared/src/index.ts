export * from "./enums.ts";
export * from "./schemas.ts";
export * from "./domain-error.ts";
export * from "./scheduling-policy-v2.ts";
// 2026-08-13：content-hash 为服务端专用（node: 依赖），改从子路径 import，
// 不再经 index 全量导出（客户端 bundle 加载会触发 node: 缺失崩溃）。
export * from "./job-queue-limits.ts";
export * from "./provider-prompt-cache.ts";
export * from "./safe-error.ts";
export * from "./contracts/card-agent-contracts.ts";
export * from "./provider-capabilities.ts";
export * from "./provider-registry.ts";
// 2026-08-13（web 客户端打包修复）：task-router 依赖 platform-config-node
// （node:fs）——服务端专用，改从 @astella/shared/task-router 子路径 import，
// 不再经 index 全量导出（客户端加载会触发 node:fs 缺失崩溃）。
export * from "./platform-config.ts";
export * from "./contracts/companion-shell-contracts.ts";
export * from "./auth-surface-manifest.ts";
// 2026-08-13：LearningRun V1 统一合同（文档 16 §12 冻结）——四对象 wire
// contract 唯一来源。
export * from "./contracts/learning-run-contracts.ts";
// 2026-08-13：Main ↔ Pet Bridge V2 合同（文档 16 §14 冻结）。
export * from "./contracts/companion-bridge-contracts.ts";
// 2026-08-13：Journey V2 合同（文档 16 §10.1 冻结）。
export * from "./contracts/companion-journey-contracts.ts";
// 2026-08-14：方案 20（learning-card-v2）Generation 域合同——纯 zod schema
// + 类型（无 node: 依赖，客户端安全）。hash 计算函数走
// @astella/shared/card-generation-v2-hashing 子路径（服务端专用）。
export * from "./contracts/card-generation-v2-contracts.ts";
// 2026-08-14：方案 20 LearningCard V2 公共合同（Public Card/Reveal/Publication）。
export * from "./contracts/learning-card-v2-contracts.ts";
// 2026-08-14：方案 20 LearningTargetSnapshotV2 合同（§16 Target Rebase）。
export * from "./contracts/learning-target-v2-contracts.ts";
// Golden Slice Member V2 outer wire: public snapshot/result/return adapters.
export * from "./contracts/learning-run-v2-contracts.ts";
export * from "./contracts/review-queue-v2-contracts.ts";
export * from "./contracts/formal-assessment-guard-contracts.ts";
export * from "./contracts/room-projection-contracts.ts";
export * from "./companion-proactive-policy.ts";
export * from "./companion-proactive-quota.ts";
export * from "./contracts/companion-home-contracts.ts";
// 伴星中心（桌面页 20）读取合同：记忆 / 记忆星图 / 日记 / 人格档案 / 对话记录。
export * from "./contracts/companion-memory-desktop-contracts.ts";
// Companion M2 语音朗读合同（companion.voice.speak → POST /voice/tts）。
export * from "./contracts/companion-voice-contracts.ts";
export * from "./contracts/note-projection-contracts.ts";
export * from "./contracts/note-save-contracts.ts";
// 2026：首页统计的跨空间合同（每空间一行 + 合计）。`GET /stats/overview` 的
// 每空间形状与 `GET /stats/overview/all` 的包装形状都只在这里定义一次。
export * from "./contracts/stats-overview-contracts.ts";
export * from "./contracts/card-generation-desktop-contracts.ts";
export * from "./contracts/quality-evidence-contracts.ts";
export * from "./capability-bundle.ts";
// Electron desktop boundary contracts are also available through the explicit
// subpath; exporting the same browser-safe module here keeps type-only tooling
// convenient without importing any server-only dependency.
export * from "./contracts/desktop-ipc-contracts.ts";
export * from "./contracts/companion-character-contracts.ts";
export * from "./contracts/companion-conversation-contracts.ts";
export * from "./contracts/companion-agent-contracts.ts";
export * from "./contracts/companion-run-diagnostics.ts";
export * from "./companion-agent-registry.ts";
export * from "./companion-persona.ts";
export * from "./pet-persona-presets.ts";
// 2026-10-02：40b §1.4 第 1 条「登记每条要求」的可检验清单。纯数据 + 惰性
// node: 导入（无顶层 node: 依赖），所以 index 仍是浏览器安全入口。
export * from "./companion-model-requirements.ts";
export * from "./contracts/card-quality-v2-contracts.ts";
export * from "./voice-expression-tags.ts";
export * from "./tts-voice-catalog.ts";
export * from "./contracts/learning-objective-surface-contracts.ts";
export * from "./contracts/note-deepening-contracts.ts";
export * from "./contracts/desktop-surface-contracts.ts";
// 设计 P1-8（2026-09-15 审计）：伴星记忆类 job 的 payload 字段契约唯一来源
// （写入侧 API 与 4 个 worker handler 共用；纯类型/常量，无 node: 依赖）。
export * from "./companion-memory-job-payload.ts";
export * from "./companion-memory-temporal.ts";
// 稳定 P1（2026-09-15 审计）：作业 payload 契约按作业类型分型。非 companion
// （parse_source）用精确类型 + fail-closed 读取器；companion_* 仍由各自契约模块
// 负责。纯类型/常量/纯函数，无 node: 依赖。
export * from "./contracts/job-payload-contracts.ts";

export type * from "./content-hash.ts";
