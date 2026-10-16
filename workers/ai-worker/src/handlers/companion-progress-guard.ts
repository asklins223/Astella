/**
 * 「她没有在推进」这件事怎么判、判到之后怎么收口（2026-10-16）。
 *
 * ## 为什么需要它
 *
 * 伴星 agent 里**没有任何预算上限**：步数、每步工具数、总工具数、模型调用数默认全是
 * `null`（`COMPANION_AGENT_*`），运行时也不会因为"走到第几步"抽走工具或砍掉内容。
 * 那只剩三条收口：任务自己走完、墙钟切片到期（重新排队接着做）、或者**真的出了错**。
 * 这个模块就是第三条的判据。
 *
 * ## 判据必须是事实，不能是计数
 *
 * 同一个「工具名 + 规范化参数」在本轮**已经拿到过成功回执**，又被原样要了一次，
 * 就是原地重放：参数是纯输入，中间没有落库的写回执时结果必然相同。正常推进的 agent
 * 每一步都会换调用（先读后写、换目标、取下一页、改参数重来），所以这条判据只对
 * **卡死的循环**成立——它不数总步数、不数总工具数、不砍内容，也不是"走到第几个就停"。
 *
 * 这与既有的两条同族判据（`invalidArgumentCalls` 与 `rejectedExecutionConstraints`：
 * 同样参数被拒后再次提交即按 `AgentOutputError` 收口）是同一个形状，只是它们管的是
 * "输入非法还不改"，这里管的是"调用成功还重复"。
 *
 * ## 为什么放行一次重放
 *
 * 只读调用不做指纹折叠（见 `ensureAgentToolCall`：只读允许在同一轮再次读取最新状态），
 * 因为写回执之后确实可能需要重新取一次。所以第一次重放照旧执行；同一个指纹**第二次**
 * 仍然原样重放时，就不再给她第三次同样的轮次，按 `no_progress` 失败收口。
 */

/** 同一个调用指纹允许的原地重放次数。判据是"完全相同的调用"，不是调用总数。 */
export const COMPANION_IDENTICAL_CALL_REPLAYS_ALLOWED = 1;

/** 一次调用的身份：工具名 + 规范化参数哈希。 */
export function companionCallFingerprint(name: string, argumentsHash: string): string {
  return `${name}:${argumentsHash}`;
}

/**
 * 记一次「这个指纹的成功回执已经交到模型手里」。
 *
 * 返回 true 表示重放额度用尽，调用方应当按 `no_progress` 收口；否则放行这一次。
 * 计数按 run 累计（调用方持有 map），跨 job 的续跑是新的循环，重新开始计。
 */
export function companionReplayExhausted(
  successfulReceipts: Map<string, number>,
  fingerprint: string,
): boolean {
  const seen = (successfulReceipts.get(fingerprint) ?? 0) + 1;
  successfulReceipts.set(fingerprint, seen);
  return seen > COMPANION_IDENTICAL_CALL_REPLAYS_ALLOWED + 1;
}
