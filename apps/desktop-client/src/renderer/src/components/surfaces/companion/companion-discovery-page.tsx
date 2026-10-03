import { useRef,useState } from "react";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { SectionState } from "./companion-center-primitives";
import { DiscoveryPanel } from "./companion-discovery-panel";
import { publishCompanionRecordsChanged,useCompanionRecordsRefresh,useCompanionResource } from "./use-companion-resource";

export function CompanionDiscoveryPage(props: { refreshKey: number }) {
  const book = useCompanionResource(meta => window.ailearn.companion.memory.discovery.get({ meta }), [props.refreshKey]);
  useCompanionRecordsRefresh(book.reload);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const write = async (id: string, action: () => Promise<unknown>, message: string) => {
    if (lock.current) return false;
    lock.current = true; setBusy(id); setError(null); setNotice(null);
    try { await action(); await book.reload({ silent: true }); setNotice(message); publishCompanionRecordsChanged(); return true; }
    catch (cause) { setError(gatewayErrorMessage(cause)); return false; }
    finally { lock.current = false; setBusy(null); }
  };
  if (!book.section) return <SectionState message={book.loading ? "正在读取发现簿" : "发现簿暂时读不到"} detail={book.failure ?? undefined} onRetry={() => void book.reload()} />;
  return <DiscoveryPanel section={book.section} busy={busy} error={error} notice={notice} onRetry={() => void book.reload()}
    onUncollect={entry => { void write(entry.entryId, async () => unwrapGatewayResult(await window.ailearn.companion.memory.discovery.uncollect({ meta: book.meta(), request: { kind: entry.kind, source: entry.source, sourceId: entry.sourceId } })), "已取消收藏，原始回答和日记仍然保留。"); }}
    onAnnotate={(entry, annotation) => write(entry.entryId, async () => unwrapGatewayResult(await window.ailearn.companion.memory.discovery.annotate({ meta: book.meta(), request: { entryId: entry.entryId, annotation } })), "批注已保存。")} />;
}
