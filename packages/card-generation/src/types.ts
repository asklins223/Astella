/**
 * 制卡领域服务的公共形状：调用方上下文与在制状态集合（都是唯一来源）。
 */

/**
 * 调用方上下文：一个工作空间 + 一个人。
 *
 * 整条制卡链的每一条读与写都带这两格（RLS 之外的应用层隔离）。它就是两格，
 * 没有别的——不要在这里"顺手"加 token、请求 id 之类，那会让领域服务长出对宿主的依赖。
 */
export type RunContext = { workspaceId: string; userId: string };

/**
 * 「在制」的状态集合（唯一常量）。
 *
 * 两处语义不同但**同一份答案**：创建事务里"同一 (笔记, 人) 只允许一批在制"的守卫，
 * 与恢复用的"active runs"列表查询。它们必须一致——一处把 `review_ready` 算在制、
 * 另一处不算，屏上就会出现"这一批在列表里、却又说没有在制批次"的自相矛盾。
 *
 * 值原样搬过来，一个都没改。
 */
export const ACTIVE_GENERATION_RUN_STATUSES = [
  "queued",
  "source_sealing",
  "planning",
  "authoring",
  "checking",
  "review_ready",
  "needs_attention",
  "activating",
] as const;