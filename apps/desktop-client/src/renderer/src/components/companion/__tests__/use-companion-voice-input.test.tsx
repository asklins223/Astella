// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompanionVoiceInput } from "../use-companion-voice-input";
import { useRoomStore } from "../../../app/room-store";
import { useCompanionNotifications } from "../companion-notifications";
import { SETTINGS_ATTENTION_VOICE_MODEL } from "../open-voice-model-settings";
import { isCompanionMicrophoneActive } from "../companion-notification-voice";

/**
 * 录音器在这里是一台**手摇的**：测试自己推帧、推电平，VAD 与分段才有确定的时间轴。
 * 假时钟让 `Date.now()` 跟着 `advanceTimersByTime` 走，静音时长就能按拍数出来。
 */
const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  options: null as null | {
    onFrame?: (chunk: Float32Array, inputSampleRate: number) => void;
    onLevel?: (level: number) => void;
    onLimit?: () => void;
  },
}));
const transcribe = vi.hoisted(() => vi.fn());
const asrReady = vi.hoisted(() => vi.fn());
const playback = vi.hoisted(() => ({ active: false, stops: 0, listeners: new Set<() => void>() }));

vi.mock("../voice-recorder", () => ({ CompanionVoiceRecorder: class {
  static isSupported() { return true; }
  constructor(options: NonNullable<typeof recorder.options>) { recorder.options = options; }
  start = recorder.start;
  stop = recorder.stop;
} }));
vi.mock("../local-speech-recognition", () => ({
  transcribeRecording: transcribe,
  isLocalAsrReady: asrReady,
  isAsrModelMissing: (error: unknown) => error instanceof Error && error.name === "AsrModelMissingError",
}));
vi.mock("../voice-asr-model", async importOriginal => ({ ...await importOriginal<typeof import("../voice-asr-model")>(), readVoiceAsrModel: vi.fn() }));
vi.mock("../../../app/desktop-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/desktop-client")>();
  return { ...actual, requireWorkspaceEpoch: async () => "epoch" };
});
vi.mock("../../../app/companion-voice-playback", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/companion-voice-playback")>();
  return {
    ...actual,
    stopCompanionSpeech: () => {
      playback.stops += 1;
      playback.active = false;
      for (const listener of playback.listeners) listener();
    },
    isCompanionSpeechActive: () => playback.active,
    subscribeCompanionSpeechActivity: (listener: () => void) => {
      playback.listeners.add(listener);
      return () => { playback.listeners.delete(listener); };
    },
  };
});

/** 一帧一拍：50ms 的 16kHz 音频 + 一个电平采样，跟真录音器的节拍同形。 */
function tick(level: number) {
  act(() => {
    recorder.options?.onFrame?.(new Float32Array(800).fill(level), 16000);
    recorder.options?.onLevel?.(level);
    vi.advanceTimersByTime(50);
  });
}
const say = (level: number, ticks: number) => { for (let index = 0; index < ticks; index += 1) tick(level); };
/**
 * 冲掉排队中的识别与收尾。
 *
 * 要多冲几跳：一段音频要过「队列 → transcribe → 贴字幕」，收尾还要再过
 * 「队列 → onTurn」，一次 `await` 只推进一跳微任务，冲少了看到的是"没发出去"。
 */
const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  recorder.start.mockReset().mockResolvedValue(undefined);
  recorder.stop.mockReset().mockResolvedValue(null);
  recorder.options = null;
  transcribe.mockReset();
  asrReady.mockReset().mockResolvedValue(true);
  playback.active = false;
  playback.stops = 0;
  playback.listeners.clear();
  useRoomStore.setState({ surface: null, settingsSection: "account", settingsAttention: null });
  useCompanionNotifications.setState({ items: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("语音对话会话", () => {
  /**
   * 2026-10：模型是用户在设置里下的附加功能，没装就不说话。
   *
   * 这一格钉的是**判断的时机**：在麦克风已经打开之后才等模型状态，用户就白说了半句
   * 还要被挡一次。所以开录那一刻先判一次，判定不通过就连麦克风都不开口要。
   */
  it("这台设备没有识别模型时，一个字节都不要麦克风", async () => {
    asrReady.mockResolvedValue(false);
    const onTurn = vi.fn();
    const onModelMissing = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn, onModelMissing }));

    await act(async () => { result.current.toggle(); });
    await flush();

    expect(result.current.modelMissing).toBe(true);
    expect(result.current.phase).toBe("idle");
    expect(result.current.note).toContain("还没有语音识别模型");
    expect(recorder.start).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTurn).not.toHaveBeenCalled();
    expect(onModelMissing).toHaveBeenCalledOnce();
    expect(useRoomStore.getState()).toMatchObject({ surface: "settings", settingsSection: "companion", settingsAttention: SETTINGS_ATTENTION_VOICE_MODEL });
    expect(isCompanionMicrophoneActive()).toBe(false);
  });

  /**
   * 这就是这次改动的正面：说完一句、停一下，字自己长出来，**没有任何东西要点**。
   *
   * 11 拍人声 = 500ms，把切段武装起来；再静 450ms → 切段识别。此时只该有字幕，
   * 不该有发送——轮次还没结束，用户可能马上接着说。
   */
  it("短停顿切出一段：字幕长出来，但这一轮还没发", async () => {
    transcribe.mockResolvedValue({ route: "local", text: "今天学到这里" });
    const onTurn = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn }));
    await act(async () => { result.current.toggle(); });
    await flush();
    expect(result.current.phase).toBe("open");

    say(0.3, 11);
    say(0.001, 9);
    await flush();

    expect(transcribe).toHaveBeenCalledOnce();
    expect(result.current.caption?.text).toBe("今天学到这里");
    expect(result.current.caption?.sending).toBe(false);
    expect(onTurn).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("open");
  });

  /**
   * 长停顿 = 这一轮说完 → 整轮文本直接交出去，界面不摆编辑框也不摆发送按钮。
   *
   * 尾随静音也会被切成"最后一段"送去识别（那是 drain 的必然），真引擎对纯静音
   * 返回空串，这里就用空串——拼接必须把它咽掉，不然句尾会拖出一个多余的标点。
   */
  it("长停顿把这一轮直接发出去，字幕清空，麦克风继续开着", async () => {
    transcribe.mockResolvedValueOnce({ route: "local", text: "今天学到这里" })
      .mockResolvedValue({ route: "local", text: "" });
    const onTurn = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn }));
    await act(async () => { result.current.toggle(); });
    await flush();

    say(0.3, 11);
    say(0.001, 17); // 950ms 切段，1350ms 收尾
    await flush();

    expect(onTurn).toHaveBeenCalledWith("今天学到这里");
    expect(result.current.caption).toBeNull();
    expect(result.current.phase).toBe("open");
    expect(isCompanionMicrophoneActive()).toBe(true);
  });

  /** 收尾那一刻界面是「在想这一句」，发出去之后自己回到「在听」。 */
  it("轮次收尾时先进入 closing，发出去再回到 open", async () => {
    let finish!: (value: { route: "local"; text: string }) => void;
    transcribe.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onTurn = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn }));
    await act(async () => { result.current.toggle(); });
    await flush();

    say(0.3, 11);
    say(0.001, 17);
    // 收尾那一刻：相位先进 closing（界面要写「在想这一句」，不能还写着"我在听"）。
    expect(result.current.phase).toBe("closing");
    expect(onTurn).not.toHaveBeenCalled();
    // 排进队列的识别要等微任务才真的开始跑；不冲这一跳，`finish` 还没被赋上。
    await flush();
    expect(result.current.caption?.sending).toBe(true);
    expect(result.current.caption?.text).toBe("");
    expect(onTurn).not.toHaveBeenCalled();

    act(() => { finish({ route: "local", text: "这一句" }); });
    await flush();
    expect(onTurn).toHaveBeenCalledWith("这一句");
    expect(result.current.phase).toBe("open");
    expect(result.current.caption).toBeNull();
  });

  /** 下一段要等上一段解完才开始，字幕因此必然按说的顺序长。 */
  it("第二段等第一段解完才开始，拼起来的话序是对的", async () => {
    const pending: Array<{ resolve: (value: { route: "local"; text: string }) => void; samples: number }> = [];
    transcribe.mockImplementation((args: { samples: Float32Array }) => new Promise(resolve => {
      pending.push({ resolve, samples: args.samples.length });
    }));
    const onTurn = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn }));
    await act(async () => { result.current.toggle(); });
    await flush();

    say(0.3, 11);
    say(0.001, 9); // 950ms：切第一段
    await flush();
    expect(pending).toHaveLength(1);

    say(0.3, 11);
    say(0.001, 17); // 切第二段，随后判定这一轮说完
    await flush();
    // 队列被第一段占着：第二段还在排队，这一轮的收尾也只能等。
    expect(pending).toHaveLength(1);

    act(() => { pending[0]?.resolve({ route: "local", text: "这一段我没看懂" }); });
    await flush();
    expect(result.current.caption?.text).toBe("这一段我没看懂");
    expect(pending).toHaveLength(2);

    act(() => { pending[1]?.resolve({ route: "local", text: "再举一个例子" }); });
    await flush();
    // 队列跑完 = 这一轮的字拼完 = 直接发出去。收尾看的是在途的识别，
    // 不是此刻屏幕上有几个字（那段静音早就归了环形缓冲，不会再解一遍）。
    expect(onTurn).toHaveBeenCalledWith("这一段我没看懂。再举一个例子");
    expect(result.current.caption).toBeNull();
    expect(result.current.phase).toBe("open");
  });

  /** 退出对话按"我说完了"理解：已经说出口的那一句仍然算数。 */
  it("再点一次麦克风是结束对话，这一句照样发出去", async () => {
    transcribe.mockResolvedValue({ route: "local", text: "先这样" });
    const onTurn = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn }));
    await act(async () => { result.current.toggle(); });
    await flush();

    say(0.3, 11);
    say(0.001, 9);
    await flush();
    act(() => { result.current.toggle(); });
    await flush();

    expect(onTurn).toHaveBeenCalledWith("先这样");
    expect(result.current.phase).toBe("idle");
    expect(isCompanionMicrophoneActive()).toBe(false);
  });

  it("取消会话把这一轮丢掉，迟到的识别结果也不许发出去", async () => {
    let finish!: (value: { route: "local"; text: string }) => void;
    transcribe.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onTurn = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn }));
    await act(async () => { result.current.toggle(); });
    await flush();

    say(0.3, 11);
    say(0.001, 9);
    await flush();
    act(() => { result.current.cancel(); });
    act(() => { finish({ route: "local", text: "迟到的识别结果" }); });
    await flush();

    expect(result.current.phase).toBe("idle");
    expect(result.current.caption).toBeNull();
    expect(onTurn).not.toHaveBeenCalled();
  });

  /**
   * 她正在念回复，我开口打断。
   *
   * 说话期间麦克风**不攒音频**（回声消除压不干净她自己的声音，攒进去就会把她自己的
   * 话当成我说的），但电平一直在看：连续越过一个明显更高的门槛才算真插话。
   */
  it("她说话时我开口，会让她闭嘴并开始收我说的", async () => {
    transcribe.mockResolvedValueOnce({ route: "local", text: "打断一下" })
      .mockResolvedValue({ route: "local", text: "" });
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn: vi.fn() }));
    await act(async () => { result.current.toggle(); });
    await flush();
    playback.stops = 0;

    act(() => { playback.active = true; for (const listener of playback.listeners) listener(); });
    // 回声消除的残留：门槛以下的持续背景，以及越一下就断的，都不算插话。
    say(0.06, 6);
    expect(playback.stops).toBe(0);
    expect(transcribe).not.toHaveBeenCalled();

    say(0.3, 6); // 连续越过插话门槛
    expect(playback.stops).toBe(1);
    expect(result.current.phase).toBe("open");

    say(0.3, 12); // 攒够一句的人声
    say(0.001, 9);
    await flush();
    expect(transcribe).toHaveBeenCalled();
    expect(result.current.caption?.text).toBe("打断一下");
  });

  /** 让路是有起止的：她说完之后必须自己把麦克风收回来，不然会话从此又聋又亮着。 */
  it("她说完之后麦克风自己收回来，接着说的话仍然进得去", async () => {
    transcribe.mockResolvedValue({ route: "local", text: "接着说的" });
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn: vi.fn() }));
    await act(async () => { result.current.toggle(); });
    await flush();

    act(() => { playback.active = true; for (const listener of playback.listeners) listener(); });
    say(0.06, 4);
    expect(transcribe).not.toHaveBeenCalled();

    act(() => { playback.active = false; for (const listener of playback.listeners) listener(); });
    say(0.3, 11);
    say(0.001, 9);
    await flush();
    expect(result.current.caption?.text).toBe("接着说的");
  });

  /** 到上限不是"悄悄把麦克风关掉"：气泡停在「我在听」而设备早灭了，是最难解释的坏。 */
  it("会话到时长上限时收尾这一轮再退出", async () => {
    transcribe.mockResolvedValue({ route: "local", text: "最后一段" });
    const onSessionEnd = vi.fn();
    const onTurn = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn, onSessionEnd }));
    await act(async () => { result.current.toggle(); });
    await flush();

    say(0.3, 11);
    act(() => { recorder.options?.onLimit?.(); });
    await flush();

    expect(onTurn).toHaveBeenCalledWith("最后一段");
    expect(onSessionEnd).toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(isCompanionMicrophoneActive()).toBe(false);
  });

  it("识别中途才发现没装模型，是给一条出路而不是判死", async () => {
    transcribe.mockRejectedValue(Object.assign(new Error("本地识别模型尚未安装"), { name: "AsrModelMissingError" }));
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn: vi.fn() }));
    await act(async () => { result.current.toggle(); });
    await flush();

    say(0.3, 11);
    say(0.001, 9);
    await flush();

    expect(result.current.modelMissing).toBe(true);
    expect(result.current.note).toContain("还没有语音识别模型");
    expect(result.current.note ?? "").not.toContain("识别失败");
    expect(result.current.phase).toBe("idle");
  });

  it("读不到模型状态时不冤枉麦克风权限，重试就能说话", async () => {
    asrReady.mockRejectedValueOnce(new Error("IPC unavailable"));
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn: vi.fn() }));
    await act(async () => { result.current.toggle(); });
    await flush();
    expect(result.current.note).toContain("暂时读不到本机语音状态");
    expect(result.current.phase).toBe("idle");
    expect(recorder.start).not.toHaveBeenCalled();

    await act(async () => { result.current.toggle(); });
    await flush();
    expect(result.current.phase).toBe("open");
    expect(isCompanionMicrophoneActive()).toBe(true);
    act(() => { result.current.cancel(); });
    expect(isCompanionMicrophoneActive()).toBe(false);
  });

  /** 起录还在 await 里时连点两下，只该有一个麦克风被占住。 */
  it("起录没落定之前连点两次，也只开一个麦克风", async () => {
    let started!: () => void;
    recorder.start.mockImplementationOnce(() => new Promise<void>(resolve => { started = resolve; }));
    const { result } = renderHook(() => useCompanionVoiceInput({ onTurn: vi.fn() }));
    await act(async () => { result.current.toggle(); result.current.toggle(); });
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("starting");
    await act(async () => { started(); });
    await flush();
    expect(result.current.phase).toBe("open");
    act(() => { result.current.cancel(); });
    expect(result.current.phase).toBe("idle");
  });
});
