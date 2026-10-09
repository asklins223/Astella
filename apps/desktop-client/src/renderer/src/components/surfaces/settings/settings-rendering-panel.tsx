import { useEffect, useState } from "react";
import type { DesktopRenderingMode, DesktopRenderingState } from "../../../../../shared/desktop-rendering";
import { SettingRow, SettingsInlineState } from "./settings-primitives";
import { HudSwitch } from "../../hud/HudControls";

const failureCopy: Record<NonNullable<DesktopRenderingState["automaticFallbackReason"]>, string> = {
  "gpu-process-failed": "检测到图形进程异常，已自动保存兼容模式",
  "webgl-context-lost": "检测到伴星画布异常，已自动保存兼容模式",
};

/** A device setting: never sent to the workspace or synced to another Mac. */
export function SettingsRenderingGroup() {
  const [state, setState] = useState<DesktopRenderingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const api = window.astellaDesktop?.rendering;
  const supportedPlatform = window.astellaDesktop?.platform === "darwin";
  useEffect(() => {
    if (!api || !supportedPlatform) return;
    let active = true;
    let receivedUpdate = false;
    setFailure(null);
    const unsubscribe = api.onStateChanged(value => {
      receivedUpdate = true;
      if (active) { setState(value); setFailure(null); }
    });
    void api.getState().then(value => { if (active && !receivedUpdate) setState(value); })
      .catch(() => { if (active && !receivedUpdate) setFailure("暂时无法读取这台设备的渲染设置。"); });
    return () => { active = false; unsubscribe(); };
  }, [api, epoch, supportedPlatform]);

  if (!api || !supportedPlatform || state?.supported === false) return null;
  const apply = async (mode: DesktopRenderingMode) => {
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      setState(await api.setMode(mode));
    } catch {
      setFailure("渲染设置没有保存成功，请再试一次。");
    } finally { setBusy(false); }
  };
  return <section className="settings-group">
    <h3 className="settings-group__title">画面与滚动</h3>
    <div className="settings-rows">
      <SettingRow title="渲染兼容模式" detail="使用软件合成避开滚动闪烁，伴星保留硬件绘制。只影响这台 Mac，下一次启动生效，可能增加 CPU 开销。">
        <HudSwitch label="渲染兼容模式" checked={state?.configuredMode === "compatible"}
          disabled={!state || busy} onChange={() => void apply(state?.configuredMode === "compatible" ? "default" : "compatible")} />
      </SettingRow>
    </div>
    {state?.automaticFallbackReason ? <div className="settings-inline-state" role="status">
      <span>
        <b>{failureCopy[state.automaticFallbackReason]}</b>
        <small>可以用上方开关恢复默认渲染。</small>
      </span>
    </div> : null}
    {state?.restartRequired ? <SettingsInlineState title="已保存，下次启动生效"
      detail="请先保存正在编辑的笔记，再退出并重新打开拾星笔记。" />
      : state ? <p className="settings-group__note">{state.activeMode === "compatible"
        ? "当前正在使用兼容模式。系统更新后，可以关闭它再重新打开应用。"
        : "当前使用默认渲染。检测到图形进程或伴星画布异常时，会自动保存兼容模式。"}</p> : null}
    {failure ? <SettingsInlineState title={state ? "设置未保存" : "设置暂时不可用"} detail={failure} tone="error"
      onRetry={() => { if (state) void apply(state.configuredMode === "compatible" ? "default" : "compatible"); else setEpoch(value => value + 1); }} /> : null}
  </section>;
}
