# 伴星通知体验验证 · 2026-10-04

本次实现把系统消息与伴星对话分别呈现：下载、后台任务、复习和约定提醒进入独立纸签，声音仍由应用唯一的 AudioContext 与 Live2D 嘴型通道承载。

## 真实窗口

运行 `apps/desktop-client/scripts/check-companion-notifications.mjs`，使用实际 Electron、renderer、preload 和 main。登录复用已有的隔离 QA 会话，在新的临时 profile 中运行；未修改日常 profile 或账号凭据。API 与 Edge TTS 使用本地已有服务。

模型状态由这个隔离 Electron 实例的 IPC 桩依次提供 absent、downloading、error、ready；按钮、导航、下载事件、常驻监控和通知组件走生产调用链。没有在这轮重新传输整个 228 MB 模型，也没有开启实体麦克风。ASR 安装与录音自身仍由原有模型、路由和录音测试覆盖。

24 项窗口检查通过：

- 点语音自动打开声音设置、定位并聚焦模型区域，关闭录音气泡；重复点击更新同一条提示，旧的角色唤起延迟不再打开轻聊。
- 下载中的纸签显示进度；取消抵达设备控制器；取消后再下载、失败后重试均能重新送达；离开设置后收到安装完成提示。
- 回复尚在等待首段声音时也占用声道。后台完成消息暂存，直接帮助安静显示，回复结束后再投递后台消息。
- 确认、取消、收起回看、10 分钟后提醒可操作。1440×810、原生最小 1280×720 和 100% / 125% / 150% / 200% 缩放下，长正文滚动，按钮留在窗口内。
- Off 可以直接确认；模拟系统减少动态时，Full 的纸签 transform 被关闭。
- 缺模型提示使用真实共享音频宿主播放；六个本地 Edge TTS MP3 均可解码；动态通知通过 renderer → preload → main → API 合成可解码的 MP3。无 renderer pageerror。

截图用 `webContents.capturePage()` 捕获实际窗口，避免 Electron 缩放下 Playwright 截图只截到部分画面。结果保存在 `outputs/companion-notifications-20261004/`，其中 `window-checks.json` 保存逐项回执；`01-model-needed.png`、`02-model-ready.png` 和 `04-long-200.png` 是主要画面。

## 回归与边界

相关桌面回归覆盖通知去重与优先级、取消后重建、延后与过期、工作区切换、确认取消单次执行及失败重试、语音合成迟到、播放设备恢复期间被回复抢占、麦克风占用释放、模型常驻监控、两处语音入口、笔记任务、设置与任务容器焦点。API 验证 TTS 引擎选择与既有同意门。shared、api、desktop-client、ai-worker 的包级 typecheck 和桌面 build 通过。

SettingsSurface 的 jsdom 用例在卸载时输出 `HTMLMediaElement.pause` 未实现提示，用例仍通过；真实声音验证由 Electron 承担。没有进行整个仓库的全量回归。

消息列表保留在当前窗口：已收下历史最多 30 条，待查看消息不因历史上限丢弃。工作区消息随 scope 清除，设备下载消息保留；旧工作区的投影、异步回执和动作均不能在新空间继续执行。重新打开笔记可以恢复 queued/running 的任务监控；不会把已完成的历史任务重新当成新完成消息。

普通任务和系统消息遵守静默时段，约好的提醒仍可送达；总静音、声音关闭、勿扰、通知边界、正式作答和外部模态继续生效。用户直接触发的模型帮助可以安静呈现。播报被回复打断后不自动重播，消息可在空闲时手动朗读。

## 新消息接入

入口是同目录 `companion-notifications.ts` 的 `notifyCompanion`，使用稳定业务 id 和原始 workspaceScopeRevision。领域服务得到实际保存或失败回执后再投递；不要用通知组件保存任务结果。

`actions` 分别提供 navigate、confirm、cancel，可返回 Promise；失败保留气泡并允许重试，返回 false 保持当前消息。`snoozable` 提供本地 10 分钟延后，`onShown / onDismiss / onSnooze` 用于真实业务回执。固定提示使用已生成的 clip，动态内容只传 audio.text，统一走 Edge TTS 通知用途。默认等空闲投递，用户直接操作的指导才选择 immediate；通知组件负责声音避让，无需各来源自行争抢播放器。

现已接入设备模型、笔记速看、互动演示、拓展草稿（包括伴星对话入口）、今日复习、约定提醒与服务端 system delivery。个人念头保留原来的伴星表达。
