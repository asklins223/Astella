/**
 * 设置页「数据与维护」最上面那一组：客户端更新。
 *
 * ## 为什么放在这一组的**最上面**
 *
 * 用户进这一页，多半是冲着"这个应用是不是该更新了"来的——它排在
 * 「空间内容」和「导出与归档」之前，是这一页真正的**第一件事**；把统计和导出压在
 * 下面，符合"先处理会影响你继续用下去的事，再处理数据"的次序。
 *
 * ## 更新从哪里来
 *
 * GitHub Releases。检查走 `api.github.com`，安装包走 GitHub 的 CDN——
 * **不经过自家服务端**，所以更新带宽不落在 apps/api 上，自家 API 挂掉也不影响升级。
 *
 * ## 有新版本时要说清三件事
 *
 * 只给一个版本号是不够的——用户真正在决定的是"值不值得现在中断手头的事"：
 *
 *   · **改了什么**（releaseName / releaseNotes）
 *   · **什么时候发的**（releaseDate）
 *   · **要下多少**（fileSize）
 *
 * 三样都取自 electron-updater 给的 `UpdateInfo`（`latest.yml` / `latest-mac.yml`
 * 里 electron-builder 写下的），不另造数据源。取不到就**不显示那一行**，不留
 * 破折号或"0 MB"占位——缺信息比假信息好。
 *
 * ## 三句话必须分清
 *
 * - `upToDate`　　已经是最新。
 * - `unreachable` 这次**没问到**（断网 / GitHub 匿名限额 60 次·小时·IP）。
 *                这不是"更新坏了"，语气应该平，给一个"再试一次"就够了。
 * - `failed`　　　更新**真的坏了**（校验不过、装不上）。这时候才该用 error 语气。
 *
 * 另有一件要提前说的事：macOS 上未签名的包，Squirrel.Mac 不允许自动替换应用
 * （它校验新旧两个 .app 的代码签名是否同一开发者）。主进程会把这个事实带过来，
 * 这里提前说明，而不是让用户点完「重启安装」再撞上一个没头没尾的失败。
 */
import type { ReactElement } from "react";
import { CalendarClock, Download, HardDrive, RefreshCw, Sparkles } from "lucide-react";

import { SettingRow } from "./settings-primitives.tsx";
import { createRequestMeta } from "../../../app/desktop-client";
import { hasActionableUpdate } from "../../../app/update-status";
import type { UpdateStateV1 } from "@ailearn/shared/desktop-ipc-contracts";

function megabytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 发布时刻 → 「2026-10-04」这样的日期。
 *
 * 只取日期不取时刻：更新是什么时候发布的，分钟级精度对用户没有意义，反而显得在
 * 假装精确。解析失败返回 null（那一行就不显示），不把 Invalid Date 打到屏幕上。
 */
function releaseDay(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function describe(state: UpdateStateV1): string {
  const version = state.currentVersion ? `当前版本 ${state.currentVersion}。` : "";
  switch (state.phase) {
    case "checking":
      return `${version}正在向 GitHub 查询有没有新版本。`;
    case "upToDate":
      return `${version}已经是最新版本。`;
    case "available":
      return `${version}有新版本可以下载。`;
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

/** 下载中的进度行。真实字节数，不是只有百分比——慢连接下百分比会长时间停在 0。 */
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
  const hasUpdate = hasActionableUpdate(state);
  const blocked = state.installBlockedReason === "macosUnsigned";
  const day = releaseDay(state.releaseDate);
  // 「这次更新」这一行只显示**标题**。没有标题时说明文字落在上面那行的 detail 里
  // ——两处都显示就是同一段话在屏上出现两次。标题与 notes 至多显示一处。
  const metaNotes = state.releaseName;
  const size = state.fileSize !== null && state.fileSize > 0 ? megabytes(state.fileSize) : null;

  return (
    <section className="settings-group settings-group--update">
      <h3 className="settings-group__title">客户端更新</h3>
      <div className="settings-rows">
        <SettingRow title="当前版本" detail={describe(state)}>
          <button type="button" className="button" onClick={onCheck} disabled={busy || state.phase === "checking"}>
            <RefreshCw size={14} aria-hidden="true" />
            {state.phase === "checking" ? "正在检查…" : "检查更新"}
          </button>
        </SettingRow>

        {hasUpdate && state.availableVersion ? (
          // detail 只在没有标题时才用 notes：有标题的话 notes 会在下面的元信息块里
          // 完整出现，行里再抄一遍就是同一段话在屏上出现两次。
          <SettingRow
            title={`新版本 ${state.availableVersion}`}
            detail={state.releaseName ? undefined : (state.releaseNotes ?? undefined)}
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

        {hasUpdate && (metaNotes || day || size) ? (
          // 有新版才出现这一块：改了什么 / 什么时候发的 / 要下多少。
          // 三样都缺就不渲染——空块比没有块更让人以为"有信息但没显示出来"。
          <dl className="settings-update__meta">
            {metaNotes ? (
              <>
                <dt><Sparkles size={13} aria-hidden="true" />这次更新</dt>
                <dd className="settings-update__notes">{metaNotes}</dd>
              </>
            ) : null}
            {day ? (
              <>
                <dt><CalendarClock size={13} aria-hidden="true" />发布时间</dt>
                <dd>{day}</dd>
              </>
            ) : null}
            {size ? (
              <>
                <dt><HardDrive size={13} aria-hidden="true" />安装包大小</dt>
                <dd>{size}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {state.phase === "downloading" && state.percent !== null ? (
          <div
            className="settings-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.percent}
          >
            <div className="settings-progress__fill" style={{ width: `${state.percent}%` }} />
          </div>
        ) : null}

        {blocked ? (
          <p className="settings-note" role="status">
            这份 macOS 安装包没有代码签名，系统不允许书房自己替换自己。到
            <a
              href={state.releaseUrl ?? undefined}
              onClick={(event) => {
                event.preventDefault();
                if (state.releaseUrl) {
                  void window.ailearn.shell.openExternal({
                    meta: createRequestMeta(),
                    request: { url: state.releaseUrl },
                  });
                }
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

/** 设置页里那枚"有新版"的小标记，复用同一份状态，不另开一条订阅。 */
export function UpdateBadge(props: { readonly state: UpdateStateV1 }): ReactElement | null {
  const { state } = props;
  if (!hasActionableUpdate(state)) return null;
  return (
    <span className="settings-update-badge" role="status">
      <Sparkles size={13} aria-hidden="true" />
      {state.phase === "ready" ? "新版本已就绪" : "有新版本"}
    </span>
  );
}