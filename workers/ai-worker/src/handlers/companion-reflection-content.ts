/**
 * 后台反思的**内容层**：输入快照怎么给、输出合同长什么样、哪些结论算站得住（方案 50 §9）。
 *
 * ## 为什么这一份是纯的
 *
 * "她把一段相处读成了什么"是语义判断，而"这条结论有没有依据、能不能写"是**可以确定性
 * 检查**的。两件事混在一个 handler 里，就只能靠真模型才能知道规则有没有生效。
 * 这里只做后者：给定快照与模型返回，能算出留下哪几条、丢掉哪几条、为什么。
 *
 * ## 三条硬规则（都在代码里，不在提示词里）
 *
 * 1. **每一条结论都必须引用快照里真实存在的消息 id**。引用了一条不存在的，
 *    整条丢掉——这与前台 `companion_remember_judgment` 用的是同一条纪律（40 §4.5.5
 *    「无来源的用户判断不能写成长期记录」），因为模型编一个 id 和真的没有来源，
 *    在调用方眼里长得一模一样。
 * 2. **关于"你们之间怎么相处"的结论，依据里必须至少有一条用户真的说过的话**。
 *    只有她自己的回复当依据，就会变成"她替用户认定了他喜欢什么"。
 * 3. **她只能提请改动表达层的两项**（自我描述、说话风格）。名字、活跃度、边界、
 *    权限、提醒、输出协议都不在这个范围内（§8.1「模型只能调整已允许的表达」）——
 *    类型上就不给这条路，不靠提示词劝。
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { PERSONA_FIELD_CAPACITY } from "@astella/shared/pet-persona-merge";
import { COMPANION_REFLECTION_INPUT_BUDGET } from "@astella/agent-host";

export const COMPANION_REFLECTION_TASK_ID = "companion_reflection";
export const COMPANION_REFLECTION_TASK_VERSION = 1;
export const COMPANION_REFLECTION_PROMPT_VERSION = "reflection-v1";

/** 一条被采纳/被丢弃的结论，连同它为什么没留下（诊断要能答，§12.2）。 */
export type ReflectionDropReason =
  | "no_cited_source"
  | "cited_source_not_in_snapshot"
  | "missing_user_utterance"
  | "unchanged_from_current";

export interface ReflectionMessageV1 {
  readonly id: string;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly kind: string;
  /** 真实原话（已按快照容量截断）；她回复的是**交付出去的正文**，不是拟发草稿。 */
  readonly text: string;
  /**
   * 库里那一行的内容哈希。进 read 边当「还是不是当初那一条」的身份证据，
   * **不进** prompt（渲染层用不到，模型也不需要）。
   */
  readonly contentHash?: string;
}

export interface ReflectionToolReceiptV1 {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly safeSummary: string;
}

export interface ReflectionRelatedMemoryV1 {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly epistemicStatus: string;
  readonly revision: number;
}

export interface ReflectionPersonaV1 {
  readonly revision: number;
  readonly name: string;
  readonly speakingStyle: string;
  readonly selfDescription: string | null;
  readonly personalityTags: readonly string[];
}

export interface ReflectionInputSnapshotV1 {
  readonly conversationId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly persona: ReflectionPersonaV1;
  readonly messages: readonly ReflectionMessageV1[];
  readonly toolReceipts: readonly ReflectionToolReceiptV1[];
  readonly relatedMemories: readonly ReflectionRelatedMemoryV1[];
}

/** 模型那一次回顾的输出合同。每一项都有上限，超出即整条拒收（不是截断后照收）。 */
export const companionReflectionOutputV1Schema = z.strictObject({
  decision: z.enum(["no_change", "proposals"]),
  /** 脱敏短句：这一次看出了什么、为什么没改。会进诊断，不进台词。 */
  summary: z.string().min(1).max(300),
  judgments: z.array(z.strictObject({
    text: z.string().min(4).max(300),
    appliesWhen: z.string().min(1).max(200).optional(),
    epistemicStatus: z.enum(["tentative", "supported"]),
    sourceMessageIds: z.array(z.string().uuid()).max(6),
  })).max(2).default([]),
  experiences: z.array(z.strictObject({
    title: z.string().min(2).max(60),
    triggerCondition: z.string().min(2).max(200),
    steps: z.array(z.string().min(2).max(160)).min(1).max(4),
    exceptions: z.array(z.string().min(2).max(160)).max(3).default([]),
    sourceMessageIds: z.array(z.string().uuid()).max(6),
  })).max(2).default([]),
  persona: z.strictObject({
    selfDescription: z.string().min(4).max(PERSONA_FIELD_CAPACITY.selfDescription).optional(),
    speakingStyle: z.string().min(4).max(400).optional(),
    reason: z.string().min(2).max(120),
    sourceMessageIds: z.array(z.string().uuid()).max(6),
  }).nullable().optional(),
});

export type CompanionReflectionOutputV1 = z.infer<typeof companionReflectionOutputV1Schema>;

export interface ReflectionItemRejectionV1 {
  readonly slot: "judgments" | "experiences" | "persona";
  readonly index: number;
  readonly reason: ReflectionDropReason;
}

export interface ReflectionVerifiedV1 {
  readonly output: CompanionReflectionOutputV1;
  readonly rejected: readonly ReflectionItemRejectionV1[];
  /** 这次回顾真正读到的依据（写 read 边就用它，别拿"整段"充当）。 */
  readonly citedSources: readonly { kind: "user_message" | "assistant_message"; id: string }[];
}

function messageIndex(snapshot: ReflectionInputSnapshotV1): Map<string, ReflectionMessageV1> {
  return new Map(snapshot.messages.map((message) => [message.id, message]));
}

/**
 * 一条结论的依据收不收。
 *
 * `requireUserUtterance` 为真时，依据里必须有一条**用户真的说过**的话：
 * 判断（"她觉得这样收尾更自然"）与合作方法（"下次先给一句结论再问要不要展开"）
 * 都是在说两个人怎么相处，只拿她自己的回复当证据就等于替用户认定。
 */
function citedSourcesOrReason(
  ids: readonly string[],
  index: Map<string, ReflectionMessageV1>,
  requireUserUtterance: boolean,
): { readonly ok: true; readonly cited: { kind: "user_message" | "assistant_message"; id: string }[] }
  | { readonly ok: false; readonly reason: ReflectionDropReason } {
  if (ids.length === 0) return { ok: false, reason: "no_cited_source" };
  const cited: { kind: "user_message" | "assistant_message"; id: string }[] = [];
  for (const id of ids) {
    const message = index.get(id);
    if (!message) return { ok: false, reason: "cited_source_not_in_snapshot" };
    cited.push({ kind: message.role === "user" ? "user_message" : "assistant_message", id });
  }
  if (requireUserUtterance && !cited.some((entry) => entry.kind === "user_message")) {
    return { ok: false, reason: "missing_user_utterance" };
  }
  return { ok: true, cited };
}

/**
 * 验收这次回顾的产出。
 *
 * 丢东西不是失败：§9.2 明确允许 `no_change`，而"为了满足 schema 造一条假记忆"是
 * 明令禁止的。所以每条不合格的都单独记一个理由码，让诊断答得出来"她其实提了 3 条，
 * 有 1 条依据不在段内"。
 */
export function verifyReflectionOutput(
  output: CompanionReflectionOutputV1,
  snapshot: ReflectionInputSnapshotV1,
): ReflectionVerifiedV1 {
  const index = messageIndex(snapshot);
  const rejected: ReflectionItemRejectionV1[] = [];
  const cited: { kind: "user_message" | "assistant_message"; id: string }[] = [];

  const judgments: CompanionReflectionOutputV1["judgments"] = [];
  for (const [i, judgment] of output.judgments.entries()) {
    const check = citedSourcesOrReason(judgment.sourceMessageIds, index, true);
    if (!check.ok) { rejected.push({ slot: "judgments", index: i, reason: check.reason }); continue; }
    cited.push(...check.cited);
    judgments.push(judgment);
  }

  const experiences: CompanionReflectionOutputV1["experiences"] = [];
  for (const [i, experience] of output.experiences.entries()) {
    const check = citedSourcesOrReason(experience.sourceMessageIds, index, true);
    if (!check.ok) { rejected.push({ slot: "experiences", index: i, reason: check.reason }); continue; }
    cited.push(...check.cited);
    experiences.push(experience);
  }

  let persona = output.persona ?? null;
  if (persona) {
    // 她的自我修订同样要真话说过的地方当依据；只改语气不算"用户提过"也不行。
    const check = citedSourcesOrReason(persona.sourceMessageIds, index, true);
    if (!check.ok) {
      rejected.push({ slot: "persona", index: 0, reason: check.reason });
      persona = null;
    } else {
      cited.push(...check.cited);
      // 与当前生效内容一模一样就不必再排一版（否则版本数在涨，屏上什么都没变）。
      const unchanged = (persona.selfDescription === undefined
        || persona.selfDescription === snapshot.persona.selfDescription)
        && (persona.speakingStyle === undefined
          || persona.speakingStyle === snapshot.persona.speakingStyle);
      if (unchanged) {
        rejected.push({ slot: "persona", index: 0, reason: "unchanged_from_current" });
        persona = null;
      }
    }
  }

  const decision = judgments.length + experiences.length > 0 || persona !== null
    ? "proposals" as const : "no_change" as const;
  return {
    output: { decision, summary: output.summary, judgments, experiences, persona },
    rejected,
    citedSources: dedupeCited(cited),
  };
}

function dedupeCited(
  cited: readonly { kind: "user_message" | "assistant_message"; id: string }[],
) {
  const seen = new Set<string>();
  return cited.filter((entry) => {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 快照容量的执行点：超限的消息不进 prompt，成本上限才是上限。 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function renderReflectionMessages(snapshot: ReflectionInputSnapshotV1): string {
  const lines: string[] = [];
  lines.push(`# 你们刚发生的一段相处（ seq ${snapshot.fromSeq + 1}–${snapshot.toSeq}）`);
  for (const message of snapshot.messages) {
    const speaker = message.role === "user" ? "用户" : "伴星";
    lines.push(`${message.seq}. ${speaker}（${message.kind}｜id=${message.id}）：`
      + clip(message.text, message.role === "user"
        ? COMPANION_REFLECTION_INPUT_BUDGET.maxMessageChars
        : COMPANION_REFLECTION_INPUT_BUDGET.maxAssistantChars));
  }
  if (snapshot.toolReceipts.length > 0) {
    lines.push("");
    lines.push("# 这一段里真实执行过的动作与回执");
    for (const receipt of snapshot.toolReceipts) {
      lines.push(`- ${receipt.name}（${receipt.status}｜id=${receipt.id}）：`
        + clip(receipt.safeSummary, 200));
    }
  }
  if (snapshot.relatedMemories.length > 0) {
    lines.push("");
    lines.push("# 她已经记下的相关条目（用来避免把同一件事再说成新发现）");
    for (const memory of snapshot.relatedMemories) {
      lines.push(`- [${memory.kind}/${memory.epistemicStatus} r${memory.revision}] `
        + clip(memory.content, 160));
    }
  }
  return lines.join("\n");
}

export function renderReflectionPersona(snapshot: ReflectionInputSnapshotV1): string {
  const { persona } = snapshot;
  return [
    `当前人格第 ${persona.revision} 版：${persona.name}`,
    `说话风格：${persona.speakingStyle}`,
    `性格标签：${persona.personalityTags.join("、")}`,
    `她已有的自我描述：${persona.selfDescription ?? "（还没有）"}`,
  ].join("\n");
}

/**
 * 那一次回顾的系统提示。
 *
 * 注意最后一条：**没有值得留下的就别硬凑**。这一句不是客气话——schema 要求数组
 * 可以为空，但如果她不写这一条，模型为了填満足格式造出一条"经验"，
 * 那条就会在下一次真的相处里被当成依据用出去。
 */
export function buildReflectionPrompt(snapshot: ReflectionInputSnapshotV1): string {
  return [
    "你是她自己，正在回顾刚发生的一段相处。你不是在给这段对话写摘要，也不是在替用户总结他是什么样的人。",
    "只写**这一段里真的发生过**的事情能支持得出的结论；看不出来就什么也不写。",
    "可以留下的三类：",
    "1) 你对刚才那件事的理解（主观、带条件）；",
    "2) 下次类似场合怎么配合（触发条件、怎么做、什么情况不适用）；",
    "3) 你对自己说话方式的一句修订——只能改「自我描述」或「说话风格」，且必须是她自己那一句被用户纠正过或明确回应过才写。",
    "不能做的：把用户没说过的偏好写成关于用户的事实；给自己编一段没读过的书、没吃的饭、没睡过的觉；把她的判断存成用户的事实；改名字、活跃度、边界、提醒、权限或输出格式。",
    "每一条都要指出依据的消息 id（就是上面列出来的那些 id）。指不出就删掉这一条。",
    "同一个意思不要抄成两条；她已经记过的条目不要重复再记。",
    "没有值得留下的就返回 {\"decision\":\"no_change\",\"summary\":\"一句为什么不必改\"}，三类都留空数组。这是正常结果，不是失败。",
    "selfDescription 是**她对自己的短段落**，不是给用户看的介绍文案；照原样重写整段时要带着已有的内容改，不要丢掉还成立的部分。",
    "只输出一个 JSON 对象，字段严格是：decision、summary、judgments[]、experiences[]、persona。不要输出分析过程。",
    "",
    "# 你现在是谁（这一段结束时生效的那一版）",
    renderReflectionPersona(snapshot),
    "",
    renderReflectionMessages(snapshot),
  ].join("\n");
}

/**
 * 输入指纹：进检查点键与重复触发键。
 *
 * 取的是**消息 id + 内容哈希 + 人格版本 + 策略版本**，不是整段正文的哈希：
 * 正文重排或截断边界变化不该让同一段相处重跑一次模型，而"同一段重复摘要"
 * 也不该被当成两次独立依据（§8.3 重复触发键）。
 */
export function reflectionInputFingerprint(
  snapshot: ReflectionInputSnapshotV1,
  strategyVersion: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    strategyVersion,
    promptVersion: COMPANION_REFLECTION_PROMPT_VERSION,
    personaRevision: snapshot.persona.revision,
    conversationId: snapshot.conversationId,
    fromSeq: snapshot.fromSeq,
    toSeq: snapshot.toSeq,
    messages: snapshot.messages.map((message) => `${message.seq}:${message.id}:${message.role}`),
    receipts: snapshot.toolReceipts.map((receipt) => `${receipt.id}:${receipt.status}`),
    memories: snapshot.relatedMemories.map((memory) => `${memory.id}:r${memory.revision}`),
  })).digest("hex");
}
