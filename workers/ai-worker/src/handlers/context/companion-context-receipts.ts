import { summarizeContextAssemblyReceipt, type AgentContextReceipt } from "@astella/agent-core";
import type { ContextAssemblyReceiptV1 } from "@astella/agent-core";
import type { ContextPressureReceiptV1 } from "@astella/shared/context-budget-contracts";
import { toContextPressureReceipt, type ContextBudgetGateOptions } from "../../lib/context-governor.ts";

/**
 * 方案 44 §3.3：这一轮**实际**装进了什么、没装进什么，以及完整请求的预算读数。
 *
 * 这块单独成模块，是因为它回答的问题与它挂载的两个编排文件无关：
 * `companion-dialogue` 负责「这一轮怎么读进来」，`companion-agent-runtime` 负责
 * 「这些步怎么走」。回执横跨两者——装配发生在前者，判定发生在后者的每一次真实调用，
 * 落库又发生在后者的进度更新里。留在任一编排文件里都会让它多背一份职责，也只会
 * 把两个编排文件推向各自的行数红线。
 *
 * 它只记条目 id、状态、字符数与水位，**不记任何请求内容**。
 */

// Assembly verifies scope and preserves complete sources. The governed provider
// measures the full request against the selected model's token window; a second
// guessed character ceiling would silently omit data before that measurement.
export function companionContextAssemblyCapacity(sources: readonly (string | { characters: number })[]): number {
  return sources.reduce((sum, source) => sum + (typeof source === "string" ? source.length : source.characters), 0) + Math.max(0, sources.length - 1) * 2;
}

export interface CompanionContextReceiptRunMeta {
  contextAssemblyReceipt?: ContextAssemblyReceiptV1;
  contextPressure?: ContextPressureReceiptV1;
  /** Memory omitted during its earlier shared-budget selection, before prompt assembly. */
  companionMemoryOmissions?: CompanionMemoryOmissionReceipt;
}

export interface CompanionMemoryOmissionReceipt {
  residentCount: number;
  directoryCount: number;
  residentCharacters: number;
  directoryCharacters: number;
  capacityEstimate: number;
}

export interface CompanionContextReceipts {
  /**
   * 供 `createGovernedProvider` 注册的压力闸选项。
   *
   * 一个 run 会发多次请求（首步、每个工具回合、可能的跨模型兜底），这里保留**最后
   * 一次**的读数：它反映这条消息最终是按什么预算发出去的。真正超限的请求会抛
   * `AIContextOverflowError` 而根本发不出去——那种情况在 job 的错误里留痕。
   *
   * `compactionAvailable` 读的是**本次请求**的压缩额度（44 §5.4：至多一次）：
   * 折过一次之后闸就选择「带着有效上下文继续」并留 `over_trigger_line`，
   * 而不是把同一个请求再压一遍。
   */
  readonly pressureGate: ContextBudgetGateOptions;
  /** New growing requests can compact again; a retry of one request cannot spin. */
  beginRequest(key: string): void;
  /** Cooldown belongs to this exact input, not all later work in the run. */
  currentRequestHash(): string | null;
  /** 本次请求还有没有一次有界压缩的额度。 */
  hasCompactionAttempt(): boolean;
  /** 消耗掉那次额度；在重发之前调用。 */
  consumeCompactionAttempt(): void;
  /** 最近一次压力判定的读数（模型路由、输入量、判定结果）。 */
  latestPressure(): ContextPressureReceiptV1 | null;
  /** 记录本轮装配的逐条准入回执（included / empty / budget_omitted）。 */
  recordAssembly(receipts: readonly AgentContextReceipt[]): void;
  /** 记录记忆专属小预算阶段的整条取舍；正文不进入回执。 */
  recordMemoryOmissions(receipt: CompanionMemoryOmissionReceipt): void;
  /** 本轮纳入的条目 id；调用方用它决定哪些记忆算「这一轮真的用上了」。 */
  admittedSources(): ReadonlySet<string>;
  /**
   * 落到 run meta 的那一份。
   *
   * 装配回执必须跟着预算一起落库：`budget_omitted` 只进日志的话，「窗口放大后触发
   * 变少」与「预算从来没接上」在数据上完全分不开（44 §2 核对到的既有缺陷）。
   */
  runMetaPatch(): CompanionContextReceiptRunMeta;
}

export function createCompanionContextReceipts(): CompanionContextReceipts {
  const admitted = new Set<string>();
  let assembly: readonly AgentContextReceipt[] | undefined;
  let memoryOmissions: CompanionMemoryOmissionReceipt | undefined;
  let pressure: ContextPressureReceiptV1 | null = null;
  let compactionAttemptAvailable = true;
  let requestKey: string | null = null;
  return {
    // 「还没折过」= 还有一次额度。耗尽后闸不再要求压缩，而是按有效上下文继续。
    hasCompactionAttempt: () => compactionAttemptAvailable,
    currentRequestHash: () => requestKey,
    beginRequest(key) {
      if (key !== requestKey) { requestKey = key; compactionAttemptAvailable = true; }
    },
    consumeCompactionAttempt: () => { compactionAttemptAvailable = false; },
    latestPressure: () => pressure,
    pressureGate: {
      compactionAvailable: () => compactionAttemptAvailable,
      onDecision: (receipt) => {
        // Classification runs concurrently with speculative generation. Its
        // small JSON budget must not replace the answer request's pressure.
        if (receipt.operation === "companion_agent:chat_completion") return;
        pressure = toContextPressureReceipt(receipt);
      },
    },
    recordAssembly(receipts) {
      assembly = receipts;
      admitted.clear();
      for (const receipt of receipts) if (receipt.status === "included") admitted.add(receipt.id);
    },
    recordMemoryOmissions(receipt) {
      memoryOmissions = receipt.residentCount + receipt.directoryCount > 0 ? receipt : undefined;
    },
    admittedSources: () => admitted,
    runMetaPatch() {
      const contextAssemblyReceipt = summarizeContextAssemblyReceipt({
        receipts: assembly,
        maxCharacters: companionContextAssemblyCapacity(assembly ?? []),
      });
      return {
        ...(contextAssemblyReceipt ? { contextAssemblyReceipt } : {}),
        ...(pressure ? { contextPressure: pressure } : {}),
        ...(memoryOmissions ? { companionMemoryOmissions: memoryOmissions } : {}),
      };
    },
  };
}
