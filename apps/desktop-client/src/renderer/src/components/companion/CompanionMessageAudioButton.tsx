import { useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import {
  CompanionCachedAudioError, playCachedCompanionMessage, subscribeCompanionSpeech,
} from "../../app/companion-voice-playback";
import { useRoomStore } from "../../app/room-store";

export const COMPANION_AUDIO_CACHE_CHANGED = "astella:companion-audio-cache-changed";

/** 手记与伴星中心共用的原声入口。没有本机录音就不承诺回放。 */
export function CompanionMessageAudioButton({ runId }: { runId: string | null }) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [cached, setCached] = useState<{ runId: string; scope: number; ordinals: number[] } | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const playback = useRef<ReturnType<typeof playCachedCompanionMessage> | null>(null);
  const ordinals = cached && cached.runId === runId && cached.scope === scope ? cached.ordinals : null;

  useEffect(() => {
    let live = true, request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const list = window.astella?.companion?.voice?.cachedList;
      if (!runId || !list) return;
      const visit = ++request;
      try {
        const result = unwrapGatewayResult(await list({ meta: createRequestMeta(), request: { runIds: [runId] } }));
        if (!live || visit !== request) return;
        const item = result.items.find(item => item.runId === runId);
        setCached(item ? { ...item, scope } : null);
        if (!item) playback.current?.stop();
      } catch { if (live && visit === request) setCached(null); }
    };
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => void read(), 150); };
    setPhase("idle"); setFailure(null);
    void read();
    window.addEventListener(COMPANION_AUDIO_CACHE_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    const unsubscribe = subscribeCompanionSpeech(progress => {
      if (progress.planId !== playback.current?.planId) return;
      if (progress.phase === "speaking") setPhase("playing");
      else {
        playback.current = null;
        setPhase("idle");
        if (progress.phase === "failed") { setFailure(progress.failure ?? "本机音频暂时无法播放。"); refresh(); }
      }
    });
    return () => {
      live = false; clearTimeout(timer); unsubscribe();
      playback.current?.stop(); playback.current = null;
      window.removeEventListener(COMPANION_AUDIO_CACHE_CHANGED, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [runId, scope]);

  if (!ordinals) return failure ? <span className="companion-message-audio__error" role="status">{failure}</span> : null;
  const active = phase !== "idle";
  return <span className="companion-message-audio">
    <button type="button" className="companion-message-audio__button" aria-label={active ? "停止播放这条消息的音频" : "播放这条消息的音频"}
      aria-pressed={active} title="播放当时已缓存的声音；本机保留最近 100 条消息的音频" onClick={() => {
        if (playback.current) { playback.current.stop(); return; }
        setFailure(null);
        try {
          playback.current = playCachedCompanionMessage(runId!, ordinals);
          setPhase("loading");
        } catch (error) {
          setPhase("idle");
          setFailure(error instanceof CompanionCachedAudioError ? error.message : gatewayErrorMessage(error));
        }
      }}>
      {phase === "loading" ? <Loader2 size={13} className="companion-hud__spin" aria-hidden="true" />
        : active ? <Square size={12} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      <span>{active ? "停止" : "播放音频"}</span>
    </button>
    {failure ? <span className="companion-message-audio__error" role="status">{failure}</span> : null}
  </span>;
}
