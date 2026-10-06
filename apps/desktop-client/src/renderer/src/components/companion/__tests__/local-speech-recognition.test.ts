// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 本地 ASR 路由（2026-10-06：解码搬到主进程的 Node 子进程）。
 *
 * 这一层最贵的错法是「安静地慢」与「悄悄送出设备」：
 *  - 没装模型就仍然把录音交出去 / 或让调用方等满超时 —— 前者是隐私事故，后者是"说完了
 *    一直没反应"；
 *  - 模型下到一半或下失败时当"能用"，用户于是拿到一句没法复现的"识别失败"。
 *
 * 锁三件事：没装模型**不叫引擎**、样本按 16 kHz Int16 base64 原样过桥、
 * 本机引擎起不来时抛的那一格错误码会一路走到界面（服务端没参与这一层要看得见）。
 */
function snapshot(status: "absent" | "downloading" | "ready" | "error") {
  return {
    version: 1,
    modelId: "sensevoice-int8-zh-en-ja-ko-yue",
    mountUrl: "ailearn-app://bundle/device/asr/",
    status,
    expectedBytes: 239_549_735,
    receivedBytes: status === "ready" ? 239_549_735 : 0,
    installedBytes: status === "ready" ? 239_549_735 : 0,
    files: [],
    failure: null,
    installedAt: null,
  } as never;
}

function stubRuntime(
  status: "absent" | "downloading" | "ready" | "error" = "ready",
  transcribe?: (input: { meta: unknown; request: { sampleRate: number; pcmBase64: string } }) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const call = vi.fn(async (input: { meta: unknown; request: { sampleRate: number; pcmBase64: string } }) => {
    if (transcribe) return transcribe(input);
    return { ok: true, data: { text: "本地结果" }, meta: {} };
  });
  vi.stubGlobal("window", Object.assign(globalThis.window, {
    ailearn: {
      companion: {
        voice: {
          asrModel: { getState: vi.fn(async () => ({ ok: true, data: snapshot(status), meta: {} })) },
          transcribe: call,
        },
      },
    },
  }));
  vi.resetModules();
  return call;
}

function decodeBase64Pcm(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

const args = () => ({ sampleRate: 16_000, samples: new Float32Array(1_600) });

describe("local speech recognition routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses to recognise without an installed model and never starts the engine", async () => {
    const call = stubRuntime("absent");
    const { transcribeRecording, isAsrModelMissing } = await import("../local-speech-recognition");
    const started = Date.now();

    await expect(transcribeRecording(args())).rejects.toSatisfy((error: unknown) => isAsrModelMissing(error));
    // 没装模型就连引擎都不该叫：那 228 MB 是白占，句子也不该离开这台机器。
    expect(call).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("treats a half-finished or failed download as \"not installed\" too", async () => {
    for (const status of ["downloading", "error"] as const) {
      const call = stubRuntime(status);
      const { transcribeRecording, isAsrModelMissing } = await import("../local-speech-recognition");
      await expect(transcribeRecording(args())).rejects.toSatisfy((error: unknown) => isAsrModelMissing(error));
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("hands the engine 16 kHz Int16 base64 and returns its text as the local route", async () => {
    let seen: { sampleRate: number; pcmBase64: string } | null = null;
    const call = stubRuntime("ready", async (input) => {
      seen = input.request;
      return { ok: true, data: { text: "本机引擎认出来的字" }, meta: {} };
    });
    const { transcribeRecording } = await import("../local-speech-recognition");

    const result = await transcribeRecording({
      sampleRate: 16_000,
      samples: new Float32Array([0, 0.5, -0.5, 1, -1]),
    });
    expect(result).toEqual({ text: "本机引擎认出来的字", route: "local" });
    expect(call).toHaveBeenCalledTimes(1);

    const request = seen as unknown as { sampleRate: number; pcmBase64: string };
    expect(request.sampleRate).toBe(16_000);
    const pcm = decodeBase64Pcm(request.pcmBase64);
    expect(Array.from(pcm)).toEqual([0, 16_384, -16_383, 32_767, -32_767]);
  });

  it("surfaces a dead local engine as \"voice_engine_unavailable\", not as a network problem", async () => {
    stubRuntime("ready", async () => ({
      ok: false,
      error: {
        code: "voice_engine_unavailable",
        safeMessageKey: "error.voice_engine_unavailable",
        retry: "user_action",
        fieldErrors: [],
      },
      meta: {},
    }));
    const { transcribeRecording } = await import("../local-speech-recognition");

    const failure = await transcribeRecording(args()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("voice_engine_unavailable");
  });

  it("isLocalAsrReady only reports whether the model is installed", async () => {
    const call = stubRuntime("ready");
    const { isLocalAsrReady } = await import("../local-speech-recognition");
    await expect(isLocalAsrReady()).resolves.toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});