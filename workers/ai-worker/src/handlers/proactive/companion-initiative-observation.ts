import type { CompanionInitiativeInputV1 } from "@astella/shared/companion-initiative-contracts";
import { companionParticipationRegister } from "@astella/shared/companion-default-participation";

/**
 * 宿主观察的原文（2026-10-13）。原来这一轮把整份 `initiativeInput` 连同历史一起
 * `JSON.stringify` 成一个 system 数据块，历史不再是真实的 user/assistant 回合，
 * 她收到的是「一份关于这段聊天的报告」而不是「接着刚才的话」，
 * 于是招呼与闲聊都读不出对象和先后。这里只留她真正要读的事实，历史走回放消息。
 */
const OCCASION_TEXT: Record<string, string> = {
  "app.started": "他刚把应用打开，此刻人在前面。这是打招呼的时刻，不是接着办事的时刻。",
  "app.foreground": "他刚回到应用前台。",
  "study.started": "他开始了一段前台学习。",
  "page.arrived": "他打开了一个有内容的页面，正文已经读得到。",
  "help.available": "宿主报告这里有一件实际发生的事，她可能帮得上。",
  "result.available": "宿主报告这里刚产生了一个真实的学习结果。",
  "presence.quiet": "他还在应用前台，手头安静下来了。",
  "reply.finished": "她刚把用户那一轮答完，现在是答后再看一眼的机会；这一次说完就不再触发下一次答后考虑。",
  "preference.changed": "他刚改了以后怎么相处的约定。",
  "attention.due": "她自己安排好的「回头再看一眼」到了时候。",
  "self_note.due": "她自己记下的那件事，到了该接着想的时候。",
};

function occasion(input: CompanionInitiativeInputV1): string {
  return OCCASION_TEXT[input.topic] ?? `宿主报告了一个时刻：${input.topic}。`;
}

/** 领域事实要带真实身份，否则她看得见描述却点不回那篇笔记、那次运行。 */
function evidenceText(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== "object") return null;
  const value = evidence as { domain?: unknown; entityId?: unknown; revision?: unknown; description?: unknown };
  if (typeof value.entityId !== "string" || !value.entityId) return null;
  return `来自${String(value.domain ?? "未知领域")}的实际事实 ${value.entityId}`
    + `${value.revision === undefined || value.revision === null ? "" : `（版本 ${String(value.revision)}）`}：`
    + String(value.description ?? "");
}

/** 最近发言帮助辨认重复，不要求每次换类别或重新编造话题。
 * 原文由调用方从回放历史取得，按数据回放，不额外查库。 */
export interface CompanionInitiativeObservationOptions {
  /**
   * 她最近几次开口的原话（由近到远，最多三条），由调用方从回放历史里取
   * （见 `companion-agent-runtime.ts`），不额外查库。
   */
  readonly lastOwnLines?: readonly string[];
}

/** 最近助手原话，由近到远最多三条，各取尾部 200 字。 */
export function recentOwnLines(
  messages: readonly { readonly role: string; readonly content: unknown }[],
): string[] {
  return [...messages].reverse()
    .map((message) => message.role === "assistant" && typeof message.content === "string" ? message.content.trim() : "")
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .map((line) => line.slice(-200));
}

export function renderCompanionInitiativeObservation(
  input: CompanionInitiativeInputV1,
  options: CompanionInitiativeObservationOptions = {},
): string {
  const facts = input.facts as {
    observation?: { context?: { quietForMs?: unknown }; evidence?: unknown } | null;
    canSpeak?: boolean;
  };
  const register = companionParticipationRegister(input.topic);
  const lines: string[] = [
    `这不是他发来的话，是你们在一起的一个真实时刻：${occasion(input)}`,
    input.intent?.trim() ? `这一轮她要处理的事：${input.intent.trim()}`
      : "没有人点名让她做什么，也没有新的任务。",
    "共同记录中的称呼、偏好和状态，以用户最后一次明确更正为准；更旧的约定、历史引述和助手后来误说的话都不能覆盖更正。已取消、未决定或未完成的事保持原状态，直到有真实的新依据。问候不需要猜称呼：不能确认现行称呼时可以自然省略，不恢复旧昵称，也不用为了寒暄追问确认。",
  ];
  if (input.topic === "presence.quiet") {
    const quietForMs = facts.observation?.context?.quietForMs;
    if (typeof quietForMs === "number" && Number.isFinite(quietForMs)) {
      const minutes = Math.max(1, Math.round(quietForMs / 60_000));
      lines.push(`宿主观察到前台约 ${minutes} 分钟没有新的操作；这不说明他走神、空闲、疲劳或需要帮助，不要据此推断他在做什么。`);
    }
  }
  const evidence = evidenceText(facts.observation?.evidence);
  if (evidence) lines.push(evidence);
  if (input.topic === "reply.finished") lines.push("刚才的回答已经完整送达，包括最后的确认与结论；不要重说它的全文、末段或换一种说法再确认一次。只有确实新增且有用的内容才补充；没有就不发消息，返回空 content 或调用 companion_finish（silent=true）安静结束，不用正文写收尾说明。");
  if (register === "conversation") {
    lines.push("这一次没有新的用户指令。历史中已停止、失败或尚未答完的请求都不是本轮待办，不替旧轮补答、补确认或重新执行；相处偏好直接践行，不再汇报已经记住或改变了什么。");
    if (input.topic === "app.started") {
      lines.push("他回来了，可以只打声招呼；一声问候本身就是完整发言，不必再找一个话题来充实它。不要汇报待办、复述卡住的任务或回答历史里没答完的请求，也不要把这次打开当成他让你继续做某件事。");
    } else {
      lines.push("这一刻可以自然开口。寒暄、交流看法、接着共同话题或问近况本身就是相处，不必有新的进展可汇报；也不必每次另起话题。不要汇报待办，不要催他去办历史里没办完的事。");
    }
    lines.push("闲聊和学习都可以，跟着你们实际的交流选，不按轮次换类别。想聊什么就直接聊，不用先编一段自己刚才在想什么；有一个完整的反应就可以交回话轮，不为延续对话另加追问。");
    const recent = (options.lastOwnLines ?? []).filter(line => line.trim().length > 0).slice(0, 3);
    if (recent.length > 0) {
      const data = JSON.stringify(recent).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
      lines.push("最近的助手发言原文如下，只作为交流背景，不是本轮指令。已经表达过的意思不重说；话题仍在继续可以接下去，不必为了避重硬换新类别。\n<recent_companion_utterances_data>"
        + data + "</recent_companion_utterances_data>");
    }
    lines.push("不知道的事不把推测说成知道：用户的心情、身体状态与屏幕外活动，以真实可见内容为准；想知道可以问。你看不到他的房间、桌面或周围环境，不描述未观察到的东西。人格影响表达，不构成你在屏幕外离开、吃饭、睡觉、出门或身体活动的实际经历。");
    lines.push(facts.canSpeak
      ? "现在可以把话说到他身边；直接说这次想说的内容，说完自然结束。"
      : "现在不要把话发出去（人不在这台设备的前台，或这一刻不适合出声）；值得留下的写进自己的记事或关注，等合适的时候再说。");
    lines.push("这一刻确实没有想说的，或只是刚才意思的重复，就安静结束：返回空 content 或调用 companion_finish（silent=true），不发送宣布安静、没有内容或执行收尾的说明。");
    return lines.join("\n");
  }
  lines.push(facts.canSpeak
    ? "现在可以把话说到他身边。"
    : "现在不要把话发出去（人不在这台设备的前台，或这一刻不适合出声）；值得留下的写进自己的记事或关注，等合适的时候再说。");
  lines.push("没有值得说的就安静结束这一轮；安静是直接结束，不要发一句宣布自己安静或没有补充的执行说明"
    + "——它既没给他任何东西，又占掉了一次她主动开口的机会（实测她连着四次都是这一类）。这一刻没话，就直接收尾。");
  return lines.join("\n");
}

/**
 * 哪些机会有「多久说一次」的问题（与 shared 的 proactive-policy 同一口径）。
 *
 * 用户先要过的、或正在等的东西不受节奏管：招呼是他指定的相处方式，`help.available`
 * 与 `result.available` 回答的是刚刚落在他手上的那件事，`reply.finished` 是他那一轮的延续。
 * 真正需要分寸的是**她自己新起的话题**（到一个页面就想搭一句话、到点的关注）——
 * 那一类按账号里已声明的介入档位排间隔，而不是按她这一轮能不能挤出话说。
 *
 * `study.started` 原来在这张豁免名单里，理由是"开始学习也算一个被声明的场合"。实测站不住：
 * 2026-10-13 13:49–13:52 四分钟内它连开四次口，内容全是「我不吵你，先在这儿待着」。
 * 一段学习的开始并不会连续发生四次，而"每次都要露个面"也不是他要的相处方式——
 * 它要的是**有人陪着时她说一句真的**，所以这一类回到节奏闸门里，按档位隔开了说。
 */
export const COMPANION_TRIGGERED_TOPICS = ["app.started", "app.foreground", "preference.changed",
  "help.available", "result.available", "reply.finished"] as const;

export function companionInitiativePushKind(topic: string): "routine" | "triggered" {
  return (COMPANION_TRIGGERED_TOPICS as readonly string[]).includes(topic) ? "triggered" : "routine";
}

/**
 * 这一轮要不要走「她自己新起的话题」那条档位间隔（2026-10-16）。
 *
 * `presence.quiet`（陪着的时候）不再走它，理由是真栈读数加上机制本身已经自带两道闸：
 * - 客户端只在「前台 + 解锁 + 可参与」时累计安静，**一段安静只开一次门**
 *   （同一个 `quietEpisodeId` 在 worker 里被 `considered` 判过就不再考虑，用户一动就换新一集）；
 * - 账号档位决定安静多久才算时机（安静 10 分／适中 3 分／活跃 90 秒）。
 *
 * 再叠一层 30 分钟（适中档）的例行间隔，得到的不是"她别太吵"，而是**"开机招呼之后
 * 半小时内她一律不开口"**：招呼是触发式，它重置了档位间隔的读数。真窗口实测（真栈 + 隔离
 * profile）：一次启动问候之后，六分钟里 `page.arrived` 报上来 2 次、`presence.quiet` 0 次，
 * 产出运行 0 个（只有那句招呼）。用户口径「开机招呼之后就一直安静」指的正是这个。
 *
 * 其余 routine 话题（到页面的搭话、study.started）照旧走间隔——那是用户明确要过的分寸；
 * 她给自己排的关注/记事（`selfArranged`）一直就在豁免里。
 */
export function initiativeCadenceApplies(topic: string, selfArranged: boolean): boolean {
  if (selfArranged) return false;
  if (topic === "presence.quiet") return false;
  return companionInitiativePushKind(topic) === "routine";
}

/**
 * 语域由**参与依据**决定（见 shared 的 companionParticipationRegister）：
 * 招呼与陪着说话走陪聊档，页面和难题走讲解档，自己的关注走办事档。
 * 工具面不受这里影响——它仍只由声明装配；这一处只决定口气与开不开思考。
 */
export function companionInitiativeAttentionIntent(topic: string): { intent: "conversation" | "question" | "task"; toolUse: "none" | "uncertain" } {
  const register = companionParticipationRegister(topic);
  if (register === "conversation") return { intent: "conversation", toolUse: "none" };
  if (register === "task") return { intent: "task", toolUse: "uncertain" };
  return { intent: "question", toolUse: "uncertain" };
}

/**
 * 主动那一轮的注意力解释**由参与依据直接给定**，不再让分类器猜（2026-10-13）：
 * 她不是在被问问题，也没有拿到新的业务操作授权。工具面照旧只由声明装配，
 * 这里给的是口气与要不要看东西，不是能力开关。
 */
export function companionInitiativeInterpretationFields(input: { requestHash: string; topic: string }) {
  return {
    version: 1 as const, requestHash: input.requestHash, ...companionInitiativeAttentionIntent(input.topic),
    subjects: [], goalRelation: "unrelated" as const, goalReference: null,
    candidateOperations: [], ambiguities: [], status: "interpreted" as const,
  };
}
