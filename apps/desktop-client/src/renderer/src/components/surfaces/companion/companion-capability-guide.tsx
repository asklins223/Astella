import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { agentGoalCapabilityManifest } from "@astella/shared/agent-capabilities";
import { companionConsentGate, SETTINGS_ATTENTION_AI_CONSENT, SETTINGS_SECTION_AI_CONSENT } from "../../../app/companion-consent-gate";
import { useRoomStore } from "../../../app/room-store";
import { useCompanionResource } from "./use-companion-resource";

// Display metadata lives beside the actual executable capability, never in a second tool directory.
export const companionDiscoverableCapabilities = agentGoalCapabilityManifest.filter(item => item.presentation.discovery);

export function CompanionCapabilityGuide({ onContinue, onOpenChange }: { onContinue: () => void; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const settings = useCompanionResource(meta => window.astella.workspace.getAiSettings({ meta }), [], open);
  const policy = settings.section?.ok ? settings.section.value : null;
  const consentNeeded = companionConsentGate(policy) === "consent_required";
  const sendingDisabled = policy?.dataPolicy.sendToExternal === false;
  const openSettings = () => {
    const room = useRoomStore.getState();
    room.setSettingsSection(SETTINGS_SECTION_AI_CONSENT);
    if (consentNeeded) room.setSettingsAttention(SETTINGS_ATTENTION_AI_CONSENT);
    room.invoke("open-settings");
  };
  return <details className="cc-capability-guide" onToggle={event => { setOpen(event.currentTarget.open); onOpenChange?.(event.currentTarget.open); }}>
    <summary><Sparkles size={16} aria-hidden="true" /><span>可以交给伴星的事<small>整理材料、核对计算、准备学习成果</small></span></summary>
    {open ? <div className="cc-capability-guide__body">
      <p>说清楚你想得到什么，也可以把几件事一起交代。要看哪份材料、做成什么样，我们可以接着聊。</p>
      <dl>{companionDiscoverableCapabilities.map(item => <div key={item.definition.name}><dt>{item.presentation.label}</dt><dd>{item.presentation.discovery}</dd></div>)}</dl>
      <p className="cc-muted">学习卡与拓展内容会先留给你审核；确认、修改、暂停和接续都可以在轻气泡或我们的对话手记里完成。学习问答、找笔记和查看进度也可以直接说。</p>
      {consentNeeded || sendingDisabled ? <p className="cc-capability-guide__restriction" role="status">
        {consentNeeded ? "还需要签署你的 AI 使用同意。" : "你已关闭内容外发，使用外部模型的能力暂时不能运行。"}
        <button type="button" className="cc-link" onClick={openSettings}>查看 AI 设置<ArrowRight size={14} aria-hidden="true" /></button>
      </p> : settings.failure || (settings.section && !settings.section.ok) ? <p role="status" className="cc-muted">当前设置暂时读不到，发送时会重新核对。<button type="button" className="cc-link" onClick={() => void settings.reload()}>重新核对</button></p> : null}
      <button type="button" className="cc-link" onClick={onContinue}>说说想做的事<ArrowRight size={14} aria-hidden="true" /></button>
    </div> : null}
  </details>;
}
