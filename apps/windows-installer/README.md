# 独立 Windows 安装器

Windows 安装、更新与卸载由本目录的 .NET 10 / WPF 程序负责。窗口、向导页面与执行层均独立实现，不使用 NSIS 的外壳、插件或安装脚本。运行时随单文件 EXE 携带，首次安装不需要预装 .NET 或下载 WebView2。

界面沿用奶油纸面、薄荷侧栏与拾星品牌。安装向导先展示完整使用须知与非商用许可，主动勾选同意后继续；新安装可选择独立本机文件夹和桌面入口。程序仅为当前用户安装，Windows 应用列表与开始菜单的名称为「拾星笔记」。

卸载默认保留 `%APPDATA%\astella-desktop-client` 中的资料，勾选后才清除该默认目录。外部导出、另行指定位置的语音模型、账号与云端笔记不会被删除。卸载器启动时先复制到临时目录，避免删除自己时被 Windows 文件锁阻止。

`scripts/package-windows.mjs` 使用 electron-builder 生成 `win-unpacked`，将文件清单与 ZIP 附在独立安装器之后。SHA-256 校验 ZIP 与逐个文件；签名在最终文件组装之后完成，读取器支持 Authenticode 证书对齐。独立卸载器不携带整个应用 ZIP。项目许可、须知、第三方声明与 .NET / WPF 原始许可一起进入安装目录。

更新客户端通过 `WindowsInstallerUpdater` 使用 GitHub provider、完整 EXE 下载与 SHA-512 校验。退出旧应用前先启动安装器，安装器等待旧进程退出，然后同卷替换整个目录；执行异常时恢复旧程序。更新回执仍由真实启动的新版本确认。旧客户端的更新参数与注册表身份保留用于迁移，新安装器不执行旧 NSIS 卸载器。

需要 .NET 10 SDK 与桌面 npm 依赖。在仓库根执行：

```sh
dotnet run --project apps/windows-installer/Core.Tests/Astella.Setup.Core.Tests.csproj -c Release
dotnet build apps/windows-installer/Astella.Setup.csproj -c Release -r win-x64
cd apps/desktop-client
npm run package:win:x64
```

`ASTELLA_DOTNET` 可指定 SDK 可执行文件路径。macOS 能交叉编译 Windows 程序，但不能运行 WPF 窗口。本机没装 .NET 时，用 SDK 容器同样能编译并跑执行层：

```sh
docker run --rm -v "$PWD":/repo -w /repo mcr.microsoft.com/dotnet/sdk:10.0 bash -lc \
  "dotnet build apps/windows-installer/Astella.Setup.csproj -c Release -r win-x64 --nologo && dotnet run --project apps/windows-installer/Core.Tests/Astella.Setup.Core.Tests.csproj -c Release"
```

当前本机证据：原生窗口项目编译和单文件发布成功；13 个执行层场景通过，覆盖中文目录、旧版迁移、文件损坏、路径越界、取消准备、失败回滚、保留与清除资料。最终 1.3.3 完整 EXE 的 85 个文件均通过哈希校验，并在模拟 Windows 注册的执行层完成安装与保留资料卸载；更新清单的 SHA-512、文件大小、差分块清单、包内更新器和许可也核对通过。桌面相关更新与设置测试共 38 项通过，desktop-client 类型检查与构建通过。

2026-10-10 追加：SDK 容器里编译与单文件发布通过（0 警告，壳 66,627,144 字节，版本资源已带「拾星笔记 / 拾星笔记 Windows 安装程序」），13 个执行层场景再次全通过。`package-windows.mjs` 新加的成品 PE 解析器用四种形状验过：真实的 1.3.3 完整包、人为贴上证书并把尾标推离文件末尾的同一份包（仍能读回相同的壳与载荷尺寸）、截断到 100 MB 的包、以及非 PE 的文本文件——后两种按预期报错。尚未在 Windows 上实跑的是新增的启动心跳、未处理异常弹框与双击等价检查，需要下一次 CI 的 Windows runner 验证。

Windows CI 的 `check-windows-installer.ps1` 对真实安装包执行自定义目录安装、原生 UI 自动化、启动、覆盖更新、保留资料卸载和清除资料卸载；每一步都阻断失败。UI 自动化检查须知初始未勾选、继续按钮、许可阅读、向导往返、实际目录与卸载默认值，实跑一次同版更新检查可操作的进度页与完成页，再往返卸载资料选择，并输出 PNG；同名控件（如「安装文件夹」的标签与输入框）按控件类型取，不靠文档序。圆角透明由 `scripts/windows-rounded-sheet-probe.ps1` 一处实现，主窗口与安装窗口共用：把窗口藏起来对同一区域重拍一张，角上的像素必须与它自己背后那一层同色、纸面内部必须不同色，两张图都留在诊断产物里；窗口外的 8px 环带用于确认藏窗那一下没有别的窗口抢到前面。屏幕边界取 UIA 根元素（与窗口矩形同一坐标系；这台 runner 上 WinForms 的 `SystemInformation::WorkArea` 取不到值）。主窗口最小 1280×720 比 runner 屏幕宽，屏外的角逐个点名跳过并报出，至少比对到两角才给过。2026-10-10 的第一版判据拿窗外邻居像素当背后参考，在 runner 上安装窗口贴着任务栏，右下角的参考点落在任务栏图标上，把已经生效的圆角判成了直角；改成藏窗重拍后，判据与桌面上是什么图案无关。2026-10-09 修复快捷方式创建失败后，该链路已在真实 Windows runner 全部通过，三张向导 PNG 已查看；Windows 执行层额外验证原生快捷方式的中文路径和归属清理。更新检查的具体范围、首轮失败与复验证据见 [桌面发布 CI 记录](../../docs/testing/desktop-release-ci-2026-10-09.md)。

## 双击没反应、也没有报错

安装程序是 GUI 子系统（PE 子系统 2）：`.NET` 启动器在进入 `Program.Main` 之前失败时只写标准错误，双击的那条路看不到任何提示，安装器自己的 `try/catch` 也无从执行。这类故障分三层，判据不同：

| 层 | 典型原因 | 判据 |
| --- | --- | --- |
| 加载器之前 | 安全软件静默拦下未签名的自解压包；文件下载不完整 | 进程不出现，或瞬间消失；事件日志/杀软记录 |
| 启动器之内 | `%TEMP%\.net\AstellaSetup` 解包失败、重复双击并发解包、临时目录不可写或盘不够 | 只有标准错误，无 `startup.log` |
| 进入 `Main` 之后 | 参数、注册表、包体校验、界面线程异常 | `startup.log` 有本次记录，`setup-logs/<时间戳>.log` 有原因 |

`Program.Main` 第一行向 `%LOCALAPPDATA%\Astella\setup-logs\startup.log` 追加一条心跳，界面线程与工作线程的未处理异常统一走 `ReportSetupFailure`（弹一次框 + 落一份诊断记录），因此「有心跳但没界面」和「连心跳都没有」在用户机器上可区分。`scripts/package-windows.mjs` 在组装并签名之后自己解析成品 PE：核对 x64、GUI 子系统、证书必须贴末尾、`ASTELLA1` 尾标在有效数据末尾、壳尺寸合理，并把清单里的版本与 `win-unpacked` 的文件数和字节数对上；未签名时打印醒目警告。`check-windows-installer.ps1` 最后一段用带 `Zone.Identifier` 网络来源标记的副本走 `UseShellExecute`（等同资源管理器双击、零参数），断言界面出现且心跳落盘——此前所有检查都直接传参数并用 `ProcessStartInfo`，覆盖不到这条真实路径。

出问题的机器上跑 `scripts/diagnose-windows-installer.ps1`（只读，随 Release 一起分发）：它核对包体结构与清单、临时目录与解包残留、互斥锁与残留进程，用重定向标准错误实跑一次以拿到 `Main` 之前的失败文本，再读安全软件与事件日志，末尾按收集到的证据给出分层结论。代码签名需要证书（`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`），配置后 `signIf` 会覆盖含载荷在内的完整文件；未配置时产物未签名，这条风险由上述警告、诊断脚本与随包说明承担。

源码与本文档遵循仓库的 [PolyForm Noncommercial 1.0.0](../../LICENSE)。许可范围和第三方边界见 [许可说明](../../docs/LICENSING.md)。
