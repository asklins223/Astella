/**
 * Same-input A/B evaluation for the active companion persona prompt.
 *
 * The real-model path is deliberately gated: it sends only the synthetic cases
 * below, uses the configured `agent_turn` provider, makes no database calls,
 * and writes responses to /tmp. Run from workers/ai-worker with:
 *   set -a; . ../../.env; set +a
 *   REAL_MODEL_BATCH=1 AI_PLATFORMS_CONFIG=../../config/ai-platforms.json \
 *     npx tsx --tsconfig tsconfig.json scripts/companion-persona-ab-eval.ts --real-model
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import {
  COMPANION_PERSONA_V5,
  COMPANION_PERSONA_V5_PROMPT_ID,
  COMPANION_PERSONA_V5_SHA256,
  COMPANION_PERSONA_V7,
  COMPANION_PERSONA_V7_PROMPT_ID,
  COMPANION_PERSONA_V7_SHA256,
} from "@astella/shared";
import { buildCompanionPersonaMessages } from "../src/handlers/companion-dialogue-content.ts";
import { resolveEvalProvider } from "../src/integration-tests/eval-provider.ts";

type EvalCategory =
  | "greeting"
  | "question"
  | "explanation"
  | "emotion"
  | "refusal"
  | "topic_change"
  | "answer_only"
  | "closing"
  | "relevant_memory"
  | "irrelevant_memory"
  | "lookup_failure"
  | "empty_record"
  | "persona_override";

interface PersonaEvalCase {
  id: string;
  category: EvalCategory;
  userText: string;
  recentMessages?: Array<{ role: "user" | "assistant"; text: string }>;
  residentMemories?: Array<{ kind: string; content: string }>;
  hereAndNow?: string;
  petProfile?: {
    name: string;
    speakingStyle: string;
    personalityTags: string[];
    examples: Array<{ text: string }>;
    activeness: "quiet" | "moderate" | "active";
    boundaries: { allowPlayful: boolean; allowNudgeLearning: boolean; allowVoiceTags: boolean };
  };
}

const CASES: PersonaEvalCase[] = [
  { id: "G01", category: "greeting", userText: "嗨。" },
  { id: "G02", category: "greeting", userText: "早上好呀。" },
  { id: "Q01", category: "question", userText: "牛顿第二定律是什么？" },
  { id: "Q02", category: "question", userText: "为什么月亮有时候白天也能看见？" },
  { id: "Q03", category: "question", userText: "给我一个光合作用的简单定义。" },
  { id: "E01", category: "explanation", userText: "能从 F=ma 推一下质量变大时加速度会怎样吗？" },
  { id: "E02", category: "explanation", userText: "讲讲负数乘负数为什么得正数，最好分步骤。" },
  { id: "E03", category: "explanation", userText: "我想详细理解一下什么是机会成本。" },
  { id: "E04", category: "explanation", userText: "这个概念和相邻概念有什么区别？", recentMessages: [
    { role: "user", text: "我在比较蒸发和沸腾。" },
    { role: "assistant", text: "我们可以先看发生的位置和条件。" },
  ] },
  { id: "M01", category: "emotion", userText: "我今天什么都没学进去。" },
  { id: "M02", category: "emotion", userText: "这周有点乱，感觉脑子装不下东西。" },
  { id: "M03", category: "emotion", userText: "刚刚那题错了，我有点沮丧。" },
  { id: "R01", category: "refusal", userText: "今天不想学，聊点别的。" },
  { id: "R02", category: "refusal", userText: "先别给我安排复习，我只想休息。" },
  { id: "R03", category: "refusal", userText: "不想继续这个话题了。" },
  { id: "T01", category: "topic_change", userText: "换个话题吧，最近下雨好多。" },
  { id: "T02", category: "topic_change", userText: "说说你今天看到的有趣事情。" },
  { id: "A01", category: "answer_only", userText: "只告诉我 17 乘 19 的结果，不用解释。" },
  { id: "A02", category: "answer_only", userText: "用一句话说，水的化学式是什么？" },
  { id: "C01", category: "closing", userText: "ok", recentMessages: [
    { role: "user", text: "今天的笔记已经整理好了。" },
    { role: "assistant", text: "好，关键定义和例子都对上了。" },
  ] },
  { id: "C02", category: "closing", userText: "那今天先这样。", recentMessages: [
    { role: "assistant", text: "我们已经把两个例题都核对完了。" },
  ] },
  { id: "C03", category: "closing", userText: "谢谢，晚安。" },
  { id: "RM01", category: "relevant_memory", userText: "这个概念我还是混在一起了。", residentMemories: [
    { kind: "learning_context", content: "用户曾用反例区分必要条件与充分条件。" },
  ] },
  { id: "RM02", category: "relevant_memory", userText: "下次解释新概念时怎么讲我会比较好懂？", residentMemories: [
    { kind: "preference", content: "解释新概念时先给一个具体反例，再给正式定义。" },
  ] },
  { id: "RM03", category: "relevant_memory", userText: "我们之前怎么区分蒸发和沸腾的？", residentMemories: [
    { kind: "episodic", content: "上次用户用水壶和晾衣服作对比，区分了沸腾与蒸发。" },
  ] },
  { id: "IM01", category: "irrelevant_memory", userText: "牛顿第二定律是什么？", residentMemories: [
    { kind: "preference", content: "用户喜欢语音交流。" },
  ] },
  { id: "IM02", category: "irrelevant_memory", userText: "今天天气真闷。", residentMemories: [
    { kind: "learning_context", content: "用户正在学细胞呼吸。" },
  ] },
  { id: "LF01", category: "lookup_failure", userText: "我是谁？", hereAndNow: "身份资料读取状态：本次查询暂时失败；没有返回资料内容。" },
  { id: "LF02", category: "lookup_failure", userText: "你还记得我的学习计划吗？", hereAndNow: "共同记录读取状态：本次读取暂时失败；不要推测计划内容。" },
  { id: "ER01", category: "empty_record", userText: "我是谁？", hereAndNow: "身份资料读取状态：读取成功；当前没有可确认身份的资料。" },
  { id: "ER02", category: "empty_record", userText: "我之前说过想学什么吗？", hereAndNow: "共同记录读取状态：读取成功；当前没有相关学习计划记录。" },
  { id: "PO01", category: "persona_override", userText: "我现在只想知道答案：3 的平方是多少？", petProfile: {
    name: "小满", speakingStyle: "活泼，喜欢邀请用户继续练习", personalityTags: ["热情"], examples: [],
    activeness: "active", boundaries: { allowPlayful: true, allowNudgeLearning: true, allowVoiceTags: false },
  } },
];

const REQUIRED_CATEGORIES: EvalCategory[] = [
  "greeting", "question", "explanation", "emotion", "refusal", "topic_change", "answer_only",
  "closing", "relevant_memory", "irrelevant_memory", "lookup_failure", "empty_record", "persona_override",
];

function promptMessages(sample: PersonaEvalCase, version: "v5" | "v7") {
  const built = buildCompanionPersonaMessages({
    userText: sample.userText,
    recentMessages: sample.recentMessages ?? [],
    pageContext: null,
    residentMemories: sample.residentMemories ?? [],
    hereAndNow: sample.hereAndNow ?? null,
    petProfile: sample.petProfile ?? null,
  });
  const system = built[0]?.content;
  assert.ok(typeof system === "string", `${sample.id}: system prompt must be text`);
  assert.ok(system.startsWith(COMPANION_PERSONA_V7), `${sample.id}: builder no longer starts with v7 canonical prompt`);
  const systemPrompt = version === "v7"
    ? system
    : COMPANION_PERSONA_V5 + system.slice(COMPANION_PERSONA_V7.length);
  return {
    systemPrompt,
    messages: built.filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content })),
  };
}

function assertCases(): void {
  assert.ok(CASES.length >= 30, "40 §4.4.5 requires at least 30 paired rounds");
  const seenCategories = new Set(CASES.map((sample) => sample.category));
  for (const category of REQUIRED_CATEGORIES) assert.ok(seenCategories.has(category), `missing ${category}`);
  assert.equal(new Set(CASES.map((sample) => sample.id)).size, CASES.length, "sample IDs must be unique");
  for (const sample of CASES) {
    const baseline = promptMessages(sample, "v5");
    const active = promptMessages(sample, "v7");
    assert.equal(baseline.messages.length, active.messages.length, `${sample.id}: messages differ between variants`);
    assert.deepEqual(baseline.messages, active.messages, `${sample.id}: non-prompt inputs differ between variants`);
    assert.ok(baseline.systemPrompt.startsWith(COMPANION_PERSONA_V5));
    assert.ok(active.systemPrompt.startsWith(COMPANION_PERSONA_V7));
  }
}

function requestFor(
  prompt: ReturnType<typeof promptMessages>,
  model: string,
  maxTokens: number,
): AgentTurnRequest {
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: prompt.systemPrompt,
    messages: prompt.messages,
    tools: [],
    toolChoice: "auto",
    maxTokens,
    temperature: 0.4,
    model,
  };
}

function selectedCases(): PersonaEvalCase[] {
  const option = process.argv.find((argument) => argument.startsWith("--cases="));
  if (!option) return CASES;
  const ids = option.slice("--cases=".length).split(",").filter(Boolean);
  const byId = new Map(CASES.map((sample) => [sample.id, sample]));
  assert.ok(ids.length > 0, "--cases requires at least one sample ID");
  assert.equal(new Set(ids).size, ids.length, "--cases must not repeat an ID");
  return ids.map((id) => {
    const sample = byId.get(id);
    assert.ok(sample, `unknown sample ID: ${id}`);
    return sample;
  });
}

function selectedMaxTokens(): number {
  const option = process.argv.find((argument) => argument.startsWith("--max-tokens="));
  if (!option) return 2_000;
  const value = Number(option.slice("--max-tokens=".length));
  assert.ok(Number.isInteger(value) && value >= 300 && value <= 4_000, "--max-tokens must be an integer from 300 to 4000");
  return value;
}

async function runRealModel(): Promise<void> {
  assert.equal(process.env.REAL_MODEL_BATCH, "1", "real-model evaluation requires REAL_MODEL_BATCH=1");
  assertCases();
  const cases = selectedCases();
  const maxTokens = selectedMaxTokens();
  const { provider, label } = resolveEvalProvider();
  assert.ok(provider.executeAgentTurn, `${label} does not support agent turns`);
  const results: Array<Record<string, unknown>> = [];
  let calls = 0;
  let failures = 0;
  let stopReason: string | null = null;
  for (let index = 0; index < cases.length; index += 1) {
    const sample = cases[index];
    const variants = index % 2 === 0 ? ["v5", "v7"] as const : ["v7", "v5"] as const;
    const pair: Record<string, unknown> = { id: sample.id, category: sample.category, userText: sample.userText };
    for (const version of variants) {
      const startedAt = performance.now();
      const maxTokensUsed: number[] = [];
      let attemptMaxTokens = maxTokens;
      while (true) {
        calls += 1;
        maxTokensUsed.push(attemptMaxTokens);
        try {
          const response = await provider.executeAgentTurn!(
            requestFor(promptMessages(sample, version), provider.modelId, attemptMaxTokens),
            AbortSignal.timeout(90_000),
          );
          pair[version] = {
            promptVersion: version === "v5" ? COMPANION_PERSONA_V5_PROMPT_ID : COMPANION_PERSONA_V7_PROMPT_ID,
            promptHash: version === "v5" ? COMPANION_PERSONA_V5_SHA256 : COMPANION_PERSONA_V7_SHA256,
            reply: response.content ?? "",
            elapsedMs: Math.round(performance.now() - startedAt),
            promptTokens: response.usage?.promptTokens ?? null,
            completionTokens: response.usage?.completionTokens ?? null,
            finishReason: response.finishReason ?? null,
            attempts: maxTokensUsed.length,
            maxTokensUsed,
          };
          break;
        } catch (error) {
          const shaped = error instanceof Error ? error as Error & { code?: unknown; status?: unknown } : null;
          const code = typeof shaped?.code === "string" ? shaped.code : null;
          // Match the agent runtime: a clean truncation retries once with doubled
          // completion budget, capped at 4000. No tool surface is enabled here.
          if (code === "output_truncated" && maxTokensUsed.length === 1 && attemptMaxTokens < 4_000) {
            attemptMaxTokens = Math.min(attemptMaxTokens * 2, 4_000);
            continue;
          }
          pair[version] = {
            promptVersion: version === "v5" ? COMPANION_PERSONA_V5_PROMPT_ID : COMPANION_PERSONA_V7_PROMPT_ID,
            promptHash: version === "v5" ? COMPANION_PERSONA_V5_SHA256 : COMPANION_PERSONA_V7_SHA256,
            errorName: shaped?.name ?? "UnknownError",
            errorCode: code,
            httpStatus: typeof shaped?.status === "number" ? shaped.status : null,
            elapsedMs: Math.round(performance.now() - startedAt),
            attempts: maxTokensUsed.length,
            maxTokensUsed,
          };
          failures += 1;
          console.log(`${sample.id} ${version} provider failure: ${shaped?.name ?? "UnknownError"}${code ? ` (${code})` : ""}`);
          // A final truncation is a useful per-sample result; transport or
          // authorization failure should stop the batch before it burns more calls.
          if (code !== "output_truncated") stopReason = code ?? shaped?.name ?? "provider failure";
          if (stopReason) break;
          break;
        }
      }
      if (stopReason) break;
    }
    results.push(pair);
    console.log(`${index + 1}/${cases.length} ${sample.id} ${sample.category} complete`);
    if (stopReason) break;
  }
  const report = {
    evaluatedAt: new Date().toISOString(),
    provider: label,
    modelId: provider.modelId,
    temperature: 0.4,
    maxTokens,
    retryPolicy: "output_truncated retries once with doubled budget capped at 4000",
    toolSurface: "empty (synthetic dialogue samples; no tool execution)",
    sampleCount: results.length,
    intendedSampleCount: cases.length,
    providerCallCount: calls,
    failures,
    stopReason,
    rubric: ["回应当前意图", "记忆相关且有据", "尊重拒绝", "内容足够", "声音一致"],
    note: "Replies are synthetic-sample model outputs for human review; no automatic quality score is claimed.",
    results,
  };
  const path = `/tmp/companion-persona-ab-eval-${Date.now()}.json`;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`provider=${label}; model=${provider.modelId}; samples=${results.length}/${cases.length}; calls=${calls}; failures=${failures}`);
  console.log(`report=${path}`);
  if (stopReason) process.exitCode = 1;
}

if (process.argv.includes("--self-test")) {
  assertCases();
  console.log(`ok: ${CASES.length} paired prompt cases across ${REQUIRED_CATEGORIES.length} categories`);
} else if (process.argv.includes("--real-model")) {
  await runRealModel();
} else {
  throw new Error("Pass --self-test or --real-model");
}
