import { isCompanionAutonomousTool } from "./companion-autonomy.ts";

/**
 * 宿主上下文：这一轮**实际发生的事**，不是分类器猜的意图（2026-10-16）。
 *
 * ## 为什么要有这一层
 *
 * 工具面的成员资格原来散在 `companion-agent-runtime.ts` 里的一段内联 `filter`：
 * 三个能力名以字面量写在判断里（批注、整篇正文那一轮的发言、主动轮的收尾），
 * 外加一条"主动轮只留自主能力与非导航只读能力"的类别规则。它读起来像特例，
 * 改起来没有单一位置，也说不清"到底还有没有别的筛选"。
 *
 * 这一层把那些规则变成**声明**（`HOST_CONTEXT_RULES` + 导航名录），成员资格只由
 * 宿主事实（有没有批注目标、这一轮正文是否直接落成笔记、是不是主动轮）决定。
 *
 * ## 它为什么不违反 2026-10-09 的教训
 *
 * 那次翻车是**分类器的一次猜测成了能力总闸**：一个做不到的请求（共享笔记）把
 * `act` 降成 `uncertain`，于是 `companion_create_note` 整批被摘；她照着自己那份清单
 * 如实回答"我手上没有新建笔记的入口"，下一轮单句请求时工具又在了，于是当众改口。
 *
 * 这一层的判据**在类型上就拿不到意图**：入参只有 `CompanionHostContextFacts`
 * （宿主事实），没有 `toolUse` / `intent` / `candidateOperations`。所以重演不了那次
 * 故障；而能力消失的代价也被限制在"这件事在这一轮根本不可能做成"的那三种情形上。
 * 没有声明的能力一律放行（fail open）。
 */
export type CompanionHostContext = "user" | "annotation" | "note_reply" | "initiative";

export interface CompanionHostContextFacts {
  /** 用户从句子的批注入手：note page 上有 `annotationTarget`。 */
  writingAnnotation: boolean;
  /** 这一轮的正文会直接保存为笔记学习内容（整篇交付那一轮）。 */
  completeNoteReply: boolean;
  /** 主动那一轮（她自己开口，不是用户在提问）。 */
  initiative: boolean;
}

/**
 * 主动那一轮被排除在外的导航能力。
 *
 * 它们都是 `read`，但在主动轮里"替用户跳到某个页面"是业务操作；`companion_edit_note`、
 * 其余写类在没有自主标记时已经被 `isCompanionAutonomousTool` 挡掉了。
 */
export const COMPANION_NAVIGATION_TOOL_NAMES: readonly string[] = Object.freeze([
  "companion_open_page",
  "companion_open_note",
  "companion_open_card",
]);

/**
 * 每条能力在哪些宿主上下文里才下发。缺省=任何对话轮都给（fail open）。
 *
 * `onlyIn`：只有这些上下文才给（这件事在别处根本做不成）。
 * `notIn`：这些上下文里不给（这一轮的交付形状不需要它）。
 */
const HOST_CONTEXT_RULES: Readonly<Record<string, {
  onlyIn?: readonly CompanionHostContext[];
  notIn?: readonly CompanionHostContext[];
}>> = Object.freeze({
  // 批注只能从句子的批注入手写；没有批注目标时这个能力不可能成功。
  companion_write_annotation: { onlyIn: ["annotation"] },
  // 整篇正文那一轮直接把正文交上去，不用分句发言（用了反而与正文分叉）。
  companion_publish_utterance: { notIn: ["note_reply"] },
  // 收尾发言只存在于主动那一轮。
  companion_finish_participation: { onlyIn: ["initiative"] },
});

/** 宿主事实 → 这一轮生效的上下文集合。任何对话轮至少是 `user`。 */
export function activeCompanionHostContexts(
  facts: CompanionHostContextFacts,
): ReadonlySet<CompanionHostContext> {
  const contexts = new Set<CompanionHostContext>(["user"]);
  if (facts.writingAnnotation) contexts.add("annotation");
  if (facts.completeNoteReply) contexts.add("note_reply");
  if (facts.initiative) contexts.add("initiative");
  return contexts;
}

/**
 * 这条能力在**这一轮的宿主上下文**里该不该下发。
 *
 * 判据只吃宿主事实，不读本轮判定（理由见文件头）。未知能力（没有声明）放行。
 */
export function companionCapabilityOfferedInHostContext(
  definition: { name: string; riskClass: string },
  facts: CompanionHostContextFacts,
): boolean {
  const contexts = activeCompanionHostContexts(facts);
  const rule = HOST_CONTEXT_RULES[definition.name];
  if (rule?.onlyIn && !rule.onlyIn.some((context) => contexts.has(context))) return false;
  if (rule?.notIn?.some((context) => contexts.has(context))) return false;
  // 主动那一轮只剩自主能力与非导航只读能力：她不能替用户执行业务操作。
  if (!contexts.has("initiative")) return true;
  return isCompanionAutonomousTool(definition.name)
    || (definition.riskClass === "read" && !COMPANION_NAVIGATION_TOOL_NAMES.includes(definition.name));
}
