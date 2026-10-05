/**
 * 语音外发的治理边界单测（**离线**：查设置与写审计都在内存里）。
 *
 * 钉的是四件会真的出事的事：
 *
 * 1. **每次真实上游调用各记一次**。qwen 失败降级 edge 是**两次**外发，两条审计；
 *    反过来，同一次合成**不该**记两遍。
 * 2. **缓存不制造第二次调用**。伴星段预热命中时根本没有上游调用，就不该多一条审计。
 * 3. **流式不提前宣布成功**。拿到流、写出响应头都还什么都没发生——只有读到 EOF
 *    才算这一次完成；中途出错或被打断按真实结局记。
 * 4. **净化后的文本才是真送出去的那份**，且门在发出去之前：没同意/政策拒发时
 *    上游一次都不该被调用，降级也不能变成绕过门的第二条路。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { synthesizeTtsBytes, type TtsEngineDeps } from "../voice-providers/tts-engine.ts";
import { createGovernedMediaCall } from "../../../lib/ai-governance.ts";
import type { TtsEngineConfig } from "../voice-providers/tts-config.ts";

const WS = "00000000-0000-0000-0000-00000000a001";
const USER = "00000000-0000-0000-0000-00000000c001";
const QWEN_WS = "00000000-0000-0000-0000-00000000d001";

type AuditRow = {
  provider: string; modelId: string; operation: string;
  dataCategories: string[]; dataSizeBytes: number | null; costTokens: number | null; status: string;
};

function harness(options: {
  policy?: { sendToExternal: boolean; piiDetection: boolean; auditLogging: boolean };
  consent?: boolean;
  qwen?: "ok" | "fail";
} = {}) {
  const rows: AuditRow[] = [];
  const sent: Array<{ engine: string; text: string }> = [];
  const policy = options.policy ?? { sendToExternal: true, piiDetection: true, auditLogging: true };
  const consent = options.consent ?? true;
  const deps: TtsEngineDeps = {
    governance: {
      settings: async () => ({
        requiresConsent: consent,
        consentAt: consent ? new Date() : null,
        consentVersion: consent ? "v1" : null,
        dataPolicy: { sendToExternal: policy.sendToExternal, sendImageContent: false,
          piiDetection: policy.piiDetection, auditLogging: policy.auditLogging },
      }),
      audit: async (row: Record<string, unknown>) => { rows.push(row as unknown as AuditRow); },
    },
    qwenSynthesize: (async (_key: string, text: string) => {
      sent.push({ engine: "qwen", text });
      if (options.qwen === "fail") throw new Error("qwen down");
      return { contentType: "audio/mpeg", stream: streamOf("qwen") };
    }) as never,
    edgeSynthesize: (async (text: string) => {
      sent.push({ engine: "edge", text });
      return { contentType: "audio/mpeg", audio: new TextEncoder().encode("edge-audio") };
    }) as never,
  };
  return { rows, sent, deps };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

function config(engine: "qwen" | "edge"): TtsEngineConfig {
  return {
    engine,
    qwen: { workspaceId: QWEN_WS, model: "qwen-audio-3.1-tts-flash", voice: "longanlingxi_v3.1",
      format: "mp3", sampleRate: 22050, instruction: "" },
    edge: { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" },
  };
}

async function synthesize(deps: TtsEngineDeps, overrides: Record<string, unknown> = {}) {
  return synthesizeTtsBytes({
    text: "她今天想把这一节过完。",
    edgeVoice: "zh-CN-XiaoxiaoNeural",
    queueKey: `${WS}:${USER}`,
    scope: { workspaceId: WS, userId: USER, currentActiveTransaction: () => undefined },
    loadConfig: () => config("qwen"),
    ...overrides,
    deps,
  } as never);
}

test("一次成功合成只记一次上游调用", async () => {
  const h = harness();
  const out = await synthesize(h.deps);
  assert.equal(out.engine, "qwen");
  assert.equal(h.rows.length, 1, "一次合成记了不止一条审计");
  assert.equal(h.rows[0]!.provider, "qwen");
  assert.equal(h.rows[0]!.status, "success");
  assert.equal(h.rows[0]!.operation, "voice_synthesis_qwen");
});

test("qwen 失败降级 edge 是两次真实外发、两条审计", async () => {
  const h = harness({ qwen: "fail" });
  const out = await synthesize(h.deps);
  assert.equal(out.engine, "edge");
  assert.deepEqual(h.rows.map((r) => [r.provider, r.status]), [["qwen", "error"], ["edge", "success"]],
    "降级那一次上游调用必须自己有一条审计：它是第二次外发，不是同一次的另一种走法");
});

test("审计只记元数据：没有正文、没有音频、没有 token 猜测", async () => {
  const h = harness();
  await synthesize(h.deps);
  const row = h.rows[0]!;
  assert.equal(row.costTokens, null, "语音上游不回 token 用量，必须按明确未知记 null，不能写 0 冒充");
  assert.ok((row.dataSizeBytes ?? 0) > 0, "外发字节数要记");
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes("她今天想把这一节过完"), false, "正文进了审计行");
  assert.equal(/"audio-mpeg"|base64/.test(serialized), false, "音频进了审计行");
  assert.deepEqual(row.dataCategories, ["text_content"]);
});

test("没同意：上游一次都不该被调用，也就不该有审计行", async () => {
  const h = harness({ consent: false });
  await assert.rejects(() => synthesize(h.deps));
  assert.equal(h.sent.length, 0, "没同意外发时上游被调用了");
  assert.equal(h.rows.length, 0, "没发出去就没有这一次外发");
});

test("政策拒发：降级也不能变成绕过门的第二条路", async () => {
  const h = harness({ policy: { sendToExternal: false, piiDetection: true, auditLogging: true } });
  await assert.rejects(() => synthesize(h.deps));
  assert.equal(h.sent.length, 0, "qwen 与 edge 都不该被调用");
  assert.equal(h.rows.length, 0);
});

test("PII 净化后的文本才是真送出去的那份", async () => {
  const h = harness();
  await synthesize(h.deps, { text: "她记下了 test@example.com 这个地址。" });
  assert.equal(h.sent[0]!.text.includes("test@example.com"), false,
    "送出去的还是原文：净化算了却没送净化后的那份");
});

test("审计开关关掉不影响合成（指标与审计是两件事）", async () => {
  const h = harness({ policy: { sendToExternal: true, piiDetection: true, auditLogging: false } });
  const out = await synthesize(h.deps);
  assert.equal(out.audio.length > 0, true);
  assert.equal(h.rows.length, 0, "审计关着时不该写行");
});

test("预热命中不再合成一次：缓存不制造第二条审计", async () => {
  // 预热的那一次合成已经在它自己那条链上记过了。客户端真来取时若在这里再建一次
  // 治理出口 / 再合成一次，就会造出"同一段语音被外发两次"的假账——而它一次都没发生。
  const source = readFileSync(join(import.meta.dirname, "..", "voice-routes.ts"), "utf8");
  const warmBranch = source.slice(source.indexOf("const warmed = await takeWarmCompanionSegment("));
  assert.ok(warmBranch.length > 0, "没找到预热命中的分支");
  const warmHit = warmBranch.slice(0, warmBranch.indexOf("const selection = await resolveSelectionForSynthesis(session, req.log);"));
  assert.doesNotMatch(warmHit, /synthesizeTtsBytes\(/,
    "预热命中后又合成了一遍：同一段音频被外发两次，审计也会记两次");
  assert.doesNotMatch(warmHit, /createGovernedMediaCall\(/,
    "预热命中时新建了治理出口：那一段音频没有新的外发，不该有第二条审计");
  // 补记的是**送达/播放**那件领域事实（synth outcome），它与"模型被调用了几次"是两件事。
  assert.match(warmHit, /recordCompanionTtsSynthOutcome\(/,
    "预热命中时该补记领域 outcome，否则客户端真来取时这一段的引擎与耗时读数会丢");
});

test("模型调用与领域 outcome 是两件事：播放上报不建治理出口", async () => {
  const source = readFileSync(join(import.meta.dirname, "..", "voice-routes.ts"), "utf8");
  const from = source.indexOf('app.post("/voice/tts/playback-outcome"');
  assert.ok(from > 0, "没找到 playback-outcome 分支");
  // 只取这一个 handler：后面还有 ASR，那条路是真的外发，不能被这条判据扫进来。
  const next = source.indexOf("app.post(", from + 1);
  const playback = source.slice(from, next > 0 ? next : source.length);
  assert.doesNotMatch(playback, /createGovernedMediaCall\(/,
    "播放上报不是模型调用：它没有外发，建治理出口会凭空多出一条审计");
  assert.match(playback, /recordCompanionTtsPlaybackOutcome\(/);
});

// ─── ASR 形状的 run：门必须在真回调之前 ─────────────────────────────────

/**
 * ASR 那种"先 `noteBytes`，再把一次真实转写塞进 `run`"的形状。
 *
 * 上一版把门放在了 `prepareText` 里，而这条路径根本不调它——于是没同意、
 * `sendToExternal=false` 时音频照样发出去。现在门在 `run`/`openStream` 内部，
 * 省不掉；这条用例用**真实回调计数**证明：被拒时回调一次都不该被调用。
 */
function asrHarness(policy: { sendToExternal: boolean; auditLogging?: boolean } | "no-consent") {
  const rows: AuditRow[] = [];
  let transcribeCalls = 0;
  const call = () => createGovernedMediaCall(
    { workspaceId: WS, userId: USER },
    "voice_asr_transcription",
    ["audio_content"],
    {
      settings: async () => ({
        requiresConsent: policy !== "no-consent",
        consentAt: policy === "no-consent" ? null : new Date(),
        consentVersion: policy === "no-consent" ? null : "v1",
        dataPolicy: {
          sendToExternal: policy !== "no-consent" ? policy.sendToExternal : true,
          sendImageContent: false, piiDetection: true,
          auditLogging: policy === "no-consent" ? true : (policy.auditLogging ?? true),
        },
      }),
      audit: async (row: Record<string, unknown>) => { rows.push(row as unknown as AuditRow); },
    },
  );
  const transcribe = async (call_: Awaited<ReturnType<typeof call>>) => {
    // 计数放在**回调内部**：它数的是"上游真的被调用了几次"。
    // 放在 run 外面量的是"调用方尝试了几次"，被门拦下时那也等于 1——测不出任何东西。
    return call_.run({ provider: "siliconflow", modelId: "SenseVoice" }, async () => {
      transcribeCalls += 1;
      return { text: "识别结果" };
    });
  };
  return { rows, transcribe, transcribeCalls: () => transcribeCalls, call };
}

test("ASR 形状：同意与政策都放行时真实回调被调用一次", async () => {
  const h = asrHarness({ sendToExternal: true });
  const media = await h.call();
  media.noteBytes(4096);
  const out = await h.transcribe(media);
  assert.equal(out.text, "识别结果");
  assert.equal(h.transcribeCalls(), 1);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0]!.operation, "voice_asr_transcription");
  assert.deepEqual(h.rows[0]!.dataCategories, ["audio_content"]);
  assert.ok((h.rows[0]!.dataSizeBytes ?? 0) >= 4096, "送出去的音频字节数要记");
});

test("ASR 形状：没同意时真实回调零调用", async () => {
  const h = asrHarness("no-consent");
  const media = await h.call();
  media.noteBytes(4096);
  await assert.rejects(() => h.transcribe(media));
  assert.equal(h.transcribeCalls(), 0, "没同意外发时上游转写被调用了");
  assert.equal(h.rows.length, 0, "没发出去就没有这一次外发");
});

test("ASR 形状：sendToExternal=false 时真实回调零调用", async () => {
  const h = asrHarness({ sendToExternal: false });
  const media = await h.call();
  media.noteBytes(4096);
  await assert.rejects(() => h.transcribe(media));
  assert.equal(h.transcribeCalls(), 0, "政策关掉外发时上游转写仍被调用了");
  assert.equal(h.rows.length, 0);
});

// ─── 降级与取消 ──────────────────────────────────────────────────────────

test("治理拒绝不触发降级：qwen 被门拦下时 edge 一次都不该被调用", async () => {
  const h = harness({ policy: { sendToExternal: false, piiDetection: true, auditLogging: true } });
  let fallbacks = 0;
  await assert.rejects(() => synthesize(h.deps, { onQwenFallback: () => { fallbacks += 1; } }));
  assert.equal(fallbacks, 0, "治理拒绝被当成上游故障降级了：降级就是第二条外发");
  assert.equal(h.sent.length, 0);
});

test("qwen 被取消时不降级 edge", async () => {
  const aborted = new AbortController();
  const h = harness();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const deps: TtsEngineDeps = {
    ...h.deps,
    qwenSynthesize: (async (_key: string, text: string, options: { signal?: AbortSignal }) => {
      h.sent.push({ engine: "qwen", text });
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(
          Object.assign(new Error("aborted"), { name: "AbortError" })));
        entered();
      });
    }) as never,
  };
  // 用户在 qwen 途中按下取消（内核步预算到点）。
  const pending = synthesize(deps, { signal: aborted.signal });
  await started;
  aborted.abort();
  await assert.rejects(() => pending);
  assert.deepEqual(h.sent.map((s) => s.engine), ["qwen"],
    "取消之后不该再发一次 edge：用户已经停下了");
});

test("上游错误的原文不进审计行（只留稳定机器码）", async () => {
  const rows: AuditRow[] = [];
  const media = await createGovernedMediaCall({ workspaceId: WS, userId: USER }, "voice_synthesis_edge", ["text_content"], {
    settings: async () => ({
      requiresConsent: false, consentAt: new Date(), consentVersion: "v1",
      dataPolicy: { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true },
    }),
    audit: async (row: Record<string, unknown>) => { rows.push(row as unknown as AuditRow); },
  });
  // 上游 message 里混着正文、完整 URL 与凭据——这些都不能进合规表。
  await assert.rejects(() => media.run({ provider: "edge", modelId: "edge-tts" }, async () => {
    throw Object.assign(new Error("联系 learner@example.com 失败 https://tts.internal/v1/speech?sig=abc Bearer sk-live-123"), { code: "NETWORK_ERROR" });
  }));
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes("learner@example.com"), false, "正文进了审计行");
  assert.equal(serialized.includes("sk-live-123"), false, "凭据进了审计行");
  assert.equal(serialized.includes("sig=abc"), false, "完整 URL 进了审计行");
  assert.match(serialized, /NETWORK_ERROR/, "稳定的机器码要留着：排障靠它，不靠原始文本");
});
