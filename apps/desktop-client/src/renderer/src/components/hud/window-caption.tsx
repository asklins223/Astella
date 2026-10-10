import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AstellaWindowAction, AstellaWindowFrame } from "../../../../shared/window-frame";

/**
 * Windows 的无边框窗口没有原生标题按钮，最小化 / 最大化 / 关闭由这里画。
 * 只在 win32 挂载（主进程用 `frame: false` 换逐像素透明，才裁得出圆角）；
 * macOS 仍是红绿灯，Linux 仍是系统标题栏。
 */
export function WindowCaption() {
  const [frame, setFrame] = useState<AstellaWindowFrame>("floating");

  useEffect(() => window.astellaDesktop?.onWindowFrame?.(setFrame), []);

  useEffect(() => {
    // 圆角要裁到视口（portal 到 body 的整屏浮层跟着裁），所以形状记在文档根上。
    document.documentElement.dataset.windowFrame = frame;
  }, [frame]);

  const send = (action: AstellaWindowAction) => () => window.astellaDesktop?.controlWindow?.(action);
  const maximized = frame === "maximized";

  return (
    <div className="window-caption" data-window-frame={frame}>
      <button type="button" className="window-caption__button" onClick={send("minimize")} title="最小化" aria-label="最小化">
        <Minus size={14} />
      </button>
      <button
        type="button"
        className="window-caption__button"
        onClick={send("toggle-maximize")}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
      >
        {maximized ? <Copy size={13} /> : <Square size={13} />}
      </button>
      <button type="button" className="window-caption__button window-caption__button--close" onClick={send("close")} title="关闭" aria-label="关闭">
        <X size={14} />
      </button>
    </div>
  );
}
