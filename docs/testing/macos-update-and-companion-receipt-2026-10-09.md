# macOS 无 Apple 证书更新与伴星成功回执

2026-10-09 用户要求修复 Mac 更新不可用、下载后重启不能升级，并在成功启动后由伴星用语音提醒。

## 现场证据与选择

本机 `/Applications/Astella.app` 实际版本为 1.3.2，完整 ad-hoc 签名、稳定 identifier requirement。当天 08:50 的 ShipIt 日志记录了替换与启动成功；但 `update-state.json` 仍缓存 `currentVersion=1.3.1 / availableVersion=1.3.2`。因此此次现场存在更新成功后仍显示旧状态的问题，不能将所有情况归因于安装失败。

原实现还依赖旧包的代码签名要求，旧签名或构建不能进入更新流程。参考 [electron-builder 26 的原生更新限制](https://www.electron.build/v26/docs/features/auto-update/)、[Sparkle 的独立 EdDSA 更新签名](https://sparkle-project.org/documentation/)以及 [Binky 的应用暂存与替换实现](https://github.com/heyderekj/binky/blob/main/Binky/Services/UpdateChecker.swift)，此次为 Electron 实施完整应用暂存、退出后替换的安装路径。没有引入 Sparkle；现有构建的稳定 ad-hoc requirement 继续保留，供仍使用旧更新器的客户端升级。

## 实际链路

- `MacosArchiveUpdater` 复用现有 GitHub provider、下载缓存、进度与 SHA-512 校验，选择当前架构的 ZIP。Mac 不再启动原生 Squirrel/ShipIt 下载代理；Windows 与 Linux 保留原安装器。
- 安装前重新计算缓存文件的 SHA-512。在应用所在卷暂存新包，使用系统 `ditto --noqtn` 解压，核对 bundle identifier、版本、Mach-O 架构与完整代码封印。完整 ad-hoc 签名不需要 Apple 证书；架构直接读取 Mach-O 头，不要求用户安装 Xcode 工具。
- 写入本机安装意图，再启动独立 shell helper。旧主进程退出后把原应用移动为备份，将新应用移到原位置，再通过 LaunchServices 启动。替换或启动命令失败会尝试恢复旧应用，并保留失败回执。
- 新主进程核对真实运行版本。只下载、仍在旧版本或同版本重启均不会产生成功提示。成功回执保持到伴星纸片真正展示，随后由 IPC 确认；此时才清理备份。旧版本检查缓存不作为新版本状态恢复。
- 伴星通知携带约 5 秒的本地 Edge 语音，沿现有音频控制器、播放队列与嘴型通道播放。更新成功回执可在启动时开启该声道，无需新的点击；总静音与窗口不可见时不播放。可重播、停止、继续学习，后续启动不重复通知。

## 验证

- 改动前相关 3 个文件、41 条测试通过。
- 改动后桌面相关 10 个测试文件、96 条测试通过，覆盖主进程状态、重复安装、IPC 通道、跨重启回执、成功通知、静音与隐藏窗口、通知中心及播放服务。
- 原生 Mac 测试创建两个没有 Apple 证书的 Mach-O `.app`，使用真实 codesign、ditto、mv 和 open，验证等待旧进程退出、完整替换、新可执行文件启动、移动失败恢复，以及错误摘要、损坏封印、错误版本和只读位置拒绝。路径包含中文、空格与单引号。
- `node scripts/check-macos-update-download.mjs` 使用真实 Electron 网络栈和本地更新 feed，验证实际下载、进度、缓存复用与错误 SHA-512 拒绝，并确认没有增加原生 Squirrel 的监听器。已接入 macOS 打包工作流。
- `node scripts/check-desktop-update-notification.mjs` 用独立 profile 和现有生产组件验证主进程回执 → preload/IPC → 伴星纸片 → 本地音频自动播放、重播、停止、继续学习和第二次启动不重复。结果在 `outputs/desktop-update-20261009/result.json`，截图在同目录。
- shared、api、desktop-client、ai-worker 的包级类型检查通过；shared 全量 885 条测试通过。
- 最终桌面生产构建与房间资源守卫通过。独立组件窗口确认了通知与真实声道；该夹具中 Live2D 模型未就绪，因此不据此宣称角色渲染或嘴型同步通过。

## 范围与尚未确认部分

更新器测试与真窗口验证均使用独立夹具，未替换用户正在使用的 `/Applications/Astella.app`，未发布 GitHub Release。现有生产账号登录信息不适用于仓库的 QA 凭据，因此没有完成生产账号下从正式旧包下载到下一正式版本的整次升级验收；这仍需要包含修复的新安装包。首次手动安装的 Gatekeeper 打开确认继续遵循系统规则。

如果 LaunchServices 接受启动请求之后新版发生启动崩溃，helper 本身不保证自动恢复旧版；备份保留到成功纸片实际展示为止。没有安装目录写权限或从只读 DMG / App Translocation 启动时，界面会提示先移动到可写的应用程序目录。
