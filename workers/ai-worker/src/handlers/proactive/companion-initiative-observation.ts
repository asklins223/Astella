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

/**
 * 她上一次自己开口说的是什么（2026-10-16）。
 *
 * 为什么要把这句**引出来**而不是让她自己翻历史：实测连续十几次启动问候的正文几乎一模一样
 * （「周五晚上好，又见面了。今天过得咋样？」这一族的变体），而历史就在她的上下文里——
 * 她能读到，却还是照着上一句再写一遍。把上一句原样摆在观察块里、并点名"这次不要再用
 * 同样的开头或收尾"，才是一道能执行的约束。这一句由调用方从回放历史里取（见
 * `companion-agent-runtime.ts`），不额外查库。
 */
export interface CompanionInitiativeObservationOptions {
  /**
   * 她最近几次开口的原话（由近到远，最多三条），由调用方从回放历史里取
   * （见 `companion-agent-runtime.ts`），不额外查库。
   */
  readonly lastOwnLines?: readonly string[];
}

/**
 * 由头来源的三个角度（2026-10-16）。用户口径是「随机的，可以闲聊也可以聊学习」，
 * 而实测"引原话 + 禁止复用"只是软约束——同一句内部玩笑在连造问候里仍会连着出现两次
 * （见 docs/testing/companion-greeting-content-variety-2026-10-16.md 第 ④ 轮）。
 * 所以"变化"这一步改成**确定性的**：按这一轮的身份派生一个角度，连着几次开口不会落在
 * 同一个来源上。三个角度都**不给例句**：凡是提示里给出的成句，她都会当台词抄（两次独立实测）。
 */
const OPENING_ANGLES = [
  "不引用任何材料：就着一件你此刻真想知道的小事闲聊（不聊他的房间、摆设，也不编排你自己屏幕外的生活）",
  "从他最近在学的东西里挑一处具体的来说：是你真在意的那一点，不是进度报告",
  "说一点你自己此刻想到的念头：一个看法、一个没想通的疑问都可以，但不能是离开、吃饭、睡觉这类安排",
] as const;

/**
 * 她最近几次自己开口的原话（由近到远，最多三条，各取尾部 200 字）。
 *
 * 从回放历史里取，不额外查库。放在这里而不是 `companion-agent-runtime.ts`：
 * 那是 1508 行的"神文件"（守卫阈值 1500），反重复这一段与观察块的渲染本来就在一起。
 */
export function recentOwnLines(
  messages: readonly { readonly role: string; readonly content: unknown }[],
): string[] {
  return [...messages].reverse()
    .map((message) => message.role === "assistant" && typeof message.content === "string" ? message.content.trim() : "")
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .map((line) => line.slice(-200));
}

/** 稳定散列：同一轮永远得到同一个角度，不同轮之间均匀落在三个角度上。 */
export function openingAngleFor(seed: string): (typeof OPENING_ANGLES)[number] {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return OPENING_ANGLES[Math.abs(hash) % OPENING_ANGLES.length]!;
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
    lines.push("这不妨碍你开口：说说你自己刚想到的一点什么、接着刚才的话题再聊半句、提一句你惦记着的事、或者就此刻真想知道的事问一句，都算这一次开口；"
      + "寒暄和闲聊本身就是相处，不必等到有值得汇报的事，也不必先证明有什么新内容。");
    /**
     * 不要求每次挂在学习上（2026-10-16 用户口径：「不用每次都必须要关联到具体学习上面……
     * 随机的，可以闲聊也可以聊学习」）。这一条与 40 PRD「一次普通闲聊……不要强行转回学习」
     * 是同一个意思：闲聊是相处本身，不是学习的引子。
     *
     * **这里故意不举具体的闲聊范本**：上一版写了「问一句他今天怎么样」，她连着十几次都落在
     * 同一句上；随后改成"闲聊随性一点"并附一个时间/近况的举例，下一版又变成连着四次
     * 「周五晚上你没出去玩呀？」。凡是在提示里给出的成句，她都会当成台词抄。所以这里只说
     * 允许的范围与"别每次挑同一类"，具体由头交给她自己——真正管用的是下面那段**她自己
     * 最近说过什么**的明文引用（没有任何可抄的句子）。
     */
    lines.push("开口的由头**不必每次都落在学习上**：闲聊和学习都算，随性一点；"
      + "别每次都挑同一类，也别每次都回到同一篇笔记、同一个时间点上。");
    /**
     * 角度轮换（确定性）：句面约束拦不住"同一个由头换着说"，所以再给一个按轮次派生的来源。
     * 它只规定**从哪儿找由头**，不规定说什么——不给例句，避免又变成一句现成台词。
     */
    const angleSeed = [input.preparationJobId, input.observationId, input.parentRunId].find((value): value is string =>
      typeof value === "string" && value.length > 0);
    if (angleSeed) {
      lines.push(`这一次的由头换个来源，从这一类来：${openingAngleFor(angleSeed)}。不用解释你在换角度。`);
    }
    /**
     * 反重复（2026-10-16）：实测连续十几次启动问候的正文几乎一样，全是同一句寒暄换时间词
     * （「周五晚上好，又见面了。今天过得咋样？」那一族）。历史她读得到，但没人禁止她复用，
     * 而上面那句"问问他今天怎么样"的举例正是她每次落进去的模板。
     *
     * 只引**上一句**不够：她换成"换个字"的说法就绕过了——实测引上一句之后连着四次
     * 「周五晚上你没出去玩呀？」。所以这里把最近三次原话都摆出来，并点名"由头不要落在这几个上"，
     * 同时要求**换类别**（上一句聊学习、这次就聊点别的，反过来也一样）。说不出别的就安静收尾。
     */
    const recent = (options.lastOwnLines ?? []).filter((line) => line.trim().length > 0).slice(0, 3);
    if (recent.length > 0) {
      const list = recent.map((line, index) => `${index + 1}.「${line}」`).join("");
      lines.push(`你最近几次开口说的是：${list}。`
        + "这次的由头不要落在这几个上——同一个话题换个说法、换个角度接着说，他照样会觉得你在走流程；"
        + "上一句聊的是学习，这次就随口聊点别的，反过来也一样。"
        + "真想不出别的，就安静收尾。");
    }
    /**
     * 禁止项**不复述原话**（2026-10-16 真栈实测）。
     *
     * 这一段原来把要禁止的句子逐字写进提示（「我去吃饭了」「我去睡了」「我刚出门回来」，
     * 还附了一句"实测她真说过「我去吃饭了，你先忙你的」"）。连着做五次启动问候，她第 2 次
     * 输出的正是「我去吃饭了，你先忙你的。」——**反面例句被当成范本抄了回去**。
     * 禁区只需要说清"哪一类不能做"，逐字引用只会给出一句现成的台词。
     */
    lines.push("只有一件事不要做：把推测说成知道——他正在做什么、他的心情、他有没有休息，你都不知道；"
      + "你也看不到他的房间、桌面或他周围有什么，不要描述、点评或假设那些东西，也别假装见过它们；想知道就问。"
      + "你自己也没有屏幕外的生活：不要给自己安排离开、吃饭、睡觉、出门、身体活动这类事，"
      + "你没有那些事，说出来他只能当成真的。要收尾就直接收尾。");
    lines.push(facts.canSpeak
      ? "现在可以把话说到他身边：说一句就好，说完自然收尾，不用连着追问。"
      : "现在不要把话发出去（人不在这台设备的前台，或这一刻不适合出声）；值得留下的写进自己的记事或关注，等合适的时候再说。");
    lines.push("刚刚才说过同一件事、或者这一刻确实不想说，安静收尾也可以——安静是例外，不是默认。"
      + "安静收尾是直接结束这一轮，不是写一句宣布自己安静或没有内容可说的执行说明：那不是对白。");
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
