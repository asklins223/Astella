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

`ASTELLA_DOTNET` 可指定 SDK 可执行文件路径。macOS 能交叉编译 Windows 程序，但不能运行 WPF 窗口。

当前本机证据：原生窗口项目编译和单文件发布成功；13 个执行层场景通过，覆盖中文目录、旧版迁移、文件损坏、路径越界、取消准备、失败回滚、保留与清除资料。最终 1.3.3 完整 EXE 的 85 个文件均通过哈希校验，并在模拟 Windows 注册的执行层完成安装与保留资料卸载；更新清单的 SHA-512、文件大小、差分块清单、包内更新器和许可也核对通过。桌面相关更新与设置测试共 38 项通过，desktop-client 类型检查与构建通过。

Windows CI 的 `check-windows-installer.ps1` 对真实安装包执行自定义目录安装、原生 UI 自动化、启动、覆盖更新、保留资料卸载和清除资料卸载；每一步都阻断失败。UI 自动化检查须知初始未勾选、继续按钮、许可阅读、向导往返、实际目录与卸载默认值，并输出 PNG。2026-10-09 修复快捷方式创建失败后，该链路已在真实 Windows runner 全部通过，三张向导 PNG 已查看；Windows 执行层额外验证原生快捷方式的中文路径和归属清理。更新检查的具体范围、首轮失败与复验证据见 [桌面发布 CI 记录](../../docs/testing/desktop-release-ci-2026-10-09.md)。

源码与本文档遵循仓库的 [PolyForm Noncommercial 1.0.0](../../LICENSE)。许可范围和第三方边界见 [许可说明](../../docs/LICENSING.md)。
