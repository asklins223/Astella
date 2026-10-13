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
import type { ApiAIGovernanceDependencies } from "../../../../lib/ai-governance.ts";
import { EdgeTtsError } from "../edge-tts.ts";
import type { TtsEngineConfig } from "../tts-config.ts";
import { QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION } from "@astella/shared/tts-voice-catalog";

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
  // 真 UUID：治理出口要在事务作用域里核身份，占位串过不了那一关——
  // 而那一关正是本轮接上的东西，用假 ID 会把整条链测成"不治理也过"。
  workspaceId: "00000000-0000-0000-0000-00000000w001".replace("w", "a"),
  userId: "00000000-0000-0000-0000-00000000b001".replace("b", "c"),
  currentActiveTransaction: () => undefined,
};

/**
 * 离线的治理依赖：查设置与写审计都在内存里。
 *
 * 缺省实现会连库——单测连库就不叫单测了。这里注入的形状与生产同构
 * （consentAt/consentVersion 决定同意，auditLogging 决定写不写审计），
 * 所以治理在不在、门有没有拦，这些用例照样判得出来。
 */
const governance = {
  settings: async () => ({
    requiresConsent: false,
    consentAt: new Date(),
    consentVersion: "v1",
    // 默认政策是 fail-closed 的（sendToExternal=false）。测试要显式把它打开——
    // 否则"治理门存在"这件事会被默认拒绝掩盖掉。
    dataPolicy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true },
  }),
  audit: async () => undefined,
} satisfies ApiAIGovernanceDependencies;
const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(text));
      controller.close();
    },
  });

const baseDeps = (overrides: Partial<TtsEngineDeps>): TtsEngineDeps => ({
  governance,
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

test("拿到 qwen 连接后音频出错：如实记失败，再为 edge 的真实成功记另一条账",async()=>{
  const outcomes:string[]=[];
  const result=await synthesizeTtsBytes({text:"完整音频才算完成",edgeVoice:"zh-CN-XiaoxiaoNeural",queueKey:"audio-failed",scope:TEST_SCOPE,
    deps:baseDeps({loadConfig:()=>makeConfig("qwen","fixture"),
      governance:{...governance,audit:async row=>{outcomes.push(`${row.provider}:${row.status}`);}},
      qwenSynthesize:async()=>({contentType:"audio/mpeg",stream:new ReadableStream<Uint8Array>({start(controller){controller.error(new Error("audio failed"));}})}),
      edgeSynthesize:async(_text,voice)=>({audio:bytes("fallback"),contentType:"audio/mpeg",voice}),
    })});
  assert.equal(result.engine,"edge");assert.deepEqual(outcomes,["qwen:error","edge:success"]);
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
    selection: { engine: "qwen", qwenVoice: "longanlingxi_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", qwenInstruction: "", qwenInstructionExplicit: false, qwenDialect: null, explicit: true },
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
    selection: { engine: "edge", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", qwenInstruction: "", qwenInstructionExplicit: false, qwenDialect: null, explicit: true },
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

// ─── 基础音色偏好 + 本轮表达指令（方言/场景不能覆盖伴星音色）───────────────

const captureInstruction = () => {
  let seen = "";
  let seenVoice = "";
  return {
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async (_key, _text, options) => {
        seen = options.instruction ?? "";
        seenVoice = options.voice;
        return { stream: streamOf("qwen"), contentType: "audio/mpeg" };
      },
      edgeSynthesize: async () => {
        throw new Error("edge must not be called");
      },
    }),
    read: () => seen,
    readVoice: () => seenVoice,
  };
};

test("方言指令用官方短格式并换成会说方言的系统女声；普通场景指令叠加基础音色", async () => {
  const withConfig = { ...makeConfig("qwen", "ws-123") };
  withConfig.qwen.instruction = "config 默认风格";

  // 方言表达优先走文档建议的直接指令，不混入通用音色描述；
  // 发音人换成会说该方言的系统女声（普通话样本复刻出来的嗓子接方言指令只改节奏，实测被否）。
  const model = captureInstruction();
  await synthesizeTtsBytes({
    text: "中不中", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    instruction: "请用河南话表达，语气轻松俏皮，笑点前停顿",
    selection: { engine: "qwen", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", qwenInstruction: "青年女性，甜美圆润", qwenInstructionExplicit: false, qwenDialect: null, explicit: true },
    deps: { ...model.deps, loadConfig: () => withConfig },
  });
  assert.equal(model.read(), "请用河南话表达。语气轻松俏皮，笑点前停顿");
  assert.equal(model.readVoice(), "longanhuan_v3.1", "方言轮换成会说河南话的系统女声");

  // 非方言场景表达仍与用户偏好合并，确保日常说话风格不回退。
  const scene = captureInstruction();
  await synthesizeTtsBytes({
    text: "中不中", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    instruction: "语气偏慢",
    selection: { engine: "qwen", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", qwenInstruction: "青年女性，甜美圆润", qwenInstructionExplicit: true, qwenDialect: null, explicit: true },
    deps: { ...scene.deps, loadConfig: () => withConfig },
  });
  assert.equal(scene.read(), "保持基础音色：青年女性，甜美圆润。本轮表达要求：语气偏慢");

  // 模型没写：用用户偏好。
  const pref = captureInstruction();
  await synthesizeTtsBytes({
    text: "中不中", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    selection: { engine: "qwen", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", qwenInstruction: "用户偏好", qwenInstructionExplicit: true, qwenDialect: null, explicit: true },
    deps: { ...pref.deps, loadConfig: () => withConfig },
  });
  assert.equal(pref.read(), "用户偏好");

  // 模型没写、偏好也没有：用 config。
  const config = captureInstruction();
  await synthesizeTtsBytes({
    text: "中不中", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    selection: { engine: "qwen", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", qwenInstruction: "", qwenInstructionExplicit: false, qwenDialect: null, explicit: true },
    deps: { ...config.deps, loadConfig: () => withConfig },
  });
  assert.equal(config.read(), "config 默认风格");
});

test("长期方言跨轮生效，单轮另一方言临时覆盖且都走系统方言女声", async () => {
  const withClone = { ...makeConfig("qwen", "ws-123") };
  const persistent = captureInstruction();
  const selection = {
    engine: "qwen" as const,
    qwenVoice: "longhua_v3.1",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    qwenInstruction: "声音温柔，语速偏慢",
    qwenInstructionExplicit: true,
    qwenDialect: "河南话" as const,
    explicit: true,
  };
  await synthesizeTtsBytes({
    text: "晚上好", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    selection,
    deps: { ...persistent.deps, loadConfig: () => withClone },
  });
  assert.equal(persistent.read(), "请用河南话表达。声音温柔，语速偏慢");
  assert.equal(persistent.readVoice(), "longanhuan_v3.1");

  const temporary = captureInstruction();
  await synthesizeTtsBytes({
    text: "晚上好", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    instruction: "请用四川话表达，语气轻快",
    selection,
    deps: { ...temporary.deps, loadConfig: () => withClone },
  });
  assert.equal(temporary.read(), "请用四川话表达。语气轻快");
  assert.equal(temporary.readVoice(), "longanhuan_v3.1");
  assert.equal(selection.qwenDialect, "河南话", "单轮四川话是事件覆盖，不改已保存的河南话偏好");
});

test("语义层明确改普通话时覆盖旧方言，即使持久设置更新失败", async () => {
  const model = captureInstruction();
  const withClone = { ...makeConfig("qwen", "ws-123") };
  await synthesizeTtsBytes({
    text: "晚上好", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    instruction: QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION,
    selection: { engine: "qwen", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural",
      qwenInstruction: "青年女性，甜美圆润", qwenInstructionExplicit: false,
      qwenDialect: "河南话", explicit: true },
    deps: { ...model.deps, loadConfig: () => withClone },
  });
  assert.equal(model.read(), `保持基础音色：青年女性，甜美圆润。本轮表达要求：${QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION}`);
  assert.equal(model.readVoice(), "longhua_v3.1", "清除语义优先级高于旧河南话克隆音色");
});

test("instruction 只进 qwen 参数：edge 分支连字段都不该出现", async () => {
  let edgeOptions: Record<string, unknown> | undefined;
  await synthesizeTtsBytes({
    text: "你好", edgeVoice: "zh-CN-XiaoxiaoNeural", queueKey: "ws:user", scope: TEST_SCOPE,
    instruction: "用河南话讲",
    selection: { engine: "edge", qwenVoice: "longhua_v3.1", edgeVoice: "zh-CN-XiaoxiaoNeural", qwenInstruction: "", qwenInstructionExplicit: false, qwenDialect: null, explicit: true },
    deps: baseDeps({
      loadConfig: () => makeConfig("qwen", "ws-123"),
      qwenSynthesize: async () => {
        throw new Error("qwen must not be called");
      },
      edgeSynthesize: async (_text, _voice, options) => {
        edgeOptions = options as Record<string, unknown>;
        return { audio: bytes("edge"), voice: "zh-CN-XiaoxiaoNeural", contentType: "audio/mpeg" };
      },
    }),
  });
  assert.ok(edgeOptions);
  assert.equal("instruction" in edgeOptions, false, "edge 没有指令参数，多出来的字段只会在上游面前出丑");
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
