import { useCallback, useEffect, useRef, useState } from "react";
import { gatewayErrorMessage } from "../../app/desktop-client";
import { isCompanionSpeechActive, stopCompanionSpeech, subscribeCompanionSpeech, subscribeCompanionSpeechActivity } from "../../app/companion-voice-playback";
import { CompanionVoiceRecorder } from "./voice-recorder";
import { guideVoiceModelDownload } from "./voice-model-notifications";
import { holdCompanionMicrophone } from "./companion-notification-voice";
import { isAsrModelMissing, isLocalAsrReady, transcribeRecording } from "./local-speech-recognition";
import { CompanionVoiceSegmenter } from "./companion-voice-segmenter";
import { COMPANION_VAD_INITIAL_STATE, COMPANION_VAD_TUNING, companionVadStep, type CompanionVadState } from "./companion-voice-vad";

export type CompanionVoicePhase = "idle" | "starting" | "open" | "closing" | "paused";
export type CompanionVoiceActivity = "idle" | "starting" | "listening" | "capturing" | "transcribing" | "waiting" | "speaking" | "paused";
export interface CompanionVoiceCaption { readonly text: string; readonly sending: boolean }
export interface CompanionVoiceInputOptions {
  readonly disabled?: boolean;
  readonly replyPending?: boolean;
  readonly onTurn: (text: string) => void | boolean | Promise<void | boolean>;
  readonly onInterrupt?: () => void;
  readonly onModelMissing?: () => void;
  readonly onSessionEnd?: () => void;
}
export interface CompanionVoiceInput {
  readonly phase: CompanionVoicePhase;
  readonly activity: CompanionVoiceActivity;
  readonly note: string | null;
  readonly noteRevision: number;
  readonly supported: boolean;
  readonly toggle: () => void;
  readonly cancel: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly interrupt: () => void;
  readonly sendNow: () => void;
  readonly dismissNote: () => void;
  readonly subscribeLevel: (listener: (level: number) => void) => () => void;
  readonly modelMissing: boolean;
  readonly caption: CompanionVoiceCaption | null;
  readonly lastTurn: string | null;
}

const FORCE_CUT_MS = 20_000;
// 播放结束后丢弃声卡/房间里的尾声，不把它当作下一轮。
const ECHO_TAIL_MS = 300;
function joinSegments(current: string, next: string): string {
  const text = next.trim();
  return !text ? current : !current ? text : /[。！？!?.；;]$/.test(current) ? `${current} ${text}` : `${current}。${text}`;
}
interface VoiceSession {
  recorder: CompanionVoiceRecorder | null;
  releaseMicrophone: (() => void) | null;
  segmenter: CompanionVoiceSegmenter;
  vad: CompanionVadState;
  closing: boolean;
  waiting: boolean;
  ignoreReply: boolean;
  speechActive: boolean;
  speechPlaying: boolean;
  guardUntil: number;
  text: string;
  decodeFailed: boolean;
  inFlight: number;
  turn: number;
  queue: Promise<void>;
}
const newVoiceSession = (): VoiceSession => ({
  recorder: null, releaseMicrophone: null, segmenter: new CompanionVoiceSegmenter(), vad: COMPANION_VAD_INITIAL_STATE,
  closing: false, waiting: false, ignoreReply: false, speechActive: false, speechPlaying: false, guardUntil: 0,
  text: "", decodeFailed: false, inFlight: 0, turn: 0, queue: Promise.resolve(),
});

/** 本机分段识别 → 自动送出 → 回复/播放 → 恢复收音。音量不能证明是人声，插话用明确操作。 */
export function useCompanionVoiceInput(options: CompanionVoiceInputOptions): CompanionVoiceInput {
  const [phase, setPhase] = useState<CompanionVoicePhase>("idle");
  const [activity, setActivity] = useState<CompanionVoiceActivity>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [noteRevision, setNoteRevision] = useState(0);
  const [modelMissing, setModelMissing] = useState(false);
  const [caption, setCaption] = useState<CompanionVoiceCaption | null>(null);
  const [lastTurn, setLastTurn] = useState<string | null>(null);
  const [supported] = useState(() => CompanionVoiceRecorder.isSupported());
  const phaseRef = useRef<CompanionVoicePhase>("idle");
  const sessionRef = useRef(newVoiceSession());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const listeners = useRef(new Set<(level: number) => void>());
  const setSessionPhase = useCallback((next: CompanionVoicePhase) => { phaseRef.current = next; setPhase(next); }, []);
  const emitLevel = useCallback((level: number) => { for (const listener of listeners.current) listener(level); }, []);
  const showNote = useCallback((text: string) => { setNote(text); setNoteRevision(value => value + 1); }, []);
  const refreshActivity = useCallback(() => {
    const session = sessionRef.current;
    const currentPhase = phaseRef.current;
    if (currentPhase === "idle" || currentPhase === "starting" || currentPhase === "paused") { setActivity(currentPhase); return; }
    setActivity(session.closing ? "transcribing" : session.speechPlaying ? "speaking"
      : session.waiting || session.speechActive || optionsRef.current.replyPending && !session.ignoreReply ? "waiting"
      : session.segmenter.isOpen || session.text || session.inFlight > 0 ? "capturing" : "listening");
  }, []);
  const publishCaption = useCallback((session: VoiceSession) => {
    setCaption(!session.text && !session.closing ? null : { text: session.text, sending: session.closing });
    refreshActivity();
  }, [refreshActivity]);
  const releaseSession = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = newVoiceSession(); // 先让所有迟到的帧、识别、发送回执失效。
    session.releaseMicrophone?.();
    if (session.recorder) void session.recorder.stop().catch(() => undefined);
    emitLevel(0);
  }, [emitLevel]);
  const cancel = useCallback(() => {
    releaseSession();
    setSessionPhase("idle"); setActivity("idle"); setCaption(null);
    optionsRef.current.onSessionEnd?.();
  }, [releaseSession, setSessionPhase]);

  const enqueueDecode = useCallback((session: VoiceSession, samples: Float32Array) => {
    const turn = session.turn;
    session.inFlight++;
    session.queue = session.queue.then(async () => {
      if (sessionRef.current !== session || session.turn !== turn) return;
      try {
        const result = await transcribeRecording({ sampleRate: 16000, samples });
        if (sessionRef.current !== session || session.turn !== turn) return;
        session.text = joinSegments(session.text, result.text);
        publishCaption(session);
      } catch (error) {
        if (sessionRef.current !== session || session.turn !== turn) return;
        session.decodeFailed = true;
        if (isAsrModelMissing(error)) {
          setModelMissing(true); showNote("这台设备还没有语音识别模型，先去设置里下载");
          optionsRef.current.onModelMissing?.(); guideVoiceModelDownload(); cancel();
        } else showNote(`这一句没听完整，请再说一次：${gatewayErrorMessage(error)}`);
      }
    }).finally(() => {
      if (session.turn === turn) session.inFlight = Math.max(0, session.inFlight - 1);
    }).catch(() => undefined);
  }, [cancel, publishCaption, showNote]);

  const finalizeTurn = useCallback((session: VoiceSession, explicit = false) => {
    if (session.closing || sessionRef.current !== session) return;
    const tail = session.segmenter.drain();
    if (tail && (explicit || session.vad.turnSpeechMs >= COMPANION_VAD_TUNING.minSpeechMs)) enqueueDecode(session, tail);
    if (!session.text && session.inFlight === 0) { session.segmenter.reset(); session.vad = COMPANION_VAD_INITIAL_STATE; refreshActivity(); return; }
    session.closing = true;
    setSessionPhase("closing"); publishCaption(session);
    const turn = session.turn;
    void session.queue.then(async () => {
      if (sessionRef.current !== session || session.turn !== turn) return;
      const text = session.text.trim();
      const failed = session.decodeFailed;
      session.text = ""; session.closing = false; session.decodeFailed = false;
      session.segmenter.reset(); session.vad = COMPANION_VAD_INITIAL_STATE;
      setCaption(null); setSessionPhase("open");
      if (!text || failed) {
        if (!failed) showNote("这一句没有听清，请再说一次");
        refreshActivity(); return;
      }
      // 先关收音闸，再交给真实发送 Promise。旧轮的迟到回执不能修改新轮。
      session.waiting = true; session.ignoreReply = false; setLastTurn(text); setNote(null); refreshActivity();
      try {
        const sent = await optionsRef.current.onTurn(text);
        if (sessionRef.current === session && session.turn === turn && sent === false) showNote("这一句没送出，可以重说；文字仍留在这里。");
      } catch (error) {
        if (sessionRef.current === session && session.turn === turn) showNote(`这一句没送出：${gatewayErrorMessage(error)}`);
      } finally {
        if (sessionRef.current === session && session.turn === turn) { session.waiting = false; refreshActivity(); }
      }
    }).catch(() => undefined);
  }, [enqueueDecode, publishCaption, refreshActivity, setSessionPhase, showNote]);

  const captureBlocked = (session: VoiceSession) => session.closing || session.waiting || session.speechActive
    || Boolean(optionsRef.current.replyPending && !session.ignoreReply) || Date.now() < session.guardUntil;

  const begin = useCallback(async (resuming = false) => {
    if (phaseRef.current !== "idle" && phaseRef.current !== "paused" || optionsRef.current.disabled) return;
    if (!CompanionVoiceRecorder.isSupported()) { showNote("当前设备没有可用的麦克风"); return; }
    const session = newVoiceSession(); sessionRef.current = session;
    setSessionPhase("starting"); setActivity("starting"); setNote(null); setCaption(null);
    if (!resuming) setLastTurn(null);
    let modelChecked = false;
    try {
      const ready = await isLocalAsrReady();
      if (sessionRef.current !== session) return;
      modelChecked = true;
      if (!ready) {
        setModelMissing(true); showNote("这台设备还没有语音识别模型，先去设置里下载");
        optionsRef.current.onModelMissing?.(); guideVoiceModelDownload(); cancel(); return;
      }
      setModelMissing(false);
      session.speechActive = isCompanionSpeechActive();
      session.releaseMicrophone = holdCompanionMicrophone("conversation");
      const recorder = new CompanionVoiceRecorder({
        maxDurationMs: Number.POSITIVE_INFINITY,
        onFrame: (chunk, rate) => {
          if (sessionRef.current === session && phaseRef.current === "open" && !captureBlocked(session)) session.segmenter.push(chunk, rate);
        },
        onLevel: level => {
          if (sessionRef.current !== session || phaseRef.current !== "open") return;
          if (captureBlocked(session)) { emitLevel(0); return; }
          emitLevel(level);
          const step = companionVadStep(session.vad, { level, at: Date.now() }); session.vad = step.state;
          if (!session.segmenter.isOpen && level >= COMPANION_VAD_TUNING.threshold) session.segmenter.openSegment();
          if (step.verdict === "end") finalizeTurn(session);
          else if (step.verdict === "cut" || session.segmenter.isOpen && session.segmenter.pendingDurationMs >= FORCE_CUT_MS) {
            const segment = session.segmenter.drain(); if (segment) enqueueDecode(session, segment);
          }
          // 很短的杂响也要清空，不让未武装的段积累整场静音。
          if (session.vad.lastVoiceAt !== null && session.vad.turnSpeechMs < COMPANION_VAD_TUNING.minSpeechMs
            && Date.now() - session.vad.lastVoiceAt >= COMPANION_VAD_TUNING.turnEndSilenceMs) {
            session.segmenter.reset(); session.vad = COMPANION_VAD_INITIAL_STATE;
          }
          refreshActivity();
        },
        onLimit: () => {
          if (sessionRef.current !== session) return;
          showNote("本次语音对话已结束，可以重新开始"); cancel();
        },
        onError: () => {
          if (sessionRef.current !== session) return;
          showNote("麦克风连接已断开，接好后可以重新开始"); cancel();
        },
      });
      session.recorder = recorder;
      await recorder.start();
      if (sessionRef.current !== session) { void recorder.stop().catch(() => undefined); return; }
      session.speechActive = isCompanionSpeechActive();
      setSessionPhase("open"); refreshActivity();
    } catch (error) {
      if (sessionRef.current !== session) return;
      releaseSession(); setSessionPhase("idle"); setActivity("idle");
      showNote(!modelChecked ? "暂时读不到本机语音状态，请稍后再试"
        : error instanceof DOMException && error.name === "NotAllowedError" ? "麦克风未获授权，请在系统设置的隐私与安全性中允许拾星笔记使用麦克风" : "麦克风暂时打不开，接好设备后请重试");
    }
  }, [cancel, emitLevel, enqueueDecode, finalizeTurn, refreshActivity, releaseSession, setSessionPhase, showNote]);

  useEffect(() => {
    const sync = () => {
      const session = sessionRef.current;
      if (phaseRef.current !== "open" && phaseRef.current !== "closing") return;
      const active = isCompanionSpeechActive();
      if (session.speechActive !== active) {
        session.speechActive = active; session.speechPlaying = false;
        session.segmenter.reset(); session.vad = COMPANION_VAD_INITIAL_STATE;
        if (!active) session.guardUntil = Date.now() + ECHO_TAIL_MS;
        emitLevel(0);
      }
      refreshActivity();
    };
    const releaseActivity = subscribeCompanionSpeechActivity(sync);
    const releaseProgress = subscribeCompanionSpeech(progress => {
      const session = sessionRef.current;
      if (phaseRef.current !== "open" && phaseRef.current !== "closing") return;
      session.speechPlaying = progress.phase === "speaking";
      refreshActivity();
    });
    return () => { releaseActivity(); releaseProgress(); };
  }, [emitLevel, refreshActivity]);
  useEffect(() => {
    if (!options.replyPending) sessionRef.current.ignoreReply = false;
    refreshActivity();
  }, [options.replyPending, refreshActivity]);
  const pause = useCallback(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "paused") return;
    releaseSession(); setSessionPhase("paused"); setActivity("paused"); setCaption(null);
  }, [releaseSession, setSessionPhase]);
  const interrupt = useCallback(() => {
    if (phaseRef.current !== "open") return;
    const session = sessionRef.current;
    session.turn++; session.waiting = false; session.ignoreReply = true;
    stopCompanionSpeech(); optionsRef.current.onInterrupt?.();
    session.speechActive = false; session.speechPlaying = false;
    session.segmenter.reset(); session.vad = COMPANION_VAD_INITIAL_STATE;
    session.guardUntil = Date.now() + ECHO_TAIL_MS;
    setCaption(null); setNote(null); refreshActivity();
  }, [refreshActivity]);
  const sendNow = useCallback(() => {
    const session = sessionRef.current;
    if (phaseRef.current === "open" && !captureBlocked(session)) finalizeTurn(session, true);
  }, [finalizeTurn]);
  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") void begin(); else cancel();
  }, [begin, cancel]);
  useEffect(() => { if (options.disabled && phaseRef.current !== "idle") cancel(); }, [options.disabled, cancel]);
  useEffect(() => {
    const hidden = () => { if (document.hidden && phaseRef.current !== "idle") pause(); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [pause]);
  useEffect(() => () => releaseSession(), [releaseSession]);
  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    listeners.current.add(listener); return () => { listeners.current.delete(listener); };
  }, []);
  return { phase, activity, note, noteRevision, supported, toggle, cancel, pause, resume: () => { void begin(true); }, interrupt, sendNow,
    dismissNote: () => setNote(null), subscribeLevel, modelMissing, caption, lastTurn };
}
