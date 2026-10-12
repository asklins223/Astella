/**
 * MiMo ASR provider 的离线契约（注入 requester，不花钱、不出网）。
 *
 * 钉住的是四件"错了也不报错、只让用户白等"的事：
 *   1. 请求体形状（`input_audio` + data URL + `asr_options.language`）——上游按这个认；
 *   2. 上游不认的容器/超限音频在**出网前**就被拒；
 *   3. 瞬时状态重试、其余 4xx 不重试（用户举着麦克风，重试就是多等一轮）；
 *   4. 空 transcript 不算成功（fail closed）。
 *
 * 真语音的端到端读数不在这里（那要花一次真实调用），记在 mimo-asr.ts 文件头。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resetPlatformConfigCache, setPlatformConfig } from "@astella/shared/platform-config-node";
import { mimoAsrLanguage, mimoTranscribe, MimoAsrError, type MimoAsrRequester } from "../mimo-asr.ts";

const SCOPE = { workspaceId: "00000000-0000-0000-0000-00000000a001", userId: "00000000-0000-0000-0000-00000000c001" };
const AUDIO = new Uint8Array([1, 2, 3, 4]);

function okTranscript(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function options(requester: MimoAsrRequester, overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "test-key",
    url: "https://example.invalid/v1/chat/completions",
    model: "mimo-v2.5-asr",
    scope: SCOPE,
    currentActiveTransaction: () => undefined,
    requester,
    ...overrides,
  } as Parameters<typeof mimoTranscribe>[2];
}

test("请求体：整段音频进 input_audio，语言进 asr_options", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const result = await mimoTranscribe(AUDIO, "take-1.wav", options(async (u, init) => {
    url = u;
    headers = init.headers;
    body = JSON.parse(init.body) as Record<string, unknown>;
    return okTranscript("你好，世界");
  }, { language: "zh-CN" }));

  assert.equal(result.text, "你好，世界");
  assert.equal(url, "https://example.invalid/v1/chat/completions");
  assert.equal(headers.Authorization, "Bearer test-key");
  assert.equal(body.model, "mimo-v2.5-asr");
  assert.deepEqual(body.asr_options, { language: "zh" }, "zh-CN 必须夹成上游认的 zh");
  assert.equal(body.stream, false);
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  assert.equal(content[0].type, "input_audio");
  const inputAudio = content[0].input_audio as { data: string };
  assert.ok(inputAudio.data.startsWith("data:audio/wav;base64,"), `data URL 形状不对：${inputAudio.data.slice(0, 40)}`);
});

test("语言参数：只认 zh/en/auto，认不出的一律交给上游 auto", () => {
  assert.equal(mimoAsrLanguage("zh-CN"), "zh");
  assert.equal(mimoAsrLanguage("zh"), "zh");
  assert.equal(mimoAsrLanguage("en-US"), "en");
  assert.equal(mimoAsrLanguage("en"), "en");
  assert.equal(mimoAsrLanguage("yue"), "auto");
  assert.equal(mimoAsrLanguage(undefined), "auto");
});

test("上游不认的容器与超限音频在出网前就被拒（不浪费一次请求）", async () => {
  let calls = 0;
  const counting = options(async () => { calls += 1; return okTranscript("不该被调用"); });

  await assert.rejects(() => mimoTranscribe(AUDIO, "take-1.webm", counting),
    (error: unknown) => error instanceof MimoAsrError && error.code === "UNSUPPORTED_AUDIO_FORMAT");
  await assert.rejects(() => mimoTranscribe(AUDIO, "take-1.m4a", counting),
    (error: unknown) => error instanceof MimoAsrError && error.code === "UNSUPPORTED_AUDIO_FORMAT");

  // base64 上限 10MB：原始音频约 7.5MB 就到顶。
  const oversized = new Uint8Array(8 * 1024 * 1024);
  await assert.rejects(() => mimoTranscribe(oversized, "long.mp3", counting),
    (error: unknown) => error instanceof MimoAsrError && error.code === "UNSUPPORTED_AUDIO_FORMAT");
  assert.equal(calls, 0, "被拒的请求不该出网");
});

test("平台根要自己接上 /chat/completions（配置里 baseUrl 存的是根）", async () => {
  // 2026-10-12 首次真跑就是漏了这一步：直接拿根去发，上游 404。
  // 顺序要紧：reset 在 set 之前——反过来会把刚注入的配置擦回「读文件」，
  // 而文件在测试进程的 CWD 下根本不存在。
  resetPlatformConfigCache();
  setPlatformConfig({
    platforms: { mimo: { type: "openai_compatible", apiKey: "k", baseUrl: "https://api.example.com/v1", models: { "mimo-v2.5-asr": {} } } },
    capabilities: { speech_recognition: { platform: "mimo", model: "mimo-v2.5-asr" } },
  });
  let url = "";
  let headers: Record<string, string> = {};
  try {
    await mimoTranscribe(AUDIO, "a.wav", {
      scope: SCOPE, currentActiveTransaction: () => undefined,
      requester: async (u, init) => { url = u; headers = init.headers; return okTranscript("好"); },
    });
  } finally {
    setPlatformConfig(null);
    resetPlatformConfigCache();
  }
  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(headers.Authorization, "Bearer k", "key 来自配置，不是写死在代码里");
});

test("缺配置 fail closed：不静默跳过识别", async () => {
  // 配置来源钉死为"没有"——否则哪天测试进程的 CWD 正好读到仓库里的
  // ai-platforms.json，这条用例就会变成一次真实出网。
  resetPlatformConfigCache();
  setPlatformConfig(null);
  try {
    await assert.rejects(() => mimoTranscribe(AUDIO, "a.wav", options(async () => okTranscript("x"), {
      apiKey: undefined, url: undefined, model: undefined,
    }) as Parameters<typeof mimoTranscribe>[2]),
    (error: unknown) => error instanceof MimoAsrError && error.code === "MISSING_API_KEY");
  } finally {
    setPlatformConfig(null);
    resetPlatformConfigCache();
  }
});

test("瞬时状态值得再问一次，4xx 不值得", async () => {
  for (const [status, expectRetries] of [[429, 2], [503, 2], [400, 1]] as const) {
    let calls = 0;
    await assert.rejects(() => mimoTranscribe(AUDIO, "a.wav", options(async () => {
      calls += 1;
      return new Response("nope", { status });
    })), (error: unknown) => error instanceof MimoAsrError);
    assert.equal(calls, expectRetries, `HTTP ${status} 的重试次数不对`);
  }
});

test("空 transcript 不算成功（fail closed）", async () => {
  await assert.rejects(() => mimoTranscribe(AUDIO, "a.wav", options(async () => okTranscript("   "))),
    (error: unknown) => error instanceof MimoAsrError && error.code === "EMPTY_TRANSCRIPT");
  await assert.rejects(() => mimoTranscribe(AUDIO, "a.wav", options(async () => new Response("<html>oops</html>", { status: 200 }))),
    (error: unknown) => error instanceof MimoAsrError && error.code === "EMPTY_TRANSCRIPT");
});
