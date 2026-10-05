/**
 * 流式媒介外发的审计结算（**离线**）。
 *
 * 流式最容易写出的错误形状是"拿到流就记成功"：响应头都发出去了，用户一个字都还没听到，
 * 而审计行里已经是 success。中途断开、上游报错、客户端打断这三种结局于是全都
 * 显示成一次成功的调用——于是"语音经常断"这件事在数据上根本看不见。
 *
 * 所以这里逐个结局判：EOF 才成功；上游出错记 error；客户端取消记 cancelled；
 * 而且**一次外发只记一条**，先到的结局说了算。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGovernedMediaCall } from "../ai-governance.ts";

const WS = "00000000-0000-0000-0000-00000000a001";
const USER = "00000000-0000-0000-0000-00000000c001";

function harness() {
  const rows: Array<{ status: string; provider: string }> = [];
  const call = () => createGovernedMediaCall(
    { workspaceId: WS, userId: USER },
    "voice_tts_stream_edge",
    ["text_content"],
    {
      settings: async () => ({
        requiresConsent: false,
        consentAt: new Date(),
        consentVersion: "v1",
        dataPolicy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true },
      }),
      audit: async (row: Record<string, unknown>) => { rows.push(row as unknown as { status: string; provider: string }); },
    },
  );
  return { rows, call };
}

const IDENTITY = { provider: "edge", modelId: "edge-tts" };
const chunk = (text: string): Uint8Array => new TextEncoder().encode(text);

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) bytes += value.length;
  }
  return bytes;
}

test("拿到流、还没读完：不得已经记成成功", async () => {
  const h = harness();
  const media = await h.call();
  const source = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(chunk("a")); },   // 开着不关
  });
  const tracked = await media.openStream(IDENTITY, async () => ({ stream: source, contentType: "audio/mpeg" }));
  assert.equal(h.rows.length, 0, "刚拿到流就记了审计：那时用户什么都还没听到");
  await tracked.stream.cancel();
});

test("读到 EOF 才算这一次完成", async () => {
  const h = harness();
  const media = await h.call();
  const tracked = await media.openStream(IDENTITY, async () => ({
    stream: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk("audio-bytes")); c.close(); },
    }),
    contentType: "audio/mpeg",
  }));
  const bytes = await drain(tracked.stream);
  assert.equal(bytes, "audio-bytes".length);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0]!.status, "success");
  assert.equal(tracked.contentType, "audio/mpeg", "上游结果的其余字段要原样带回");
});

test("上游中途出错：记 error，不是 success", async () => {
  const h = harness();
  const media = await h.call();
  const tracked = await media.openStream(IDENTITY, async () => ({
    stream: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk("partial")); c.error(new Error("upstream died")); },
    }),
    contentType: "audio/mpeg",
  }));
  await assert.rejects(() => drain(tracked.stream));
  assert.deepEqual(h.rows.map((r) => r.status), ["error"]);
});

test("客户端打断：记 cancelled，且只记一次", async () => {
  const h = harness();
  const media = await h.call();
  const tracked = await media.openStream(IDENTITY, async () => ({
    stream: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(chunk("partial")); },   // 不关，等着被打断
    }),
    contentType: "audio/mpeg",
  }));
  await tracked.stream.cancel();
  // 打断之后上游自己又报了错：不能因为"后来又有个结局"就多记一条。
  media.settle({ ...IDENTITY, status: "error" });
  assert.deepEqual(h.rows.map((r) => r.status), ["cancelled"]);
});

test("拿到流这一步失败：自己记一次 error 并把原始错误抛回去", async () => {
  const h = harness();
  const media = await h.call();
  await assert.rejects(
    () => media.openStream(IDENTITY, async () => { throw new Error("ws refused"); }),
    /ws refused/,
  );
  assert.deepEqual(h.rows.map((r) => r.status), ["error"]);
});

test("流式路径不声称做过音频的文本 PII", async () => {
  const h = harness();
  const media = await h.call();
  // 这条路径只调 noteBytes（送出去的是音频字节），没有 prepareText。
  media.noteBytes(4096);
  media.settle({ ...IDENTITY, status: "success" });
  assert.equal(h.rows.length, 1, "音频外发也必须有审计：同意与政策不跑就等于没门");
});
