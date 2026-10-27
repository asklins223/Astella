import { z } from "zod";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { extractJsonFromText } from "../../lib/providers/json-response.ts";
import { logger } from "../../lib/logger.ts";
import { watchCompanionOutput } from "../agent/companion-output-watchdog.ts";

/**
 * "Does this turn ask for separate messages?" as a tiny closed-set call.
 *
 * This decides one thing: whether the delivered reply should arrive as several
 * chat bubbles. The reply itself is written by the model as usual; the split is
 * a parsing/presentation step on our side, exactly where it lives in Muse's own
 * protocol (channel markers resolved by the backend parser, not by the UI).
 *
 * It reads the request, not a phrase list: paraphrases, indirect wording and
 * other languages all reach the same question.
 */
const verdictSchema = z.object({
  decision: z.enum(["single", "split", "unsure"]),
  // Advisory only; the real count is what the reply actually contains.
  messages: z.number().int().optional(),
});

export interface CompanionSplitVerdict {
  readonly decision: "single" | "split" | "unsure";
  /** Requested number of separate messages, when the user named one. */
  readonly messages?: number;
}

export const COMPANION_SPLIT_MESSAGES_DEFAULT = 2;
export const COMPANION_SPLIT_MESSAGES_MAX = 6;

export function companionSplitMessageCount(verdict: CompanionSplitVerdict): number {
  const requested = verdict.messages;
  if (!Number.isFinite(requested)) return COMPANION_SPLIT_MESSAGES_DEFAULT;
  return Math.min(COMPANION_SPLIT_MESSAGES_MAX, Math.max(2, Math.trunc(requested as number)));
}

export function companionSplitIntentMessages(userText: string) {
  return [
    { role: "system" as const, content: [
      "判断用户这条消息是否要求把回复拆成多条独立消息。只返回 JSON：{\"decision\":\"split\"|\"single\"|\"unsure\",\"messages\":数字}。",
      "split：要求分条、分几条、分开说、一条一条发、别用一整段、拆成两条（含同义或间接说法）。messages 填用户要求的条数；没说具体条数就填 2。",
      "single：没有这种要求。",
      "unsure：拿不准。宁可 unsure，也不要漏掉分条要求。",
    ].join("\n") },
    { role: "user" as const, content: userText },
  ];
}

export function parseCompanionSplitIntent(raw: string): CompanionSplitVerdict {
  try {
    const parsed = verdictSchema.parse(extractJsonFromText(raw, ["decision"]));
    return { decision: parsed.decision, ...(parsed.messages === undefined ? {} : { messages: parsed.messages }) };
  } catch {
    return { decision: "unsure" };
  }
}

/** Never throws; unavailable judging returns null and normal delivery continues. */
export async function judgeCompanionSplitIntent(input: {
  userText: string | undefined; provider: AIProvider; signal: AbortSignal; runId: string;
}): Promise<CompanionSplitVerdict | null> {
  const text = input.userText?.trim();
  if (!text) return null;
  try {
    const response = await watchCompanionOutput(signal => input.provider.chatCompletion(
      companionSplitIntentMessages(text),
      { temperature: 0, responseFormat: "json_object", disableThinking: true, maxTokens: 256 }, signal), input.signal);
    const verdict = parseCompanionSplitIntent(response.content ?? "");
    logger.info({ runId: input.runId, decision: verdict.decision, messages: verdict.messages },
      "companion split intent judged");
    return verdict;
  } catch (error) {
    logger.warn({ runId: input.runId, error: error instanceof Error ? error.name : "unknown" },
      "companion split intent judge unavailable; keeping normal delivery");
    return null;
  }
}

/**
 * Cut one reply into the separate messages it already contains.
 *
 * A model that is asked to "say it in two messages" writes both of them in one
 * reply, separated by a blank line — measured 10/10 in both the plain and the
 * tool-enabled shapes. Reading that boundary is the same move Muse's parser
 * makes on its channel markers: decide where one message ends and the next
 * begins, then deliver them as separate messages.
 *
 * Blank lines inside a fenced code block are not boundaries; extra paragraphs
 * beyond `limit` join the last message so nothing is dropped or reordered.
 */
export function splitCompanionReplyParts(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) parts.push(value);
    current = [];
  };
  for (const line of trimmed.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      current.push(line);
      continue;
    }
    if (marker) {
      fence = marker[1];
      current.push(line);
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    current.push(line);
  }
  flush();
  if (parts.length <= 1) return parts;
  const keep = Math.max(2, Math.min(parts.length, Math.trunc(limit)));
  if (parts.length <= keep) return parts;
  return [...parts.slice(0, keep - 1), parts.slice(keep - 1).join("\n\n")];
}

/**
 * The message drafts for one reply: one entry per delivered message.
 *
 * Rich blocks (citations, saved-note cards, navigation) attach to the last
 * entry only, because they trail the reply — a list of results must never sit
 * between two sentences she said separately.
 */
export function companionReplyMessageDrafts(input: {
  parts: readonly string[];
  richBlocks: readonly Record<string, unknown>[];
  emotion: string;
  hash: (value: unknown) => string;
  newId: () => string;
  maxRichBlocks?: number;
}): Array<{ id: string; text: string; blocks: Array<Record<string, unknown>>; contentSha256: string }> {
  const parts = input.parts.length > 0 ? input.parts : [""];
  return parts.map((text, index) => {
    const last = index === parts.length - 1;
    const blocks = [
      { type: "text", text, emotion: input.emotion },
      ...(last ? input.richBlocks.slice(0, input.maxRichBlocks ?? 32) : []),
    ];
    return { id: input.newId(), text, blocks, contentSha256: input.hash(blocks) };
  });
}
