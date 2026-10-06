/**
 * 本机识别引擎（主进程侧的 utilityProcess 管理者）的单测。
 *
 * 这一层是"引擎在不在、崩了怎么办、什么时候把它收回来"三条线的唯一判据：
 *   - 一次解码一轮一句，按 id 配对回包（乱序回包也必须各自归位）；
 *   - 子进程退出 ⇒ 在途请求立刻失败、句柄丢掉，下一次**重新 fork**（死句柄绝不复用）；
 *   - 空闲 90 s 交还内存（228 MB 的引擎不该占到应用退出），**有在途请求时顺延**。
 *
 * `utilityProcess` 与 `electron` 在这里都是替身：真的拉一个 Node 子进程去读 228 MB
 * 模型不该由单测负责，真窗口那一条路由 2026-10-06 的安装包复测覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeChild {
  readonly scriptPath: string;
  readonly args: string[];
  posted: unknown[];
  killed: boolean;
  postMessage(message: unknown): void;
  kill(): void;
  emitMessage(message: unknown): void;
  emitExit(): void;
}

const forked: FakeChild[] = [];
const forkMock = vi.fn((scriptPath: string, args: string[]) => {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const child: FakeChild & { on: (event: string, listener: (payload: unknown) => void) => void } = {
    scriptPath,
    args,
    posted: [],
    killed: false,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    postMessage(message) {
      child.posted.push(message);
    },
    emitMessage(message) {
      for (const listener of listeners.get("message") ?? []) listener(message);
    },
    emitExit() {
      for (const listener of listeners.get("exit") ?? []) listener(0);
    },
    kill() {
      child.killed = true;
    },
  };
  forked.push(child);
  return child;
});

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/tmp/ailearn-asr-test",
    getPath: () => "/tmp/ailearn-asr-test/userData",
  },
  utilityProcess: { fork: forkMock },
}));

// 引擎文件与模型在真机上是否存在，是 `resolveVoiceAsrEnginePaths` 的判据；这里一律
// 说"在"——路径解析本身另有纯逻辑（绝对路径 + 三个文件齐全），不该由单测碰真实磁盘。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, existsSync: () => true }, existsSync: () => true };
});

const PATHS = {
  hostPath: "/tmp/out/main/voice-asr-host.js",
  engineDir: "/tmp/out/renderer/sherpa",
  modelPath: "/tmp/userData/voice-models/model.int8.onnx",
  tokensPath: "/tmp/userData/voice-models/tokens.txt",
};

function loadModule() {
  return import("../voice-asr-engine");
}

describe("VoiceAsrEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forked.length = 0;
    forkMock.mockClear();
    // 模块里那一份进程内共享引擎必须每条用例重新拿，否则上一条收摊后的 `disposed`
    // 会顺着模块单例漏进下一条。
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forks lazily with the engine paths as argv and answers one decode per id", async () => {
    const { VoiceAsrEngine } = await loadModule();
    const engine = new VoiceAsrEngine(PATHS);
    expect(forked).toHaveLength(0);

    const pcm = new Int16Array([0, 1000, -1000]);
    const pending = engine.transcribe(pcm, 16_000);
    expect(forked).toHaveLength(1);
    expect(forked[0]!.scriptPath).toBe(PATHS.hostPath);
    expect(forked[0]!.args).toEqual([PATHS.engineDir, PATHS.modelPath, PATHS.tokensPath]);
    expect(forked[0]!.posted[0]).toMatchObject({ type: "decode", sampleRate: 16_000, pcm });

    forked[0]!.emitMessage({ type: "result", id: 1, text: "插入排序是稳定的。" });
    await expect(pending).resolves.toBe("插入排序是稳定的。");
  });

  it("pairs replies by id even when they come back out of order", async () => {
    const { VoiceAsrEngine } = await loadModule();
    const engine = new VoiceAsrEngine(PATHS);
    const first = engine.transcribe(new Int16Array(2), 16_000);
    const second = engine.transcribe(new Int16Array(3), 16_000);
    expect(forked).toHaveLength(1);
    expect(forked[0]!.posted).toHaveLength(2);

    forked[0]!.emitMessage({ type: "result", id: 2, text: "第二句" });
    forked[0]!.emitMessage({ type: "result", id: 1, text: "第一句" });
    await expect(first).resolves.toBe("第一句");
    await expect(second).resolves.toBe("第二句");
  });

  it("reports a per-decode error without killing the process", async () => {
    const { VoiceAsrEngine } = await loadModule();
    const engine = new VoiceAsrEngine(PATHS);
    const pending = engine.transcribe(new Int16Array(2), 16_000);
    forked[0]!.emitMessage({ type: "error", id: 1, message: "decode boom" });
    await expect(pending).rejects.toThrow(/decode boom/);
    expect(forked[0]!.killed).toBe(false);

    // 进程还活着：下一句还能走同一条路。
    const next = engine.transcribe(new Int16Array(2), 16_000);
    forked[0]!.emitMessage({ type: "result", id: 2, text: "还在" });
    await expect(next).resolves.toBe("还在");
  });

  it("fails every in-flight decode when the process exits, and never reuses the dead one", async () => {
    const { VoiceAsrEngine } = await loadModule();
    const engine = new VoiceAsrEngine(PATHS);
    const first = engine.transcribe(new Int16Array(2), 16_000);
    forked[0]!.emitExit();
    await expect(first).rejects.toThrow(/exited/);

    const second = engine.transcribe(new Int16Array(2), 16_000);
    expect(forked).toHaveLength(2);
    expect(forked[1]).not.toBe(forked[0]);
    // id 是这份 engine 上的递增值：换了一个进程也还是 2。
    forked[1]!.emitMessage({ type: "result", id: 2, text: "重开之后" });
    await expect(second).resolves.toBe("重开之后");
  });

  it("a fatal init error fails the in-flight decode at once and swaps the process", async () => {
    const { VoiceAsrEngine } = await loadModule();
    const engine = new VoiceAsrEngine(PATHS);
    const pending = engine.transcribe(new Int16Array(2), 16_000);
    // 先挂上拒绝的等待，否则这一次拒绝会变成无人接手的 unhandled。
    const settled = expect(pending).rejects.toThrow(/failed to start/);

    // fatal 没有 id：它说的是"引擎起不来"，不是"这一句解不动"。
    forked[0]!.emitMessage({ type: "fatal", message: "engine files missing" });
    expect(forked[0]!.killed).toBe(true);
    // 不等那句超时兜底：这一句立刻判失败，用户点开气泡就知道"这次没做成"。
    await settled;

    const next = engine.transcribe(new Int16Array(2), 16_000);
    expect(forked).toHaveLength(2);
    forked[1]!.emitMessage({ type: "result", id: 2, text: "换了一个进程" });
    await expect(next).resolves.toBe("换了一个进程");
  });

  it("gives the 228 MB engine back after the idle window, and respawns for the next utterance", async () => {
    const { VoiceAsrEngine, VOICE_ASR_IDLE_RELEASE_MS } = await loadModule();
    const engine = new VoiceAsrEngine(PATHS);
    const first = engine.transcribe(new Int16Array(2), 16_000);
    forked[0]!.emitMessage({ type: "result", id: 1, text: "第一句" });
    await expect(first).resolves.toBe("第一句");
    expect(forked[0]!.killed).toBe(false);

    // 差一秒不收：这是"空闲"不是"用完即弃"，连说几句不用重载模型。
    await vi.advanceTimersByTimeAsync(VOICE_ASR_IDLE_RELEASE_MS - 1_000);
    expect(forked[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(forked[0]!.killed).toBe(true);

    const second = engine.transcribe(new Int16Array(2), 16_000);
    expect(forked).toHaveLength(2);
    forked[1]!.emitMessage({ type: "result", id: 2, text: "第二句" });
    await expect(second).resolves.toBe("第二句");
  });

  it("never lets the idle window yank the engine out from under a running decode", async () => {
    const { VoiceAsrEngine, VOICE_ASR_IDLE_RELEASE_MS } = await loadModule();
    const engine = new VoiceAsrEngine(PATHS);
    const pending = engine.transcribe(new Int16Array(2), 16_000);
    await vi.advanceTimersByTimeAsync(VOICE_ASR_IDLE_RELEASE_MS + 10_000);
    expect(forked[0]!.killed).toBe(false);
    forked[0]!.emitMessage({ type: "result", id: 1, text: "慢慢说完" });
    await expect(pending).resolves.toBe("慢慢说完");
  });

  it("drops the shared engine after any failure so a just-installed model can work", async () => {
    const { VoiceAsrEngine, transcribeWithVoiceAsrEngine } = await loadModule();
    void VoiceAsrEngine;
    const first = transcribeWithVoiceAsrEngine(new Int16Array(2), 16_000);
    forked[0]!.emitExit();
    await expect(first).rejects.toThrow(/exited/);

    const second = transcribeWithVoiceAsrEngine(new Int16Array(2), 16_000);
    expect(forked).toHaveLength(2);
    forked[1]!.emitMessage({ type: "result", id: 1, text: "换个进程继续" });
    await expect(second).resolves.toBe("换个进程继续");
  });
});