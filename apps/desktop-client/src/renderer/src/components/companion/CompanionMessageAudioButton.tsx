import { useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import {
  CompanionCachedAudioError, beginCompanionSpeechLine, playCachedCompanionMessage, subscribeCompanionSpeech,
  type CompanionServerVoiceSegment,
} from "../../app/companion-voice-playback";
import { useRoomStore } from "../../app/room-store";

export const COMPANION_AUDIO_CACHE_CHANGED = "astella:companion-audio-cache-changed";

/** 手记与伴星中心共用的原声入口。本机没留下录音时可以按服务端留档补听。 */
export function CompanionMessageAudioButton({ runId, conversationId = null, exchange = false }:
  { runId: string | null; conversationId?: string | null; exchange?: boolean }) {
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

  /**
   * 本机没留下录音时的补听（2026-10-16）。
   *
   * 原来这里直接 `return null`：一次错过（气泡不在场、App 没开）就等于这一句永久静音，
   * 连手动补听的入口都没有。现在按 **服务端留档** 把这一轮的段取回来重新合成——
   * 段身份仍以服务端为准，客户端不自己重新切段；事件过了 TTL 就如实说没有留档。
   */
  const redrive = async () => {
    const list = window.astella?.companion?.chat?.listRunVoiceSegments;
    if (!runId || !conversationId || !list) { setFailure("这段暂时取不回来。"); return; }
    setPhase("loading"); setFailure(null);
    try {
      const result = unwrapGatewayResult(await list({
        meta: createRequestMeta(),
        request: { version: 1, conversationId, runId },
      }));
      if (result.items.length === 0) { setPhase("idle"); setFailure("这段没有留下语音记录。"); return; }
      const session = beginCompanionSpeechLine({ strictSegments: true });
      for (const item of result.items) {
        session.feedSegment({
          ref: { version: 2, conversationId, runId, generation: result.generation,
            ordinal: item.ordinal, segmentId: item.segmentId },
          displayText: item.displayText, displayStart: item.displayStart, displayEnd: item.displayEnd,
          cue: item.cue as CompanionServerVoiceSegment["cue"],
        });
      }
      session.finish();
      playback.current = { planId: session.planId, stop: () => session.stop() };
      setPhase("playing");
    } catch (error) {
      setPhase("idle");
      setFailure(gatewayErrorMessage(error));
    }
  };

  if (!ordinals) {
    // 同一个 run 只在一个地方露这一条（父组件按 ownsRunAudio 已经筛过），
    // 所以它的密度与有缓存时的那个按钮一致，不是每条消息都挂一个。
    return <>
      <button type="button" className="text-action" onClick={() => {
        if (playback.current) { playback.current.stop(); playback.current = null; setPhase("idle"); return; }
        void redrive();
      }}>
        {phase === "loading" ? <Loader2 size={13} className="companion-hud__spin" aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
        <span>{phase === "playing" ? "停止" : "补听这段"}</span>
      </button>
      {failure ? <span className="companion-message-audio__error" role="status">{failure}</span> : null}
    </>;
  }
  const active = phase !== "idle";
  return <span className="companion-message-audio">
    <button type="button" className="companion-message-audio__button" aria-label={active ? exchange ? "停止播放这段交流的音频" : "停止播放这条消息的音频" : exchange ? "播放这段交流的音频" : "播放这条消息的音频"}
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
