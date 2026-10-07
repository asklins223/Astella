import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Cloud, CornerDownRight, Loader2, Volume2, VolumeX } from "lucide-react";
import type { CompanionChatListThoughtsResultV1, CompanionThoughtV1 } from "@astella/shared/companion-chat-desktop-contracts";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { messageDayLabel, messageTime } from "./CompanionChatRecord";
import { renderCompanionMarkdown } from "./companion-markdown";
import { speakCompanionNotification, stopCompanionNotificationSpeech, type NotificationVoicePhase } from "./companion-notification-voice";

/**
 * 念想页里「她说过的那一句」的朗读状态。
 *
 * `silent` 是声道 herself 让给了更要紧的东西（正在念的回复、你正按着的录音），
 * 或者是总静音——这条必须说出来：点了没动静，用户收到的就是"她根本不会念"。
 */
type ThoughtSpeech = { readonly id: string; readonly phase: NotificationVoicePhase };

const SPEAK_LABEL: Record<NotificationVoicePhase, string> = {
  preparing: "正在准备朗读…",
  speaking: "正在念，点这里停",
  paused: "朗读已暂停",
  finished: "念出来",
  silent: "暂未播放，稍后再试",
  failed: "这次没念成，点这里再试",
  consent_required: "朗读需要先确认 AI 使用同意",
};

export function CompanionThoughtJournal({ companionName, onBringToChat, onReady }: {
  companionName: string;
  onBringToChat: (text: string, date: string) => void;
  onReady?: () => void;
}) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [result, setResult] = useState<{ scope: number; page: CompanionChatListThoughtsResultV1 } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ scope: number; message: string } | null>(null);
  const requestRef = useRef(0);
  const restoredScope = useRef<number | null>(null);
  const read = useCallback(async (before?: string) => {
    const request = ++requestRef.current;
    setLoading(true); setError(null);
    const current = () => request === requestRef.current && scope === useRoomStore.getState().workspaceScopeRevision;
    try {
      const epoch = await requireWorkspaceEpoch();
      if (!current()) return;
      const page = unwrapGatewayResult(await window.astella.companion.chat.listThoughts({
        meta: createRequestMeta(epoch), request: { version: 1, limit: 30, ...(before ? { before } : {}) },
      }));
      if (!current()) return;
      setResult(previous => {
        const existing = before && previous?.scope === scope ? previous.page.items : [];
        const ids = new Set(existing.map(item => item.id));
        return { scope, page: { ...page, items: [...existing, ...page.items.filter(item => !ids.has(item.id))] } };
      });
    } catch (failure) {
      if (current()) setError({ scope, message: gatewayErrorMessage(failure) });
    } finally {
      if (current()) setLoading(false);
    }
  }, [scope]);
  useEffect(() => {
    void read();
    return () => { requestRef.current += 1; };
  }, [read]);
  const page = result?.scope === scope ? result.page : null;
  const failure = error?.scope === scope ? error.message : null;
  const [speech, setSpeech] = useState<ThoughtSpeech | null>(null);
  const speechIdRef = useRef<string | null>(null);
  // 换空间或离开这一页，她不该继续念上一空间的念想。按 id 撤自己这一条：
  // 通知中心那时可能正在念它自己的消息，整条声道不该被这里掐掉。
  useEffect(() => () => {
    const id = speechIdRef.current;
    if (id) { speechIdRef.current = null; stopCompanionNotificationSpeech(id); }
    setSpeech(null);
  }, [scope]);
  const speakThought = (item: CompanionThoughtV1) => {
    const speechId = `thought:${scope}:${item.id}`;
    if (speechIdRef.current === speechId) {
      speechIdRef.current = null;
      setSpeech(null);
      stopCompanionNotificationSpeech(speechId);
      return;
    }
    speechIdRef.current = speechId;
    setSpeech({ id: speechId, phase: "preparing" });
    void speakCompanionNotification({
      id: speechId,
      text: item.text,
      purpose: "thought",
      allowed: () => speechIdRef.current === speechId && scope === useRoomStore.getState().workspaceScopeRevision,
      report: (phase) => {
        if (speechIdRef.current !== speechId) return;
        // 念完就退回原样；停在这里的状态都是要让人看见的（没念成、要先同意、声道被占）。
        if (phase === "finished") { speechIdRef.current = null; setSpeech(null); return; }
        if (phase === "failed" || phase === "consent_required" || phase === "silent") speechIdRef.current = null;
        setSpeech({ id: speechId, phase });
      },
    });
  };
  useLayoutEffect(() => {
    if (page && restoredScope.current !== scope) { restoredScope.current = scope; onReady?.(); }
  }, [page, scope, onReady]);
  return <section className="companion-thought-journal" aria-label="伴星念想">
    <header className="companion-journal__section-heading">
      <span className="companion-journal__section-symbol"><Cloud size={26} aria-hidden="true" /></span>
      <div><h3>伴星的念想</h3><p>{companionName} 想起你时，留下的几句话。</p></div>
    </header>
    {loading && !page ? <p className="companion-history__system" role="status"><Loader2 size={15} className="companion-hud__spin" />正在加载念想…</p> : null}
    {failure ? <p className="companion-journal__read-error" role="status">{failure}<button type="button" onClick={() => void read(page?.nextBefore ?? undefined)}>重新读取</button></p> : null}
    {page?.items.length ? <ol className="companion-thought-journal__entries">{page.items.map(item => <li key={item.id}>
      <span className="companion-thought-journal__dot" aria-hidden="true" />
      <div><header><time dateTime={item.deliveredAt}>{messageDayLabel(item.deliveredAt)} · {messageTime(item.deliveredAt)}</time><small>{item.openedAt ? "后来聊起过" : "曾想对你说"}</small></header>
        <div className="companion-record__body">{renderCompanionMarkdown(item.text)}</div>
        {(() => {
          const phase = speech?.id === `thought:${scope}:${item.id}` ? speech.phase : null;
          const speaking = phase === "speaking";
          return <div className="companion-thought-journal__actions">
            <button type="button" className="companion-thought-journal__reply" onClick={() => onBringToChat(item.text, messageDayLabel(item.deliveredAt))}><CornerDownRight size={14} />聊聊这句</button>
            {/* 整条原文交给朗读通道，这里不按长度改口：念想多长她就念多长。 */}
            <button type="button" className="companion-thought-journal__speak" data-phase={phase ?? "idle"} data-speaking={speaking || undefined}
              aria-label={phase ? `${SPEAK_LABEL[phase]}：${item.text}` : `念出来：${item.text}`}
              onClick={() => speakThought(item)}>
              {phase === "preparing" ? <Loader2 size={14} className="companion-hud__spin" aria-hidden="true" />
                : speaking ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
              {phase ? SPEAK_LABEL[phase] : "念出来"}
            </button>
          </div>;
        })()}
      </div>
    </li>)}</ol> : page && !loading && !failure ? <div className="companion-journal__empty"><Cloud size={38} aria-hidden="true" /><strong>这里还没有念想</strong><p>伴星在这间书房主动说过的话，会留在这里。</p></div> : null}
    {page?.nextBefore ? <button type="button" className="companion-thought-journal__more" disabled={loading} onClick={() => void read(page.nextBefore ?? undefined)}>{loading ? "正在加载更早的念想…" : "更早的念想"}</button> : null}
  </section>;
}
