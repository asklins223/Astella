/**
 * 「这一发错误能不能重试」的一份分类——内核搬家（39d W7-7 刀二）的第一块砖。
 *
 * 为什么先搬它：队列、租约、阶段代码都纠缠在那份 4400 行的 handler 里，一次搬完要在
 * 中间动刀；这三样是纯函数＋一个轻量错误类，没有 DB 依赖，搬完两边都还是原语义。
 * 事故记录跟着走：mock/未配置 provider 抛的那类 `Error` 只带 `retryable=false`、
 * 没有 `kind`，此前只读 `kind` 曾把配置错误当成可重试，退避 6 次（实测 7m45s 墙钟）
 * 零次 LLM 调用，用户只看到长时间"生成中"——两种形状都必须被尊重。
 */

import { CardGenerationPipelineErrorV2 } from "@ailearn/shared/card-generation-v2-pipeline";

/**
 * 判别错误是否不可重试（provider 5xx/429/408/超时 → retryable；
 * schema/协议/配置 → non-retryable）。
 *
 * 2026-09-17（实机事故修复）：除类实例的 `kind` 字段外，**同时**识别裸 Error 上
 * 的 `retryable` 布尔。事故形态是 `providers.ts` 的 mock/未配置 provider
 * fail-closed 抛出的 `Error`，只设置了 `retryable = false`、没有 `kind`——
 * 本函数此前只读 `kind`，于是这个显式标记为"不可重试"的配置错误被当成可重试：
 * outbox 退避重试 6 次（15/30/60/120/240s，实测 7m45s 墙钟）、期间零 LLM 调用，
 * 用户只看到长时间"生成中"然后 needs_attention。两种形状都必须被尊重，
 * 否则"显式标注不可重试"这件事在读取侧形同虚设。
 *
 * 已导出供单测直接覆盖（此前是模块私有函数，分类错误无法被测试捕获）。
 */
export function isNonRetryableErrorLike(error: unknown): boolean {
  // 本地可分类错误（CardGenerationProviderErrorLike 携带 `retryable` 布尔）。
  if (error instanceof CardGenerationProviderErrorLike) return !error.retryable;
  // providers.ts（独立模块，避免循环依赖）抛出的 CardGenerationProviderError：
  // 类实例走 `kind`；历史/裸 Error 形态走 `retryable`。两者都给出明确结论时
  // 以 `kind` 为准（它是 canonical 形状）。
  if (typeof error === "object" && error !== null) {
    const e = error as { name?: string; kind?: string; retryable?: unknown };
    if (e.name === "CardGenerationProviderError") {
      if (e.kind === "non-retryable") return true;
      if (e.kind === "retryable") return false;
      if (e.retryable === false) return true;
      if (e.retryable === true) return false;
    }
  }
  // 2026-08-25（AI 设计审计修复）：shared 纯逻辑抛的领域错误（seal/binding
  // plan 的确定性校验失败，全部为 4xx）是确定性结论，重试只会原样复现——且
  // 每次重试都重放 planner+author 的 LLM 调用（token 双花）。worker 与
  // packages/shared 之间只有单一物理副本，instanceof 判定可靠；api 子类
  // （CardGenerationV2ServiceError）继承本基类，同样被覆盖。
  if (error instanceof CardGenerationPipelineErrorV2) return true;
  return false;
}

export function isRetryableProviderError(error: unknown): boolean {
  // ── round-8 🟡4 标注（保持现状 + 说明）────────────────────────────────────
  // 事务内 DB 抛的确定性"数据违约"错误（唯一约束违反 / RLS 拒绝 / 类型 cast 失败）
  // 也是普通 Error → 这里被判 retryable → 会重跑整条（可能 LP-heavy）管道最多 3 次
  // 才失败。因事务每次回滚，**安全但浪费**（LLM 模式下 token 双花，同 🟡3 机制）。
  // 未在此加代码级分类的理由：DB 错误码因 driver 而异，粗略按"查询错误 vs 连接瞬态"
  // 匹配易误判——把瞬态连接错误（connection reset/timeout/池耗尽）误判为 non-retryable
  // 会破坏既有的超时/5xx 重试语义，回归风险高于收益。激活前若要做，应让 worker 的 DB
  // 驱动对违反类错误（23xxx / 42xxx）抛出结构化（可判 non-retryable）错误，再据其校验
  // （pg error code 前缀）白名单分类；当前不做，仅在审计留档。
  // ──────────────────────────────────────────────────────────────────────
  return !isNonRetryableErrorLike(error);
}

/** 轻量可分类错误类型（避免依赖 providers 导致 worker 重边）。 */
export class CardGenerationProviderErrorLike extends Error {
  readonly retryable: boolean;
  constructor(retryable: boolean, message: string) {
    super(message);
    this.name = "CardGenerationProviderError";
    this.retryable = retryable;
  }
}
