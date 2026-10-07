import { useCallback, useEffect, useRef, useState } from "react";
import {
  gatewayErrorMessage,
} from "../../app/desktop-client";
import { CompanionVoiceRecorder } from "./voice-recorder";
import { guideVoiceModelDownload } from "./voice-model-notifications";
import { holdCompanionMicrophone } from "./companion-notification-voice";
import { isCompanionSpeechActive, stopCompanionSpeech, subscribeCompanionSpeechActivity } from "../../app/companion-voice-playback";
import { isAsrModelMissing, isLocalAsrReady, transcribeRecording } from "./local-speech-recognition";
import { CompanionVoiceSegmenter } from "./companion-voice-segmenter";
import {
  COMPANION_BARGE_IN_INITIAL_STATE,
  COMPANION_VAD_INITIAL_STATE,
  COMPANION_VAD_TUNING,
  companionBargeInStep,
  companionVadStep,
  type CompanionBargeInState,
  type CompanionVadState,
} from "./companion-voice-vad";

/**
 * 伴星语音**对话**输入（2026-10-07 从"按一句、认一句、点发送"改写成常驻会话）。
 *
 * 开一次麦克风就一直开着，说到短停顿就把那一段切出去识别、字幕往上长；说到长停顿
 * 就把这一轮拼起来**直接发给伴星**——没有中间那层"转成文字等你点发送"。
 *
 * 为什么切段而不是真流式：随包这份 sherpa 1.13.8 里 SenseVoice 只有离线配置
 * （`OfflineSenseVoiceModelConfig`，没有任何 `Online*` 的 SenseVoice 入口），
 * 逐字出字要换模型。本机实测 SenseVoice 的 RTF 约 0.17——一句 4 秒的话 735ms 解完，
 * 切段落在停顿的 450ms 上，所以字基本是"刚说完就长出来"，不用假装流式。
 *
 * 她在说话时你也能插话（barge-in）：麦克风不关，但**不攒音频**，电平连续越过
 * 一个明显更高的门槛才认定是真插话——回声消除压不干净她自己的声音，把那段残留
 * 当字识别出去，代价是她会自己打断自己。
 *
 * 模型是用户在设置里自己下的附加功能（见 `voice-asr-model.ts`）。没装时这里
 * **不猜、不重试**，直接告诉界面「去设置里下载」——那条路有可点的下一步，
 * 而一句「识别失败」没有。
 */

export type CompanionVoicePhase = "idle" | "starting" | "open" | "closing";

export interface CompanionVoiceCaption {
  /** 这一轮已经认出的字，按段追加。 */
  readonly text: string;
  /** 停顿已经够了，正在等最后一段解完——发出去之前的那一小会儿。 */
  readonly sending: boolean;
}

export interface CompanionVoiceInputOptions {
  readonly disabled?: boolean;
  /** 一轮说完：文本直接进对话，不再经过任何确认。 */
  readonly onTurn: (text: string) => void | Promise<void>;
  readonly onModelMissing?: () => void;
  /** 会话结束（用户退出、到上限、失败）。界面收起对应的气泡。 */
  readonly onSessionEnd?: () => void;
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
  /** 本机还没装识别模型（这一刻不可能有字幕）。 */
  readonly modelMissing: boolean;
  /** 此刻的字幕；会话没开或这一轮还没出字时为 null。 */
  readonly caption: CompanionVoiceCaption | null;
}

/** 会话里一口气说太久：先切一段出去解，别让一句话越攒越长。 */
const FORCE_CUT_MS = 20_000;
/** 一次对话会话的兜底上限；到点收尾并退出，而不是悄悄丢掉音频。 */
const SESSION_LIMIT_MS = 300_000;

/** 两段之间补标点，免得"今天学到这里"和"下一句"粘成一句。 */
function joinSegments(current: string, next: string): string {
  const text = next.trim();
  if (!text) return current;
  if (!current) return text;
  const endsClean = /[。！？!?.；;]$/.test(current);
  return endsClean ? `${current} ${text}` : `${current}。${text}`;
}

/**
 * 一次会话的全部可变状态，**装在同一个对象里**。
 *
 * 这件事必须是一个对象，而不是十几个 `useRef`：这套逻辑写的时候"结束一轮到底要
 * 重置哪几个"改过三遍，每遍都漏一两个——漏掉 `closing` 会让下一轮永远发不出去，
 * 漏掉 `ducked` 让她念完回复之后界面一片「在听」却一个字都收不进去。结束会话就是
 * 换一个干净对象，一件都不会漏；在途的回调手上握着**自己那一份**会话，比一下引用
 * 就知道自己过期了，不用再造一个计数器去猜"这是第几次操作"。
 */
interface VoiceSession {
  starting: boolean;
  recorder: CompanionVoiceRecorder | null;
  releaseMicrophone: (() => void) | null;
  segmenter: CompanionVoiceSegmenter;
  vad: CompanionVadState;
  barge: CompanionBargeInState;
  /** 她在说话：不攒音频、不切段、不收尾，只听有没有插话。 */
  ducked: boolean;
  /** 这一轮正在收尾发出去：期间不再开新段，等在途的识别解完。 */
  closing: boolean;
  text: string;
  /** 在途的识别有几段：收尾要看它，不能看字幕——字幕要等队列跑完才有字。 */
  inFlight: number;
  /** 识别按顺序排队：字幕要按说话的顺序长，并发解完谁先回来就贴谁会是乱的。 */
  queue: Promise<void>;
}

const newVoiceSession = (): VoiceSession => ({
  starting: false,
  recorder: null,
  releaseMicrophone: null,
  segmenter: new CompanionVoiceSegmenter(),
  vad: COMPANION_VAD_INITIAL_STATE,
  barge: COMPANION_BARGE_IN_INITIAL_STATE,
  ducked: false,
  closing: false,
  text: "",
  inFlight: 0,
  queue: Promise.resolve(),
});

export function useCompanionVoiceInput(options: CompanionVoiceInputOptions): CompanionVoiceInput {
  const [phase, setPhase] = useState<CompanionVoicePhase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [noteRevision, setNoteRevision] = useState(0);
  const [modelMissing, setModelMissing] = useState(false);
  const [caption, setCaption] = useState<CompanionVoiceCaption | null>(null);
  const [supported] = useState(() => CompanionVoiceRecorder.isSupported());
  const phaseRef = useRef<CompanionVoicePhase>("idle");
  phaseRef.current = phase;
  const sessionRef = useRef<VoiceSession>(newVoiceSession());
  const listenersRef = useRef(new Set<(level: number) => void>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

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

  const publishCaption = useCallback((session: VoiceSession) => {
    setCaption(session.text.length === 0 && !session.closing ? null : { text: session.text, sending: session.closing });
  }, []);

  /** 交还麦克风，并把会话换成一个干净的对象（相位归谁说由调用方定）。 */
  const releaseSession = useCallback(() => {
    const session = sessionRef.current;
    const recorder = session.recorder;
    session.recorder = null;
    session.releaseMicrophone?.();
    session.releaseMicrophone = null;
    sessionRef.current = newVoiceSession();
    emitLevel(0);
    if (recorder) void recorder.stop().catch(() => undefined);
  }, [emitLevel]);

  /**
   * 把一段音频排进**这一轮所属会话**的识别队列。
   *
   * 队列是一条 Promise 链而不是并发：引擎那边本来就是排队解（见主进程
   * `voice-asr-host.ts` 的 queue），这里排队只是让字幕的顺序有保证。
   */
  const enqueueDecode = useCallback((session: VoiceSession, samples: Float32Array) => {
    session.inFlight += 1;
    session.queue = session.queue
      .then(async () => {
        // 握着的会话已经不是当前那一份 = 这一句作废了，一个字都不许贴进屏幕。
        if (sessionRef.current !== session) return;
        try {
          const result = await transcribeRecording({ sampleRate: 16000, samples });
          if (sessionRef.current !== session) return;
          session.text = joinSegments(session.text, result.text);
          publishCaption(session);
        } catch (error) {
          if (sessionRef.current !== session) return;
          if (isAsrModelMissing(error)) {
            setModelMissing(true);
            showNote("这台设备还没有语音识别模型，先去设置里下载");
            optionsRef.current.onModelMissing?.();
            guideVoiceModelDownload();
            phaseRef.current = "idle";
            setPhase("idle");
            releaseSession();
            optionsRef.current.onSessionEnd?.();
            return;
          }
          showNote(`这一句没认出来：${gatewayErrorMessage(error)}`);
        }
      })
      .finally(() => { session.inFlight = Math.max(0, session.inFlight - 1); })
      .catch(() => undefined);
  }, [publishCaption, releaseSession, showNote]);

  /**
   * 长停顿：这一轮说完了。等在途的几段解完，把整轮文本交出去。
   *
   * `closing` 期间**不再开新段**，所以这里等的是"刚才那一批"，不会把用户接着说的
   * 下一句算进这一轮。窗口很短：切段落在停顿 450ms、收尾落在 850ms，而一段典型
   * 2~3 秒的话解完只要 350~550ms，收尾时最后一段多半已经解完了。
   */
  const finalizeTurn = useCallback((session: VoiceSession) => {
    if (session.closing) return;
    /**
     * 「这一轮说完了」要等的是在途的识别，不是此刻屏幕上的字。
     *
     * 切段之后到收尾这 400ms 里，静音帧都归了环形缓冲，`drain()` 是空的；而第一段
     * 还在队列里没回来，`session.text` 也还是空的。**空**不等于"没话"——照屏幕上有
     * 几个字来判，等于把正常说话的那一轮判成一次误触，用户说完什么也不会发出去。
     */
    if (!session.text.trim() && session.inFlight === 0) {
      session.vad = COMPANION_VAD_INITIAL_STATE;
      return;
    }
    session.closing = true;
    // 界面要分得开"在听"与"这一句正在收尾"：不写这一次 setPhase，`closing` 就只是
    // 类型上的一个词，气泡上那句「在想这一句…」永远显示不出来。
    phaseRef.current = "closing";
    setPhase("closing");
    publishCaption(session);
    void session.queue.then(async () => {
      if (sessionRef.current !== session) return;
      const text = session.text.trim();
      session.text = "";
      session.closing = false;
      setCaption(null);
      if (phaseRef.current === "closing") {
        // 会话还开着就回到"在听"；已经被退出的那一路由自己的收尾把相位归 idle。
        phaseRef.current = "open";
        setPhase("open");
      }
      if (text) await optionsRef.current.onTurn(text);
      // 轮与轮之间重新数：上一轮的累计人声、静音起点都不该影响这一轮的判定。
      session.vad = COMPANION_VAD_INITIAL_STATE;
    }).catch(() => undefined);
  }, [publishCaption]);

  const endSession = useCallback((ending: { readonly finalize: boolean; readonly note?: string }) => {
    const session = sessionRef.current;
    if (ending.note) showNote(ending.note);
    if (!ending.finalize) {
      phaseRef.current = "idle";
      setPhase("idle");
      releaseSession();
      optionsRef.current.onSessionEnd?.();
      return;
    }
    /**
     * 退出前把**还在缓冲里的那半句**也切出去识别。
     *
     * 不等停顿判定的话这一段就没了：到时长上限那一刻用户通常正在说话，而界面还写着
     * 「我在听」、麦克风其实早就还回去了——这是方案 35 E2 那一类错误，换成立即退出
     * 的会话模式一样会犯。
     */
    const tail = session.segmenter.drain();
    if (tail) enqueueDecode(session, tail);
    finalizeTurn(session);
    // 收尾的落点在 finalizeTurn 里（它先挂上队列），这里只负责把麦克风交还。
    void session.queue.then(() => {
      if (sessionRef.current !== session) return;
      phaseRef.current = "idle";
      setPhase("idle");
      releaseSession();
      optionsRef.current.onSessionEnd?.();
    }).catch(() => undefined);
  }, [enqueueDecode, finalizeTurn, releaseSession, showNote]);

  /** 每一拍电平：切段、收尾、插话，都在这一个入口里判。 */
  const handleLevel = useCallback((level: number) => {
    emitLevel(level);
    const session = sessionRef.current;
    const at = Date.now();
    if (session.closing) return;

    if (session.ducked) {
      const step = companionBargeInStep(session.barge, { level, at });
      session.barge = step.state;
      if (!step.triggered) return;
      // 真的有人插话了：她闭嘴，环形缓冲里垫着的这 250ms 就是插话的开头。
      stopCompanionSpeech();
      session.ducked = false;
      session.barge = COMPANION_BARGE_IN_INITIAL_STATE;
      session.vad = COMPANION_VAD_INITIAL_STATE;
      session.segmenter.openSegment();
      return;
    }

    const step = companionVadStep(session.vad, { level, at });
    session.vad = step.state;
    const segmenter = session.segmenter;
    if (!segmenter.isOpen && level >= COMPANION_VAD_TUNING.threshold) segmenter.openSegment();
    if (step.verdict === "cut" || step.verdict === "end") {
      const segment = segmenter.drain();
      if (segment) enqueueDecode(session, segment);
      // 短停顿切一段出去识别；长停顿把整轮收尾发出去。
      if (step.verdict === "end") finalizeTurn(session);
      return;
    }
    // 一口气说了很久：先把已有的一段解出去，轮次照旧等停顿来判。
    if (segmenter.isOpen && segmenter.pendingDurationMs >= FORCE_CUT_MS) {
      const segment = segmenter.drain();
      if (segment) enqueueDecode(session, segment);
      segmenter.openSegment();
    }
  }, [emitLevel, enqueueDecode, finalizeTurn]);

  const begin = useCallback(async () => {
    if (phaseRef.current !== "idle" || sessionRef.current.starting || optionsRef.current.disabled) return;
    if (!CompanionVoiceRecorder.isSupported()) {
      showNote("当前设备没有可用的麦克风");
      return;
    }
    const session = newVoiceSession();
    sessionRef.current = session;
    // 「正在起录」这道闸先落下：下面第一件事就是一次 await，不先占住的话，
    // 连点两下「开始对话」会开两个麦克风。
    session.starting = true;
    phaseRef.current = "starting";
    setPhase("starting");
    setNote(null);
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
      if (sessionRef.current !== session) return;
      modelChecked = true;
      if (!ready) {
        setModelMissing(true);
        showNote("这台设备还没有语音识别模型，先去设置里下载");
        optionsRef.current.onModelMissing?.();
        guideVoiceModelDownload();
        phaseRef.current = "idle";
        setPhase("idle");
        return;
      }
      setModelMissing(false);
      // 开口之前先让她安静：说话期间由插话判定接管，不再需要这里停第二次。
      stopCompanionSpeech();
      session.ducked = isCompanionSpeechActive();
      session.releaseMicrophone = holdCompanionMicrophone();
      const recorder = new CompanionVoiceRecorder({
        maxDurationMs: SESSION_LIMIT_MS,
        onFrame: (chunk, inputSampleRate) => {
          // 插话判定之前也要攒着（环形只留最近 250ms），但**她说话时不进段**。
          if (!session.ducked) session.segmenter.push(chunk, inputSampleRate);
        },
        onLevel: handleLevel,
        // 会话到上限：把已经说出的这一轮发出去再退，而不是把麦克风悄悄关掉。
        onLimit: () => { endSession({ finalize: true, note: "说了一会儿了，先把这段发给伴星" }); },
      });
      session.recorder = recorder;
      await recorder.start();
      // 起录期间被取消（用户点了另一处或组件卸载）：把麦克风还回去。
      if (sessionRef.current !== session || session.recorder !== recorder) {
        void recorder.stop().catch(() => undefined);
        return;
      }
      phaseRef.current = "open";
      setPhase("open");
      setNote(null);
    } catch {
      if (sessionRef.current !== session) return;
      session.recorder = null;
      session.releaseMicrophone?.();
      session.releaseMicrophone = null;
      phaseRef.current = "idle";
      setPhase("idle");
      showNote(modelChecked ? "麦克风不可用或未授权" : "暂时读不到本机语音状态，请稍后再试");
    } finally {
      if (sessionRef.current === session) {
        session.starting = false;
        if (phaseRef.current === "starting") {
          phaseRef.current = "idle";
          setPhase("idle");
        }
      }
    }
  }, [endSession, handleLevel, showNote]);

  /**
   * 她开口→麦克风让路；她说完→**把麦克风收回来**。
   *
   * 后半句不是顺手写的：只处理"开始说"的话，一次正常的回复念完，会话就永远处于
   * ducked——此后用户除非喊到插话那么响，否则一个字都攒不进去，界面还是一片
   * 「在听」。让路是有起止的，回来这件事必须显式发生；两个方向都要重数一遍，
   * 因为让路期间攒下的那点回声残留不该变成下一句的开头。
   */
  useEffect(() => subscribeCompanionSpeechActivity(() => {
    if (phaseRef.current !== "open" && phaseRef.current !== "closing") return;
    const session = sessionRef.current;
    const speaking = isCompanionSpeechActive();
    if (speaking === session.ducked) return;
    session.ducked = speaking;
    session.segmenter.reset();
    session.vad = COMPANION_VAD_INITIAL_STATE;
    session.barge = COMPANION_BARGE_IN_INITIAL_STATE;
  }), []);

  const cancel = useCallback(() => {
    releaseSession();
    phaseRef.current = "idle";
    setPhase("idle");
    setCaption(null);
  }, [releaseSession]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "open" || phaseRef.current === "closing") {
      // 退出对话：说出口的那一句仍然算数，先把这一轮发出去再收麦克风。
      endSession({ finalize: true });
    } else if (phaseRef.current === "idle") void begin();
  }, [begin, endSession]);

  useEffect(() => () => {
    const session = sessionRef.current;
    const recorder = session.recorder;
    session.recorder = null;
    session.releaseMicrophone?.();
    session.releaseMicrophone = null;
    if (recorder) void recorder.stop().catch(() => undefined);
  }, []);

  return {
    phase, note, noteRevision, supported, toggle, cancel,
    dismissNote: () => setNote(null),
    subscribeLevel, modelMissing, caption,
  };
}
