import type { AgentMethodV1 } from "@astella/shared/agent-growth-contracts";
import { AGENT_PROMPT_DIRECTORY_LIMIT } from "@astella/agent-host";

/**
 * 方案 44 §6.1：专业任务（制卡、拓展、速看、演示）执行时读取**相关**的合作/生成经验。
 *
 * ## 为什么只给目录
 *
 * §6.1 的纪律与记忆一致：**先给相关目录，需要时读正文**。把全部方法正文塞进每一次
 * 生成的提示词，会把「她有一条做法」变成「她照抄了一条做法」——而且每轮多烧窗口。
 *
 * ## 怎么判断相关
 *
 * 这里只有当前目标文本（不是笔记正文），所以相关性只能按**关键词**判：方法标题与
 * 适用条件里出现了目标里的词，才算相关。判不出来就不给——宁可这次没有经验可用，
 * 也不要塞一条不相干的做法让她按错误的先验做事。
 *
 * 边界：目录出现**不等于**采用。是否真的用在这一次的步骤/参数/表达上，由采用记录
 * 单独记（§6.3）；这里只负责「让她看见」。
 */

/**
 * 目录一次最多给几条：条数预算的唯一声明源在 @astella/agent-host（与手册目录的 20/5 同处，
 * 2026-10-12 收口），这里只引用、不再各写一遍。超限是**整条取舍**——少给的条数挂在
 * 数组回执上（不可枚举），渲染时如实说出，不静默消失。
 */
export const MAX_RELEVANT_METHODS = AGENT_PROMPT_DIRECTORY_LIMIT;

const STOPWORDS = new Set([
  "的", "了", "和", "与", "或", "在", "是", "有", "把", "被", "给", "对", "和", "个", "这", "那",
  "我", "你", "他", "她", "它", "们", "要", "会", "就", "也", "都", "不", "没", "要", "做", "用",
  "the", "a", "an", "of", "to", "and", "or", "in", "is", "for", "on", "with",
]);

/** 从一段文本里取关键词：拉丁词取整词，中文取 2-gram。与记忆检索同一条纪律。 */
export function methodRelevanceTerms(text: string, max = 12): string[] {
  const terms: string[] = [];
  const push = (term: string): boolean => {
    const lower = term.toLowerCase();
    if (term.length < 2 || STOPWORDS.has(lower) || terms.includes(lower)) return true;
    terms.push(lower);
    return terms.length < max;
  };
  for (const token of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const latin of token.match(/[A-Za-z0-9]+/g) ?? []) {
      if (!push(latin.slice(0, 30))) break;
    }
    // 中文一律切成**重叠**的 2-gram，而不是把整串当成一个词。
    //
    // 「公式卡片」当成一个 4 字词去匹配，永远命中不了标题里的「讲公式……」；切成
    // 公式/式卡/卡片之后第一条就命中了。相关性宁可多给候选——真正的把关在
    // 「适用条件对不上就别用」那句话上，以及按 id 展开正文时的那次核对。
    const han = (token.match(/\p{Script=Han}+/gu) ?? []).join("");
    const grams: string[] = han.length <= 2
      ? (han ? [han] : [])
      : Array.from({ length: Math.min(han.length - 1, max * 2) }, (_, index) => han.slice(index, index + 2));
    for (const gram of grams) {
      if (!push(gram)) break;
    }
    if (terms.length >= max) break;
  }
  return terms;
}

/**
 * 选出与这次任务相关的方法目录。
 *
 * 排序按命中词数：命中多的更像这条任务真正会用到的做法。只给标题与适用条件——
 * 正文仍要按 `methodId + revision` 另行展开（`readAgentMethod`），展开才记「读过」，
 * 目录出现只记「提供过」（§6.3：两者不是一回事）。
 *
 * 超限是**整条取舍**：少给几条挂在返回数组的不可枚举回执上（`omittedCount`），
 * 普通数组消费方不受影响，渲染侧读得到「这次目录短了几条」。
 */
export function selectRelevantMethods(
  methods: readonly AgentMethodV1[],
  query: string,
  limit = MAX_RELEVANT_METHODS,
): AgentMethodV1[] {
  const haystack = query.toLowerCase();
  if (haystack.trim().length === 0) return [];
  const scored: Array<{ method: AgentMethodV1; score: number }> = [];
  for (const method of methods) {
    // **从方法这一侧取词，去问它有没有出现在任务里**，而不是反过来。
    //
    // 反过来的写法有一个具体的坑：任务是一句长中文时，「把牛顿第二定律讲清楚，带上它的
    // 适用条件」的重叠 2-gram 会在句子前半段就把词额用光（把牛/牛顿/顿第/第二/…），
    // 真正与做法对得上的「适用条件」根本没进词表——于是明明相关的做法一条都选不出来。
    // 方法自己的标题与适用条件很短、也**本来就聚焦**，拿它去任务里找命中既准又不会耗尽。
    const terms = methodRelevanceTerms(`${method.title} ${method.appliesWhen}`);
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score += 1;
    if (score > 0) scored.push({ method, score });
  }
  scored.sort((a, b) => b.score - a.score || a.method.title.localeCompare(b.method.title));
  const picked = scored.slice(0, limit).map(entry => entry.method);
  Object.defineProperty(picked, "omittedCount", {
    value: Math.max(0, scored.length - limit), enumerable: false, configurable: true,
  });
  return picked;
}

/**
 * 渲染目录块。
 *
 * 措辞必须写清三件事：这是**合作指引**、它**不**改变原文事实与权限、以及「适用条件
 * 不对就别用」。否则一条本来只适用于某类材料的方法会被当成放之四海皆准的规矩。
 *
 * 标题与适用条件**整条给出**（2026-10-12 裁决：进提示词的输入不按字数静默裁）——
 * 砍半句的「适用条件」正是最容易让模型误用一条做法的位置。
 */
export function renderMethodCatalogBlock(methods: readonly AgentMethodV1[]): string {
  if (methods.length === 0) return "";
  const omitted = (methods as readonly unknown[] & { omittedCount?: number }).omittedCount ?? 0;
  const data = (value: unknown): string =>
    JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const items = methods.map(method => ({
    methodId: method.methodId,
    revision: method.revision,
    title: method.title,
    appliesWhen: method.appliesWhen,
  }));
  return [
    "<related_methods>",
    "下面是**以前定下的做法目录**，可能与这次任务相关，也可能不相关：",
    "· 它们只是合作指引，不改变原文事实、证据引用、领域输出结构与安全校验，也不授予任何权限；",
    "· 逐条看「适用条件」——条件对不上就不要用，用错一条比不用更糟；",
    "· 这里给的是标题与适用条件，正文不在其中；真正要照着做时再按 methodId 与 revision 取正文。",
    // 整条取舍的留痕：少给了几条要如实说，不让「短了的目录」被当成「她只有这些做法」。
    ...(omitted > 0 ? [`· 目录按条数上限整条取舍，这次另有 ${omitted} 条相关做法没有列进来。`] : []),
    data(items),
    "</related_methods>",
  ].join("\n");
}
