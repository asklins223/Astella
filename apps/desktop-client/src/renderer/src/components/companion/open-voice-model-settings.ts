import { useRoomStore } from "../../app/room-store";

export const SETTINGS_ATTENTION_VOICE_MODEL = "voice-asr-model";

/**
 * 「去设置里下载语音识别模型」这一个动作。
 *
 * 语音在两个界面上都能开始：伴星旁边的语音气泡，和作答页的语音复述。缺模型时两边
 * 都要把人领到**同一处**——设置 → 伴星 → 声音与显示。两处各写一遍 `open-settings`，
 * 迟早有一处忘了设分区，用户会被丢回设置首页自己找。
 */
export function openVoiceModelSettings(): void {
  const room = useRoomStore.getState();
  room.setSettingsSection("companion");
  room.setSettingsAttention(SETTINGS_ATTENTION_VOICE_MODEL);
  room.invoke("open-settings");
}
