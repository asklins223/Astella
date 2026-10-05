/**
 * 三个 provider 的**真实**取消传导（离线：注入 fetch / requester / WebSocket 构造器）。
 *
 * 判据只有一条：调用方按下取消之后，那一次上游调用必须真的被中止——
 * 不是"本进程不再等它"。后者没有资源意义：连接还挂着、上游还在生成，
 * 而用户已经不听这一段了。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeTtsSynthesize, EdgeTtsError } from "../edge-tts.ts";
import { qwenTtsSynthesizeStreamForUser } from "../qwen-tts.ts";
import { siliconFlowTranscribe, SiliconFlowAsrError, type AsrRequester } from "../siliconflow-asr.ts";

const WS = "00000000-0000-0000-0000-00000000a001";
const USER = "00000000-0000-0000-0000-00000000c001";

test("edge-tts：调用方取消会真的中止这一次 fetch", async () => {
  const controller = new AbortController();
  let fetchSawAborted = false;
  let started!: () => void;
  const fetchStarted = new Promise<void>((r) => { started = r; });
  const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    started();
    init?.signal?.addEventListener("abort", () => { fetchSawAborted = true; reject(new Error("aborted")); });
  })) as unknown as typeof fetch;

  const pending = edgeTtsSynthesize("她今天想把这一节过完。", "zh-CN-XiaoxiaoNeural", {
    baseUrl: "http://127.0.0.1:9", fetchImpl, signal: controller.signal,
  });
  // 等这一次真的发出去之后再按取消——中途取消才是"拆掉在途 HTTP"那一档。
  await fetchStarted;
  controller.abort();
  await assert.rejects(() => pending, (error: unknown) => error instanceof EdgeTtsError);
  assert.equal(fetchSawAborted, true, "取消没有传到 fetch：这次 HTTP 还在跑");
});

test("edge-tts：已经取消的信号不该再发起这次合成", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const fetchImpl = (async () => { fetchCalls += 1; throw new Error("不该被调用"); }) as unknown as typeof fetch;
  await assert.rejects(() => edgeTtsSynthesize("她今天想把这一节过完。", "zh-CN-XiaoxiaoNeural", {
    baseUrl: "http://127.0.0.1:9", fetchImpl, signal: controller.signal,
  }), (error: unknown) => error instanceof EdgeTtsError);
  assert.equal(fetchCalls, 0, "已取消还发起了 HTTP：取消后不得新发");
});

test("qwen：已取消时不建连、不向上游发任何指令", async () => {
  const controller = new AbortController();
  controller.abort();
  let sockets = 0;
  const sent: Array<Record<string, unknown>> = [];
  class FakeSocket {
    readyState = 1;
    constructor() { sockets += 1; }
    send(payload: string): void { sent.push(JSON.parse(payload) as Record<string, unknown>); }
    addEventListener(): void { /* noop */ }
    removeAllListeners(): void { /* noop */ }
    close(): void { /* noop */ }
  }
  await assert.rejects(() => qwenTtsSynthesizeStreamForUser(`${WS}:${USER}`, "她今天想把这一节过完。", {
    workspaceId: WS, apiKey: "k", model: "qwen-audio-3.1-tts-flash", voice: "v",
    WebSocketImpl: FakeSocket as never, signal: controller.signal,
  }), /取消/);
  assert.equal(sockets, 0, "已取消仍然建了 WS 连接");
  assert.equal(sent.length, 0, "已取消仍然向上游发了指令");
});

test("ASR：外部取消与内核步预算合并，任一按下都中止这一次转写", async () => {
  const controller = new AbortController();
  const seen: Array<boolean> = [];
  const requester: AsrRequester = async (_url, init) => {
    seen.push(init.signal.aborted);
    return new Promise<Response>((_resolve, reject) => {
      if (init.signal.aborted) { reject(new Error("aborted")); return; }
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  const pending = siliconFlowTranscribe(new Uint8Array([1, 2, 3]), "a.mp3", {
    apiKey: "k", scope: { workspaceId: WS, userId: USER },
    currentActiveTransaction: () => undefined, signal: controller.signal,
    requester, model: "SenseVoice",
  });
  controller.abort();
  await assert.rejects(() => pending, (error: unknown) => error instanceof SiliconFlowAsrError);
  assert.ok(seen.length > 0, "转写请求根本没发出去：判据无效");
  assert.equal(seen.at(-1), true, "外部取消没有合并进内核那一份 signal");
});
