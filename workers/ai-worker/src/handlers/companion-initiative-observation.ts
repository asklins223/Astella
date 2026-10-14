import type { CompanionInitiativeInputV1 } from "@astella/shared/companion-initiative-contracts";
import { companionParticipationRegister } from "@astella/shared/companion-default-participation";

/**
 * 宿主观察的原文（2026-10-13）。原来这一轮把整份 `initiativeInput` 连同历史一起
 * `JSON.stringify` 成一个 system 数据块，历史不再是真实的 user/assistant 回合，
 * 她收到的是「一份关于这段聊天的报告」而不是「接着刚才的话」，
 * 于是招呼与闲聊都读不出对象和先后。这里只留她真正要读的事实，历史走回放消息。
 */
const OCCASION_TEXT: Record<string, string> = {
  "app.started": "他刚把应用打开，此刻人在前面。",
  "app.foreground": "他刚回到应用前台。",
  "study.started": "他开始了一段前台学习。",
  "page.arrived": "他打开了一个有内容的页面，正文已经读得到。",
  "help.available": "宿主报告这里有一件实际发生的事，她可能帮得上。",
  "result.available": "宿主报告这里刚产生了一个真实的学习结果。",
  "presence.quiet": "他还在应用前台，这一阵没有观察到新的操作。",
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
    observation?: { facts?: { context?: { quietForMs?: unknown }; evidence?: unknown } | null } | null;
    canSpeak?: boolean;
  };
  const lines: string[] = [
    `这不是他发来的话，是宿主报告的一个真实时刻：${occasion(input)}`,
    input.intent?.trim() ? `这一轮她要处理的事：${input.intent.trim()}`
      : "宿主没有点名具体事情，按上面的时刻和她自己的判断决定要不要说、说什么。",
  ];
  if (input.topic === "presence.quiet") {
    const quietForMs = facts.observation?.facts?.context?.quietForMs;
    if (typeof quietForMs === "number" && Number.isFinite(quietForMs)) {
      const minutes = Math.max(1, Math.round(quietForMs / 60_000));
      lines.push(`宿主观察到前台约 ${minutes} 分钟没有新的操作；这不说明他走神、空闲或需要帮助，不要据此推断。`);
    }
  }
  const evidence = evidenceText(facts.observation?.facts?.evidence);
  if (evidence) lines.push(evidence);
  lines.push(facts.canSpeak
    ? "现在可以把话说到他身边。"
    : "现在不要把话发出去（人不在这台设备的前台，或这一刻不适合出声）；值得留下的写进自己的记事或关注，等合适的时候再说。");
  lines.push("没有值得说的就安静结束这一轮，不要把「没什么补充」「本轮不发言」当成一句话发出去。");
  return lines.join("\n");
}

/**
 * 哪些机会有「多久说一次」的问题（与 shared 的 proactive-policy 同一口径）。
 *
 * 用户先要过的、或正在等的东西不受节奏管：招呼是他指定的相处方式，`help.available`
 * 与 `result.available` 回答的是刚刚落在他手上的那件事，`reply.finished` 是他那一轮的延续。
 * 真正需要分寸的是**她自己新起的话题**（到一个页面就想搭一句话、到点的关注）——
 * 那一类按账号里已声明的介入档位排间隔，而不是按她这一轮能不能挤出话说。
 */
const TRIGGERED_TOPICS = ["app.started", "app.foreground", "preference.changed", "study.started",
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
