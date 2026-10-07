import type { CompanionExportKindV1 } from "@astella/shared/companion-memory-desktop-contracts";
import type { RequestMetaV1 } from "@astella/shared/desktop-ipc-contracts";
import { Download,Trash2 } from "lucide-react";
import { useEffect,useRef,useState } from "react";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { publishCompanionRecordsChanged } from "../../companion/companion-events";
import { SettingsInlineState,type SettingsReadable } from "./settings-primitives";
import { SETTINGS_SECTION_AI_CONSENT } from "../../../app/companion-consent-gate";

const EXPORTS = [
  { kind: "all", title: "全部伴星数据", detail: "记忆、对话、人格与操作记录的副本" },
  { kind: "memory", title: "记忆与关联", detail: "记忆条目与真实内容之间的关系" },
  { kind: "audit", title: "操作与邀请记录", detail: "伴星执行操作留下的记录" },
] as const;
const CLEAR_ACTIONS = [
  { kind: "memory", title: "清空全部记忆", detail: "把当前书房中你的记忆、候选移入回收区，30 天内可恢复；连续对话与人格保留。" },
  { kind: "history", title: "清空连续对话记录", detail: "清除当前书房中你的对话正文与收件消息；记忆、人格、旅程与动态状态保留。" },
  { kind: "audit", title: "删除操作与邀请记录", detail: "清除当前书房中你的操作与邀请记录；不会重新触发邀请。" },
] as const;
type ClearKind = (typeof CLEAR_ACTIONS)[number]["kind"];

export function SettingsCompanionData(props: { meta: () => RequestMetaV1; onReadable: (value: SettingsReadable) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [confirm, setConfirm] = useState<ClearKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openRefs = useRef<Partial<Record<ClearKind, HTMLButtonElement | null>>>({});
  const previousConfirm = useRef<ClearKind | null>(null);
  useEffect(() => { const target = confirm ?? previousConfirm.current; if (target) openRefs.current[target]?.focus(); previousConfirm.current = confirm; }, [confirm]);
  const run = async (key: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(key); setError(null); setNotice(null);
    try { await action(); }
    catch (cause) { setError(gatewayErrorMessage(cause)); }
    finally { lock.current = false; setBusy(null); }
  };
  const exportData = (kind: CompanionExportKindV1) => void run(`export-${kind}`, async () => {
    const result = unwrapGatewayResult(await window.astella.companion.data.export({ meta: props.meta(), kind }));
    setNotice(result.canceled ? "已取消导出。" : `已保存 ${result.fileName ?? "导出文件"}（${result.bytes.toLocaleString()} 字节）。`);
  });
  const clear = (kind: ClearKind) => void run(kind, async () => {
    if (kind === "memory") {
      const result = unwrapGatewayResult(await window.astella.companion.memory.clear({ meta: props.meta() }));
      setNotice(`已将 ${result.deletedCount} 条记忆移入回收区，可在 30 天内恢复。`);
    } else if (kind === "history") {
      const result = unwrapGatewayResult(await window.astella.companion.history.clear({ meta: props.meta() }));
      setNotice(`已清除 ${result.deletedMessages} 条消息、${result.deletedConversations} 段对话；动态收件箱已重新建立。`);
    } else {
      const result = unwrapGatewayResult(await window.astella.companion.data.deleteAudit({ meta: props.meta() }));
      setNotice(`已删除 ${result.deletedAudit} 条操作记录和 ${result.deletedLedger} 条邀请记录。`);
    }
    setConfirm(null); publishCompanionRecordsChanged();
  });
  const readable: SettingsReadable = {
    statusLine: error ?? notice ?? "伴星数据",
    items: [...EXPORTS.map(item => ({ label: `导出${item.title}`, state: "导出副本" })), ...CLEAR_ACTIONS.map(item => ({ label: item.title, state: "清除数据" }))],
  };
  const serialized = JSON.stringify(readable);
  useEffect(() => { props.onReadable(JSON.parse(serialized) as SettingsReadable); }, [serialized, props.onReadable]);
  return <div className="settings-companion-data" onKeyDown={event => { if (event.key === "Escape" && confirm && busy === null) { event.preventDefault(); event.stopPropagation(); setConfirm(null); } }}>
    {error ? <SettingsInlineState title="这次操作没有完成" detail={error} tone="error" /> : null}
    {notice ? <p className="settings-companion-notice" role="status">{notice}</p> : null}
    <div className="settings-companion-privacy"><div><strong>AI 数据同意</strong><p>外发内容的授权与审计在账号的 AI 数据同意页统一管理。</p></div><button type="button" className="button" onClick={() => useRoomStore.getState().setSettingsSection(SETTINGS_SECTION_AI_CONSENT)}>查看数据同意</button></div>
    <section className="settings-companion-chapter"><header><h3>导出副本</h3><p>副本保存在本机的「下载 / Astella / 伴星」，每次导出会保存为新文件。</p></header><div className="settings-companion-exports">{EXPORTS.map(item => <button type="button" key={item.kind} disabled={busy !== null} onClick={() => exportData(item.kind)}><Download size={18} aria-hidden="true" /><span><strong>导出{item.title}</strong><small>{item.detail}</small></span></button>)}</div></section>
    <section className="settings-companion-chapter settings-companion-danger"><header><h3>清除数据</h3><p>先核对每项的范围：记忆可在 30 天内恢复，对话与操作记录永久清除。</p></header>{CLEAR_ACTIONS.map(item => <div key={item.kind} className="settings-companion-clear"><div><Trash2 size={16} aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.detail}</small></span><button ref={element => { openRefs.current[item.kind] = element; }} type="button" className="danger-quiet" disabled={busy !== null} aria-expanded={confirm === item.kind} onClick={() => setConfirm(confirm === item.kind ? null : item.kind)}>{confirm === item.kind ? "取消" : "清除"}</button></div>{confirm === item.kind ? <div className="settings-companion-confirm" role="group" aria-label={`确认${item.title}`}><p>{item.detail} {item.kind === "memory" ? "可在记忆页的回收区恢复。" : "这项操作不可恢复。"}</p><button type="button" className="button danger" disabled={busy !== null} onClick={() => clear(item.kind)}>{busy === item.kind ? "正在清除…" : `确认${item.title}`}</button></div> : null}</div>)}</section>
  </div>;
}
