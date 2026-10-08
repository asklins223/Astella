import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildCompanionPersonaMessages, buildFinalCuePayload, sanitizeCompanionVisibleText } from "../companion-dialogue-content.ts";
import { companionVisibleText, createCompanionStreamDelivery } from "../companion-dialogue-stream.ts";
import { companionVoiceExpressionBoundaries, companionVoiceSegmentExpression, projectCompanionVoiceExpression } from "../companion-voice-expression.ts";
import { splitCommittedDisplaySegments } from "../../lib/tts-segments.ts";
import type { ReadContext } from "../companion-dialogue-store.ts";
import { resolveCompanionPersonaContext } from "../companion-identity-context.ts";

const speak = (raw: string, enabled = true) => {
  const expression = projectCompanionVoiceExpression(raw);
  const split = splitCommittedDisplaySegments(expression.displayText, { cursor: 0, sentCount: 0 }, true, {
    maxSegmentChars: 112, expressionBoundaries: companionVoiceExpressionBoundaries(expression),
  });
  return { expression, segments: split.segments.map(segment => ({ ...segment,
    ...companionVoiceSegmentExpression(expression, segment, enabled) })) };
};

test("emotion follows model expression even when the words resemble the old keyword rules", () => {
  const { segments } = speak("[empathetic]辛苦了，能坚持到这里已经很棒了。[serious]这个错误的原因是变量还没有初始化。");
  assert.deepEqual(segments.map(segment => segment.cue.emotion), ["concerned", "neutral"]);
  assert.equal(segments[0]!.text, "[empathetic]辛苦了，能坚持到这里已经很棒了。");
  assert.equal(segments[1]!.text, "[serious]这个错误的原因是变量还没有初始化。");
  assert.equal(buildFinalCuePayload("恭喜！通过了！为什么？辛苦了。").emotion, "neutral");
  assert.equal(buildFinalCuePayload("[happy]恭喜！").emotion, "neutral");
});

test("rich sounds keep their positions, clean history, and synthesis hashes", () => {
  const { expression, segments } = speak("[mischievously]这个比喻还挺贴切。[giggles]一下就记住了。[neutral]接着看下一段吧。");
  assert.equal(expression.displayText, "这个比喻还挺贴切。一下就记住了。接着看下一段吧。");
  assert.equal(segments[1]!.text, "[mischievously][giggles]一下就记住了。");
  assert.equal(segments[2]!.text, "接着看下一段吧。");
  assert.equal(segments[2]!.cue.emotion, "neutral");
  for (const segment of segments) assert.equal(segment.textSha256, createHash("sha256").update(segment.text).digest("hex"));
});

test("a control change splits a clause and repeated TTS tasks inherit only the active control", () => {
  const { segments } = speak("[excited]太好了，[empathetic]不过你已经很累了，先休息。[serious]明天再认真核对。还有一处条件。");
  assert.deepEqual(segments.map(segment => segment.text), ["[excited]太好了，", "[empathetic]不过你已经很累了，先休息。",
    "[serious]明天再认真核对。", "[serious]还有一处条件。"]);
});

test("voice expression off strips model-authored controls AND rich sounds", () => {
  const { segments } = speak("[excited]恭喜你！[giggles]今晚好好休息。", false);
  assert.deepEqual(segments.map(segment => segment.text), ["恭喜你！", "今晚好好休息。"]);
  assert.ok(segments.every(segment => segment.cue.emotion === "neutral"));
});

test("fact substitution and markdown do not displace expression ranges", () => {
  const expression = projectCompanionVoiceExpression("[serious]今天是 {{f:today_minutes}} 分钟。\n[empathetic]**先歇一下**，好吗？", { today_minutes: "25" });
  const split = splitCommittedDisplaySegments(expression.displayText, { cursor: 0, sentCount: 0 }, true, {
    expressionBoundaries: companionVoiceExpressionBoundaries(expression),
  });
  const segments = split.segments.map(segment => companionVoiceSegmentExpression(expression, segment));
  assert.equal(segments[0]!.text, "[serious]今天是 25 分钟。");
  assert.equal(segments[1]!.text, "[empathetic]先歇一下 ，好吗？");
});

test("split tags stream cleanly without waiting for the whole line or exposing a half tag", () => {
  const source = "[empathetic]辛苦了，能坚持到这里已经很棒了。[neutral]先休息一下吧。";
  let previous = "";
  for (let index = 1; index <= source.length; index += 1) {
    const visible = companionVisibleText(source.slice(0, index));
    assert.ok(visible.startsWith(previous), `${index}: ${previous} -> ${visible}`);
    assert.ok(!visible.includes("["));
    previous = visible;
  }
  assert.equal(previous, sanitizeCompanionVisibleText(source));
  assert.equal(companionVisibleText("[excited]恭喜你！正在接着解释"), "恭喜你！正在接着解释");
  assert.equal(sanitizeCompanionVisibleText("你好。[excite"), "你好。");
});

test("long replies retain every display word and bounded synthesis text", () => {
  const raw = "[empathetic]" + "长内容".repeat(120) + "。[serious]" + "解释".repeat(120) + "。";
  const { expression, segments } = speak(raw);
  assert.equal(segments.map(segment => segment.displayText).join(""), expression.displayText);
  assert.ok(segments.every(segment => segment.text.length <= 160));
  assert.ok(segments.slice(0, 4).every(segment => segment.text.startsWith("[empathetic]")));
});

test("expression prefixes do not make headings, list syntax, or split code blocks audible", () => {
  const { segments } = speak("[serious]### 先看原理\n- 第一步。\n```ts\nconst secret = 1;\nconsole.log(secret);\n```\n[empathetic]再慢慢试。");
  const spoken = segments.map(segment => segment.text).join(" ");
  assert.ok(!/[#`]/.test(spoken));
  assert.ok(!spoken.includes("const") && !spoken.includes("console"));
  assert.ok(spoken.includes("先看原理") && spoken.includes("第一步") && spoken.includes("再慢慢试"));
});

test("committed delivery passes raw expression while deltas and final history stay identical", async () => {
  const written: string[] = [];
  const spoken: string[] = [];
  let state = { cursor: 0, sentCount: 0 };
  const read = { runId: "run", conversationId: "conversation", generation: 1, accountEpoch: 1, userId: "user" } as unknown as ReadContext;
  const delivery = createCompanionStreamDelivery({
    ctx: { workspaceId: "workspace" }, read,
    job: { id: "job", workspaceId: "workspace", requestedBy: "user", leaseToken: "lease" },
    expiresAt: new Date().toISOString(), notifyCompanionEvent: async () => undefined,
    flushChars: 1, flushIntervalMs: 0,
    writeVisible: async text => { written.push(text); return true; },
    onVisibleCommitted: async (_chunk, visible, modelText) => {
      const expression = projectCompanionVoiceExpression(modelText);
      const split = splitCommittedDisplaySegments(visible, state, false, { expressionBoundaries: companionVoiceExpressionBoundaries(expression) });
      state = split.next;
      spoken.push(...split.segments.map(segment => companionVoiceSegmentExpression(expression, segment).text));
    },
  });
  for (const chunk of ["[em", "pathetic]先休息一下吧。", "[gig", "gles]我们明天再接着来。", "[neutral]晚安。"])
    assert.equal(await delivery.onRawDelta(chunk), true);
  const finished = await delivery.finish();
  assert.ok(finished.ok);
  assert.equal(written.join(""), "先休息一下吧。我们明天再接着来。晚安。");
  assert.ok(spoken[1]!.includes("[giggles]"));
  assert.equal(buildFinalCuePayload(delivery.modelText()).emotion, "neutral");
});

test("a repaired/buffered tail carries its own expression before being spoken", async () => {
  const modelSnapshots: string[] = [];
  const delivery = createCompanionStreamDelivery({
    ctx: { workspaceId: "workspace" }, read: {} as ReadContext,
    job: { id: "job", workspaceId: "workspace", requestedBy: "user", leaseToken: "lease" },
    expiresAt: new Date().toISOString(), notifyCompanionEvent: async () => undefined,
    flushChars: 1, flushIntervalMs: 0, writeVisible: async () => true,
    onVisibleCommitted: async (_chunk, _visible, raw) => { modelSnapshots.push(raw); },
  });
  await delivery.onRawDelta("[neutral]先看一下。");
  await delivery.finish();
  assert.equal(await delivery.writeTail("先看一下。原来是这样。", "[neutral]先看一下。[amazed]原来是这样。"), true);
  assert.equal(modelSnapshots.at(-1), "[neutral]先看一下。[amazed]原来是这样。");
});

test("real generation context includes expression protocol and respects the user boundary", () => {
  const input = { userText: "你好", recentMessages: [], pageContext: null };
  const system = String(buildCompanionPersonaMessages(input)[0]!.content);
  assert.match(system, /声音表达协议/);
  assert.match(system, /\[giggles\]/);
  assert.match(system, /历史回复中的标记已由宿主剥除/);
  const persona = resolveCompanionPersonaContext(null);
  const off = String(buildCompanionPersonaMessages({ ...input, petProfile: { ...persona, boundaries: { ...persona.boundaries, allowVoiceTags: false } } })[0]!.content);
  assert.match(off, /声音表达已关闭/);
  assert.doesNotMatch(off, /声音表达协议：/);
});


test("web references stay in display ranges but never enter speech, including across hard splits", () => {
  const raw = "先看列表。[^web-1234567890abcdef]再看元组。[^web-fedcba0987654321]两种都可以保存有序数据。[^web-3c284a008b00842]";
  const expression = projectCompanionVoiceExpression(raw);
  const { segments } = splitCommittedDisplaySegments(expression.displayText, { cursor: 0, sentCount: 0 }, true, { maxSegmentChars: 10 });
  const spoken = segments.map(segment => companionVoiceSegmentExpression(expression, segment, false).text).join("");
  assert.equal(spoken, "先看列表。再看元组。两种都可以保存有序数据。");
  assert.equal(expression.displayText, raw);
  assert.equal(segments.at(-1)?.displayEnd, raw.length);
  assert.equal(sanitizeCompanionVisibleText("解释[^web-12345"), "解释");
});
