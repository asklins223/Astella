/**
 * 门禁页底部那一行客户端版本与更新入口。
 *
 * ## 为什么在未登录的这一屏也要有
 *
 * 注册现在强制邮箱验证码，**旧客户端根本注册不了**——它需要的不是"再试一次"，
 * 而是先把自己换掉。拒绝的话由服务端说（`client_update_required`），
 * 而"去哪儿换"必须在这一屏就能点到，否则人被挡在门外还要自己去翻下载页。
 *
 * ## 只读一份状态
 *
 * 数据源是 app 级 store `useUpdateStatus`（主进程那条 `UPDATE_STATE_CHANNEL`
 * 的唯一订阅点在 `use-update-notifications.ts`，这里额外挂一次是为了门禁期间
 * 也能收到下载进度——两处都走同一个 `accept`，不会分叉出第二份真相）。
 * 相位文案与设置页那组「客户端更新」同源：`checking / upToDate / available /
 * downloading / ready / unreachable / failed` 各说各的话，不拿"检查失败"
 * 冒充"已是最新"。
 */
import { useEffect } from "react";
import { Download, RefreshCw } from "lucide-react";
import { hasActionableUpdate, useUpdateStatus } from "../app/update-status";

export function GateUpdateRow() {
  const { state, checking, downloading, installing, check, download, install } = useUpdateStatus();

  // 进这一屏自动查一次；主进程那边有 6 小时缓存与上次结果打底，
  // 不会因此每次都打对端。
  useEffect(() => {
    void check();
  }, [check]);

  const versionLabel = state.currentVersion ? `v${state.currentVersion}` : "版本未知";

  if (hasActionableUpdate(state) && state.availableVersion) {
    if (state.phase === "ready") {
      return (
        <p className="desktop-access-gate__update" data-update-state="ready">
          <span>新版本 v{state.availableVersion} 已下载好</span>
          <button type="button" onClick={() => void install()} disabled={installing}>
            <Download size={14} aria-hidden="true" />
            {installing ? "正在准备…" : "重启并安装"}
          </button>
        </p>
      );
    }
    if (state.phase === "downloading") {
      return (
        <p className="desktop-access-gate__update" data-update-state="downloading" role="status">
          <span>v{state.availableVersion} 正在下载 {state.percent ?? 0}%</span>
          <span className="desktop-access-gate__update-version">{versionLabel}</span>
        </p>
      );
    }
    return (
      <p className="desktop-access-gate__update" data-update-state="available">
        <span>发现新版本 v{state.availableVersion}</span>
        <button type="button" onClick={() => void download()} disabled={downloading}>
          <Download size={14} aria-hidden="true" />
          {downloading ? "正在下载…" : "下载更新"}
        </button>
      </p>
    );
  }

  return (
    <p className="desktop-access-gate__update" data-update-state={state.phase}>
      <span className="desktop-access-gate__update-version">{versionLabel}</span>
      <button type="button" onClick={() => void check()} disabled={checking || state.phase === "checking"}>
        <RefreshCw size={14} aria-hidden="true" />
        {checking || state.phase === "checking" ? "检查中…" : "检查更新"}
      </button>
      {state.phase === "upToDate" ? <span className="desktop-access-gate__update-hint">已是最新</span> : null}
      {state.phase === "unreachable" ? <span className="desktop-access-gate__update-hint">这次没查到</span> : null}
    </p>
  );
}
