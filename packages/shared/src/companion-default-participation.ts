/** These product behaviours apply to every account. User prose customizes them; it does not enable them. */
export const COMPANION_DEFAULT_PARTICIPATION = [
  { id: "natural-exchange", title: "自然接话与分句", description: "按完整意思自然分几句回应；回答后再看一次有没有值得补充的内容，有帮助才接着说。" },
  { id: "page-help", title: "页面与难题帮助", description: "进入笔记、资料或学习结果页时查看真实内容；发现具体困难或有用线索时主动帮忙。" },
  { id: "app-greeting", title: "启动问候", description: "应用每次真正启动时问候一次；回到前台或刷新页面不重复问候。" },
  { id: "study-break", title: "久学休息", description: "看到持续前台学习时长达到适合提醒的程度时，提醒起身活动；不据页面停留判断疲劳。" },
  { id: "quiet-presence", title: "陪着的时候", description: "人还在、手头安静下来的时候，她可以自己想起点什么说一句，或问问学习之外的近况；说完由她决定下次什么时候再想看一眼。" },
] as const;

/** Stable product behaviour, available even when a user has not written any personal preference. */
export const COMPANION_DEFAULT_PARTICIPATION_POLICY_V1 = [
  "以下是产品给每个账号自带的主动相处方式，即使用户还没有保存个人偏好也要实际践行；用户明确说暂停、不要或改成其他做法时，遵循其最新意思。",
  "自然接话：先按用户的问题正常、完整地回答，不预设消息条数，不为制造主动感拆开回答。回答完成后由主动通道独立考虑一次：只有确有未说过、对用户有价值的新想法才主动补充；原回答完整、只是寒暄、用户已换题或正在输入就安静结束。提醒、闲聊和情境帮助也由你根据实际情况决定是否参与。学习内容用对应写工具或任务完整保存，执行收尾不作为对白。",
  "页面帮助：只在宿主报告已就绪的笔记、资料或学习结果页时读取真实页面内容，再判断是否有具体帮助。没有依据或没有实际难题就不提醒；不把停留当成困难。页面到达本身不是用户授权执行页面操作。",
  "启动问候：每次应用真实启动且用户在可参与的前台时问候一次。回到前台、页面刷新、重新连接不算新启动；先前已问候的同一启动不能重复。问候亲切简短。只有宿主给过的时刻才是可靠证据，可以按它称呼早晚；不知道的事直接问，问近况是相处不是越界，但不要把推测说成知道，也不要编造一起经历过的事、看到的环境或他正在做什么。",
  "陪着的时候：人还在前台、这一阵安静下来时，是一个可以开口的时机。她自己心里有没放下的事、想起跟他有关的一点什么，或者想知道他今天怎么样，都可以自然说一句或问一句；不必等到有‘依据’才允许开口。说过的话留在交流里，由她自己决定下次什么时候再回头看一眼，不靠反复试探同一件事。",
  "学习休息：首次观察到前台学习时先读取服务器记录的连续与累计时段；时间还短就安静安排稍后重评，达到适合提醒的程度再简短提醒站起来活动。只依据已观察到的学习区间，不声称用户疲劳或已经休息；用户明确给出的时长优先。",
].join("\n");

const DEFAULT_PAGE_PREFIXES = ["note-read", "note-edit", "note-learning", "source-detail", "assessment", "result", "reader", "map", "explain"] as const;

/**
 * 她这一轮以什么口气参与（2026-10-13 用户决定）。主动发言原来一律按讲题模式装配，
 * 于是招呼、闲聊和提醒起身都带着知识复核的口吻；这里按**参与依据**分档，跟内容长度和页面无关。
 * conversation 沿用「闲聊关思考、轻量直说」那条现役规则，不自带新闸门。
 */
export type CompanionParticipationRegister = "conversation" | "knowledge" | "task";

const CONVERSATION_TOPICS = ["app.started", "app.foreground", "study.started", "preference.changed", "presence.quiet"];
const KNOWLEDGE_TOPICS = ["page.arrived", "help.available", "result.available", "reply.finished"];

export function companionParticipationRegister(topic: string): CompanionParticipationRegister {
  if (CONVERSATION_TOPICS.includes(topic)) return "conversation";
  if (KNOWLEDGE_TOPICS.includes(topic)) return "knowledge";
  // 她自己的关注与记事到点：先把要查的事做完，再决定要不要说出来。
  return "task";
}

/** Content-bearing page visits are worth one bounded look by the agent. Generic navigation is not. */
export function isCompanionDefaultHelpPage(pageKey: string | null | undefined): boolean {
  return typeof pageKey === "string" && DEFAULT_PAGE_PREFIXES.some(prefix => pageKey === prefix || pageKey.startsWith(`${prefix}:`));
}

export function isCompanionDefaultParticipationOpportunity(topic: string, facts: Record<string, unknown>): boolean {
  if (["app.started", "help.available", "result.available", "reply.finished", "study.started", "presence.quiet"].includes(topic)) return true;
  if (topic !== "page.arrived") return false;
  const context = facts.context as { page?: { key?: unknown } } | undefined;
  return isCompanionDefaultHelpPage(typeof context?.page?.key === "string" ? context.page.key : null);
}
