/**
 * 设置页「更新」那一组。
 *
 * ## 更新从哪里来
 *
 * GitHub Releases。检查走 `api.github.com`，安装包走 GitHub 的 CDN——
 * **不经过自家服务端**，所以更新带宽不落在 apps/api 上，自家 API 挂掉也不影响升级。
 *
 * ## 三句话必须分清
 *
 * 这个面板最要紧的不是进度条，是**别把三件不同的事说成同一句**：
 *
 * - `upToDate`　　已经是最新。
 * - `unreachable` 这次**没问到**（断网 / GitHub 匿名限额 60 次·小时·IP）。
 *                这不是"更新坏了"，语气应该平，给一个"再试一次"就够了。
 * - `failed`　　　更新**真的坏了**（校验不过、装不上）。这时候才该用 error 语气。
 *
 * 另有一件要提前说的事：macOS 上未签名的包，Squirrel.Mac 不允许自动替换应用
 * （它校验新旧两个 .app 的代码签名是否同一开发者）。主进程会把这个事实带过来，
 * 这里提前说明，而不是让用户点完"重启安装"再撞上一个没头没尾的失败。
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Download, RefreshCw, Sparkles } from "lucide-react";

import { SettingRow } from "./settings-primitives.tsx";
import { createRequestMeta } from "../../../app/desktop-client";
import type { UpdateStateV1 } from "@ailearn/shared/desktop-ipc-contracts";

const IDLE_STATE: UpdateStateV1 = {
  phase: "idle",
  currentVersion: "",
  availableVersion: null,
  releaseNotes: null,
  releaseUrl: null,
  percent: null,
  transferred: null,
  total: null,
  message: null,
  installBlockedReason: null,
  checkedAt: null,
};

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 下载态要给**真实**字节数。慢连接下 percent 会长时间停在 0，只报百分比就是在演动画。 */
function downloadLine(state: UpdateStateV1): string | null {
  if (state.phase !== "downloading") return null;
  const percent = state.percent ?? 0;
  if (state.transferred !== null && state.total !== null && state.total > 0) {
    return `正在下载 ${percent}%　${megabytes(state.transferred)} / ${megabytes(state.total)}`;
  }
  return `正在下载 ${percent}%`;
}

export function SettingsUpdateGroup(props: {
  /** 主进程推来的最新状态；渲染层只读它，不自己推导相位。 */
  readonly state: UpdateStateV1;
  readonly busy: boolean;
  readonly onCheck: () => void;
  readonly onDownload: () => void;
  readonly onInstall: () => void;
}): ReactElement {
  const { state, busy, onCheck, onDownload, onInstall } = props;

  const progressLine = downloadLine(state);
  const hasUpdate = state.phase === "available" || state.phase === "downloading" || state.phase === "ready";
  const blocked = state.installBlockedReason === "macosUnsigned";

  return (
    <section className="settings-group">
      <h3 className="settings-group__title">更新</h3>
      <div className="settings-rows">
        <SettingRow
          title="客户端更新"
          detail={describe(state)}
        >
          <button type="button" className="button" onClick={onCheck} disabled={busy || state.phase === "checking"}>
            <RefreshCw size={14} aria-hidden="true" />
            {state.phase === "checking" ? "正在检查…" : "检查更新"}
          </button>
        </SettingRow>

        {hasUpdate && state.availableVersion ? (
          <SettingRow
            title={`新版本 ${state.availableVersion}`}
            detail={state.releaseNotes ?? "这个版本没有写更新说明。"}
          >
            {state.phase === "ready" ? (
              <button type="button" className="button primary" onClick={onInstall} disabled={busy || blocked}>
                <Download size={14} aria-hidden="true" />
                重启并安装
              </button>
            ) : state.phase === "downloading" ? (
              <span className="settings-update__progress" role="status">{progressLine}</span>
            ) : (
              <button type="button" className="button" onClick={onDownload} disabled={busy}>
                <Download size={14} aria-hidden="true" />
                下载更新
              </button>
            )}
          </SettingRow>
        ) : null}

        {state.phase === "downloading" && state.percent !== null ? (
          <div className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
            <div className="settings-progress__fill" style={{ width: `${state.percent}%` }} />
          </div>
        ) : null}

        {blocked ? (
          <p className="settings-note" role="status">
            这份 macOS 安装包没有代码签名，系统不允许应用自己替换自己。到
            <a
              href={state.releaseUrl ?? undefined}
              onClick={(event) => {
                event.preventDefault();
                if (state.releaseUrl) window.ailearn.shell.openExternal({ meta: createRequestMeta(), request: { url: state.releaseUrl } });
              }}
            >下载页</a>
            手动安装，装好后把旧的那一份删掉即可。
          </p>
        ) : null}

        {state.phase === "failed" && state.message ? (
          <p className="settings-note settings-note--error" role="alert">{state.message}</p>
        ) : null}

        {state.phase === "unreachable" && state.message ? (
          <p className="settings-note" role="status">
            暂时没拿到新版本信息（网络不通，或 GitHub 的查询次数用完了）。{state.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 一句话把当前相位说清楚。措辞跟着 phase 走，别让"没问到"听起来像"坏了"。
 *
 * 版本号放在这里而不是标题里：这一屏的行标题要登记给伴星读（settings-surface 的
 * 行账本会核对），标题若随版本号变化，那份登记每次发版都会整条抖动。
 */
function describe(state: UpdateStateV1): string {
  const version = state.currentVersion ? `当前版本 ${state.currentVersion}。` : "";
  switch (state.phase) {
    case "checking":
      return `${version}正在向 GitHub 查询有没有新版本。`;
    case "upToDate":
      return `${version}已经是最新版本。`;
    case "available":
      return `${version}有可安装的新版本。`;
    case "downloading":
      return `${version}正在下载新版本，下载完可以重启安装。`;
    case "ready":
      return `${version}新版本已下载完，重启即可安装。`;
    case "unreachable":
      return `${version}这次没能查到更新信息，稍后可以再试。`;
    case "failed":
      return `${version}${state.message ?? "更新没能完成。"}`;
    case "idle":
    default:
      return `${version}更新从 GitHub Releases 下载，不经过本项目的服务器。`;
  }
}

/**
 * 把主进程推来的更新状态接过来。
 *
 * 单独抽成 hook 是为了让设置面板只管摆位：订阅、退订、首次取快照这三件事
 * 与界面无关，而且**必须**在卸载时退订——否则每次进出设置页都会多挂一个监听。
 */
export function useUpdateStatus(): {
  readonly state: UpdateStateV1;
  readonly busy: boolean;
  readonly check: () => void;
  readonly download: () => void;
  readonly install: () => void;
} {
  const [state, setState] = useState<UpdateStateV1>(IDLE_STATE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // `ailearnDesktop` 在浏览器预览（无 preload）下是 undefined；那里没有主进程，
    // 也就没有更新可言，保持 idle 即可，不要抛。
    const bridge = window.ailearnDesktop;
    if (!bridge) return;
    return bridge.onUpdateState(setState);
  }, []);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }, []);

  const check = useCallback(() => {
    void run(async () => {
      const result = await window.ailearn.update.check({ meta: createRequestMeta(), userInitiated: true });
      if (result.ok) setState(result.data);
    });
  }, [run]);

  const download = useCallback(() => {
    void run(async () => {
      const result = await window.ailearn.update.download({ meta: createRequestMeta() });
      if (result.ok) setState(result.data);
    });
  }, [run]);

  const install = useCallback(() => {
    void run(async () => {
      const result = await window.ailearn.update.install({ meta: createRequestMeta() });
      if (result.ok) setState(result.data);
    });
  }, [run]);

  return { state, busy, check, download, install };
}

/** 设置页顶部那枚"有新版"的小标记，复用同一份状态，不另开一条订阅。 */
export function UpdateBadge(props: { readonly state: UpdateStateV1 }): ReactElement | null {
  const { state } = props;
  if (state.phase !== "available" && state.phase !== "ready") return null;
  return (
    <span className="settings-update-badge" role="status">
      <Sparkles size={13} aria-hidden="true" />
      {state.phase === "ready" ? "新版本已就绪" : "有新版本"}
    </span>
  );
}