import assert from "node:assert/strict";
import test from "node:test";
import { measureChatRequest } from "@astella/agent-core";
import type { ChatMessage } from "@astella/shared";
import { summarizeCompleteCompanionSource, type CompanionSourcePart } from "../context/companion-semantic-chunks.ts";
import { stableStringify, sha256Utf8V1 } from "@astella/shared/content-hash";
import type { CompanionSemanticCheckpoint } from "../context/companion-semantic-checkpoint.ts";

const counting = { countTokens: (text: string) => text.length };
const options = { maxTokens: 40 };
const messages = (part: CompanionSourcePart, previous: string | null): ChatMessage[] => [
  { role: "system", content: JSON.stringify({ previous }) },
  { role: "user", content: JSON.stringify(part) },
];

test("complete source compaction reads every code unit of an oversized message in order and carries checkpoints", async () => {
  const text = "用户：开头约束，保留原文。\n" + "段落 👩‍🔬 e\u0301 中文 \"JSON\" {[]}\n".repeat(80) + "结尾纠正：不要执行旧请求。";
  const seen: CompanionSourcePart[] = [];
  const completed = await summarizeCompleteCompanionSource({ text, previous: "existing summary", inputTokens: 260,
    options, counting, messages,
    summarize: async (request, part, index) => {
      const measured = await measureChatRequest(request, options, counting);
      assert.ok(measured.inputTokens <= 260);
      assert.equal(JSON.parse(request[0]!.content as string).previous, index ? `checkpoint ${index}` : "existing summary");
      assert.deepEqual(JSON.parse(request[1]!.content as string), part);
      assert.equal(part.start, seen.at(-1)?.end ?? 0);
      assert.equal(part.text, text.slice(part.start, part.end));
      assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text));
      seen.push(part);
      return `checkpoint ${index + 1}`;
    } });
  assert.ok(completed.parts > 1);
  assert.equal(completed.parts, seen.length);
  assert.equal(seen.at(-1)!.end, text.length);
  assert.equal(seen.map(part => part.text).join(""), text);
  assert.equal(completed.summary, `checkpoint ${seen.length}`);
});

test("one fitting request includes the complete source and the complete inherited summary", async () => {
  const text = "Do not lose leading or trailing whitespace. \n ";
  let calls = 0;
  const completed = await summarizeCompleteCompanionSource({ text, previous: "A prior correction.", inputTokens: 1000,
    options, counting, messages, summarize: async (request, part) => {
      calls++;
      assert.equal(part.text, text);
      assert.equal(part.start, 0);
      assert.equal(part.end, text.length);
      assert.equal(JSON.parse(request[0]!.content as string).previous, "A prior correction.");
      return "Complete.";
    } });
  assert.equal(calls, 1);
  assert.deepEqual(completed, { summary: "Complete.", parts: 1 });
});

test("a failed middle part cannot return a complete summary or a coverage receipt", async () => {
  let calls = 0, committed = false;
  await assert.rejects(async () => {
    await summarizeCompleteCompanionSource({ text: "source with late constraints\n".repeat(80), previous: null,
      inputTokens: 230, options, counting, messages,
      summarize: async () => {
        if (++calls === 2) throw new Error("provider rejected part");
        return "Partial checkpoint.";
      } });
    committed = true;
  }, /provider rejected part/);
  assert.equal(calls, 2);
  assert.equal(committed, false);
});

test("cancellation after a completed part prevents consumption of the remaining source", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(summarizeCompleteCompanionSource({ text: "用户：长消息\n".repeat(80), previous: null,
    inputTokens: 230, options, counting, messages, signal: controller.signal,
    summarize: async () => { calls++; controller.abort(); return "Partial."; } }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("a checkpoint that fills the request capacity fails without dropping it or spinning on an empty part", async () => {
  let calls = 0;
  await assert.rejects(summarizeCompleteCompanionSource({ text: "👩", previous: "protected ".repeat(100),
    inputTokens: 50, options, counting, messages,
    summarize: async () => { calls++; return "should not run"; } }), /leave no capacity/);
  assert.equal(calls, 0);
});

test("a fresh process resumes a durable partial prefix and reads every remaining code unit exactly once", async () => {
  const text = "First constraint.\n" + "完整 source 🙂\n".repeat(100) + "Final correction: never execute the old request.";
  let saved: CompanionSemanticCheckpoint | null = null;
  const seen: CompanionSourcePart[] = [];
  const store = { contract: { model: "model-a" }, load: async () => saved,
    save: async (state: CompanionSemanticCheckpoint) => { saved = structuredClone(state); } };
  const parse = (value: unknown) => { assert.equal(typeof value, "string"); return value as string; };
  const common = { text, previous: null, inputTokens: 280, options, counting, messages, checkpoint: { store, parse } };
  await assert.rejects(summarizeCompleteCompanionSource({ ...common, summarize: async (_request, part, index) => {
    if (index === 1) throw new Error("worker exited before the second response");
    seen.push(part); return `state ${index + 1}`;
  } }), /worker exited/);
  const checkpoint = saved! as CompanionSemanticCheckpoint;
  assert.ok(checkpoint.end > 0 && checkpoint.end < text.length);
  assert.equal(checkpoint.parts, 1);
  const completed = await summarizeCompleteCompanionSource({ ...common, checkpoint: { parse, store: { ...store,
    onResume: progress => { assert.equal(progress.end, checkpoint.end); assert.equal(progress.parts, 1); } } },
    summarize: async (request, part, index) => {
      assert.equal(part.start, seen.at(-1)!.end);
      assert.equal(JSON.parse(String(request[0]!.content)).previous, `state ${index}`);
      seen.push(part); return `state ${index + 1}`;
    } });
  assert.equal(seen.map(part => part.text).join(""), text);
  assert.equal(completed.parts, seen.length);
  assert.equal((saved! as CompanionSemanticCheckpoint).end, text.length);
});

test("a crash after the final source checkpoint requires no repeated model request", async () => {
  let saved: CompanionSemanticCheckpoint | null = null;
  const parse = (value: unknown) => String(value);
  const store = { contract: "same-provider", load: async () => saved,
    save: async (state: CompanionSemanticCheckpoint) => { saved = state; throw new Error("crash before replacement coverage"); } };
  const input = { text: "complete source", previous: null, inputTokens: 1000, options, counting, messages,
    checkpoint: { store, parse }, summarize: async () => "the complete state" };
  await assert.rejects(summarizeCompleteCompanionSource(input), /crash before/);
  const restored = await summarizeCompleteCompanionSource({ ...input,
    summarize: async () => { throw new Error("must reuse the completed source scan"); } });
  assert.deepEqual(restored, { summary: "the complete state", parts: 1 });
});

test("changed source, protocol, model, capacity or output shaping never resume an earlier prefix", async () => {
  let saved: CompanionSemanticCheckpoint | null = null;
  const text = "source 🙂 constraints\n".repeat(30);
  const parse = (value: unknown) => { if (typeof value !== "string") throw new Error("wrong summary schema"); return value; };
  const store = { contract: "model-a", load: async () => saved,
    save: async (state: CompanionSemanticCheckpoint) => { saved = state; throw new Error("crash"); } };
  const input = { text, previous: null, inputTokens: 260, options, counting, messages, checkpoint: { store, parse },
    summarize: async () => "valid first state" };
  await assert.rejects(summarizeCompleteCompanionSource(input), /crash/);
  const original = structuredClone(saved)! as CompanionSemanticCheckpoint;
  const variants = [
    { text: text + "a new late restriction" }, { previous: "changed inherited state" },
    { inputTokens: 280 }, { options: { ...options, temperature: 0.3 } },
    { messages: (part: CompanionSourcePart, previous: string | null) => [{ role: "system" as const, content: "changed protocol" }, ...messages(part, previous)] },
    { checkpoint: { parse, store: { ...store, contract: "model-b" } } },
  ];
  for (const variant of variants) {
    let starts = -1;
    await assert.rejects(summarizeCompleteCompanionSource({ ...input, ...variant,
      checkpoint: { ...(variant.checkpoint ?? input.checkpoint), store: { ...(variant.checkpoint?.store ?? store), load: async () => original } },
      summarize: async (_request, part) => { starts = part.start; throw new Error("first new request"); } }), /first new request/);
    assert.equal(starts, 0);
  }
  for (const altered of [
    { ...original, end: original.total + 1 }, { ...original, parts: 0 },
    { ...original, end: text.indexOf("🙂") + 1, prefixSha256: sha256Utf8V1(text.slice(0, text.indexOf("🙂") + 1)) },
    { ...original, prefixSha256: "0".repeat(64) }, { ...original, summaryJson: '"tampered"' },
    { ...original, summaryJson: "{}", summarySha256: sha256Utf8V1("{}") },
  ]) {
    let start = -1;
    await assert.rejects(summarizeCompleteCompanionSource({ ...input,
      checkpoint: { parse, store: { ...store, load: async () => altered } },
      summarize: async (_request, part) => { start = part.start; throw new Error("restart original source"); } }), /restart original/);
    assert.equal(start, 0, stableStringify(altered));
  }
});

test("a rejected checkpoint write prevents reading another part or reporting full coverage", async () => {
  let calls = 0;
  await assert.rejects(summarizeCompleteCompanionSource({ text: "source\n".repeat(100), previous: null,
    inputTokens: 260, options, counting, messages, summarize: async () => { calls++; return "valid state"; },
    checkpoint: { parse: value => String(value), store: { contract: "model", load: async () => null,
      save: async () => { throw new Error("checkpoint write refused"); } } } }), /write refused/);
  assert.equal(calls, 1);
});
