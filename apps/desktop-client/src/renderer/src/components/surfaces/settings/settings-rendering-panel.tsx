import { useEffect, useState } from "react";
import type { DesktopRenderingMode, DesktopRenderingState } from "../../../../../shared/desktop-rendering";
import { SettingRow, SettingsInlineState } from "./settings-primitives";
import { HudSwitch } from "../../hud/HudControls";

const failureCopy: Record<NonNullable<DesktopRenderingState["suggestedFallbackReason"]>, string> = {
  "gpu-process-failed": "图形进程在这台 Mac 上异常退出过",
  "webgl-context-lost": "伴星画布的 WebGL 上下文丢失过",
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
  const dismiss = async () => {
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      setState(await api.dismissFallbackSuggestion());
    } catch {
      setFailure("这条提示没有关掉，请再试一次。");
    } finally { setBusy(false); }
  };
  const suggestion = state?.suggestedFallbackReason && state.configuredMode !== "compatible"
    ? state.suggestedFallbackReason : null;
  return <section className="settings-group">
    <h3 className="settings-group__title">画面与滚动</h3>
    <div className="settings-rows">
      <SettingRow title="渲染兼容模式" detail="换用较早的页面绘制路径。只影响这台 Mac，下一次启动生效，伴星和页面仍使用硬件加速。">
        <HudSwitch label="渲染兼容模式" checked={state?.configuredMode === "compatible"}
          disabled={!state || busy} onChange={() => void apply(state?.configuredMode === "compatible" ? "default" : "compatible")} />
      </SettingRow>
    </div>
    {/* 图形异常只换来一次询问，不换来一次替用户做的决定：备用路径并没有被证明更便宜。 */}
    {suggestion ? <div className="settings-inline-state" role="status">
      <span>
        <b>{failureCopy[suggestion]}</b>
        <small>如果画面出现闪烁或丢内容，可以改用兼容渲染试一次；切换在下一次启动生效。</small>
      </span>
      <button type="button" className="button" disabled={busy} onClick={() => void apply("compatible")}>改用兼容渲染</button>
      <button type="button" className="text-action" disabled={busy} onClick={() => void dismiss()}>不用了</button>
    </div> : null}
    {state?.restartRequired ? <SettingsInlineState title="已保存，下次启动生效"
      detail="请先保存正在编辑的笔记，再退出并重新打开拾星笔记。" />
      : state ? <p className="settings-group__note">{state.activeMode === "compatible"
        ? "当前正在使用兼容模式。系统更新后，可以关闭它再重新打开应用。"
        : "当前使用默认渲染。"}</p> : null}
    {failure ? <SettingsInlineState title={state ? "设置未保存" : "设置暂时不可用"} detail={failure} tone="error"
      onRetry={() => { if (state) void apply(state.configuredMode === "compatible" ? "default" : "compatible"); else setEpoch(value => value + 1); }} /> : null}
  </section>;
}
