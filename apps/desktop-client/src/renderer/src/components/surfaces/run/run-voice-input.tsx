import { useCallback, useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Mic, Square } from "lucide-react";
import { CompanionVoiceRecorder } from "../../companion/voice-recorder";
import { isAsrModelMissing, isLocalAsrReady, transcribeRecording } from "../../companion/local-speech-recognition";
import { openVoiceModelSettings } from "../../companion/open-voice-model-settings";
import { guideVoiceModelDownload } from "../../companion/voice-model-notifications";
import { holdCompanionMicrophone } from "../../companion/companion-notification-voice";
import { stopCompanionSpeech } from "../../../app/companion-voice-playback";
import { microphoneAvailabilityCopy, probeMicrophone, type MicrophoneAvailability } from "../../voice-capability";

const MAX_RECORDING_SECONDS = 60;
const MIN_TRANSCRIBE_MS = 200;

/**
 * 语音复述作答（2026-09-20 实走复盘 #8）。
 *
 * 这个交互此前**没有输入组件**：`voice_teachback` 只渲染一段"当前设备没有可用的
 * 语音输入"的阻塞文案，`voice` 载荷类型与录音器都在，但没人把声音送进去，于是
 * 换到语音作答对所有人都是死路。本组件补的就是这一截：
 * 录音 → 本机转写 → 可校对 → 交给作答载荷。
 *
 * 交互用「点一下开始、点一下结束」而不是伴星那边的 VAD 自动收尾：复述本身可能
 * 接近 `maxSeconds`，中途停顿是被允许的表达节奏，自动掐断会把话说一半截掉。
 */

export interface VoiceTeachbackValue {
  readonly confirmedTranscript: string;
  readonly correctionMethod?: "none" | "re_recorded" | "manual_text_edit";
}

export function VoiceTeachbackEditor({
  maxSeconds,
  value,
  onChange,
  onBusyChange,
}: {
  readonly maxSeconds: number;
  readonly value: VoiceTeachbackValue;
  readonly onChange: (value: VoiceTeachbackValue) => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [mic, setMic] = useState<MicrophoneAvailability | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [modelMissing, setModelMissing] = useState(false);
  const recorderRef = useRef<CompanionVoiceRecorder | null>(null);
  const operationRef = useRef(0);
  const startingRef = useRef(false);
  const releaseMicrophoneRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onBusyChange(phase !== "idle");
    return () => onBusyChange(false);
  }, [onBusyChange, phase]);

  useEffect(() => {
    let active = true;
    const probe = () => { void probeMicrophone().then((result) => { if (active) setMic(result); }); };
    probe();
    // 在系统设置里授权后回到窗口，钟面应当自己恢复——不等用户再点一次按钮。
    window.addEventListener("focus", probe);
    return () => {
      active = false;
      window.removeEventListener("focus", probe);
    };
  }, []);

  /** 单段录音上限：合同给的 maxSeconds 与录音器自身的硬上限取小。 */
  const recordingCapSeconds = Math.max(5, Math.floor(Math.min(maxSeconds, MAX_RECORDING_SECONDS)));

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setSeconds((current) => current + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  // 录音器到 60 秒会自己停下（内部硬上限）。这里必须跟着收尾，否则用户以为还在录，
  // 而点"说完了"只会拿回一个 null、被误报成"没录到声音"。
  const stopAndTranscribeRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (phase === "recording" && seconds >= recordingCapSeconds) void stopAndTranscribeRef.current?.();
  }, [phase, seconds, recordingCapSeconds]);

  const stopAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    const operation = operationRef.current;
    setPhase("transcribing");
    let recording;
    try { recording = await recorder.stop(); } catch {
      if (operation === operationRef.current) { setPhase("idle"); setNote("录音没能保存，可以再试一次。"); releaseMicrophoneRef.current?.(); releaseMicrophoneRef.current = null; }
      return;
    }
    if (operation !== operationRef.current) return;
    if (!recording || recording.samples.length === 0) {
      setPhase("idle");
      setNote("没录到声音，可以再录一次，或者改用文本作答。");
      releaseMicrophoneRef.current?.(); releaseMicrophoneRef.current = null;
      return;
    }
    if (recording.durationMs < MIN_TRANSCRIBE_MS) {
      setPhase("idle");
      setNote("这段太短了（不到 0.2 秒），再说长一点。");
      releaseMicrophoneRef.current?.(); releaseMicrophoneRef.current = null;
      return;
    }
    try {
      const transcription = await transcribeRecording({
        sampleRate: recording.sampleRate,
        samples: recording.samples,
      });
      if (operation !== operationRef.current) return;
      if (transcription.text.trim().length === 0) {
        setNote("这段录音没听出内容，再录一次长一点的说法试试。");
      } else {
        setNote(null);
      }
      onChange({
        confirmedTranscript: transcription.text.trim(),
        correctionMethod: value.confirmedTranscript.trim() ? "re_recorded" : "none",
      });
    } catch (error) {
      if (operation !== operationRef.current) return;
      // 没装模型：这不是"这次没说好"，是这台设备还不能说话。给一个能走通的下一步，
      // 并把按钮收起来——让人对着一个按下去只会被挡住的按钮反复点没有意义。
      setModelMissing(isAsrModelMissing(error));
      if (isAsrModelMissing(error)) guideVoiceModelDownload();
      setNote(isAsrModelMissing(error)
        ? "这台设备还没有语音识别模型，先下载再说话。"
        : "这段没能转成文字，可以重录，或改用文本作答。");
    } finally {
      if (operation === operationRef.current) { setPhase("idle"); releaseMicrophoneRef.current?.(); releaseMicrophoneRef.current = null; }
    }
  }, [onChange, value.confirmedTranscript]);

  stopAndTranscribeRef.current = stopAndTranscribe;

  const start = useCallback(async () => {
    if (startingRef.current || recorderRef.current) return;
    startingRef.current = true;
    const operation = ++operationRef.current;
    setNote(null);
    try {
      const ready = await isLocalAsrReady();
      if (operation !== operationRef.current) return;
      if (!ready) { setModelMissing(true); guideVoiceModelDownload(); return; }
      setModelMissing(false);
      const availability = await probeMicrophone();
      if (operation !== operationRef.current) return;
      setMic(availability);
      /**
       * 「还没有权限」不是一道闸。`enumerateDevices()` 分不出「从来没问过」和「已经点了拒绝」
       * （两种都是 label 全空），拦在这里等于把系统那次提问的机会一起没收 —— 首次授权
       * 因此永远弹不出来，界面只剩一句让人去翻系统设置的死路话。
       * 真正没有退路的是另外两种：这个窗口没有录音 API，或这台机器一个输入设备都没有。
       */
      if (availability.state === "no-api" || availability.state === "no-device") return;
      const recorder = new CompanionVoiceRecorder();
      stopCompanionSpeech();
      releaseMicrophoneRef.current = holdCompanionMicrophone();
      try {
        await recorder.start();
      } catch (error) {
        if (operation !== operationRef.current) return;
        releaseMicrophoneRef.current?.(); releaseMicrophoneRef.current = null;
        const name = error instanceof DOMException ? error.name : "UnknownError";
        // 被系统或用户拒绝时回到 `no-permission` 那句话：它给的是出路，不是一个异常名。
        setMic(name === "NotAllowedError" ? { state: "no-permission" } : { state: "start-failed", errorName: name });
        return;
      }
      if (operation !== operationRef.current) { void recorder.stop().catch(() => undefined); return; }
      // 麦都开起来了，就别再挂着探测那句「还没有权限」：它说的只是探测那一刻。
      setMic({ state: "ready" });
      recorderRef.current = recorder;
      setSeconds(0);
      setPhase("recording");
    } catch {
      if (operation === operationRef.current) {
        setNote("暂时读不到本机语音状态，请稍后再试。");
        releaseMicrophoneRef.current?.(); releaseMicrophoneRef.current = null;
      }
    } finally { if (operation === operationRef.current) startingRef.current = false; }
  }, []);

  useEffect(() => () => { operationRef.current++; startingRef.current = false; void recorderRef.current?.stop().catch(() => undefined); recorderRef.current = null; releaseMicrophoneRef.current?.(); releaseMicrophoneRef.current = null; }, []);

  const blocked = mic !== null && mic.state !== "ready";
  const reason = mic ? microphoneAvailabilityCopy(mic) : "";

  return (
    <div className="run-voice-input">
      <div className="run-voice-input__controls">
        {phase === "recording" ? (
          <button type="button" className="button primary" onClick={() => void stopAndTranscribe()}>
            <Square size={14} aria-hidden="true" />说完了（{seconds}s）
          </button>
        ) : (
          <button
            type="button"
            className="button"
            disabled={phase === "transcribing"}
            onClick={() => void start()}
          >
            {phase === "transcribing" ? <LoaderCircle size={14} aria-hidden="true" /> : <Mic size={14} aria-hidden="true" />}
            {phase === "transcribing" ? "正在转写…" : value.confirmedTranscript ? "重录一段" : "开始说"}
          </button>
        )}
        <small className="meta">单段最长 {recordingCapSeconds} 秒，到点自动转写；转写结果可以先改字再交。</small>
        {/**
         * 「开始说」被挡住时，紧挨着它给出路：这台设备还不能说话 →
         * 去装那个可选的模型。放在同一行而不是另起一块，是因为它替代的正是
         * 左边那颗按下去只会被挡住的按钮。
         */}
        {modelMissing ? (
          <button type="button" className="button run-voice-input__model" onClick={openVoiceModelSettings}>
            <Download size={14} aria-hidden="true" />去设置里下载识别模型
          </button>
        ) : null}
      </div>
      {blocked ? <p className="run-voice-input__block" role="alert">{reason}</p> : null}
      {note ? <p className="run-voice-input__note" role="status">{note}</p> : null}
      <label className="run-voice-input__transcript">
        <span className="sr-only">转写文本（可校对后再提交）</span>
        <textarea
          value={value.confirmedTranscript}
          disabled={phase !== "idle"}
          placeholder={phase === "transcribing" ? "正在把录音转成文字…" : "录一段说法，这里会出现转写结果；你可以直接改这里的文字。"}
          onChange={(event) => onChange({ ...value, confirmedTranscript: event.target.value, correctionMethod: "manual_text_edit" })}
        />
      </label>
    </div>
  );
}
