/**
 * 设置页用到的三张**纯数据表**：外发策略的四个开关、审计台账的类目字与状态字。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 它们原先是页面里的模块级 `const`。`SettingsDataBoundaryGroup` 要用其中两张半，
 * 可它在页面之外——于是组件只能把字面量重抄一遍。**抄文案就是抄错的开始**：
 * 「已外发」与「外发中」那一字之差，抄错了没有任何测试会报。
 *
 * 纯数据，零行为变化。
 */
import type { DesktopAiAuditItemV1 } from "@ailearn/shared/desktop-surface-contracts";
import type { AiDataPolicyV1, WorkspaceSummaryV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { EDGE_TTS_VOICE_OPTIONS, QWEN_TTS_VOICE_OPTIONS, type TtsEngineV1 } from "@ailearn/shared/tts-voice-catalog";
import type { CompanionAnswerModePreferenceV1 } from "@ailearn/shared";
import { LEARNING_ROOM_ASSET_BASE_PATH } from "@ailearn/shared/desktop-ipc-contracts";

export const DATA_POLICY_FIELDS: ReadonlyArray<readonly [keyof AiDataPolicyV1, string, string]> = [
  ["sendToExternal", "允许发送到外部模型服务", "关闭后，内容不会发送给外部模型服务。"],
  ["sendImageContent", "允许发送图片内容", "只影响图片类素材；关闭后图片留在本机。"],
  ["piiDetection", "外发前做个人信息检测", "在内容离开本机前先标记可能的个人信息。"],
  ["auditLogging", "记录 AI 审计日志", "每次外发都留下可追溯的记录，供你回看。"],
];

export const AUDIT_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  note_content: "笔记正文",
  user_answer: "你的回答",
  question: "题目",
  claim: "结论",
  quote: "原文引用",
};

export const AUDIT_STATUS_LABELS: Readonly<Record<DesktopAiAuditItemV1["status"], string>> = {
  success: "已完成",
  failed: "没成功",
  blocked: "被拦下",
};

/* —— 空间那一行右上角那句身份说明（角色 + 类型）。原在页面里，现由「我的空间」那一组直接引用，不用把字重抄一遍 —— */
export function spaceRoleTypeLine(role: WorkspaceSummaryV1["role"], type: WorkspaceSummaryV1["workspaceType"]): string {
  return `${role === "owner" ? "Owner" : "Member"} · ${spaceTypeLabel(type)}`;
}

export function spaceTypeLabel(type: WorkspaceSummaryV1["workspaceType"] | undefined): string {
  if (!type) return "—";
  return type === "personal" ? "个人空间" : "协作空间";
}

/* 设置页的日/夜预览使用同页的原始场景图，与 taskPosters.system 对应。 */
export const THEME_PLATES: Readonly<Record<"day" | "night", string>> = {
  day: `${LEARNING_ROOM_ASSET_BASE_PATH}/posters/task-scenes/companion-system-day-v1.png`,
  night: `${LEARNING_ROOM_ASSET_BASE_PATH}/posters/task-scenes/companion-system-night-v1.png`,
};

/* —— 几个「还没读到 / 读到了多少」的小句子。它们被作答方式与声音两块共用，
   放在页面里就等于让下一个人猜「还有别处用吗」—— */
export function pendingReadLine(read: boolean): string {
  return read ? "未读到" : "读取中…";
}

export function percentLine(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export const formatVoiceTime = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export function voicePlayerLine(player: { readonly name: string } | null): string {
  return player ? `正在试听：${player.name}` : "还没有试听过";
}

/* —— 合成引擎那几档（跟着账号走，不跟空间走）—— */
export const TTS_ENGINE_OPTIONS: ReadonlyArray<readonly [TtsEngineV1, string]> = [
  ["qwen", "千问"],
  ["edge", "Edge-TTS"],
];

/* —— 音色清单与「切引擎时该选哪条音色」的规则 —— */
export function voicesForEngine(engine: TtsEngineV1 | undefined): typeof QWEN_TTS_VOICE_OPTIONS {
  return engine === "qwen" ? QWEN_TTS_VOICE_OPTIONS : engine === "edge" ? EDGE_TTS_VOICE_OPTIONS : [];
}

export const ttsDefaultVoiceFor = (engine: TtsEngineV1): string =>
  engine === "qwen" ? QWEN_TTS_VOICE_OPTIONS[0].voice : EDGE_TTS_VOICE_OPTIONS[0].voice;

/* —— 音色行上那枚「在用」的标记（两处：能力清单与音色清单）—— */
export const VOICE_IN_USE_TAG = "在用";

/* —— 作答方式那三档（账号级偏好，跨设备一致）—— */
export const ANSWER_MODE_OPTIONS: ReadonlyArray<readonly [CompanionAnswerModePreferenceV1["preference"], string]> = [  ["any", "跟随安排"],
  ["voice", "语音"],
  ["silent", "静默结构"],
  ["text", "文字"],
];
