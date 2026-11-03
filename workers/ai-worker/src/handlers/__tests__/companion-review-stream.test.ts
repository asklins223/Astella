import assert from "node:assert/strict";
import test from "node:test";
import { reviewCompanionParagraphs, splitCompanionReviewParagraphs } from "../agent/companion-review-stream.ts";

const parts = splitCompanionReviewParagraphs("第一段。\n\n第二段。\n\n第三段。");
const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

test("paragraph boundaries preserve original whitespace and complete fenced code", () => {
  const draft = "说明。\n\n```text\na\n\nb\n```\n \n最后。";
  const split = splitCompanionReviewParagraphs(draft);
  assert.equal(split.length, 3);
  assert.equal(split.map(part => part.separator + part.text).join(""), draft);
  assert.equal(split[1]!.text, "```text\na\n\nb\n```");
});

test("top-level list items are separate verification units with their original separators", () => {
  const draft = "四个比较点：\n1. 第一个事实。\n续行仍属同一点。\n2. 第二个事实。\n\n3. 第三个事实。";
  const split = splitCompanionReviewParagraphs(draft);
  assert.equal(split.length, 4);
  assert.equal(split[1]!.text, "1. 第一个事实。\n续行仍属同一点。");
  assert.equal(split.map(part => part.separator + part.text).join(""), draft);
});

test("independent verifications overlap but publish in original order before the last review completes", async () => {
  const gates = parts.map(() => gate<string>()), started: number[] = [], published: string[] = [];
  const result = reviewCompanionParagraphs({ paragraphs: parts, signal: new AbortController().signal,
    review: async (_part, index) => { started.push(index); return gates[index]!.promise; },
    validate: () => undefined, publish: async text => { published.push(text); return true; } });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]);
  gates[1]!.resolve("改好的第二段。"); gates[0]!.resolve("第一段。");
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.deepEqual(published, ["第一段。", "\n\n改好的第二段。"]);
  gates[2]!.resolve("第三段。");
  assert.equal(await result, "第一段。\n\n改好的第二段。\n\n第三段。");
  assert.equal(published.join(""), await result);
});

test("invalid or interrupted later verification preserves only the already verified prefix", async () => {
  const second = gate<string>(), published: string[] = [];
  const result = reviewCompanionParagraphs({ paragraphs: parts, signal: new AbortController().signal,
    review: async (_part, index) => index === 0 ? "第一段。" : second.promise,
    validate: text => { if (text.includes("unsafe")) throw new Error("invalid citation"); },
    publish: async text => { published.push(text); return true; } });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.deepEqual(published, ["第一段。"]);
  second.resolve("unsafe"); await assert.rejects(result, /invalid citation/);
  assert.deepEqual(published, ["第一段。"]);
});

test("cancellation stops queued reviews and never publishes a late result", async () => {
  const controller = new AbortController(), release = gate<string>(), started: number[] = [], published: string[] = [];
  const paragraphs = Array.from({ length: 8 }, (_, index) => ({ text: String(index), separator: index ? "\n\n" : "" }));
  const result = reviewCompanionParagraphs({ paragraphs, signal: controller.signal,
    review: async (_part, index) => { started.push(index); if (started.length === 4) { controller.abort(); release.resolve("late"); } return release.promise; },
    validate: () => undefined, publish: async text => { published.push(text); return true; } });
  await assert.rejects(result, error => (error as Error).name === "AbortError");
  assert.equal(started.length, 4); assert.deepEqual(published, []);
});

test("a one-paragraph answer uses a single review without an extra scheduling call", async () => {
  let calls = 0;
  const text = await reviewCompanionParagraphs({ paragraphs: [{ text: "原文。", separator: "" }], signal: new AbortController().signal,
    review: async paragraph => { calls++; return paragraph.text; }, validate: () => undefined });
  assert.equal(calls, 1); assert.equal(text, "原文。");
});

test("a reviewer can remove an unrequested preamble or repeated conclusion without leaving leading gaps", async () => {
  const paragraphs = splitCompanionReviewParagraphs("多余前言。\n\n1. 需要的事实。\n\n重复总结。");
  const deltas: string[] = [];
  const text = await reviewCompanionParagraphs({ paragraphs, signal: new AbortController().signal,
    review: async (part, index) => index === 1 ? part.text : "", validate: () => undefined,
    publish: async delta => { deltas.push(delta); return true; } });
  assert.equal(text, "1. 需要的事实。"); assert.deepEqual(deltas, [text]);
});
