import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Cloud, CornerDownRight, Loader2 } from "lucide-react";
import type { CompanionChatListThoughtsResultV1 } from "@ailearn/shared/companion-chat-desktop-contracts";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { messageDayLabel, messageTime } from "./CompanionChatRecord";
import { renderCompanionMarkdown } from "./companion-markdown";

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
      const page = unwrapGatewayResult(await window.ailearn.companion.chat.listThoughts({
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
  useLayoutEffect(() => {
    if (page && restoredScope.current !== scope) { restoredScope.current = scope; onReady?.(); }
  }, [page, scope, onReady]);
  return <section className="companion-thought-journal" aria-label="伴星念想">
    <header className="companion-journal__section-heading">
      <span className="companion-journal__section-symbol"><Cloud size={26} aria-hidden="true" /></span>
      <div><h3>伴星的念想</h3><p>{companionName} 想起你时，留下的几句话。</p></div>
    </header>
    {loading && !page ? <p className="companion-history__system" role="status"><Loader2 size={15} className="companion-hud__spin" />正在翻开念想…</p> : null}
    {failure ? <p className="companion-journal__read-error" role="status">{failure}<button type="button" onClick={() => void read(page?.nextBefore ?? undefined)}>重新读取</button></p> : null}
    {page?.items.length ? <ol className="companion-thought-journal__entries">{page.items.map(item => <li key={item.id}>
      <span className="companion-thought-journal__dot" aria-hidden="true" />
      <div><header><time dateTime={item.deliveredAt}>{messageDayLabel(item.deliveredAt)} · {messageTime(item.deliveredAt)}</time><small>{item.openedAt ? "后来聊起过" : "曾想对你说"}</small></header>
        <div className="companion-record__body">{renderCompanionMarkdown(item.text)}</div>
        <button type="button" className="companion-thought-journal__reply" onClick={() => onBringToChat(item.text, messageDayLabel(item.deliveredAt))}><CornerDownRight size={14} />聊聊这句</button>
      </div>
    </li>)}</ol> : page && !loading && !failure ? <div className="companion-journal__empty"><Cloud size={38} aria-hidden="true" /><strong>让念想慢慢留下来</strong><p>这间书房还没有已表达的念想。<br />伴星主动想对你说的话，会在这里留一份。</p></div> : null}
    {page?.nextBefore ? <button type="button" className="companion-thought-journal__more" disabled={loading} onClick={() => void read(page.nextBefore ?? undefined)}>{loading ? "正在翻找…" : "更早的念想"}</button> : null}
  </section>;
}
