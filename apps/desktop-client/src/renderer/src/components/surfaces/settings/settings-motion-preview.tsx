import { Leaf } from "lucide-react";
import { useRoomStore } from "../../../app/room-store";

export function SettingsMotionPreview() {
  const motion = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const detail = reduced ? "系统已开启减少动态，物件会直接就位，操作仍然即时响应。"
    : motion === "off" ? "现在关闭了动效，切换与按压会直接呈现结果。"
    : motion === "lite" ? "轻量模式收敛回弹，让操作安静、平稳地接续。"
    : "按住这枚叶子再松开，感受一下柔软的回弹。";
  return <div className="settings-motion-preview">
    <button type="button" className="settings-motion-preview__leaf" data-settings-bounce aria-label="试试回弹"><Leaf size={26} aria-hidden="true" /></button>
    <div><strong>试试书房的手感</strong><p>{detail}</p></div>
  </div>;
}
