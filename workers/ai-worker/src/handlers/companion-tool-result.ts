/**
 * 工具执行面共用的**结果类型与两级报错**（2026-10-01 从 `companion-tool-execution.ts` 搬出）。
 *
 * ## 为什么要单独一个文件
 *
 * 记忆工具族（`companion-memory-tools.ts`）也要用这两样东西，而它**同时**被
 * `companion-tool-execution.ts` 引用。真按运行时代码去画依赖，是
 *
 * ```
 * companion-tool-execution.ts  ──导入──▶  companion-memory-tools.ts
 *         ▲                                          │
 *         └────────────── 导入 ─────────────────────┘
 * ```
 *
 * 一个环。环在 ESM 里**常常**能跑（类绑定只在函数体里用到，调用时早已解析），
 * 但「常常能跑」正是 AGENTS.md 记的那类事故：`companion-agent-runtime.ts`
 * 那次同时搬两个模块就成过环，只好回退。
 *
 * 所以**先搬状态，再搬方法**：这两个声明本身不依赖任何东西，是天然的叶子模块。
 * 它们落到这里之后，两边各自向**下**依赖它，依赖方向恢复成树。
 *
 * 注意 `CompanionToolError` 是**运行期值**（不是只有类型）——
 * `companion-tool-outcome.ts` 的 `classifyCompanionToolFailure` 与
 * `companion-agent-runtime.test.ts` 那条
 * 「runtime 与 executor 拿到的是同一个类」的断言都依赖这一点，
 * 所以两边必须从**这里**取，不能各自复制一份。
 */

import type { CompanionContentBlockV1 } from "@astella/shared";

/** 工具报错分两级：能被用户看见的，与必须停在工具面的。 */
export class CompanionToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionToolError";
  }
}

export class CompanionToolBlockedError extends CompanionToolError {
  constructor(message: string) {
    super(message);
    this.name = "CompanionToolBlockedError";
  }
}

/**
 * 「这件事**可能已经发生**，但这一轮拿不到确定回执」。
 *
 * ## 它为什么**故意不继承** `CompanionToolError`
 *
 * `classifyCompanionToolFailure` 的判定顺序是：blocked → unavailable →
 * not_executed → failed → unknown（见 `companion-tool-outcome.ts`）。
 * 继承 `CompanionToolError` 就等于掉进 `failed` 那一档，
 * 那会把「可能已经改了东西」说成「确定没发生」——用户据此继续操作，
 * 可能把一次已经落库的写入再做一遍。
 *
 * 不继承就走最后一档 `outcome_unknown`（读类工具除外，那条本来就无副作用）。
 * 这也是 40b §3.2 把它单列成一类状态的原因。
 */
export class CompanionToolOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionToolOutcomeUnknownError";
  }
}

/**
 * 「这一步**从未开始**」（40b §3.2 `not_executed`：参数无效、屏障、取消、预算耗尽）。
 *
 * ## 为什么它**继承** `CompanionToolError`
 *
 * 与上面那个正好相反。`outcome_unknown` 危险的地方是**它必须自己独占最后一档**：
 * 继承 `CompanionToolError` 就会掉进 `failed`，把"可能已经改了东西"说成"确定没发生"。
 * 而 `not_executed` 的每一句 message 都是**确定没有副作用**的（它压根没进执行体），
 * 所以它就是一条普通的、用户看得见的工具失败，只是状态词要说准。
 *
 * 继承 `CompanionToolError` 的实际好处在别处：任何 `catch` 里的
 * `instanceof CompanionToolError`（记忆工具族、集成测试）都仍然认得它，
 * 而**不必**在每个 catch 上再加一条 `|| error instanceof CompanionToolNotExecutedError`——
 * 那正是漏掉之后变成一句通用话术的原因。
 */
export class CompanionToolNotExecutedError extends CompanionToolError {
  constructor(message: string) {
    super(message);
    this.name = "CompanionToolNotExecutedError";
  }
}

/**
 * 「所需资源或能力不可用」（40b §3.2 `unavailable`）。
 *
 * ## 它和 `blocked` 的分界
 *
 * `blocked` 说的是**这一条动作不获准**（权限档、预算上限、工具未注册）；
 * `unavailable` 说的是**能力本身这一轮没有**——读图工具要用户先允许图片外发，
 * 没开就没有它。于是两者的下一步不同：`blocked` 的替代是"换个做法做同一件事"，
 * `unavailable` 的替代必须**指出实际影响与可用替代**（正文仍可读、开关在哪），
 * 否则她只会说"我做不到"，用户既不知道少了什么，也不知道怎么拿回来。
 */
export class CompanionToolUnavailableError extends CompanionToolError {
  constructor(message: string) {
    super(message);
    this.name = "CompanionToolUnavailableError";
  }
}

export interface AgentToolExecutionResult {
  value: Record<string, unknown>;
  safeSummary: string;
  resultRef?: string;
  route?: Record<string, unknown>;
  /** 跳转块上给人看的那句（"打开《消防疏散》"）。缺省回落到工具描述。 */
  routeLabel?: string;
  /** 工具顺手带出的其它富块（读出来的原文 = quote）。与 route 生成的 nav 一起落进消息。 */
  blocks?: CompanionContentBlockV1[];
}