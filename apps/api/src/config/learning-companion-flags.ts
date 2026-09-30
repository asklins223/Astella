/** Server-only rollout gates for the current Companion product paths. */

/** LearningRun creation, player, submission, assessment, and commit gate. */
export function isLearningRunEnabled(): boolean {
  return process.env.LEARNING_RUN_ENABLED === "true";
}

/** Keep canonical mastery/schedule writes separately gated from the UI path. */
/**
 * Card Generation V2 capability（方案 20）：
 * 价值优先生成、候选治理与 LearningTarget 重基。
 * 默认关闭（fail closed）；内部验证环境显式 CARD_GENERATION_V2_ENABLED=true。
 */
export function isCardGenerationV2Enabled(): boolean {
  return process.env.CARD_GENERATION_V2_ENABLED === "true";
}

/**
 * 伴星对话链路（COMPANION_DIALOGUE_V1_ENABLED）。同一个开关决定
 * `/companion/*` 对话路由是否 404 fail closed，所以能力投影必须读它，
 * 否则设置页永远显示「已关闭」，与真实部署状态相反。
 */
export function isCompanionDialogueEnabled(): boolean {
  return process.env.COMPANION_DIALOGUE_V1_ENABLED === "true";
}

/** 伴星语音对话（COMPANION_VOICE_DIALOGUE_V1_ENABLED）。 */
export function isCompanionVoiceDialogueEnabled(): boolean {
  return process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED === "true";
}

/**
 * 伴星旅程 V2（COMPANION_JOURNEY_V2）。
 *
 * P1-8：**此前这个函数被逐字复制了 4 份**
 * （companion-conversation 的 timeline / inbox / delivery 三条路由，
 * 以及 companion-journey/routes.ts），外加 2 处 OR 集合。
 * 一处开关散在 6 个地方意味着：改判据（比如加 `1` 兼容、或者改成读配置中心）
 * 要改 6 处，而漏掉哪一处只会表现为「某个子端点 404 了」——不是一个会报错的差异。
 *
 * 判据保持 `=== "true"`：**fail closed**。未设置即为关闭，与 P0-5 限流那次的
 * 结论一致（默认值要落在安全的那一侧）。
 */
export function isCompanionJourneyV2Enabled(): boolean {
  return process.env.COMPANION_JOURNEY_V2 === "true";
}

/**
 * 记忆上下文（COMPANION_MEMORY_VECTOR_V1，**或**旅程 V2 总开关）。
 *
 * 记忆能力是旅程的一部分，所以旅程开着时它也开着；单独开 `MEMORY_VECTOR_V1`
 * 则用于只验记忆链路、不开整条旅程的阶段。
 */
export function isMemoryContextEnabled(): boolean {
  return process.env.COMPANION_MEMORY_VECTOR_V1 === "true"
    || isCompanionJourneyV2Enabled();
}

/** 宠物档案（COMPANION_PET_PROFILE_V1，**或**旅程 V2 总开关）。理由同记忆上下文。 */
export function isPetProfileEnabled(): boolean {
  return process.env.COMPANION_PET_PROFILE_V1 === "true"
    || isCompanionJourneyV2Enabled();
}

/**
 * 向量记忆**重建**（COMPANION_MEMORY_VECTOR_V1 单开关，**不含**旅程总开关）。
 *
 * 为什么它不能并进 `isMemoryContextEnabled`：
 * 那个是「记忆上下文能不能用」的能力门控（`MEMORY_VECTOR_V1 || JOURNEY_V2`），
 * 这个是「embedding 重建这个具体作业开没开」。两者形似而语义不同——
 * 只开 JOURNEY_V2 时，记忆端点应该可用（所以门控放行），
 * 但**不应该**去触发 embedding 重建作业（那是另一个能力）。
 *
 * 收口前这三处是裸的 `process.env.COMPANION_MEMORY_VECTOR_V1` 直读
 * （`memory-routes.ts` 的确认后重建、批量重建、以及 rebuild-embeddings 端点的 404 门控）。
 * 审计统计的「3 套 OR 集合」没算到它们，因为它们不是 OR 集合——是第四类形状：
 * **单开关裸读**。一起收进来才不会留下「改判据时漏改」的口子。
 */
export function isMemoryVectorRebuildEnabled(): boolean {
  return process.env.COMPANION_MEMORY_VECTOR_V1 === "true";
}
