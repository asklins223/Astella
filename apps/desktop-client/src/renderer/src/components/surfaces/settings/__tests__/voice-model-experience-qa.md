# 可选语音识别模型核对 · 2026-10-04

本轮沿设置卡 → preload → 主进程仓库 → 同源模型路由 → 本地识别引擎检查下载安装，并核对设置册的真实样式和窗口交互。保留工作区已有的其他改动。

## 下载和安装

- 原 hf-mirror 和 Hugging Face 地址的仓库日期写成了 `2024-06-17`，实际应为 `2024-07-17`。已修正，并把魔搭社区放在第一位：<https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue>。
- 选用兼容当前 sherpa-onnx WASM 的 int8 导出。魔搭文件清单里的大小和 SHA-256 与官方两份文件一致；不能直接替换为 SenseVoiceSmall 的 PyTorch/FunASR 导出。
- 真实主进程仓库从魔搭完整下载了 `model.int8.onnx` 和 `tokens.txt`，共 239,549,735 字节。下载过程中校验大小与 SHA-256，通过后才原子落盘；本次测试约 8.2 秒完成，仅代表测试时的网络条件。
- 下载加上连接 15 秒、连续无数据 30 秒超时，随后尝试下一个源；不限制整份文件的下载总时间。磁盘失败单独报告，不继续换源重复下载。
- 修复并发发起下载的写句柄竞争，以及完整模型和当前传输被重复计入进度的问题。取消后保留已完成文件，清理半截文件；移除与下载串行。
- 用项目自带 WASM 运行时和下载出的模型识别官方中文样例，输出「开饭时间早上9点至下午5点。」；模型与引擎兼容性已实际验证。

## 设置卡和状态

模型卡使用项目字体、奶油纸面、薄荷色图标和状态印章。下载、取消和移除沿用设置册按钮的自定义视觉及触感；进度是自绘元素加 ARIA 语义，没有使用原生 `progress` 或系统确认框。独立 CSS 从 `styles.ts` 在设置册之后接入，避免被同名旧规则覆盖。

缺模型入口直接切到「声音与显示」，滚动并聚焦模型卡。下载时显示当前源；校验结束前最多显示 99%。取消为普通状态，操作失败与读取失败分别提示。删除了实际不会重新下载的「重新下载」按钮；已安装状态提供移除，移除后可再次下载。

修复 StrictMode / React Activity 往返后不再更新状态的问题，轮询等待上一次读取完成，忽略过期读数并同步拦截重复动作。状态读取失败时不再将上次的进度显示为当前读数。按钮因状态切换被替换时接续键盘焦点，用户已在其他输入框时不抢焦点。

## 验证

自动回归覆盖模型仓库、同源路由、设置卡和 hook、设置入口、设置触感、样式接入、伴星及作答语音相关路径。命令在 `apps/desktop-client` 运行：

```sh
npm run test -- src/main/__tests__/voice-asr-model-store.test.ts src/main/__tests__/voice-asr-model-route.test.ts src/main/__tests__/settings-surface-css-guard.test.ts src/renderer/src/components/surfaces/settings/__tests__ src/renderer/src/components/surfaces/__tests__/settings-surface.test.tsx src/renderer/src/components/companion/__tests__/local-speech-recognition.test.ts src/renderer/src/components/companion/__tests__/use-companion-voice-input.test.tsx src/renderer/src/components/home-v2/__tests__/companion-voice-local-readiness.test.ts
npm run typecheck
npm run build
```

相关 11 个测试文件、152 项测试通过。shared、api、desktop-client、ai-worker 各包的 `npm run typecheck` 通过；桌面构建通过。jsdom 仍打印既有的媒体 `pause` 未实现提示，相关断言通过。

在隔离用户目录和模型目录中启动构建后的 Electron 窗口，以 `ailearn-app://bundle/` 加载页面，1440×810 内容区实际操作了：

- 缺模型提示 → 设置卡定位与焦点。
- 下载、取消、再次下载、完成、移除；进度展开后取消按钮仍可见。
- Enter 发起后焦点接到取消按钮，取消后接回下载按钮。
- 下载中切到「陪伴规则」，稍后用方向键返回「声音与显示」，读数恢复并显示安装完成。
- 100%、125%、150%、200% 缩放。卡片说明换行，窄宽度下状态和按钮顺排，无横向溢出；高倍缩放时卡片高于正文视口，可通过滚动到达全部内容与按钮。伴星仍位于纸面右侧。

窗口与下载只使用本轮隔离目录；未采集真实麦克风录音或修改真实账户数据。测试后恢复窗口 100% 缩放并退出。

## 已知边界

本轮未实测物理麦克风的权限与完整录音识别，也未切换操作系统减少动态设置。相关本地识别、Off 与减少动态自动测试通过，不能替代设备实测。

全局 `renderer-style-closure-guard.test.ts` 仍有收藏页三个既有缺失选择器：`objective-brief__mode-description`、`objective-brief__postcard`、`objective-brief__type-help`。用本轮修改前的文件覆盖到隔离扫描目录后，得到完全相同的三项失败；本轮设置样式守卫通过，未改动收藏页。

原始验证日志及下载、识别结果保存在工作区 `outputs/voice-model-review-20261004/`，属于本轮工作材料。
