import type { AgentMethodEvidenceV1 } from "@astella/shared/agent-growth-contracts";

/**
 * 方案 44 §6.4：识别共同原始来源，**同源只算一条依据**。
 *
 * ## 要挡的那件事
 *
 * 一次真实事件会派生出一串东西：运行 → 抽取出的记忆 → 摘要 → 日记 → 方法候选。
 * 如果它们全都作为「依据」被列进同一条方法，看上去就有四五条独立支持，实际上只有一个
 * 原始来源。把模型重述或后台反思再包装一次，就能凭空造出「多方印证」的假象。
 *
 * ## 为什么必须去重存储而不是只去重显示
 *
 * 存储里的 `evidence` 数组**就是**支持集：投影、`astella_agent_method_sources_current`
 * 的有效性核对、界面上的「依据」列表全都读它。只在显示层合并，等于让所有下游继续
 * 按被放大的条数说话。所以去重发生在**写入口**。
 *
 * ## 判定
 *
 * 每个引用归到一个**来源键**：
 *   - `memoryId` → 它派生自哪次运行（由调用方查 `source_run_id` 后给出），查不到就是它自己；
 *   - `runId` → 那次运行；
 *   - `eventId` → 那个事件。
 *
 * 同一个来源键只保留**最具体的一条**：运行 > 记忆 > 事件。保留运行是因为它能被
 * `sources_current` 完整核对（含它引用的材料版本），而记忆只是它的一次投影。
 */

export interface AgentMethodEvidenceOriginInput {
  ref: AgentMethodEvidenceV1;
  /**
   * 这条记忆派生自哪次运行（`assistant_memory_items.source_run_id`）。
   *
   * 由调用方查好传进来：core 不碰数据库。返回 null 表示这条记忆不是从某次运行派生的
   * （用户自述、手工整理），那它自己就是一个独立来源。
   */
  /**
   * 这条记忆的**来源键**——由存取层按真实列算好、**已经定型**（例如 `run:<runId>`）。
   *
   * 两处刻意的设计：
   *   - 它是**字符串**而不是 `{runId, runRevision}`，因为库里其实**没有**
   *     「记忆派生自哪次运行」这样的列——第一版按那个形状去查 `source_run_id`，
   *     而那一列不存在，整条写入路径因此一次都没跑成功过。列的知识留在存取层，
   *     这里只接收结论。
   *   - 它**不含 revision**：同一次运行的两个版本仍是同一个原始来源，
   *     而 §6.4 要的正是「识别共同原始来源」。
   */
  memoryOrigin?: { originKey: string } | null;
}

export interface AgentMethodEvidenceGrouping {
  /** 去重后的依据：同一来源键只留最具体的一条。 */
  refs: AgentMethodEvidenceV1[];
  /** 独立来源数。它才是「有几条依据」，而不是 `refs` 被放大后的长度。 */
  independentCount: number;
  /** 被合并掉的条数（原长度 − 独立来源数）。 */
  mergedCount: number;
  /** 每个来源键下原本有几条——用于回执与排障，不参与判定。 */
  origins: Array<{ originKey: string; refCount: number; kept: AgentMethodEvidenceV1 }>;
}

function originKeyOf(input: AgentMethodEvidenceOriginInput): string {
  const { ref, memoryOrigin } = input;
  if (ref.runId) return `run:${ref.runId}`;
  if (ref.memoryId) {
    // 有来源键就按来源归并：同一趟摘要派生出的多条记忆会落到同一个键上，
    // 而它与那条运行引用也落到同一个键——「一次运行派生出的东西不算多方印证」
    // 要识别的正是这个形状。
    return memoryOrigin
      ? memoryOrigin.originKey
      : `memory:${ref.memoryId}:${ref.memoryRevision ?? 0}`;
  }
  if (ref.eventId) return `event:${ref.eventId}`;
  // 契约要求三者至少有一个；走到这里说明数据不合法，各自独立以免把坏数据合并掉。
  return `unknown:${JSON.stringify(ref)}`;
}

/** 具体程度：运行 > 记忆 > 事件。同源时留最具体的那条。 */
function specificity(ref: AgentMethodEvidenceV1): number {
  if (ref.runId) return 3;
  if (ref.memoryId) return 2;
  if (ref.eventId) return 1;
  return 0;
}

export function groupAgentMethodEvidenceOrigins(
  inputs: readonly AgentMethodEvidenceOriginInput[],
): AgentMethodEvidenceGrouping {
  const byOrigin = new Map<string, { refs: AgentMethodEvidenceV1[]; kept: AgentMethodEvidenceV1 }>();
  for (const input of inputs) {
    const key = originKeyOf(input);
    const entry = byOrigin.get(key);
    if (!entry) {
      byOrigin.set(key, { refs: [input.ref], kept: input.ref });
      continue;
    }
    entry.refs.push(input.ref);
    if (specificity(input.ref) > specificity(entry.kept)) entry.kept = input.ref;
  }
  const origins = [...byOrigin.entries()].map(([originKey, entry]) => ({
    originKey, refCount: entry.refs.length, kept: entry.kept,
  }));
  return {
    refs: origins.map(entry => entry.kept),
    independentCount: origins.length,
    mergedCount: inputs.length - origins.length,
    origins,
  };
}

/**
 * 认识状态与依据条数是否相称。
 *
 * 只处理**明显过头**的那一种：调用方给了多条依据、去重后只剩一个来源，却仍然声称
 * `supported`。那正是「把同源重述包装成多方印证」的形状，降为 `tentative`。
 *
 * 反过来不做：单条依据声称 `supported` 是允许的——一条**可核对的具体事实**
 * （例如一个真实的失败条件与错误）本来就能支撑一条有边界的做法，§6.2 明确要求
 * 「不能凭一次失败把能力永久判死」，同样也不能凭「只有一条」把它判成没依据。
 */
export function reconcileEvidenceEpistemicStatus(input: {
  claimed: "tentative" | "supported" | "disputed";
  originalCount: number;
  grouping: AgentMethodEvidenceGrouping;
}): "tentative" | "supported" | "disputed" {
  if (input.claimed !== "supported") return input.claimed;
  if (input.originalCount > 1 && input.grouping.independentCount <= 1) return "tentative";
  return input.claimed;
}
