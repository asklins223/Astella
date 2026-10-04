/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 本地 ASR 路由（2026-10：只此一条路）。
 *
 * 这一层最贵的错法是「安静地慢」：worker 脚本加载失败时只走 onerror，不会发
 * ready/fatal 消息，于是 init 要等满 60 秒超时，用户点完「说完了」白等一分钟。
 * 这里锁三件事——崩溃即刻失败、死掉的 worker 不被复用、空闲到点必须收摊。
 *
 * 还锁了**没有第二条路**这件事本身：模型没装时抛的是 `AsrModelMissingError`，
 * 而不是某个"先发出去试试"的兜底。将来谁又想加一条云通道，这条会红。
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  postMessage(data: Record<string, unknown>): void {
    this.posted.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  failLoad(): void {
    this.onerror?.();
  }
}

const MOUNT_URL = "ailearn-app://bundle/device/asr/";

function snapshot(status: "absent" | "downloading" | "ready" | "error") {
  return {
    version: 1,
    modelId: "sensevoice-int8-zh-en-ja-ko-yue",
    mountUrl: MOUNT_URL,
    status,
    expectedBytes: 239_549_735,
    receivedBytes: status === "ready" ? 239_549_735 : 0,
    installedBytes: status === "ready" ? 239_549_735 : 0,
    files: [],
    failure: null,
    installedAt: null,
  } as never;
}

function stubRuntime(status: "absent" | "downloading" | "ready" | "error" = "ready"): void {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("window", Object.assign(globalThis.window, {
    ailearn: {
      companion: {
        voice: {
          asrModel: { getState: vi.fn(async () => ({ ok: true, data: snapshot(status), meta: {} })) },
        },
      },
    },
  }));
  vi.resetModules();
}

async function loadModule() {
  return import("../local-speech-recognition");
}

const args = () => ({ sampleRate: 16_000, samples: new Float32Array(1_600) });

describe("local speech recognition routing", () => {
  beforeEach(() => stubRuntime());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses to recognise without an installed model and never reaches for the network", async () => {
    stubRuntime("absent");
    const { transcribeRecording, isAsrModelMissing } = await loadModule();
    const started = Date.now();

    await expect(transcribeRecording(args())).rejects.toSatisfy((error: unknown) => isAsrModelMissing(error));
    // 一个 worker 都不该被拉起：模型都没有，拉引擎只是白占几百 MB。
    expect(FakeWorker.instances).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("treats a half-finished or failed download as \"not installed\" too", async () => {
    for (const status of ["downloading", "error"] as const) {
      stubRuntime(status);
      const { transcribeRecording, isAsrModelMissing } = await loadModule();
      await expect(transcribeRecording(args())).rejects.toSatisfy((error: unknown) => isAsrModelMissing(error));
      expect(FakeWorker.instances).toHaveLength(0);
    }
  });

  it("hands the worker the mount URL the main process reported, not a hard-coded path", async () => {
    const { transcribeRecording } = await loadModule();
    const pending = transcribeRecording(args());
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const worker = FakeWorker.instances[0]!;
    expect(worker.posted[0]).toEqual({ type: "init", mountUrl: MOUNT_URL });
    worker.emit({ type: "ready" });
    await vi.waitFor(() => expect(worker.posted.some((message) => message.type === "decode")).toBe(true));
    const decode = worker.posted.find((message) => message.type === "decode")!;
    worker.emit({ type: "result", id: decode.id, text: "本地结果" });
    await expect(pending).resolves.toEqual({ text: "本地结果", route: "local" });
  });

  it("fails at once when the worker fails to load, and never reuses the dead one", async () => {
    const { transcribeRecording } = await loadModule();

    const first = transcribeRecording(args());
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    const dead = FakeWorker.instances[0]!;
    dead.failLoad();
    await expect(first).rejects.toThrow(/crashed/);
    expect(dead.terminated).toBe(true);

    const second = transcribeRecording(args());
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const live = FakeWorker.instances[1]!;
    expect(live).not.toBe(dead);
    live.emit({ type: "ready" });
    await vi.waitFor(() => expect(live.posted.some((message) => message.type === "decode")).toBe(true));
    const decode = live.posted.find((message) => message.type === "decode")!;
    live.emit({ type: "result", id: decode.id, text: "本地结果" });
    await expect(second).resolves.toEqual({ text: "本地结果", route: "local" });
  });

  /**
   * 空闲下线（2026-09-22 性能重扫 H6）。
   *
   * 这一层以前只有崩溃才 `terminate`：本地 SenseVoice 一份引擎就是那份 228 MB 的 int8
   * 模型，用户说过一句话之后它就一直占到应用退出——而语音是偶尔用的。这里锁两件事：
   * 空闲窗口到点必须下线，且再说一句要能重新拉起（不能下线之后就永久坏掉）。
   */
  it("releases the engine after the idle window and re-spawns for the next utterance", async () => {
    vi.useFakeTimers();
    try {
      const flush = async (ms = 0) => {
        await vi.advanceTimersByTimeAsync(ms);
      };
      const { transcribeRecording } = await loadModule();

      const first = transcribeRecording(args());
      await flush();
      expect(FakeWorker.instances).toHaveLength(1);
      const worker = FakeWorker.instances[0]!;
      worker.emit({ type: "ready" });
      await flush();
      const decode = worker.posted.find((message) => message.type === "decode");
      expect(decode).toBeTruthy();
      worker.emit({ type: "result", id: decode!.id, text: "本地结果" });
      await expect(first).resolves.toMatchObject({ text: "本地结果", route: "local" });
      expect(worker.terminated).toBe(false);

      // 差一秒不收：说明这条线是"空闲"而不是"用完即弃"，连说几句不用重载模型。
      await flush(89_000);
      expect(worker.terminated).toBe(false);
      await flush(90_000 - 89_000 + 1_000);
      expect(worker.terminated).toBe(true);

      const second = transcribeRecording(args());
      await flush();
      expect(FakeWorker.instances).toHaveLength(2);
      const next = FakeWorker.instances[1]!;
      expect(next).not.toBe(worker);
      next.emit({ type: "ready" });
      await flush();
      const nextDecode = next.posted.find((message) => message.type === "decode");
      expect(nextDecode).toBeTruthy();
      next.emit({ type: "result", id: nextDecode!.id, text: "第二句" });
      await expect(second).resolves.toMatchObject({ text: "第二句", route: "local" });
    } finally {
      vi.useRealTimers();
    }
  });
});