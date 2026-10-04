import type { CompanionAccountPatch } from "@ailearn/shared/companion-shell-contracts";
import { ArrowUpRight,BookOpen } from "lucide-react";
import { Activity,useEffect,useRef,useState,type ReactNode } from "react";
import { useRoomStore } from "../../../app/room-store";
import { SETTINGS_ATTENTION_VOICE_MODEL } from "../../companion/open-voice-model-settings";
import { COMPANION_AGENT_PERMISSION_OPTIONS,COMPANION_INTERVENTION_OPTIONS,COMPANION_PRESENCE_OPTIONS,companionInterventionHint,quietHoursPatch,quietHoursWithBoundary } from "../../companion/companion-account-presence";
import { HudSegmented,HudSwitch } from "../../hud/HudControls";
import { SettingsCompanionData } from "./settings-companion-data";
import { CompanionTimePicker } from "./settings-companion-time";
import { SettingsCompanionVoice } from "./settings-companion-voice";
import { SettingRow,SettingsInlineState,type SettingsReadable } from "./settings-primitives";
import { useCompanionAccountSettings } from "./use-companion-account-settings";

const CHAPTERS = [["rules", "陪伴规则"], ["voice", "声音与显示"], ["data", "伴星数据"]] as const;
type Chapter = (typeof CHAPTERS)[number][0];
const permissionDetail = {
  read_only: "只读取和查询，执行改动前需要你调整权限。",
  guided: "每次产生改动前先征求你的确认。",
  full: "跳转、设置与填充可以自动执行；不可恢复的操作仍会确认。",
};

function QuietHoursEditor(props: { value: NonNullable<CompanionAccountPatch["quietHours"]>; busy: boolean; onSave: (value: NonNullable<CompanionAccountPatch["quietHours"]>) => Promise<boolean> }) {
  const [start, setStart] = useState(props.value.startLocal);
  const [end, setEnd] = useState(props.value.endLocal);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!dirty) { setStart(props.value.startLocal); setEnd(props.value.endLocal); } }, [props.value, dirty]);
  return <form className="settings-companion-quiet" onSubmit={async event => {
    event.preventDefault();
    const result = quietHoursWithBoundary({ ...props.value, endLocal: end }, "startLocal", start);
    if (!end || !result.ok) { setError(!end ? "开始与结束时间都需要填写。" : result.ok ? null : result.reason); return; }
    setError(null); if (await props.onSave(result.value)) setDirty(false);
  }}>
    <div><span>开始</span><CompanionTimePicker label="静默开始时间" value={start} disabled={props.busy} onChange={value => { setStart(value); setDirty(true); }} /></div><span>至</span>
    <div><span>结束</span><CompanionTimePicker label="静默结束时间" value={end} disabled={props.busy} onChange={value => { setEnd(value); setDirty(true); }} /></div>
    <button type="submit" className="button" disabled={!dirty || props.busy}>保存时段</button><small>时区：{props.value.timezone}</small>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}

export function SettingsCompanionPanel(props: { onReadable: (value: SettingsReadable) => void; capabilities: ReactNode }) {
  const [chapter, setChapter] = useState<Chapter>("rules");
  const rootRef = useRef<HTMLDivElement>(null);
  const attention = useRoomStore(state => state.settingsAttention);
  useEffect(() => {
    if (attention !== SETTINGS_ATTENTION_VOICE_MODEL) return;
    if (chapter !== "voice") { setChapter("voice"); return; }
    const card = rootRef.current?.querySelector<HTMLElement>(".settings-voice-model");
    card?.scrollIntoView({ block: "center", behavior: "instant" });
    card?.focus({ preventScroll: true });
    useRoomStore.getState().setSettingsAttention(null);
  }, [attention, chapter]);
  const motionMode = useRoomStore(state => state.motionMode);
  const reducedMotion = useRoomStore(state => state.reducedMotion);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const settings = useCompanionAccountSettings();
  const { account, busy, patch } = settings;
  const quiet = account?.quietHours ?? null;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const presenceOptions = COMPANION_PRESENCE_OPTIONS;
  const interventionOptions = COMPANION_INTERVENTION_OPTIONS;
  const permissionOptions = COMPANION_AGENT_PERMISSION_OPTIONS;
  const ruleReadable: SettingsReadable = {
    statusLine: settings.error ?? settings.notice ?? (settings.loading && !account ? "正在读取伴星设置" : "陪伴规则"),
    items: account ? [
      { label: "启用伴星", state: account.globalEnabled ? "已开启" : "已关闭" },
      { label: "在线状态", state: presenceOptions.find(option => option[0] === account.presence?.presence)?.[1] ?? "在线" },
      { label: "主动介入", state: interventionOptions.find(option => option[0] === (account.interventionLevel ?? "moderate"))?.[1] },
      { label: "静默时段", state: quiet ? `${quiet.startLocal}–${quiet.endLocal}` : "已关闭" },
      { label: "助理权限", state: permissionOptions.find(option => option[0] === (account.agentSettings?.permissionLevel ?? "guided"))?.[1] },
      { label: "自动生成日记", state: account.diaryEnabled ? "已开启" : "已暂停" },
    ] : [],
  };
  const serialized = JSON.stringify(ruleReadable);
  useEffect(() => { if (chapter === "rules") props.onReadable(JSON.parse(serialized) as SettingsReadable); }, [chapter, serialized, props.onReadable]);
  return <div ref={rootRef} className="settings-companion" data-motion={reducedMotion ? "off" : motionMode}>
    <div className="settings-companion-home"><BookOpen size={24} aria-hidden="true" /><div><strong>想看看你们留下的东西？</strong><p>对话、日记、记忆、发现簿与人格都在伴星中心。</p></div><button type="button" className="button" onClick={() => { const room = useRoomStore.getState(); room.setCompanionCenterTarget({ tab: "overview" }); room.invoke("open-companion-center"); }}>打开伴星中心<ArrowUpRight size={15} aria-hidden="true" /></button></div>
    <nav className="settings-companion-tabs" role="tablist" aria-label="伴星设置分区"><span className="settings-companion-tabs__cushion" data-settings-cushion aria-hidden="true" />{CHAPTERS.map(([id, label], index) => <button type="button" key={id} ref={element => { tabRefs.current[index] = element; }} id={`companion-settings-tab-${id}`} role="tab" aria-selected={chapter === id} aria-controls={`companion-settings-panel-${id}`} tabIndex={chapter === id ? 0 : -1} onClick={() => setChapter(id)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % CHAPTERS.length : event.key === "ArrowLeft" ? (index - 1 + CHAPTERS.length) % CHAPTERS.length : event.key === "Home" ? 0 : event.key === "End" ? CHAPTERS.length - 1 : null;
      if (next === null) return; event.preventDefault(); setChapter(CHAPTERS[next][0]); tabRefs.current[next]?.focus();
    }}>{label}</button>)}</nav>
    <Activity mode={chapter === "rules" ? "visible" : "hidden"}><div data-settings-page="rules" data-settings-active={chapter === "rules" ? "true" : "false"} id="companion-settings-panel-rules" role="tabpanel" aria-labelledby="companion-settings-tab-rules">
      {settings.error ? <SettingsInlineState title="伴星设置暂时不可用" detail={settings.error} tone="error" onRetry={() => void settings.reload()} /> : null}
      {settings.notice ? <p className="settings-companion-notice" role="status">{settings.notice}</p> : null}
      {!account && settings.loading ? <p role="status">正在读取伴星设置</p> : null}
      {account ? <>
        <section className="settings-companion-chapter"><header><h3>什么时候陪在旁边</h3><p>账号级规则，会在你的不同设备和书房间同步。</p></header>
          <SettingRow title="启用伴星" detail="关闭后停止伴星运行。已留下的记录仍可在伴星中心查看。"><HudSwitch label="启用伴星" checked={account.globalEnabled} disabled={busy} onChange={next => void patch({ globalEnabled: next })} /></SettingRow>
          <SettingRow title="在线状态" detail={account.presence?.presence === "offline" ? "暂停陪伴与主动消息；需要时切回在线。" : account.presence?.presence === "dnd" ? "保持勿扰，减少主动打扰。" : "可以在合适时机主动开口。"}><HudSegmented label="在线状态" value={account.presence?.presence ?? "online"} options={presenceOptions} compact disabled={busy} onChange={value => void patch({ presence: { presence: value } })} /></SettingRow>
          <SettingRow title="主动介入" detail={companionInterventionHint(account.interventionLevel ?? "moderate")}><HudSegmented label="主动介入强度" value={account.interventionLevel ?? "moderate"} options={interventionOptions} compact disabled={busy} onChange={value => void patch({ interventionLevel: value })} /></SettingRow>
          <SettingRow title="静默时段" detail="这段时间不主动开口；你约过的提醒到点照样会来。"><HudSwitch label="静默时段" checked={Boolean(quiet)} disabled={busy} onChange={next => void patch({ quietHours: quietHoursPatch(next, timezone) })} /></SettingRow>
          {quiet ? <QuietHoursEditor value={quiet} busy={busy} onSave={value => patch({ quietHours: value })} /> : null}
        </section>
        <section className="settings-companion-chapter"><header><h3>她可以做什么</h3><p>执行动作的权限与表达边界分别管理。</p></header>
          <SettingRow title="助理权限" detail={permissionDetail[account.agentSettings?.permissionLevel ?? "guided"]}><HudSegmented label="助理权限档位" value={account.agentSettings?.permissionLevel ?? "guided"} options={permissionOptions} compact disabled={busy} onChange={value => void patch({ agentPermissionLevel: value })} /></SettingRow>
          <SettingRow title="自动生成日记" detail="暂停期间不收集日记素材；重新开启后从开启时起积累。"><HudSwitch label="自动生成日记" checked={account.diaryEnabled} disabled={busy} onChange={next => void patch({ diaryEnabled: next })} /></SettingRow>
          <p className="settings-companion-note">说话风格、名字和表达分量，在伴星中心的「人格」页调整。</p>
        </section>
      </> : null}
      <details className="settings-companion-capabilities"><summary>查看当前可用能力</summary>{props.capabilities}</details>
    </div></Activity>
    <Activity mode={chapter === "voice" ? "visible" : "hidden"}><div data-settings-page="voice" data-settings-active={chapter === "voice" ? "true" : "false"} id="companion-settings-panel-voice" role="tabpanel" aria-labelledby="companion-settings-tab-voice"><SettingsCompanionVoice onReadable={props.onReadable} /></div></Activity>
    <Activity mode={chapter === "data" ? "visible" : "hidden"}><div data-settings-page="data" data-settings-active={chapter === "data" ? "true" : "false"} id="companion-settings-panel-data" role="tabpanel" aria-labelledby="companion-settings-tab-data"><SettingsCompanionData meta={settings.meta} onReadable={props.onReadable} /></div></Activity>
  </div>;
}
