import type { CompanionNotificationAudio } from "./companion-notifications";

export interface NotificationVoiceHost {
  readonly available: () => boolean;
  readonly synthesize: (text: string, clip?: CompanionNotificationAudio, purpose?: "notification" | "guidance") => Promise<AudioBuffer>;
  readonly play: (buffer: AudioBuffer, allowed: () => boolean) => Promise<void>;
  readonly stop: () => void;
}

export type NotificationVoicePhase = "preparing" | "speaking" | "finished" | "silent" | "failed" | "consent_required";
let host: NotificationVoiceHost | null = null;
let generation = 0;
let active: { id: string; phase: NotificationVoicePhase; report: (phase: NotificationVoicePhase) => void } | null = null;
const microphones = new Set<symbol>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const isCompanionMicrophoneActive = () => microphones.size > 0;
export const isCompanionNotificationSpeechActive = () => active !== null;
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
  previous.report("silent");
  emit();
}

export function holdCompanionMicrophone(): () => void {
  const token = Symbol("microphone");
  microphones.add(token);
  stopCompanionNotificationSpeech();
  emit();
  return () => { if (microphones.delete(token)) emit(); };
}

/** No synthesis while occupied. Late bytes cannot reclaim the shared voice channel. */
export async function speakCompanionNotification(input: {
  readonly id: string;
  readonly text: string;
  readonly clip?: CompanionNotificationAudio;
  readonly purpose?: "notification" | "guidance";
  readonly allowed: () => boolean;
  readonly report: (phase: NotificationVoicePhase) => void;
}): Promise<void> {
  const currentHost = host;
  const allowed = () => host === currentHost && Boolean(currentHost?.available()) && !isCompanionMicrophoneActive() && input.allowed();
  if (!currentHost || !allowed()) { input.report("silent"); return; }
  stopCompanionNotificationSpeech();
  const operation = ++generation;
  active = { id: input.id, phase: "preparing", report: input.report };
  input.report("preparing");
  emit();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const buffer = await Promise.race([
      currentHost.synthesize(input.text, input.clip, input.purpose),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("notification audio deadline")), input.purpose === "guidance" ? 20_000 : 8_000); }),
    ]);
    clearTimeout(deadline);
    if (operation !== generation) return;
    if (!allowed()) { stopCompanionNotificationSpeech(input.id); return; }
    active = { id: input.id, phase: "speaking", report: input.report };
    input.report("speaking");
    // A bounded wait also releases the channel if an audio device stops producing onended.
    await Promise.race([
      currentHost.play(buffer, () => operation === generation && allowed()),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("notification playback deadline")), buffer.duration * 1_000 + 3_000); }),
    ]);
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
