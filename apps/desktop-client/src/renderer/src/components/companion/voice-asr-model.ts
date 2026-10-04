/**
 * 语音输入用的本地识别模型，在设置页里是一个可选的附加功能。
 *
 * 模型本体不进安装包（一份 239 MB，而语音是偶尔才用的），由用户自己决定要不要下。
 * 识别在 worker 里就地发生，**录音没有任何一条出设备的路**：这一族只回答
 * 「模型在不在这台机器上、下到哪了」，音频一个字节都不经过这里。
 */
import {
  VOICE_ASR_MODEL_EXPECTED_BYTES,
  VOICE_ASR_MODEL_LABEL,
  type VoiceAsrModelFailure,
  type VoiceAsrModelSnapshotV1,
  type VoiceAsrModelStatus,
} from "@ailearn/shared/voice-asr-model-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";

export type { VoiceAsrModelFailure, VoiceAsrModelSnapshotV1, VoiceAsrModelStatus };

export const VOICE_ASR_MODEL_NAME = VOICE_ASR_MODEL_LABEL;

/**
 * 「从哪儿下」的一句话读数。
 *
 * 印的是**整条链**而不只是第一个：镜像挂了会自动换下一个，用户看到的是"在换源"，
 * 而不是以为下载坏了。只印第一个源的话，他会在一个已经没人用的地址上等。
 */
export function voiceAsrModelSourceLine(state: VoiceAsrModelSnapshotV1 | null): string {
  const names = state?.sources ?? [];
  if (names.length === 0) return "";
  if (names.length === 1) return `来自 ${names[0]}`;
  return `优先 ${names[0]}，连不上自动换 ${names.slice(1).join("、")}`;
}

/** 「大约 228 MB」这类读数：设置页与提示条共用一份算法，别各写一个 toFixed。 */
export function voiceAsrModelBytesLine(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 100 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`;
}

export const VOICE_ASR_MODEL_SIZE_LINE = voiceAsrModelBytesLine(VOICE_ASR_MODEL_EXPECTED_BYTES);

/** 总量来自固定模型清单。文件全部落盘之前最多 99%，避免提前宣告完成。 */
export function voiceAsrModelPercent(state: VoiceAsrModelSnapshotV1): number | null {
  if (state.expectedBytes <= 0) return null;
  const maximum = state.status === "ready" ? 100 : 99;
  return Math.min(maximum, Math.max(0, Math.round((state.receivedBytes / state.expectedBytes) * 100)));
}

/** 主进程的失败分类 → 设置页上的操作提示。 */
const FAILURE_COPY: Record<VoiceAsrModelFailure, string> = {
  network: "没连上模型库。检查一下网络，或稍后重试。",
  size_mismatch: "下回来的文件不完整，重下一次就好。",
  storage: "模型没能写入这台设备，请检查剩余空间和目录的写入权限后重试。",
  cancelled: "这次下载已取消。",
  unknown: "这次没下成，再试一次。",
};

export function voiceAsrModelFailureLine(failure: VoiceAsrModelFailure): string {
  return FAILURE_COPY[failure];
}

/**
 * 一句状态读数。设置卡上的印章、页脚提示与设置页的可读镜像用的是同一份口径——
 * 三处各写一遍的话，迟早有一处忘了改，用户在某一处看到「已装好」而另一处没有。
 */
export function voiceAsrModelStatusLine(status: string | null): string {
  switch (status) {
    case "ready": return "已装在这台设备上";
    case "downloading": return "正在下载";
    case "error": return "这次没下成";
    case "absent": return "还没有下载";
    case "unknown": return "暂时读不到状态";
    default: return "正在看本机状态";
  }
}

function meta() {
  // 设备级通道不要求工作区纪元：模型在这台机器上，与登录哪个空间无关。
  return { meta: createRequestMeta() };
}

export function readVoiceAsrModel(): Promise<VoiceAsrModelSnapshotV1> {
  return window.ailearn.companion.voice.asrModel.getState(meta()).then(unwrapGatewayResult);
}

export function downloadVoiceAsrModel(): Promise<VoiceAsrModelSnapshotV1> {
  return window.ailearn.companion.voice.asrModel.download(meta()).then(unwrapGatewayResult).then(state => {
    window.dispatchEvent(new CustomEvent("ailearn:voice-model-download-started", { detail: state }));
    return state;
  });
}

export function cancelVoiceAsrModel(): Promise<VoiceAsrModelSnapshotV1> {
  return window.ailearn.companion.voice.asrModel.cancel(meta()).then(unwrapGatewayResult);
}

export function removeVoiceAsrModel(): Promise<VoiceAsrModelSnapshotV1> {
  return window.ailearn.companion.voice.asrModel.remove(meta()).then(unwrapGatewayResult);
}
