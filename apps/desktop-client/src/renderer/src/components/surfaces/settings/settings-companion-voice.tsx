import { useEffect,useState } from "react";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { DEFAULT_COMPANION_SCALE,MAX_COMPANION_SCALE,MIN_COMPANION_SCALE,useRoomStore } from "../../../app/room-store";
import { WINDOW_LIVE2D_MODEL_REGISTRY,type WindowLive2DModelId } from "../../companion/window-live2d-contract";
import { HudSegmented,HudSlider,HudSwitch } from "../../hud/HudControls";
import { useCompanionResource } from "../companion/use-companion-resource";
import { SettingsAnswerModeRow } from "./settings-answer-mode-row";
import { ANSWER_MODE_OPTIONS,TTS_ENGINE_OPTIONS,pendingReadLine,percentLine,voicePlayerLine,voicesForEngine } from "./settings-data-tables";
import { SettingRow,SettingsInlineState,type SettingsReadable } from "./settings-primitives";
import { SettingsVoicePanel } from "./settings-voice-panel";
import { useSettingsVoice } from "./use-settings-voice";

export function SettingsCompanionVoice(props: { onReadable: (value: SettingsReadable) => void }) {
  const scale = useRoomStore(state => state.companionScale);
  const setScale = useRoomStore(state => state.setCompanionScale);
  const placementOwner = useRoomStore(state => state.companionPlacementOwner);
  const resetPosition = useRoomStore(state => state.resetCompanionPosition);
  const model = useRoomStore(state => state.companionModelId);
  const setModel = useRoomStore(state => state.setCompanionModelId);
  const masterMuted = useRoomStore(state => state.masterMuted);
  const setMasterMuted = useRoomStore(state => state.setMasterMuted);
  const voiceResource = useCompanionResource(meta => window.ailearn.companion.voicePreference.get({ meta }));
  const answer = useCompanionResource(meta => window.ailearn.companion.answerMode.get({ meta }));
  const [error, setError] = useState<string | null>(null);
  const [answerSaving, setAnswerSaving] = useState(false);
  const voice = useSettingsVoice({ epochRef: voiceResource.epochRef, setFailureNotice: setError });
  useEffect(() => {
    voice.setVoicePreference(voiceResource.section?.ok ? voiceResource.section.value : null);
    voice.setVoicePreferenceRead(!voiceResource.loading);
  }, [voiceResource.section, voiceResource.loading, voice.setVoicePreference, voice.setVoicePreferenceRead]);
  const answerMode = answer.section?.ok ? answer.section.value : null;
  const models = Object.entries(WINDOW_LIVE2D_MODEL_REGISTRY).map(([value, entry]) => [value as WindowLive2DModelId, entry.displayName] as const);
  const changeAnswer = async (preference: NonNullable<typeof answerMode>["preference"]) => {
    if (answerSaving) return;
    setAnswerSaving(true); setError(null);
    try { unwrapGatewayResult(await window.ailearn.companion.answerMode.patch({ meta: answer.meta(), preference })); await answer.reload({ silent: true }); }
    catch (cause) { setError(gatewayErrorMessage(cause)); }
    finally { setAnswerSaving(false); }
  };
  const readable: SettingsReadable = {
    statusLine: error ?? voice.voicePreviewError ?? (voice.voicePlayer ? voicePlayerLine(voice.voicePlayer) : "声音与显示"),
    metrics: [{ label: "伴星大小", value: percentLine(scale) }],
    filters: [{ label: "伴星与环境音", value: masterMuted ? "已关闭" : "已开启" }, { label: "书桌上的形象", value: WINDOW_LIVE2D_MODEL_REGISTRY[model].displayName }],
    items: [
      { label: "默认作答方式", state: answerMode ? ANSWER_MODE_OPTIONS.find(option => option[0] === answerMode.preference)?.[1] : pendingReadLine(!answer.loading) },
      { label: "用哪套声音合成", state: voice.voicePreference ? TTS_ENGINE_OPTIONS.find(option => option[0] === voice.voicePreference?.engine)?.[1] : pendingReadLine(voice.voicePreferenceRead) },
      ...voicesForEngine(voice.voicePreference?.engine).map(option => ({ label: option.name, ...(voice.voicePreference?.voice === option.voice ? { state: "在用" } : {}) })),
    ],
  };
  const serialized = JSON.stringify(readable);
  useEffect(() => { props.onReadable(JSON.parse(serialized) as SettingsReadable); }, [serialized, props.onReadable]);
  return <div className="settings-companion-voice">
    {error ? <SettingsInlineState title="这次设置没有保存" detail={error} tone="error" /> : null}
    <section className="settings-companion-chapter"><header><h3>书桌上的伴星</h3><p>这台设备上的形象、大小与声音。</p></header>
      <SettingRow title="书桌上的形象" detail="只改变显示的角色模型，人格和记忆仍然保留。"><HudSegmented label="书桌上的形象" value={model} options={models} onChange={setModel} compact /></SettingRow>
      <div className="settings-companion-size"><b>伴星大小</b><HudSlider label="伴星大小" value={scale} min={MIN_COMPANION_SCALE} max={MAX_COMPANION_SCALE} step={0.05} onChange={setScale} format={percentLine} hint="位置可以在书桌和页面里拖动调整。" /></div>
      <SettingRow title="让伴星回到默认位置" detail="拖到边缘或挡住纸面时，恢复默认座位与 100% 大小。"><button type="button" className="button" disabled={placementOwner === "semantic" && scale === DEFAULT_COMPANION_SCALE} onClick={() => { resetPosition(); setScale(DEFAULT_COMPANION_SCALE); }}>恢复位置与大小</button></SettingRow>
      <SettingRow title="伴星与环境音" detail="本机总静音，同时控制环境音和伴星语音。"><HudSwitch checked={!masterMuted} onChange={next => setMasterMuted(!next)} label="伴星与环境音" /></SettingRow>
    </section>
    <section className="settings-companion-chapter"><header><h3>对话与朗读</h3><p>默认作答方式和音色在账号的设备间共享。</p></header>
      <SettingsAnswerModeRow answerMode={answerMode} answerModeRead={!answer.loading} answerModeSaving={answerSaving} changeAnswerMode={changeAnswer} />
      {answer.section && !answer.section.ok ? <SettingsInlineState title="作答偏好暂时读不到" detail={answer.section.message} tone="error" onRetry={() => void answer.reload()} /> : null}
      <SettingsVoicePanel voicePreference={voice.voicePreference} voicePreferenceRead={voice.voicePreferenceRead} voiceSaving={voice.voiceSaving} voicePlayer={voice.voicePlayer} changeVoice={voice.changeVoice} previewVoice={voice.previewVoice} onTogglePlayer={voice.toggleVoicePlayer} />
      <audio ref={voice.voiceAudioRef} className="settings-voice__source" preload="none" />
      {voiceResource.section && !voiceResource.section.ok ? <SettingsInlineState title="音色偏好暂时读不到" detail={voiceResource.section.message} tone="error" onRetry={() => void voiceResource.reload()} /> : null}
      {voice.voicePreviewError ? <SettingsInlineState title="这一段没试听成" detail={voice.voicePreviewError} tone="error" /> : null}
    </section>
  </div>;
}
