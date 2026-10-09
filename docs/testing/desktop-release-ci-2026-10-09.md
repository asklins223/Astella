# 2026-10-09 桌面发布 CI 修复与验证

首轮 `v1.3.4` 发布对应 `c23f59fb`，其 [Desktop release](https://github.com/asklins223/Astella/actions/runs/37910867877) 未通过，没有公开桌面 Release。

- macOS 安装包构建与包体冒烟都在 renderer 打包阶段耗尽约 2 GB 的 Node 堆。`4fa25b8f` 将 `npm run build` 中的构建进程明确设为 4096 MB，所有平台与 CI 入口共用这个命令，参数不传给安装后的 Electron 应用。
- Windows 完整安装包解包后，`WScript.Shell` 动态 COM 创建快捷方式报 `System.ArgumentException`，安装执行层回滚。`5e4bc0ee` 改用 `IShellLinkW` 和 `IPersistFile`，并在 Windows 的执行层测试中直接创建、读取及清理快捷方式，验证中文、空格、单引号路径及其他应用目标的保留。
- Windows UI 自动化继续使用系统 Windows PowerShell 的 STA 线程，脚本增加 UTF-8 BOM，保留中文控件名。

修复提交 `5e4bc0ee` 的 [main CI](https://github.com/asklins223/Astella/actions/runs/37912087389) 通过。跨平台执行层 13 个场景和原生向导交叉编译也在本机通过，编译没有警告或错误。

[Desktop package 复验](https://github.com/asklins223/Astella/actions/runs/37912094865) 使用同一提交，版本仍为 1.3.4，仅上传验证产物，不公开 Release。

Windows runner 实际通过：中文自定义目录安装、须知初始未勾选与继续按钮禁用、许可阅读、向导往返与实际路径核对、卸载默认保留资料、已安装 Electron 启动、覆盖更新清除陈旧程序文件并保留资料、保留资料卸载，以及重装后主动清除资料卸载。真实快捷方式回归也通过。三张原生向导 PNG 已人工查看，见该 run 的 `astella-windows-startup-diag-37912094865` 产物。

覆盖更新检查把安装标记临时设为 `0.0.0`，再运行同一个完整安装包，并核对位置、目标版本、陈旧文件和资料；旧版迁移与旧更新器参数另由执行层用例验证。这轮没有从已发布旧版客户端发起联网自动更新。

macOS runner 的完整构建、ZIP 包体与签名、DMG 挂载、架构和版本，以及安装包启动检查均通过。后续 `v1.3.5` 使用同一修复，沿正常 tag 发布链路重新验证与发布；最终结果以对应 tag 的 CI 和 Release 为准。
