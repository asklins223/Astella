import { useEffect, useState } from "react";
import { subscribeCompanionSpeech } from "../../app/companion-voice-playback";
import type { Live2DEmotionEvent } from "./live2d-emotion";

/** A queued segment does not own the face until its real audio starts. */
export function useCompanionSpeechExpression(scopeRevision: number, paused: boolean): Live2DEmotionEvent | null {
  const [expression, setExpression] = useState<{ scope: number; event: Live2DEmotionEvent } | null>(null);
  useEffect(() => {
    setExpression(null);
    if (paused) return;
    let planId: string | null = null;
    let segmentIndex = -1;
    return subscribeCompanionSpeech(progress => {
      if (progress.phase === "speaking") {
        if (!progress.cue || (planId === progress.planId && segmentIndex === progress.segmentIndex)) return;
        planId = progress.planId;
        segmentIndex = progress.segmentIndex;
        setExpression({ scope: scopeRevision, event: { emotion: progress.cue.emotion,
          intensity: progress.cue.intensity, at: performance.now() } });
      } else if (progress.planId === planId) {
        planId = null;
        segmentIndex = -1;
        setExpression(null);
      }
    });
  }, [scopeRevision, paused]);
  return !paused && expression?.scope === scopeRevision ? expression.event : null;
}
