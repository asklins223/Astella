import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRoomStore } from "../../../app/room-store";
import type { GuideStepId } from "./guide-definitions";
import type { NotificationVoicePhase } from "../companion-notification-voice";

/** 静音时约一分钟。朗读仍在进行时保留本幕结尾，不截断旁白来赶进度。 */
export const GUIDE_FILM_SECONDS: Record<GuideStepId, number> = {
  voice: 0, room: 10, notes: 13, reading: 14, agent: 14, return: 9,
  space: 10, sources: 12, review: 12, settings: 10,
};
export function filmClockStep(elapsed: number, delta: number, duration: number, running: boolean, voice: NotificationVoicePhase) {
  const time = running ? Math.min(duration, elapsed + Math.max(0, Math.min(delta, .25))) : elapsed;
  return { time, done: time >= duration && voice !== "preparing" && voice !== "speaking" && voice !== "paused" };
}

export function useGuideFilm(step: GuideStepId, index: number, last: boolean, blocked: boolean, onNext: (direction: number) => void) {
  const visible = useRoomStore(state => state.windowState === "visible");
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState(false);
  const [replay, setReplay] = useState(0);
  const voice = useRef<NotificationVoicePhase>("silent");
  const clock = useRef({ time: 0, at: 0, advanced: false });
  const reportVoice = useCallback((phase: NotificationVoicePhase) => { voice.current = phase; }, []);
  useLayoutEffect(() => {
    clock.current = { time: 0, at: performance.now(), advanced: false };
    voice.current = "silent"; setElapsed(0); setFinished(false);
  }, [step, index, replay]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = clock.current, at = performance.now();
      const delta = (at - current.at) / 1000; current.at = at;
      if (current.advanced || !playing || !visible || blocked || document.hidden) return;
      const result = filmClockStep(current.time, delta, GUIDE_FILM_SECONDS[step], true, voice.current);
      current.time = result.time; setElapsed(result.time);
      if (!result.done) return;
      current.advanced = true;
      if (last) { setFinished(true); setPlaying(false); }
      else onNext(1);
    }, 50);
    return () => window.clearInterval(timer);
  }, [step, index, playing, last, replay, visible, blocked, onNext]);
  const restart = () => { setReplay(value => value + 1); setPlaying(true); };
  const toggle = () => { if (finished) restart(); else setPlaying(value => !value); };
  return { playing, visible, elapsed, finished, replay, reportVoice, restart, toggle, pause: () => setPlaying(false),
    phase: Math.min(2, Math.floor(elapsed / Math.max(1, GUIDE_FILM_SECONDS[step]) * 3)),
    progress: elapsed / Math.max(1, GUIDE_FILM_SECONDS[step]) };
}
