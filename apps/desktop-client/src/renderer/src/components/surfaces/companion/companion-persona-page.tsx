import { companionPersonaPatchFromContent,companionPersonaPatchFromPresetSwitch,type CompanionPersonaPresetV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { personaFromDefaultPreset, planPersonaSwitch, type SwitchableField } from "@astella/shared/pet-persona-merge";
import type { GatewayResultV1 } from "@astella/shared/desktop-ipc-contracts";
import { useEffect,useRef,useState } from "react";
import { useCompanionChat } from "../../../app/companion-chat-session";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { companionDisplayName,publishCompanionDisplayName } from "../../companion/companion-display-name";
import { SectionState } from "./companion-center-primitives";
import { PersonaPanel } from "./companion-persona-panel";
import { publishCompanionRecordsChanged,useCompanionRecordsRefresh,useCompanionResource } from "./use-companion-resource";

type PersonaChange = { name?: string; activeness?: "quiet" | "moderate" | "active"; boundaries?: { allowPlayful?: boolean; allowNudgeLearning?: boolean; allowVoiceTags?: boolean; catchphrase?: string | null } };

export function CompanionPersonaPage(props: { refreshKey: number; onSettings: () => void }) {
  const chat = useCompanionChat();
  const persona = useCompanionResource(meta => window.astella.companion.persona.get({ meta }), [props.refreshKey]);
  const versions = useCompanionResource(meta => window.astella.companion.persona.versions({ meta }), [props.refreshKey]);
  const pending = useCompanionResource(meta => window.astella.companion.persona.pending({ meta }), [props.refreshKey]);
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

  // 「当前生效的人格内容」。账号还没有档案时用系统默认人格当底稿 ——
  // 这样表达分量与边界那几颗控件从第一眼起就是可点的，点了就落成第 1 版。
  const effective = value?.profile ?? (value?.activePreset ? personaFromDefaultPreset(value.activePreset) : null);
  const patch = (changes: PersonaChange, key: string) => {
    if (!value || !effective) return Promise.resolve(false);
    const request = companionPersonaPatchFromContent(effective, value.profileRevision, changes);
    return write(key, () => window.astella.companion.persona.patch({ meta: persona.meta(), request }));
  };

  // ── 换人格：先把"会被换掉的是什么"摊开，再让用户自己勾 ──────────────────
  // 此前点一下卡片就是整份替换：她改过的语气、你改过的名字和开关一起没了，
  // 没有任何提示。现在只有"不是预设写的那几项"进这个清单，且默认保留。
  const [switchTarget, setSwitchTarget] = useState<CompanionPersonaPresetV1 | null>(null);
  const [overwrite, setOverwrite] = useState<readonly SwitchableField[]>([]);
  const switchPlan = switchTarget && effective ? planPersonaSwitch(effective, switchTarget) : null;
  const openSwitch = (preset: CompanionPersonaPresetV1) => {
    if (!value) return;
    setOverwrite([]);
    setSwitchTarget(preset);
  };
  const confirmSwitch = () => {
    if (!value || !switchTarget || !effective) return;
    const previous = value.profileRevision;
    const request = companionPersonaPatchFromPresetSwitch(effective, previous, switchTarget, overwrite);
    const kept = (switchPlan?.options.length ?? 0) - overwrite.length;
    void write(
      "preset",
      () => window.astella.companion.persona.patch({ meta: persona.meta(), request }),
      // 明说"换之前的样子存在哪一版"：这是让人敢点的前提。
      () => [`已换成「${switchTarget.name}」。`, kept > 0 ? `保留了 ${kept} 项你们的改动。` : "", `切换前是第 ${previous} 版，可在下方版本记录里恢复。`]
        .filter(Boolean)
        .join(""),
    ).then((ok) => { if (ok) setSwitchTarget(null); });
  };

  if (!persona.section) return <SectionState loading={persona.loading} message={persona.loading ? "正在加载人格档案" : "人格档案当前不可用"} detail={persona.failure ?? undefined} onRetry={() => void reload()} />;
  return <PersonaPanel section={persona.section} persona={value}
    versions={versions.section?.ok ? versions.section.value.versions : null}
    versionsError={versions.section && !versions.section.ok ? versions.section.message : versions.failure}
    pending={pending.section?.ok ? pending.section.value : undefined}
    pendingError={pending.section && !pending.section.ok ? pending.section.message : pending.failure}
    busy={busy} error={error} notice={notice} onSettings={props.onSettings}
    switchTarget={switchTarget} switchOptions={switchPlan?.options ?? []} overwrite={overwrite}
    onOverwrite={fields => setOverwrite(fields)} onSwitchCancel={() => setSwitchTarget(null)} onSwitchConfirm={confirmSwitch}
    onPreset={openSwitch}
    onActiveness={activeness => void patch({ activeness }, "activeness")}
    onBoundary={key => { const boundaries = effective?.boundaries; if (boundaries) void patch({ boundaries: { ...boundaries, [key]: !boundaries[key] } }, "boundary"); }}
    onRename={name => patch({ name }, "name")}
    onReset={() => { if (value) void write("reset", () => window.astella.companion.persona.reset({ meta: persona.meta(), revision: value.profileRevision })); }}
    onRestore={revision => { if (value) void write("restore", () => window.astella.companion.persona.restore({ meta: persona.meta(), revision, currentRevision: value.profileRevision })); }}
    onActivatePending={() => { if (pendingValue?.pending) void write("activate-pending", () => window.astella.companion.persona.activate({ meta: persona.meta(), revision: pendingValue.currentRevision }), result => `已生效，现在使用第 ${(result as { profileRevision: number }).profileRevision} 版。`); }}
    onRetryPending={() => void pending.reload()} onReloadVersions={() => void versions.reload()} onRetry={() => void reload()} />;
}
