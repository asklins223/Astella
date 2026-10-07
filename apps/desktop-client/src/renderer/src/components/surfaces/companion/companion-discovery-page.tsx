import { useEffect,useRef,useState } from "react";
import type { CompanionDiscoveryEntryV1 } from "@astella/shared/desktop-ipc-contracts";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { SectionState } from "./companion-center-primitives";
import { DiscoveryPanel } from "./companion-discovery-panel";
import { publishCompanionRecordsChanged,useCompanionRecordsRefresh,useCompanionResource } from "./use-companion-resource";

export function CompanionDiscoveryPage(props: { refreshKey: number; onSource: (entry: CompanionDiscoveryEntryV1) => void; onBrowse: (tab: "dialogue" | "diary") => void }) {
  const book = useCompanionResource(meta => window.astella.companion.memory.discovery.get({ meta }), [props.refreshKey]);
  useCompanionRecordsRefresh(book.reload);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Activity resumes this effect when returning to the page. A receipt from
  // the previous visit must not contradict a bookmark changed in its source.
  useEffect(() => { setError(null); setNotice(null); }, []);
  const write = async (id: string, action: () => Promise<unknown>, message: string) => {
    if (lock.current) return false;
    lock.current = true; setBusy(id); setError(null); setNotice(null);
    try { await action(); await book.reload({ silent: true }); setNotice(message); publishCompanionRecordsChanged(); return true; }
    catch (cause) { setError(gatewayErrorMessage(cause)); return false; }
    finally { lock.current = false; setBusy(null); }
  };
  if (!book.section) return <SectionState loading={book.loading} message={book.loading ? "正在加载发现簿" : "发现簿暂时读不到"} detail={book.failure ?? undefined} onRetry={() => void book.reload()} />;
  return <DiscoveryPanel section={book.section} busy={busy} error={error} notice={notice} onRetry={() => void book.reload()} onSource={props.onSource} onBrowse={props.onBrowse}
    onUncollect={entry => { void write(entry.entryId, async () => unwrapGatewayResult(await window.astella.companion.memory.discovery.uncollect({ meta: book.meta(), request: { kind: entry.kind, source: entry.source, sourceId: entry.sourceId } })), "已取消收藏，原始回答和日记仍然保留。"); }}
    onAnnotate={(entry, annotation) => write(entry.entryId, async () => unwrapGatewayResult(await window.astella.companion.memory.discovery.annotate({ meta: book.meta(), request: { entryId: entry.entryId, annotation } })), "批注已保存。")} />;
}
