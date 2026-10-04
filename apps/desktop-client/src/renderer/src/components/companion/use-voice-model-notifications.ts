import { useEffect } from "react";
import { readVoiceAsrModel, type VoiceAsrModelSnapshotV1 } from "./voice-asr-model";
import { VOICE_MODEL_DOWNLOAD_STARTED, notifyVoiceModelDownloading, notifyVoiceModelSettled } from "./voice-model-notifications";

/** Lives beside the companion, so leaving Settings cannot lose the completion. */
export function useVoiceModelNotifications(): void {
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let timer = 0;
    let watching = false;
    const accept = (state: VoiceAsrModelSnapshotV1) => {
      if (state.status === "downloading") { watching = true; notifyVoiceModelDownloading(state); }
      else if (watching) {
        watching = false;
        notifyVoiceModelSettled(state);
      }
    };
    const poll = async (operation: number) => {
      try {
        const state = await readVoiceAsrModel();
        if (!alive || operation !== generation) return;
        accept(state);
      } catch {
        // A temporarily unreadable IPC state is not a failed download.
      }
      if (alive && watching && operation === generation) timer = window.setTimeout(() => void poll(operation), 900);
    };
    const started = (event: Event) => {
      const state = (event as CustomEvent<VoiceAsrModelSnapshotV1>).detail;
      if (!state) return;
      window.clearTimeout(timer);
      const operation = ++generation;
      watching = true;
      if (state.status === "downloading") notifyVoiceModelDownloading(state, true);
      accept(state);
      if (watching) timer = window.setTimeout(() => void poll(operation), 900);
    };
    window.addEventListener(VOICE_MODEL_DOWNLOAD_STARTED, started);
    // Recover an in-progress device download, but never greet an already installed model.
    void poll(generation);
    return () => { alive = false; generation++; window.clearTimeout(timer); window.removeEventListener(VOICE_MODEL_DOWNLOAD_STARTED, started); };
  }, []);
}
