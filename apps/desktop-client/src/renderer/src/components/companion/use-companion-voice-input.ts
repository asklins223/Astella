import { useCallback, useEffect, useRef, useState } from "react";
import {
  gatewayErrorMessage,
} from "../../app/desktop-client";
import { CompanionVoiceRecorder } from "./voice-recorder";
import { guideVoiceModelDownload } from "./voice-model-notifications";
import { holdCompanionMicrophone } from "./companion-notification-voice";
import { stopCompanionSpeech } from "../../app/companion-voice-playback";
import { isAsrModelMissing, isLocalAsrReady, transcribeRecording } from "./local-speech-recognition";
import {
  COMPANION_VAD_INITIAL_STATE,
  companionVadStep,
  type CompanionVadState,
} from "./companion-voice-vad";

/**
 * 伴星语音输入（2026-09-18；2026-10 只剩本机这一条路）。
 *
 * 录音结束后把转写文字交给 HUD 的独立语音气泡，用户可修改后发送。
 *
 * 交互是「点一下开始说」：录到足够人声后，连续静音由 VAD 判定收尾（见
 * companion-voice-vad），不需要用户再点一次。
 *
 * 模型是用户在设置里自己下的附加功能（见 `voice-asr-model.ts`）。没装时这里
 * **不猜、不重试**，直接告诉界面「去设置里下载」——那条路有可点的下一步，
 * 而一句「识别失败」没有。
 */

export type CompanionVoicePhase = "idle" | "listening" | "transcribing";

export interface CompanionVoiceTranscript {
  readonly text: string;
}

export interface CompanionVoiceInputOptions {
  readonly disabled?: boolean;
  readonly onTranscript: (transcript: CompanionVoiceTranscript) => void | Promise<void>;
  readonly onModelMissing?: () => void;
}

export interface CompanionVoiceInput {
  readonly phase: CompanionVoicePhase;
  readonly note: string | null;
  /**
   * 每发出一条提示就 +1。
   *
   * 只有 `note` 字符串本身不够：5 秒的限时提示还没到点时用户又撞上同一个失败，
   * 字符串没变 → UI 那个 effect 不重跑 → 倒计时不重置，也没有第二次反馈——
   * 而下面那条注释承诺的"下一次同样的失败仍然算一次新事件"，只有在
   * `dismissNote` 已经跑过后成立（方案 35 E5）。
   */
  readonly noteRevision: number;
  readonly supported: boolean;
  readonly toggle: () => void;
  readonly cancel: () => void;
  /**
   * 收掉当前提示（提示条限时显示后由 UI 调用）。清空后同一句话再次出现会被
   * 当成新事件——否则连点两次「没有任何麦克风」第二次不会再有反馈。
   */
  readonly dismissNote: () => void;
  /**
   * 实时电平订阅（约 20Hz）。用订阅而不是 state：20Hz 的 setState 会把整块气泡
   * UI 一起重渲，而麦克风呼吸环只关心一个 CSS 变量。
   */
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  /** 本机还没装识别模型（这一刻 voiceDraft 一定为空）。 */
  readonly modelMissing: boolean;
}

export function useCompanionVoiceInput(options: CompanionVoiceInputOptions): CompanionVoiceInput {
  const operationRef = useRef(0);
  const [phase, setPhase] = useState<CompanionVoicePhase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [noteRevision, setNoteRevision] = useState(0);
  const [modelMissing, setModelMissing] = useState(false);
  const [supported] = useState(() => CompanionVoiceRecorder.isSupported());
  const phaseRef = useRef<CompanionVoicePhase>("idle");
  phaseRef.current = phase;
  const recorderRef = useRef<CompanionVoiceRecorder | null>(null);
  const startingRef = useRef(false);
  const releaseMicrophoneRef = useRef<(() => void) | null>(null);
  const vadRef = useRef<CompanionVadState>(COMPANION_VAD_INITIAL_STATE);
  const listenersRef = useRef(new Set<(level: number) => void>());

  const emitLevel = useCallback((level: number) => {
    for (const listener of listenersRef.current) listener(level);
  }, []);

  /**
   * 发一条系统提示。文本与"这是第几次"一起变，界面才能把 5 秒内的第二次同样失败
   * 当成新事件重跑一遍计时（见 `noteRevision`）。
   */
  const showNote = useCallback((text: string) => {
    setNote(text);
    setNoteRevision((value) => value + 1);
  }, []);

  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || phaseRef.current !== "listening") return;
    recorderRef.current = null;
    const operation = operationRef.current;
    phaseRef.current = "transcribing";
    setPhase("transcribing");
    emitLevel(0);
    try {
      const recording = await recorder.stop();
      if (operation !== operationRef.current) return;
      if (!recording) {
        phaseRef.current = "idle";
        setPhase("idle");
        showNote("好像没录到内容，再试一次");
        return;
      }
      const transcription = await transcribeRecording({
        sampleRate: recording.sampleRate,
        samples: recording.samples,
      });
      if (operation !== operationRef.current) return;
      phaseRef.current = "idle";
      setPhase("idle");
      setModelMissing(false);
      showNote("识别好了，可以修改后发送；这段录音没有离开设备");
      await options.onTranscript({ text: transcription.text });
    } catch (error) {
      if (operation !== operationRef.current) return;
      phaseRef.current = "idle";
      setPhase("idle");
      // 「本机还没装模型」不是失败提示：它有自己的下一步（去设置里下载），
      // 与其在这里喊一句"识别失败"，不如把人领过去。
      if (isAsrModelMissing(error)) {
        setModelMissing(true);
        showNote("这台设备还没有语音识别模型，先去设置里下载");
        options.onModelMissing?.();
        guideVoiceModelDownload();
        return;
      }
      showNote(`识别失败：${gatewayErrorMessage(error)}`);
    } finally {
      if (operation === operationRef.current) {
        releaseMicrophoneRef.current?.();
        releaseMicrophoneRef.current = null;
      }
    }
  }, [emitLevel, options, showNote]);

  const finishRef = useRef(finish);
  finishRef.current = finish;

  const begin = useCallback(async () => {
    if (phaseRef.current !== "idle" || startingRef.current || options.disabled) return;
    if (!CompanionVoiceRecorder.isSupported()) {
      showNote("当前设备没有可用的麦克风");
      return;
    }
    // 「正在起录」这道闸先落下：下面第一件事就是一次 await，不先占住的话，
    // 连点两下「开始录音」会开两个麦克风。
    startingRef.current = true;
    const operation = ++operationRef.current;
    let modelChecked = false;
    try {
      /**
       * 先判模型，再碰麦克风。
       *
       * 顺序是有讲究的：模型是用户自己下的附加功能，没装时这一句根本不可能被识别。
       * 反过来先开麦，用户要的麦克风授权弹窗照弹、权限也给了，然后被告知说不了话——
       * 白要一次授权，还白等一句「没有模型」。所以这里在**建录音器之前**就问一次。
       */
      const ready = await isLocalAsrReady();
      if (operation !== operationRef.current) return;
      modelChecked = true;
      if (!ready) {
        setModelMissing(true);
        showNote("这台设备还没有语音识别模型，先去设置里下载");
        options.onModelMissing?.();
        guideVoiceModelDownload();
        return;
      }
      setModelMissing(false);
      stopCompanionSpeech();
      releaseMicrophoneRef.current = holdCompanionMicrophone();
      vadRef.current = COMPANION_VAD_INITIAL_STATE;
      const recorder = new CompanionVoiceRecorder({
        onLevel: (level) => {
          emitLevel(level);
          const step = companionVadStep(vadRef.current, { level, at: Date.now() });
          vadRef.current = step.state;
          if (step.verdict === "stop") void finishRef.current();
        },
        // 录到 60 秒上限：走与"说完自动收尾"完全同一条路，这段音频才会被送去识别。
        // 以前是录音器自己 `void stop()`，返回值没人接，界面就停在「我在听」上不动了。
        onLimit: () => { void finishRef.current(); },
      });
      recorderRef.current = recorder;
      await recorder.start();
      // 起录期间被取消（用户点了另一处或组件卸载）：把麦克风还回去。
      if (recorderRef.current !== recorder) {
        void recorder.stop().catch(() => undefined);
        return;
      }
      phaseRef.current = "listening";
      setPhase("listening");
      setNote(null);
    } catch {
      if (operation !== operationRef.current) return;
      recorderRef.current = null;
      releaseMicrophoneRef.current?.();
      releaseMicrophoneRef.current = null;
      phaseRef.current = "idle";
      setPhase("idle");
      showNote(modelChecked ? "麦克风不可用或未授权" : "暂时读不到本机语音状态，请稍后再试");
    } finally {
      if (operation === operationRef.current) startingRef.current = false;
    }
  }, [emitLevel, options, showNote]);

  const cancel = useCallback(() => {
    operationRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    startingRef.current = false;
    releaseMicrophoneRef.current?.();
    releaseMicrophoneRef.current = null;
    emitLevel(0);
    phaseRef.current = "idle";
    setPhase("idle");
    if (recorder) {
      void recorder.stop().catch(() => undefined);
      showNote("已取消这次录音");
    }
  }, [emitLevel, showNote]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "listening") void finishRef.current();
    else if (phaseRef.current === "idle") void begin();
  }, [begin]);

  const dismissNote = useCallback(() => setNote(null), []);

  useEffect(() => () => {
    operationRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    releaseMicrophoneRef.current?.();
    releaseMicrophoneRef.current = null;
    if (recorder) void recorder.stop().catch(() => undefined);
  }, []);

  return { phase, note, noteRevision, supported, toggle, cancel, dismissNote, subscribeLevel, modelMissing };
}
