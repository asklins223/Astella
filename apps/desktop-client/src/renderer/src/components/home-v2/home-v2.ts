import type { MotionMode } from "../../app/room-machine";
import { LIGHTHOUSE_HOME_SCENE_PROFILE } from "./home-scene-profile";

export type HomeV2Zone = "wide" | "desk" | "shelf" | "window" | "rest";

export type HomeV2CameraPreset = {
  readonly scale: number;
  readonly xPercent: number;
  readonly yPercent: number;
};

export const HOME_V2_CAMERA_PRESETS: Readonly<Record<HomeV2Zone, HomeV2CameraPreset>> =
  LIGHTHOUSE_HOME_SCENE_PROFILE.cameraPresets;

export function homeV2CameraDuration(mode: MotionMode): number {
  if (mode === "off") return 0;
  if (mode === "lite") return 0.22;
  return 0.48;
}

export function homeV2CameraCss(preset: HomeV2CameraPreset) {
  return {
    "--scene-camera-scale": preset.scale,
    "--scene-camera-x-percent": `${preset.xPercent}%`,
    "--scene-camera-y-percent": `${preset.yPercent}%`,
  } as const;
}

/**
 * 房间里该不该有声音。
 *
 * 首页曾经有一层常驻的环境音床，这条闸门是为它写的；2026-10-06 那层删掉之后，
 * 它管的是房间自己发出的瞬态音（翻页、脚步、魔法）和伴星的主动提示音。名字
 * 跟着职责走，别再叫 ambient——`home-audio-idle` 钉住的是"没有常驻音源"。
 */
export function shouldPlayHomeV2Feedback(input: {
  readonly unlocked: boolean;
  readonly masterMuted: boolean;
  readonly surfaceOpen: boolean;
  readonly windowVisible: boolean;
}): boolean {
  return input.unlocked
    && !input.masterMuted
    && !input.surfaceOpen
    && input.windowVisible;
}

/**
 * 用户亲口问出来的那条回复该不该出声。
 *
 * 与上面那条闸门只差一件事：**不看窗口可见性**。被别的程序整块盖住（Chromium 把这
 * 报成 `document.hidden`）不是取消这句回答的理由——她人在屏幕外，话还是她的。
 * 2026-10-09 之前可见性并在这条判断里，失焦那一刻整个 AudioContext 被挂起，
 * 念到一半的句子直接断掉。
 *
 * 没解锁与总静音仍然挡住：那是用户明确要的安静，不是"暂时看不见"。
 */
export function shouldPlayCompanionReplyVoice(input: {
  readonly unlocked: boolean;
  readonly masterMuted: boolean;
}): boolean {
  return input.unlocked && !input.masterMuted;
}
