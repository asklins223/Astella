import { openVoiceModelSettings } from "./open-voice-model-settings";
import { notifyCompanion, useCompanionNotifications } from "./companion-notifications";
import { VOICE_ASR_MODEL_SIZE_LINE, cancelVoiceAsrModel, voiceAsrModelPercent, voiceAsrModelFailureLine, type VoiceAsrModelSnapshotV1 } from "./voice-asr-model";

export const VOICE_MODEL_DOWNLOAD_STARTED = "ailearn:voice-model-download-started";

export function notifyVoiceModelDownloading(state: VoiceAsrModelSnapshotV1, started = false): void {
  const id = "voice-model-download-progress";
  const progress = { percent: voiceAsrModelPercent(state) ?? 0, label: state.receivedBytes >= state.expectedBytes ? "正在校验并安装" : state.activeSource ? `正在从${state.activeSource}下载` : "正在连接下载源" };
  if (!started && useCompanionNotifications.getState().items.some(item => item.id === id)) {
    useCompanionNotifications.getState().update(id, { progress }); return;
  }
  useCompanionNotifications.getState().remove("voice-model-needed");
  notifyCompanion({
    id, kind: "model", scope: "device", delivery: started ? "immediate" : "when-idle", priority: "high", source: "语音输入", title: "语音模型正在下载", progress, repeat: true,
    body: "可以继续学习，下载会在后台进行。校验并安装完成后，我会再提醒你。",
    actions: [{ id: "settings", label: "查看下载", kind: "navigate", run: openVoiceModelSettings },
      { id: "cancel", label: "取消下载", kind: "cancel", run: async () => { await cancelVoiceAsrModel(); } }],
  });
}

export function guideVoiceModelDownload(): void {
  openVoiceModelSettings();
  notifyCompanion({
    id: "voice-model-needed", kind: "model", scope: "device", delivery: "immediate", repeat: true,
    source: "语音输入", title: "先装好，我就能听你说了",
    body: `已经帮你翻到语音输入设置。选择下载约 ${VOICE_ASR_MODEL_SIZE_LINE} 的识别模型，装好后我会提醒你。录音只在这台设备上识别。`,
    audio: { clip: "voice-model-needed", text: "这台设备还没有语音识别模型。我帮你打开设置了，选择下载，装好后我会提醒你。" },
    actions: [{ id: "settings", label: "定位下载位置", kind: "navigate", run: openVoiceModelSettings },
      { id: "later", label: "先用文字", kind: "cancel" }],
  });
}

export function notifyVoiceModelSettled(state: VoiceAsrModelSnapshotV1): void {
  useCompanionNotifications.getState().remove("voice-model-download-progress");
  if (state.status === "ready") useCompanionNotifications.getState().remove("voice-model-needed");
  if (state.status === "ready") {
    notifyCompanion({
      id: `voice-model-ready:${state.installedAt ?? Date.now()}`, kind: "model", scope: "device", priority: "high",
      source: "下载完成", title: "语音输入准备好了", body: "识别模型已经装到这台设备上。下次点语音按钮，就可以直接说话了。",
      audio: { clip: "voice-model-ready", text: "语音识别模型已经装好了。现在点语音按钮，就可以和我说话啦。" },
      actions: [{ id: "ok", label: "知道了", kind: "confirm" }, { id: "settings", label: "查看语音设置", kind: "navigate", run: openVoiceModelSettings }],
    });
  } else if (state.status === "error") {
    notifyCompanion({
      id: `voice-model-failed:${Date.now()}`, kind: "model", scope: "device", priority: "high", source: "下载提醒",
      title: "语音模型还没装好", body: voiceAsrModelFailureLine(state.failure ?? "unknown"),
      audio: { clip: "voice-model-failed", text: "语音识别模型这次没下载成功。你可以在设置里重试，其他功能照常使用。" },
      actions: [{ id: "settings", label: "去设置重试", kind: "navigate", run: openVoiceModelSettings }, { id: "cancel", label: "暂时不用", kind: "cancel" }],
    });
  }
}
