/**
 * TTS 引擎选择器单测（2026-09-19 语音链路改造）：
 * - qwen 成功 → 直接返回 qwen 字节，不碰 edge；
 * - qwen 失败 → 自动降级 edge（语气标签在 edge 前剥离）；
 * - qwen 未配置 workspaceId → 直接 edge；
 * - engine=edge → qwen 完全不被调用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { synthesizeTtsBytes, type TtsEngineDeps } from "../tts-engine.ts";
import { EdgeTtsError } from "../edge-tts.ts";
import type { TtsEngineConfig } from "../tts-config.ts";

function makeConfig(engine: "qwen" | "edge", workspaceId: string): TtsEngineConfig {
  return {
    engine,
    qwen: {
      workspaceId,
      model: "qwen-audio-3.1-tts-flash",
      voice: "longanlingxi_v3.1",
      format: "mp3",
      sampleRate: 22050,
      instruction: "",
    },
    edge: { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" },
  };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(`audio:${text}`);
/**
 * 41a：合成接到统一内核后必填「归属 + 事务边界读数」。单测没有真实事务，
 * 读数传 `() => undefined`——内核会在发外部调用前核一次，这里应当恒真通过。
 */
const TEST_SCOPE = {
  workspaceId: "w-test",
  userId: "u-test",
  currentActiveTransaction: () => undefined,
};
const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(text));
      controller.close();
    },
  });

const baseDeps = (overrides: Partial<TtsEngineDeps>): TtsEngineDeps => ({
  collectStream: async (stream) => {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  },
  ...overrides,
});

test("qwen 成功：返回 qwen 字节，不调用 edge", async () => {
  let edgeCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "[excited]哇，背完三十个！",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    scope: TEST_SCOPE,
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async (_key, text) => ({ stream: streamOf(`qwen:${text}`), contentType: "audio/mpeg" }),
      edgeSynthesize: async () => {
        edgeCalls += 1;
        throw new Error("edge must not be called");
      },
    }),
  });
  assert.equal(result.engine, "qwen");
  assert.equal(new TextDecoder().decode(result.audio), "audio:qwen:[excited]哇，背完三十个！");
  assert.equal(edgeCalls, 0);
});

test("qwen 失败：降级 edge，且 edge 拿到的是剥离语气标签后的文本", async () => {
  const fallbacks: unknown[] = [];
  let edgeText = "";
  const result = await synthesizeTtsBytes({
    text: "[excited]哇，背完三十个！",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    scope: TEST_SCOPE,
    onQwenFallback: (error) => fallbacks.push(error),
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async () => { throw new Error("ws boom"); },
      edgeSynthesize: async (text) => {
        edgeText = text;
        return { audio: bytes("edge"), voice: text, contentType: "audio/mpeg" };
      },
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(edgeText, "哇，背完三十个！");
  assert.equal(fallbacks.length, 1);
});

test("qwen 未配置 workspaceId：直接 edge，不调用 qwen", async () => {
  let qwenCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    scope: TEST_SCOPE,
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", ""),
      qwenSynthesize: async () => {
        qwenCalls += 1;
        throw new Error("qwen must not be called");
      },
      edgeSynthesize: async (text) => ({ audio: bytes(text), voice: text, contentType: "audio/mpeg" }),
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(qwenCalls, 0);
});

test("engine=edge：qwen 完全不参与", async () => {
  let qwenCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    scope: TEST_SCOPE,
    deps: baseDeps({
      loadConfig: () => makeConfig("edge", "ws-123"),
      qwenSynthesize: async () => {
        qwenCalls += 1;
        throw new Error("qwen must not be called");
      },
      edgeSynthesize: async (text) => ({ audio: bytes(text), voice: text, contentType: "audio/mpeg" }),
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(qwenCalls, 0);
});

// ─── 用户音色偏好（selection 覆盖 config）───────────────────────────────

test("selection 指定 qwen 音色：进上游的是这一身，不是 config 那条", async () => {
  let seenVoice = "";
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    scope: TEST_SCOPE,
    selection: { engine: "qwen", qwenVoice: "longanlingxi_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", explicit: true },
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async (_key, _text, options) => {
        seenVoice = options.voice;
        return { stream: streamOf("qwen"), contentType: "audio/mpeg" };
      },
      edgeSynthesize: async () => {
        throw new Error("edge must not be called");
      },
    }),
  });
  assert.equal(result.engine, "qwen");
  assert.equal(seenVoice, "longanlingxi_v3.1");
});

test("selection 说 edge：config 是 qwen 也不碰 qwen，不做'先试千问再降级'", async () => {
  // 用户明确挑了 edge，让 qwen 先试一遍等于把设置里那个选择演成没发生过
  // （而且 qwen 成功时根本不会降级，播出去的还是千问的声音）。
  let qwenCalls = 0;
  const result = await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    scope: TEST_SCOPE,
    selection: { engine: "edge", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", explicit: true },
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async () => {
        qwenCalls += 1;
        return { stream: streamOf("qwen"), contentType: "audio/mpeg" };
      },
      edgeSynthesize: async (_text, voice) => ({ audio: bytes("edge"), voice, contentType: "audio/mpeg" }),
    }),
  });
  assert.equal(result.engine, "edge");
  assert.equal(qwenCalls, 0);
});

test("不传 selection：仍旧用 config 那条音色（默认行为没被动过）", async () => {
  let seenVoice = "";
  await synthesizeTtsBytes({
    text: "你好",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: "ws:user",
    scope: TEST_SCOPE,
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async (_key, _text, options) => {
        seenVoice = options.voice;
        return { stream: streamOf("qwen"), contentType: "audio/mpeg" };
      },
      edgeSynthesize: async () => {
        throw new Error("edge must not be called");
      },
    }),
  });
  assert.equal(seenVoice, makeConfig("qwen", "ws-123").qwen.voice);
});

/**
 * 41a 的正控制：内核不是"包了一层看不见"。
 *
 * 只断言"还能合成"是**空断言**——它恒真，与有没有内核无关。这里量三件事，
 * 每一件都只有"真的走了内核"才会成立：
 * 1. 事务边界读数**被读过**（没有活动事务 ⇒ 恒真通过；有活动事务 ⇒ 内核拒绝发请求）；
 * 2. provider 拿到的那一步**不会**被内核重试（qwen→edge 只发生一次，
 *    `maxAutoRetries: 0` 与 `maxModelCalls: 2` 同时成立）；
 * 3. 失败时**原始错误类型**回到调用方（`EdgeTtsError`），路由的 502 映射靠它。
 */
test("41a：走统一内核——事务边界读数被核过，失败仍抛原始 EdgeTtsError", async () => {
  // (1) 有活动事务时，内核在发外部调用前就该拦下；provider 一次都不许被碰到。
  let providerCalls = 0;
  await assert.rejects(
    () => synthesizeTtsBytes({
      text: "你好",
      edgeVoice: "zh-CN-XiaoxiaoNeural",
      queueKey: "ws:user",
      scope: { ...TEST_SCOPE, currentActiveTransaction: () => ({ active: true }) },
      deps: baseDeps({
        loadConfig: () => makeConfig("edge", ""),
        edgeSynthesize: async (_text, voice) => {
          providerCalls += 1;
          return { audio: bytes("edge"), voice, contentType: "audio/mpeg" };
        },
      }),
    }),
    /事务|transaction/i,
  );
  assert.equal(providerCalls, 0, "有活动事务时不得发出任何合成请求");

  // (2)+(3) 无活动事务时正常跑完；qwen 失败只降级一次，edge 再失败时抛原始错误。
  let qwenCalls = 0;
  let edgeCalls = 0;
  await assert.rejects(
    () => synthesizeTtsBytes({
      text: "你好",
      edgeVoice: "zh-CN-XiaoxiaoNeural",
      queueKey: "ws:user",
      scope: TEST_SCOPE,
      deps: baseDeps({
        loadConfig: () => makeConfig("qwen", "ws-123"),
        qwenSynthesize: async () => {
          qwenCalls += 1;
          throw new Error("qwen 断了");
        },
        edgeSynthesize: async () => {
          edgeCalls += 1;
          throw new EdgeTtsError("UPSTREAM_ERROR", "edge 也不通", 503);
        },
      }),
    }),
    (err: unknown) => {
      // (3) 原始类型与 status 都还在——路由按 instanceof EdgeTtsError 映射 502。
      assert.ok(err instanceof EdgeTtsError, "失败时必须抛回原始 EdgeTtsError");
      assert.equal((err as EdgeTtsError).code, "UPSTREAM_ERROR");
      assert.equal((err as EdgeTtsError).status, 503);
      return true;
    },
  );
  // (2) qwen 与 edge 各一次：内核没有替这一发再跑一遍。
  assert.equal(qwenCalls, 1);
  assert.equal(edgeCalls, 1);
});
