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

## v1.4.0：两条只在 CI 全量并行下红的用例

首轮 tag（`2d38655a`）的 [Desktop release](https://github.com/asklins223/Astella/actions/runs/37955475173) 在 `v1 quality and build` 红一条：`learning-run-surface.actions` 的「提交短作答前先保存最后一段专注时间」，断言要 1 次租约上报、实得 0 次，失败现场的 DOM 已经进「回答已锁定，正在评估」——点击提交时那发上报根本没发出去。同一 commit 的 main CI（406 文件全量并行）绿，本地单跑与该文件 6 趟重跑也绿。`0e98a13e` 先按同文件「上报失败仍允许提交」已有的口径，把"秒表确实在走"补成用例前提；断言内容没改。

期间一次复现尝试作废：改用同步 `getByRole` 制造的红，错误文本是 `Unable to find an accessible element`，与 CI 的失败形状不是同一条，不能当依据。

重打 tag 后的 [Desktop release](https://github.com/asklins223/Astella/actions/runs/37958288137) 又红一条，文件不同、形状相同：`source-experience` 的「重复材料不再留通用提交入口」在 `fireEvent.paste` 之后找不到「开始解析」（207ms 就失败，不是等待超时）。两条并起来指向测试环境前提没成立——`vitest.setup.ts` 一直没有设 `IS_REACT_ACT_ENVIRONMENT`，React 19 因此不会在 `act` 里把更新冲干净，passive effect 与状态更新排到渲染之后，整套用例的 stderr 里满是 `The current testing environment is not configured to support act(...)`。`a9dd5f12` 打开这个官方开关：全量跑该告警归零，本地桌面 `npm test` 连跑两趟 406 文件 / 3503 条全绿，用例断言一个字没动。

打 tag 前的本地基线：`make verify`（shared／agent-core／agent-host／ai-quality／api／desktop-client／ai-worker 的 typecheck 与测试，加发布版本与合同脚本自测）与桌面 `npm run build` 全绿。两处由本批改动自己引入的样式守卫失败（附页类名没有规则接手、轨道折叠删除后留下死 CSS 与无人调用的 `visibleAgentNodes`）在同一笔里清掉。后两笔只改用例与 setup，各自跑桌面 `npm run typecheck` 与全量 `npm test`，没有重跑整条 `make verify`。

tag 因上面两次修复各重打一次（`38334e3f` → `e23663b1` → `e1366599`）；重打时 Release 从未公开、`Publish release` 仍是 skipped，所以没有已发布资产受影响。最终 [Desktop release](https://github.com/asklins223/Astella/actions/runs/37959956663) 全绿并发布，tag [CI](https://github.com/asklins223/Astella/actions/runs/37959956330)（含服务端镜像与部署）与 [main CI](https://github.com/asklins223/Astella/actions/runs/37959951821) 同绿。

包体裁剪有了实测数：DMG 287.0 → 186.7 MB，ZIP 311.5 → 193.6 MB，Windows 安装包 454.8 → 338.4 MB。判据挂在 `package:smoke` 上，linux-x64、windows-x64 与 macos-native 三台 runner 都按解包产物做内容判据与启动检查：`node_modules` 除 katex 不得进 asar、笔记导出需要的四份 katex 文件必须在、界面语言只留 zh-CN/zh-TW/en-US。

未覆盖的部分：没有从已发布的 v1.3.5 客户端发起真实联网自动更新；Electron 44 与兼容模式的软件合成路径只在用户本机真实窗口确认过，CI runner 不判视觉闪烁；头像那条原生文件选择对话框的自动化仍未走通，见 [头像体验记录](avatar-cache-and-presence-2026-10-09.md)。
