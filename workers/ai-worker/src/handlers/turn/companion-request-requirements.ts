import type { AgentTurnRequest } from "@astella/shared";
import { companionCreatedNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";
import { explicitCompanionProductRequest, explicitlyRequestsCalculationTool, explicitlyRequestsUtterances } from "../tools/companion-tool-intent.ts";
import { companionOperationName, companionPublicationFinal, isCompanionPublicationCall } from "@astella/shared";

function number(text: string): number | null {
  if (/^\d+$/u.test(text)) return Number(text);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let value = 0, digit = 0;
  for (const char of text) {
    if (char in digits) digit = digits[char];
    else if (char === "十" || char === "百" || char === "千") { value += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]); digit = 0; }
    else return null;
  }
  return value + digit;
}
export type CompanionRequestRequirements = { characters?: { min: number; max: number }; noteCharacters?: { min: number; max: number }; noteCount?: number; utteranceCount?: number; requiredTools?: string[] };

/** Receipts can close a plain save request; additional questions still need an answer. */
export function companionReceiptOnlyNoteRequest(text: string, prepared: boolean, requirements: CompanionRequestRequirements): boolean {
  return prepared && Boolean(requirements.noteCount)
    && !/(?:并且|另外|同时|然后|还要|再帮|顺便|解释|回答|总结|概括|告诉|比较|对比|计算|列出)/u.test(text);
}

/** Only explicit, current-turn numeric requirements. No additional model call. */
export function companionRequestRequirements(text: string, canCreateNotes = false, availableTools: readonly string[] = []): CompanionRequestRequirements {
  const value = text.normalize("NFKC").replace(/[“「『‘"]([^”」』’"]*)[”」』’"]/gu, "");
  const result: CompanionRequestRequirements = {};
  const calculationTool = availableTools.includes("companion_observe") ? "companion_observe" : null;
  if (calculationTool && explicitlyRequestsCalculationTool(value)) result.requiredTools = [calculationTool];
  const numeral = "([\\d零一二两三四五六七八九十百千]+)";
  if (explicitlyRequestsUtterances(value)) {
    const count = new RegExp(`(?:分|拆成|拆为)\\s*${numeral}\\s*(?:条|句)`, "u").exec(value);
    const target = count ? number(count[1]) : null;
    if (target && Number.isSafeInteger(target)) result.utteranceCount = target;
  }
  const lengths = [...value.matchAll(new RegExp(`(?:约|大约|大概|差不多|恰好|正好|至少|不少于|不超过|最多)?\\s*${numeral}\\s*(?:个)?字`, "gu"))];
  const length = lengths.filter(match => !/(?:不要|别|不用|并非|不是)[^，,。！？\n]{0,12}$/u.test(value.slice(0, match.index))).at(-1);
  // Explanatory questions and quoted examples are not output specifications.
  const lengthRequest = /(?:写|生成|新建|创建|整理|笔记|讲|说|回答|解释|介绍|总结|概括|故事|文章|短文|回复)/u.test(value)
    && !/(?:什么是|是什么意思|多少字|如何统计|怎么算)[^。！？]*$/u.test(value);
  if (length && lengthRequest && !/[“「『"].*[”」』"]/u.test(length.input.slice(0, length.index))) {
    const target = number(length[1]);
    if (target && Number.isSafeInteger(target)) result.characters = /至少|不少于/u.test(length[0]) ? { min: target, max: Infinity }
      : /不超过|最多/u.test(length[0]) ? { min: 1, max: target }
        : /恰好|正好/u.test(length[0]) ? { min: target, max: target }
          : { min: Math.ceil(target * 85 / 100), max: Math.floor(target * 115 / 100) };
  }
  const newNote = explicitCompanionProductRequest(value).newNote;
  if (newNote && result.characters) { result.noteCharacters = result.characters; delete result.characters; }
  if (canCreateNotes && newNote) {
    const count = new RegExp(`${numeral}\\s*(?:篇|份)[^。！？\\n]{0,14}笔记`, "u").exec(value);
    const target = count ? number(count[1]) : null;
    if (target && Number.isSafeInteger(target)) result.noteCount = target;
  }
  return result;
}

export function companionVisibleCharacterCount(text: string): number {
  return Array.from(stripVoiceExpressionTags(text).replace(/```[\s\S]*?```/gu, "")
    .replace(/^ {0,3}#{1,6}\s+.*$/gmu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/<[^>]*>/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")).length;
}

export function companionRequirementGuidance(requirements: CompanionRequestRequirements): string {
  const length = requirements.noteCharacters ?? requirements.characters;
  return [requirements.noteCount ? `本轮需要 ${requirements.noteCount} 篇不同笔记，以真实保存回执核对数量。完成第一篇正文就调用 companion_notes_write（action=create），拿到回执再写下一篇；不预写后面几篇，不用聊天正文代替保存。已保存的笔记不要再建。` : "",
    requirements.utteranceCount ? `本轮需要 ${requirements.utteranceCount} 条独立消息，用 companion_say（action=publish）的真实发布回执核对。每条只承担用户指定的内容，最后一条 final=true，不以连续正文或一条消息替代。` : "",
    requirements.requiredTools?.length ? `用户明确要求使用工具核对，本轮必须取得 ${requirements.requiredTools.join("、")} 的成功回执后才能交付核对结论。` : "",
    length ? `${requirements.noteCharacters ? "每篇笔记正文" : "本轮正文"}的篇幅为 ${length.min}–${Number.isFinite(length.max) ? length.max : "不限"} 字，按不含标点、空白、Markdown 符号的可见文字统计；标题与标点不能充当正文字数。直接按篇幅写出完整正文与结尾，宿主会在保存前核对长度，不需要在推理中逐字计数。` : "",
  ].filter(Boolean).join("\n");
}

/** Count durable publication identities, including checkpoint-replayed receipts. */
export function companionPublishedUtterances(messages: AgentTurnRequest["messages"]): { count: number; pending: boolean } {
  // Only this request's publications count. Earlier turns also contain published
  // messages; counting them would let an old turn satisfy a new split request.
  let boundary = messages.length - 1;
  while (boundary >= 0 && messages[boundary].role !== "user") boundary -= 1;
  const current = boundary < 0 ? messages : messages.slice(boundary);
  // Publication receipts key on the operation, not the model-facing name, so
  // any call that publishes is counted the same way.
  const calls = new Map(current.flatMap(message => message.role === "assistant"
    ? (message.toolCalls ?? []).filter(call => isCompanionPublicationCall({ name: call.name, arguments: call.arguments }))
      .map(call => [call.id, call] as const) : []));
  const delivered = new Set<string>();
  let pending = false;
  for (const message of current) {
    const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
    if (message.role !== "tool" || !call || typeof message.content !== "string") continue;
    try {
      const receipt = JSON.parse(message.content);
      const value = receipt.data ?? (typeof receipt.resultRef === "string" ? JSON.parse(receipt.resultRef) : null);
      if (receipt.ok !== true || value?.published !== true || typeof value.messageId !== "string" || delivered.has(value.messageId)) continue;
      delivered.add(value.messageId);
      pending = companionPublicationFinal({ name: call.name, arguments: call.arguments }) === false;
    } catch { /* A missing or malformed receipt cannot prove publication. */ }
  }
  return { count: delivered.size, pending };
}

export function companionUtteranceRequirementIssue(requirements: CompanionRequestRequirements, messages: AgentTurnRequest["messages"]) {
  const { count: deliveredCount, pending } = companionPublishedUtterances(messages);
  if (requirements.utteranceCount && deliveredCount < requirements.utteranceCount) return {
    key: `utterances:${requirements.utteranceCount}:${deliveredCount}`,
    instruction: `用户要求 ${requirements.utteranceCount} 条独立消息，真实发布只有 ${deliveredCount} 条。继续调用 companion_say（action=publish）交付剩余 ${requirements.utteranceCount - deliveredCount} 条，最后一条 final=true；不要重复已发内容，不用普通最终正文代替消息。`,
  };
  if (!requirements.utteranceCount && pending) return { key: `utterance-pending:${deliveredCount}`,
    instruction: "上一条实际发言标为 final=false，这轮还未交付完。请用 companion_say（action=publish）继续发布尚未说出的内容，最后一条 final=true；不重复已发内容，不用普通最终正文代替。" };
  return null;
}

/**
 * Delivery shape judged from the request itself, without a phrase list.
 *
 * `delivered` counts the separate messages the user has actually received:
 * published utterances plus ordinary reply text that already reached the chat.
 * Counting the paragraph means a reply that arrived as one block is "1 of 2",
 * so the correction asks only for what is still missing instead of repeating
 * what the user just read. A pending `final=false` publication is unfinished
 * regardless of count, because that line announced more.
 */
export function companionSplitShapeIssue(input: {
  count: number; delivered: number; pending: boolean; textShown?: boolean;
}): { key: string; instruction: string } | null {
  const delivered = input.delivered + (input.textShown === true ? 1 : 0);
  const remaining = input.count - delivered;
  if (remaining <= 0 && !input.pending) return null;
  return {
    key: `split-shape:${input.count}:${delivered}${input.pending ? ":pending" : ""}`,
    instruction: remaining > 0
      ? `用户要把回复拆成 ${input.count} 条独立消息，目前已经收到 ${delivered} 条。`
        + (input.textShown === true ? "刚才那一整段用户已经看到，不要再说一遍。" : "")
        + `把还没说的 ${remaining} 条用 companion_say（action=publish）逐条发出，每条只承担一个意思，最后一条 final=true；不要改用一整段正文代替。`
      : "上一条发言标了 final=false，这轮还没说完。用 companion_say（action=publish）发下一条，最后一条 final=true；不重复已发内容。",
  };
}

export function companionRequirementIssue(requirements: CompanionRequestRequirements, text: string,
  messages: AgentTurnRequest["messages"] = []): { key: string; instruction: string } | null {
  const speech = companionUtteranceRequirementIssue(requirements, messages);
  if (speech) return speech;
  for (const tool of requirements.requiredTools ?? []) {
    const ids = new Set(messages.flatMap((message) => message.role === "assistant"
      ? message.toolCalls?.filter((call) => call.name === tool || companionOperationName(call) === tool).map((call) => call.id) ?? [] : []));
    const succeeded = messages.some((message) => {
      if (message.role !== "tool" || !message.toolCallId || !ids.has(message.toolCallId) || typeof message.content !== "string") return false;
      try { return JSON.parse(message.content).ok === true; } catch { return false; }
    });
    if (!succeeded) return { key: `tool:${tool}`, instruction: `当前用户明确要求用计算工具核对，但尚无 ${tool} 的成功回执。请先实际调用该工具，再给出结果；不能用心算或“未核验”代替已获授权的工具操作。` };
  }
  if (requirements.noteCount) {
    const saved = new Set<string>();
    for (const message of messages) {
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      try {
        const receipt = JSON.parse(message.content);
        if (receipt.ok !== true) continue;
        // Fresh executions add a model-facing status; resumed executions carry
        // the durable result_ref. Validate the same durable receipt in both cases.
        let value = receipt.data;
        if (value && typeof value === "object" && !Array.isArray(value) && "status" in value) {
          const { status, ...saved } = value;
          if (status !== "succeeded") continue;
          value = saved;
        }
        if (value == null && typeof receipt.resultRef === "string") value = JSON.parse(receipt.resultRef);
        const note = companionCreatedNoteV1Schema.safeParse(value);
        if (note.success) saved.add(note.data.noteId);
      } catch { /* Unrelated or malformed evidence is not a saved note. */ }
    }
    if (saved.size < requirements.noteCount) return { key: `notes:${requirements.noteCount}:${[...saved].sort().join(",")}`,
      instruction: `当前请求需要保存 ${requirements.noteCount} 篇不同笔记，真实回执只有 ${saved.size} 篇。只完成剩余 ${requirements.noteCount - saved.size} 篇；保留已保存身份，不重建、不重写，不用一段回复冒充笔记。若权限、确认或故障阻止保存，如实说明未完成部分。` };
  }
  if (requirements.characters) {
    const count = companionVisibleCharacterCount(text), { min, max } = requirements.characters;
    if (count < min || count > max) return { key: `characters:${min}:${max}`,
      instruction: `当前正文按不含标点与空白统计为 ${count} 字，未满足当前请求的篇幅（${min}–${Number.isFinite(max) ? max : "不限"} 字）。请当场交付符合篇幅的完整正文和结尾，勿只写承诺或把后半段留给下一轮。保留当前主题、人物、对象和原始要求；不要重复执行任何已完成操作。` };
  }
  return null;
}
