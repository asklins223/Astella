import { companionPersonaPatchFromPreset,companionPersonaPatchFromProfile,type CompanionPersonaProfileV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { useEffect,useRef,useState } from "react";
import { useCompanionChat } from "../../../app/companion-chat-session";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { companionDisplayName,publishCompanionDisplayName } from "../../companion/companion-display-name";
import { SectionState } from "./companion-center-primitives";
import { PersonaPanel } from "./companion-persona-panel";
import { publishCompanionRecordsChanged,useCompanionRecordsRefresh,useCompanionResource } from "./use-companion-resource";

export function CompanionPersonaPage(props: { refreshKey: number; onSettings: () => void }) {
  const chat = useCompanionChat();
  const persona = useCompanionResource(meta => window.ailearn.companion.persona.get({ meta }), [props.refreshKey]);
  const versions = useCompanionResource(meta => window.ailearn.companion.persona.versions({ meta }), [props.refreshKey]);
  const pending = useCompanionResource(meta => window.ailearn.companion.persona.pending({ meta }), [props.refreshKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = async () => { await Promise.all([persona.reload({ silent: true }), versions.reload({ silent: true }), pending.reload({ silent: true })]); };
  useCompanionRecordsRefresh(reload);
  const value = persona.section?.ok ? persona.section.value : null;
  const pendingValue = pending.section?.ok ? pending.section.value : null;
  useEffect(() => {
    if (!value) return;
    const name = companionDisplayName(value);
    publishCompanionDisplayName(name);
    chat.setCompanionName(name);
  }, [value, chat.setCompanionName]);
  const write = async (key: string, action: () => Promise<GatewayResultV1<unknown>>, receipt?: (result: unknown) => string): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true; setBusy(key); setError(null); setNotice(null);
    try {
      const result = unwrapGatewayResult(await action());
      await reload();
      setNotice(receipt?.(result) ?? "已保存。新的人格用于下一次尚未开始的调用。");
      publishCompanionRecordsChanged();
      return true;
    } catch (cause) { setError(gatewayErrorMessage(cause)); await reload(); return false; }
    finally { lock.current = false; setBusy(null); }
  };
  const patch = (changes: Partial<Pick<CompanionPersonaProfileV1, "name" | "activeness" | "boundaries">>, key: string) => {
    if (!value) return Promise.resolve(false);
    const current = value.profile ? companionPersonaPatchFromProfile(value.profile, changes) : value.activePreset
      ? { ...companionPersonaPatchFromPreset(value.activePreset, value.profileRevision), ...changes } : null;
    return current ? write(key, () => window.ailearn.companion.persona.patch({ meta: persona.meta(), request: current })) : Promise.resolve(false);
  };
  if (!persona.section) return <SectionState message={persona.loading ? "正在读取人格档案" : "人格档案当前不可用"} detail={persona.failure ?? undefined} onRetry={() => void reload()} />;
  return <PersonaPanel section={persona.section} persona={value}
    versions={versions.section?.ok ? versions.section.value.versions : null}
    versionsError={versions.section && !versions.section.ok ? versions.section.message : versions.failure}
    pending={pending.section?.ok ? pending.section.value : undefined}
    pendingError={pending.section && !pending.section.ok ? pending.section.message : pending.failure}
    busy={busy} error={error} notice={notice} onSettings={props.onSettings}
    onPreset={preset => { if (value) void write("preset", () => window.ailearn.companion.persona.patch({ meta: persona.meta(), request: companionPersonaPatchFromPreset(preset, value.profileRevision) })); }}
    onActiveness={activeness => void patch({ activeness }, "activeness")}
    onBoundary={key => { const boundaries = value?.profile?.boundaries ?? value?.activePreset?.boundaries; if (boundaries) void patch({ boundaries: { ...boundaries, [key]: !boundaries[key] } }, "boundary"); }}
    onRename={name => patch({ name }, "name")}
    onReset={() => { if (value) void write("reset", () => window.ailearn.companion.persona.reset({ meta: persona.meta(), revision: value.profileRevision })); }}
    onRestore={revision => { if (value) void write("restore", () => window.ailearn.companion.persona.restore({ meta: persona.meta(), revision, currentRevision: value.profileRevision })); }}
    onActivatePending={() => { if (pendingValue?.pending) void write("activate-pending", () => window.ailearn.companion.persona.activate({ meta: persona.meta(), revision: pendingValue.currentRevision }), result => `已生效，现在使用第 ${(result as { profileRevision: number }).profileRevision} 版。`); }}
    onRetryPending={() => void pending.reload()} onReloadVersions={() => void versions.reload()} onRetry={() => void reload()} />;
}
