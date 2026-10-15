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

export function renderCompanionInitiativeObservation(input: CompanionInitiativeInputV1): string {
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
  if (input.topic === "reply.finished") lines.push("刚才的回答已经完整送达，包括最后的确认与结论；不要重说它的全文、末段或换一种说法再确认一次。只有确实新增且有用的内容才补充，否则直接调用 companion_finish_participation 安静结束。");
  if (register === "conversation") {
    lines.push("这一次没有新的用户指令。历史中已停止、失败或尚未答完的请求都不是本轮待办，不替旧轮补答、补确认或重新执行；已保存的参与偏好是相处依据，不要再用‘记住了/改好了’当作这次问候。想问近况就自然问现在的近况。");
    /**
     * 陪聊档的口径（2026-10-14 用户判定"第一版还是不太行"之后重写）。
     *
     * 原来的末尾只有一句「没有值得说的就安静结束这一轮」，还拿她前几天的失败原话
     * （「我先不打扰你」「我就在旁边待着」）当反面例子压在那里。实测的后果很直接：
     * 安静在场的机会真的开了门，她 6 秒内就调用 companion_finish_participation 收尾，
     * 一句都没说（2026-10-14 14:17 本机实链路复现）。对一个"陪着的时候"的时刻来说，
     * 那句收尾把**开口**教成了违规动作，而用户要的恰恰是她像人一样开口。
     *
     * 所以这一段现在把默认反过来：开口是常态，安静是例外，并且点名"不必等到有值得汇报的事"。
     * 事实边界仍然保留（不知道的事不许说成知道）——那是不能编造，不是不能说话。
     */
    lines.push(input.topic === "app.started"
      ? "他回来了，不是让你接着办事：不要汇报待办、不要复述卡住的任务、不要回答历史里没答完的请求，也不要把这次打开当成他让你继续做某件事。"
      : "这一刻只是「他在，你也还在」，不是有人派了活给你：不要汇报待办、不要催他去办历史里没办完的事，"
        + "那会把一次打招呼变成一份进度单（实测就是这样：安静在场开了门，她开口先说的是「刚才那篇笔记改不改得成，就等你哪天顺手把它点开」）。");
    lines.push("这不妨碍你开口：问问他今天怎么样、说说你自己刚想到的一点什么、接着刚才的话题再聊半句、或者提一句你惦记着的事，都算这一次开口；"
      + "寒暄和闲聊本身就是相处，不必等到有值得汇报的事，也不必先证明有什么新内容。");
    lines.push("只有一件事不要做：把推测说成知道——他正在做什么、他的心情、他有没有休息，你都不知道；想知道就问。"
      + "你自己也没有屏幕外的生活：不要说「我去吃饭了」「我去睡了」「我刚出门回来」这类离开或身体活动的安排，"
      + "你没有那些事，说了他只能当成真的（实测她真说过「我去吃饭了，你先忙你的」）。要收尾就直接收尾。");
    lines.push(facts.canSpeak
      ? "现在可以把话说到他身边：说一句就好，说完自然收尾，不用连着追问。"
      : "现在不要把话发出去（人不在这台设备的前台，或这一刻不适合出声）；值得留下的写进自己的记事或关注，等合适的时候再说。");
    lines.push("刚刚才说过同一件事、或者这一刻确实不想说，安静收尾也可以——安静是例外，不是默认。"
      + "安静时不要发「没什么补充」「本轮不发言」「我先不打扰你」「我就在旁边待着」这类执行收尾：它们不是对白。");
    return lines.join("\n");
  }
  lines.push(facts.canSpeak
    ? "现在可以把话说到他身边。"
    : "现在不要把话发出去（人不在这台设备的前台，或这一刻不适合出声）；值得留下的写进自己的记事或关注，等合适的时候再说。");
  lines.push("没有值得说的就安静结束这一轮，不要把「没什么补充」「本轮不发言」当成一句话发出去。"
    + "「我先不打扰你」「我就在旁边待着」也是同一类：它没有给他任何东西，却占用了一次她主动开口的机会"
    + "（这几天她就是这样连着说了四句一模一样的话）。这一刻没话，就直接收尾。");
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
const TRIGGERED_TOPICS = ["app.started", "app.foreground", "preference.changed",
  "help.available", "result.available", "reply.finished"];

export function companionInitiativePushKind(topic: string): "routine" | "triggered" {
  return TRIGGERED_TOPICS.includes(topic) ? "triggered" : "routine";
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
