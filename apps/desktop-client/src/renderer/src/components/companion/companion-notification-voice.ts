import type { CompanionNotificationAudio } from "./companion-notifications";
import { splitForSpeech } from "../../app/companion-speech-segments";

export type NotificationVoicePurpose = "notification" | "guidance" | "thought";

export interface NotificationVoiceHost {
  readonly available: () => boolean;
  readonly synthesize: (text: string, clip?: CompanionNotificationAudio, purpose?: NotificationVoicePurpose) => Promise<AudioBuffer>;
  readonly play: (buffer: AudioBuffer, allowed: () => boolean, offset?: number) => Promise<void>;
  readonly progress?: () => number | null;
  readonly stop: () => void;
}

export type NotificationVoicePhase = "preparing" | "speaking" | "paused" | "finished" | "silent" | "failed" | "consent_required";

const SYNTHESIS_DEADLINE_MS: Record<NotificationVoicePurpose, number> = {
  notification: 8_000,
  guidance: 20_000,
  thought: 20_000,
};
let host: NotificationVoiceHost | null = null;
let generation = 0;
let active: { id: string; purpose: NotificationVoicePurpose; phase: NotificationVoicePhase; report: (phase: NotificationVoicePhase) => void; paused: boolean; interrupted: boolean; offset: number; duration: number; wake: (() => void) | null } | null = null;
// 单段录音独占音频；实时会话只压住背景播报，回复仍能使用扬声器。
const microphones = new Map<symbol, "recording" | "conversation">();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const isCompanionMicrophoneActive = () => microphones.size > 0;
export const isCompanionReplyBlockedByMicrophone = () => [...microphones.values()].some(mode => mode === "recording");
export const isCompanionNotificationSpeechActive = () => active !== null;
export const isPausedCompanionGuidanceSpeech = () => active?.purpose === "guidance" && active.paused;
export const subscribeCompanionAudioPriority = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function setCompanionNotificationVoiceHost(next: NotificationVoiceHost | null): void {
  stopCompanionNotificationSpeech();
  host = next;
}

/** Only the notification's own playback can be stopped here; a reply never gets cut off. */
export function stopCompanionNotificationSpeech(id?: string): void {
  if (!active || id !== undefined && active.id !== id) return;
  const previous = active;
  generation++;
  active = null;
  if (previous.phase === "speaking") host?.stop();
  previous.wake?.();
  previous.report("silent");
  emit();
}

/** 暂停只释放当前音源，保留已经合成的音频与位置；恢复不重复请求或从头念。 */
export function pauseCompanionNotificationSpeech(id: string): void {
  if (!active || active.id !== id || active.paused) return;
  active.paused = true;
  active.interrupted = active.phase === "speaking";
  if (active.phase === "speaking") {
    const fraction = host?.progress?.();
    if (fraction != null) active.offset = Math.min(active.duration, Math.max(0, fraction * active.duration));
    host?.stop();
  }
  active.phase = "paused"; active.report("paused");
}
export function resumeCompanionNotificationSpeech(id: string): void {
  if (!active || active.id !== id || !active.paused) return;
  active.paused = false; active.phase = "preparing"; active.report("preparing"); active.wake?.();
}

export function holdCompanionMicrophone(mode: "recording" | "conversation" = "recording"): () => void {
  const token = Symbol("microphone");
  microphones.set(token, mode);
  stopCompanionNotificationSpeech();
  emit();
  return () => { if (microphones.delete(token)) emit(); };
}

/** No synthesis while occupied. Late bytes cannot reclaim the shared voice channel. */
export async function speakCompanionNotification(input: {
  readonly id: string;
  readonly text: string;
  readonly clip?: CompanionNotificationAudio;
  readonly purpose?: NotificationVoicePurpose;
  readonly allowed: () => boolean;
  readonly report: (phase: NotificationVoicePhase) => void;
}): Promise<void> {
  const currentHost = host;
  const allowed = () => host === currentHost && Boolean(currentHost?.available()) && !isCompanionMicrophoneActive() && input.allowed();
  if (!currentHost || !allowed()) { input.report("silent"); return; }
  stopCompanionNotificationSpeech();
  const operation = ++generation;
  const playback = { id: input.id, purpose: input.purpose ?? "notification", phase: "preparing" as NotificationVoicePhase, report: input.report, paused: false, interrupted: false, offset: 0, duration: 0, wake: null as (() => void) | null };
  active = playback;
  input.report("preparing");
  emit();
  // 一句念想是一段话，不是一段音频：按句切开逐段取，每段各自命中本机缓存、各自合成。
  // 于是 `COMPANION_VOICE_MAX_TEXT_LENGTH` 只管"一次请求回多少字节、该等多久"，
  // 不再冒充"能念多少字"。带固定提示音的通知仍然就是那一条预制音频。
  const lines = input.clip ? [input.text] : splitForSpeech(input.text).map(segment => segment.text);
  // 一次请求该等多久，只有一个源：背景提示 8 秒念不出来就该放弃；带路和念想是会反复
  // 听的固定句（而且念一次就留在本机），值得等到 20 秒。
  const synthesizeDeadlineMs = SYNTHESIS_DEADLINE_MS[input.purpose ?? "notification"];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const within = <T>(promise: Promise<T>, ms: number, reason: string): Promise<T> => new Promise<T>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(reason)), ms);
    promise.then((value) => { clearTimeout(deadline); resolve(value); },
      (error: unknown) => { clearTimeout(deadline); reject(error); });
  });
  try {
    for (const line of lines) {
      if (playback.paused) await new Promise<void>(resolve => { playback.wake = resolve; });
      playback.wake = null;
      if (operation !== generation) return;
      const buffer = await within(currentHost.synthesize(line, input.clip, input.purpose), synthesizeDeadlineMs, "notification audio deadline");
      if (operation !== generation) return;
      playback.offset = 0; playback.duration = buffer.duration;
      do {
        if (playback.paused) await new Promise<void>(resolve => { playback.wake = resolve; });
        playback.wake = null;
        if (operation !== generation) return;
        if (!allowed()) { stopCompanionNotificationSpeech(input.id); return; }
        playback.phase = "speaking"; playback.interrupted = false; input.report("speaking");
        const canPlay = () => operation === generation && !playback.paused && allowed();
        const playing = playback.offset > 0 ? currentHost.play(buffer, canPlay, playback.offset) : currentHost.play(buffer, canPlay);
        await within(playing, (buffer.duration - playback.offset) * 1_000 + 3_000, "notification playback deadline");
        if (operation !== generation) return;
      } while (playback.interrupted);
    }
    if (operation === generation) input.report("finished");
  } catch (error) {
    if (operation === generation) {
      if (active?.phase === "speaking") currentHost.stop();
      input.report(error && typeof error === "object" && "code" in error && error.code === "ai_consent_required" ? "consent_required" : "failed");
    }
  } finally {
    clearTimeout(deadline);
    if (operation === generation) { active = null; emit(); }
  }
}
