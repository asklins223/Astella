import { useEffect, useState } from "react";
import type { DesktopRenderingState } from "../../../../../shared/desktop-rendering";
import { SettingRow, SettingsInlineState } from "./settings-primitives";
import { HudSwitch } from "../../hud/HudControls";

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
  const change = async () => {
    if (!state || busy) return;
    setBusy(true); setFailure(null);
    try {
      setState(await api.setMode(state.configuredMode === "compatible" ? "default" : "compatible"));
    } catch {
      setFailure("渲染设置没有保存成功，请再试一次。");
    } finally { setBusy(false); }
  };
  return <section className="settings-group">
    <h3 className="settings-group__title">画面与滚动</h3>
    <div className="settings-rows">
      <SettingRow title="渲染兼容模式" detail="检测到图形故障时会自动开启，也可手动开启。只影响这台 Mac，伴星和页面仍使用硬件加速。">
        <HudSwitch label="渲染兼容模式" checked={state?.configuredMode === "compatible"}
          disabled={!state || busy} onChange={() => void change()} />
      </SettingRow>
    </div>
    {state?.restartRequired ? <SettingsInlineState title={state.automaticFallbackReason ? "已检测到图形异常，下次启动自动使用兼容模式" : "已保存，下次启动生效"}
      detail="请先保存正在编辑的笔记，再退出并重新打开拾星笔记。" />
      : state ? <p className="settings-group__note">{state.activeMode === "compatible"
        ? state.automaticFallbackReason ? "已因图形异常自动启用兼容模式。系统更新后，可以关闭它再重新打开应用。" : "当前正在使用兼容模式。系统更新后，可以关闭它再重新打开应用。"
        : "当前使用默认渲染，检测到图形故障时会自动启用兼容模式。"}</p> : null}
    {failure ? <SettingsInlineState title={state ? "设置未保存" : "设置暂时不可用"} detail={failure} tone="error"
      onRetry={() => { if (state) void change(); else setEpoch(value => value + 1); }} /> : null}
  </section>;
}
