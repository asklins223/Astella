/**
 * 伴星能力那两行：模型在本机的加载状态、以及伴星读取/外发那一条。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 36 行、8 个外部符号。`actionReason` / `featureReason` / `nativeReason` 三个
 * 「为什么这一档是这一档」的说明函数，以及 `live2dStatusLabel` 都随它进来或直接引用——
 * 理由**只有这一处消费**，放在页面里就等于让下一个人猜「这几个函数还有别处用吗」。
 *
 * ⚠️ 那条注释是这一块的一部分：伴星形态的切换入口**在别处**（伴星快捷设置 → 伴星设置，
 * 2026-09-20 用户裁决），这里只留本机加载状态。别因为"这里也能改"就把入口搬回来。
 *
 * 硬约束（`AGENTS.md`）：模型不可用时伴星会隐藏，但**那要在伴星那一侧处理并就地说明**——
 * 这里只报事实，不改成"重新加载"那颗按钮。
 */
import type { ReactElement } from "react";
import { AudioLines, MessageCircle, MessagesSquare, Mic, Sparkles } from "lucide-react";
import { SettingRow } from "./settings-primitives.tsx";
import type { CapabilityProjectionV1 } from "@ailearn/shared/desktop-ipc-contracts";

type Live2dStatus = "ready" | "loading" | "unavailable";

export type ActionCapabilityValue = CapabilityProjectionV1["actionCapabilities"][keyof CapabilityProjectionV1["actionCapabilities"]];
export type NativeCapabilityValue = CapabilityProjectionV1["nativeCapabilities"][keyof CapabilityProjectionV1["nativeCapabilities"]];

export function actionReason(value: ActionCapabilityValue | undefined): string {
  if (!value) return "这一项还没拿到答复。";
  if (value === "allowed") return "已经允许。";
  if (value === "conditional") return "满足条件时才允许，由系统按当前情况判断。";
  return "当前不允许。伴星相关能力由工作区 AI 同意与数据外发策略决定，管理类能力由角色决定。";
}

export function featureReason(state: string | undefined, reason: string | undefined): string {
  if (!state) return "这一项还没拿到答复。";
  if (state === "enabled") return "这条链路已经启用。";
  if (state === "conditional") return "按条件启用。";
  return reason === "error.feature_disabled"
    ? "部署时没有打开这条链路。"
    : "这一项当前不可用。";
}

export function nativeReason(value: NativeCapabilityValue | undefined): string {
  if (!value) return "还没有读到本机能力。";
  return value === "available"
    ? "这台设备上的客户端已接入这条链路。"
    : "桌面端还没有接入这条链路：能力值由主进程按真实存在的通道计算，不是权限被拒绝。";
}

/**
 * One chip for every permission the projection reports. The gateway answers with
 * a three-way grant or a native availability, never a boolean, so the chip says
 * which of those it is instead of collapsing them into allowed / denied.
 */
/** 那一枚芯片写的状态词（`null`＝屏上是一个破折号，还没有读数）。 */
export function capabilityChipLabel(
  kind: "action" | "native" | "feature",
  value: ActionCapabilityValue | NativeCapabilityValue | undefined,
): string | null {
  if (!value) return null;
  // 本机能力为 unavailable 时，含义是「客户端没有这条链路」，而不是「权限被拒」。
  return kind === "native"
    ? (value === "available" ? "已接入" : "未接入")
    : kind === "feature"
      ? (value === "enabled" ? "已开启" : value === "conditional" ? "按条件" : value === "disabled" ? "已关闭" : "暂不可用")
      : (value === "allowed" ? "已允许" : value === "conditional" ? "按条件" : "未允许");
}

export function CapabilityChip({ value, kind = "action", reason }: {
  readonly value: ActionCapabilityValue | NativeCapabilityValue | undefined;
  readonly kind?: "action" | "native" | "feature";
  /** 悬停说明：为什么是当前这个状态。 */
  readonly reason?: string;
}) {
  if (!value) return <span className="tag" title={reason} aria-label={`状态未知：${reason ?? "尚未读取"}`}>—</span>;
  const on = value === "allowed" || value === "available" || value === "enabled";
  return <span className={on ? "tag green" : "tag"} title={reason} aria-label={`${capabilityChipLabel(kind, value)}：${reason ?? ""}`}>{capabilityChipLabel(kind, value)}</span>;
}

export function live2dStatusLabel(status: Live2dStatus): string {
  return status === "ready" ? "已加载" : status === "loading" ? "加载中" : "不可用";
}

export function SettingsCompanionStatus(props: {
  readonly live2dStatus: Live2dStatus;
  readonly capabilities: CapabilityProjectionV1 | null;
  readonly companion: CapabilityProjectionV1["actionCapabilities"] | undefined;
  readonly features: CapabilityProjectionV1["featureAvailability"] | null;
  readonly actionReason: (value: ActionCapabilityValue | undefined) => string;
  readonly featureReason: (state: string | undefined, reason: string | undefined) => string;
  readonly nativeReason: (value: NativeCapabilityValue | undefined) => string;
}): ReactElement {
  const {
    live2dStatus, capabilities, companion, features,
    featureReason, nativeReason,
  } = props;
  return (
<div className="settings-rows settings-rows--split">
  {/* 伴星形态的切换入口在伴星快捷设置（「更多功能」→ 伴星设置），2026-09-20 用户裁决；
      这里只保留本机加载状态。 */}
  <SettingRow mark={<Sparkles size={15} />} title="模型状态" detail="当前形态的模型在本机的加载状态。">
    <span
      className={live2dStatus === "ready" ? "tag green" : "tag"}
      title={live2dStatus === "ready"
        ? "模型已在本机加载完成。"
        : live2dStatus === "loading"
          ? "模型正在加载，完成后这里会变为已加载。"
          : "模型、许可或 WebGL 不可用；伴星形象会隐藏并就地给出说明。"}
    >
      {live2dStatusLabel(live2dStatus)}
    </span>
  </SettingRow>
  <SettingRow mark={<MessageCircle size={15} />} title="实时对话" detail="完整对话是否写入由系统开关决定。">
    <CapabilityChip value={companion?.["companion.sendMessage"]} reason={actionReason(companion?.["companion.sendMessage"])} />
  </SettingRow>
  <SettingRow mark={<MessagesSquare size={15} />} title="对话能力" detail="伴星对话链路的启用状态。">
    <CapabilityChip
      kind="feature"
      value={features?.companion_dialogue_v1.state}
      reason={featureReason(features?.companion_dialogue_v1.state, features?.companion_dialogue_v1.reason)}
    />
  </SettingRow>
  <SettingRow mark={<Mic size={15} />} title="本机语音识别" detail="不可用时自动回落到文字输入。">
    <CapabilityChip kind="native" value={capabilities?.nativeCapabilities.asr} reason={nativeReason(capabilities?.nativeCapabilities.asr)} />
  </SettingRow>
  <SettingRow mark={<AudioLines size={15} />} title="语音对话" detail="语音能力由系统开关决定。">
    <CapabilityChip
      kind="feature"
      value={features?.companion_voice_dialogue_v1.state}
      reason={featureReason(features?.companion_voice_dialogue_v1.state, features?.companion_voice_dialogue_v1.reason)}
    />
  </SettingRow>
</div>
  );
}
