import assert from "node:assert/strict";
import { test } from "node:test";
import { attachImagesToLastUserMessage } from "../agent/companion-attachment-images.ts";

type Msg = { role: string; content: unknown; hostObservation?: boolean };

test("this turn's pictures ride on the current user message, not an older one", () => {
  // A document and a quoted note are text; only the pictures become multimodal.
  const messages: Msg[] = [
    { role: "user", content: "上一轮的问题" },
    { role: "assistant", content: "上一轮的回答" },
    { role: "user", content: "对比这几张图和文档，再结合我引用的手记说说差异" },
    { role: "system", hostObservation: true, content: "当前页面" },
  ];
  const decorated = attachImagesToLastUserMessage(messages, [
    { assetId: "a", mimeType: "image/png", bytes: Buffer.from("one") },
    { assetId: "b", mimeType: "image/jpeg", bytes: Buffer.from("two") },
  ]);
  const multimodal = decorated.filter(message => Array.isArray(message.content));
  assert.equal(multimodal.length, 1, "exactly one message carries pictures");
  assert.equal(decorated[2]!.content, multimodal[0]!.content, "and it is the current user message");
  const parts = multimodal[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.equal(parts[0]!.type, "text");
  assert.match(String(parts[0]!.text), /对比这几张图和文档/);
  assert.deepEqual(parts.slice(1).map(part => part.type), ["image_url", "image_url"]);
  assert.match(String(parts[1]!.image_url!.url), /^data:image\/png;base64,/);
  assert.match(String(parts[2]!.image_url!.url), /^data:image\/jpeg;base64,/);
  // The earlier turn keeps its plain text.
  assert.equal(decorated[0]!.content, "上一轮的问题");
});

test("no pictures leaves every message exactly as it was", () => {
  const messages: Msg[] = [{ role: "user", content: "只有文字" }];
  assert.deepEqual(attachImagesToLastUserMessage(messages, []), messages);
});
