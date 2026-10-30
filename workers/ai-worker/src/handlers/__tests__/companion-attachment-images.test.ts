import assert from "node:assert/strict";
import { test } from "node:test";
import { attachImagesToLastUserMessage, companionTurnMessagesWithImages, loadCompanionAttachmentImages } from "../agent/companion-attachment-images.ts";
import { COMPANION_IMAGE_MAX_BYTES_V1 } from "@astella/shared/companion-conversation-contracts";
import { replayCompanionHistory } from "../turn/companion-history-replay.ts";

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
  assert.deepEqual(parts.slice(1).map(part => part.type), ["text", "image_url", "text", "image_url"]);
  assert.match(String(parts[1]!.text), /"assetId":"a"/);
  assert.match(String(parts[2]!.image_url!.url), /^data:image\/png;base64,/);
  assert.match(String(parts[3]!.text), /"assetId":"b"/);
  assert.match(String(parts[4]!.image_url!.url), /^data:image\/jpeg;base64,/);
  // The earlier turn keeps its plain text.
  assert.equal(decorated[0]!.content, "上一轮的问题");
});

test("a declared vision model cannot turn failed/partial storage loads into delivered images", async () => {
  const messages: Msg[] = [{ role: "user", content: "对比两张图" }];
  const args = { ctx: { workspaceId: "w" }, turnImagesSentDirectly: true,
    read: { userId: "u", runId: "r", userImageAttachments: [{ assetId: "a" }, { assetId: "b" }] } };
  const missing = await companionTurnMessagesWithImages({ args, messages }, async () => []);
  assert.equal(missing[0]!.content, "对比两张图");
  assert.match(String(missing.at(-1)!.content), /"sentAssetIds":\[\],"unsentAssetIds":\["a","b"\]/);
  const partial = await companionTurnMessagesWithImages({ args, messages }, async () => [
    { assetId: "b", mimeType: "image/png", bytes: Buffer.from("second") }]);
  assert.match(String(partial.at(-1)!.content), /"sentAssetIds":\["b"\],"unsentAssetIds":\["a"\]/);
  assert.equal(partial.at(-1)!.hostObservation, true);
  const parts = partial[0]!.content as Array<{ type: string; text?: string }>;
  assert.match(parts[1]!.text!, /"assetId":"b"/);
});

test("current attachments stay on the real user message when host material follows it", async () => {
  const messages: Msg[] = [{ role: "user", content: "真实图片问题" },
    { role: "user", content: "宿主追加材料", hostObservation: true }];
  const args = { ctx: { workspaceId: "w" }, turnImagesSentDirectly: true,
    read: { userId: "u", runId: "r", userImageAttachments: [{ assetId: "current" }] } };
  const result = await companionTurnMessagesWithImages({ args, messages }, async () => [
    { assetId: "current", mimeType: "image/png", bytes: Buffer.from("actual-fixture") }]);
  assert.ok(Array.isArray(result[0]!.content));
  assert.equal(result[1]!.content, "宿主追加材料");
  assert.equal((result[0]!.content as Array<{ type: string }>).filter(part => part.type === "image_url").length, 1);
});

test("decorating a multimodal request preserves the original text parts", () => {
  const messages: Msg[] = [{ role: "user", content: [{ type: "text", text: "请看右上角。" }] }];
  const decorated = attachImagesToLastUserMessage(messages, [{ assetId: "a", mimeType: "image/png", bytes: Buffer.from("a") }]);
  assert.deepEqual((decorated[0]!.content as unknown[])[0], { type: "text", text: "请看右上角。" });
});

test("no pictures leaves every message exactly as it was", () => {
  const messages: Msg[] = [{ role: "user", content: "只有文字" }];
  assert.deepEqual(attachImagesToLastUserMessage(messages, []), messages);
});

test("the loop's top-level vision flag is what sends this turn's pictures", async () => {
  const messages: Msg[] = [{ role: "user", content: "看看这张图" }];
  let loaded = 0;
  const load = async () => {
    loaded += 1;
    return [{ assetId: "a", mimeType: "image/png", bytes: Buffer.from("one") }];
  };
  const base = { ctx: { workspaceId: "w" }, read: { userId: "u", runId: "r",
    userImageAttachments: [{ assetId: "a", label: "照片-1.png" }] } };

  const sent = await companionTurnMessagesWithImages({ args: { ...base, turnImagesSentDirectly: true }, messages }, load);
  assert.equal(loaded, 1, "the main-model vision flag must reach the loader");
  assert.ok(Array.isArray(sent[0]!.content), "the picture rides on the user message");

  const notSent = await companionTurnMessagesWithImages({ args: { ...base, turnImagesSentDirectly: false }, messages }, load);
  assert.equal(loaded, 1, "a false flag never loads bytes");
  assert.equal(notSent[0]!.content, "看看这张图");

  const noAttachments = await companionTurnMessagesWithImages({
    args: { ...base, read: { userId: "u", runId: "r" }, turnImagesSentDirectly: true }, messages }, load);
  assert.equal(loaded, 1, "no attachments means no lookup");
  assert.equal(noAttachments[0]!.content, "看看这张图");
});

test("accepted images above 4MB and multiple originals above 12MB reach the reader intact", async () => {
  const a = Buffer.alloc(7_000_000, 31), b = Buffer.alloc(7_000_000, 47);
  const images = await loadCompanionAttachmentImages({ workspaceId: "w", userId: "u", runId: "r",
    attachments: [{ assetId: "a" }, { assetId: "b" }] }, {
    readRows: async wanted => wanted.map(id => ({ id, object_key: id, mime_type: "image/png", byte_size: a.length })),
    readBytes: async (key, limit) => {
      assert.equal(limit, COMPANION_IMAGE_MAX_BYTES_V1);
      return key === "a" ? a : b;
    },
  });
  assert.equal(images.length, 2);
  assert.equal(images[0]!.bytes, a);
  assert.equal(images[1]!.bytes, b);
});

test("a later question receives historical pixels on their original user turn", async () => {
  const original = Buffer.from("original image bytes");
  const history = replayCompanionHistory([{ role: "user", text: "看看这张图", imageAttachments: [{ assetId: "old", label: "原图" }] },
    { role: "assistant", text: "上一轮识读可能错了" }], false);
  const messages = [...history, { role: "user" as const, content: "再实际看看刚才那张图" }];
  const decorated = await companionTurnMessagesWithImages({ args: { ctx: { workspaceId: "w" }, turnImagesSentDirectly: true,
    read: { userId: "u", runId: "r" } }, messages }, async input => {
    assert.deepEqual(input.attachments.map(ref => ref.assetId), ["old"]);
    return [{ assetId: "old", mimeType: "image/png", bytes: original }];
  });
  const parts = decorated[0]!.content as Array<{type:string;image_url?:{url:string}}>;
  assert.equal(parts.find(p => p.type === "image_url")!.image_url!.url, "data:image/png;base64," + original.toString("base64"));
  assert.equal(decorated[2]!.content, messages[2]!.content);
  assert.ok(!JSON.stringify(decorated).includes("astella-image-asset:"));
});

test("denied native vision strips internal references and never fetches historical bytes", async () => {
  const messages = replayCompanionHistory([{ role: "user", text: "原问题", imageAttachments: [{ assetId: "a", label: "图" }] }], false);
  const decorated = await companionTurnMessagesWithImages({ args: { ctx: { workspaceId: "w" }, turnImagesSentDirectly: false,
    read: { userId: "u", runId: "r" } }, messages }, async () => { assert.fail("denied images must not be fetched"); });
  assert.ok(!JSON.stringify(decorated).includes("astella-image-asset:"));
  assert.ok(!JSON.stringify(decorated).includes('"type":"image_url"'));
  assert.match(String(decorated.at(-1)!.content), /"unsentAssetIds":\["a"\]/u);
});
