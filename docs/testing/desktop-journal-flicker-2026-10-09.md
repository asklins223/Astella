# 对话手记滚动闪烁：软件合成兼容路径（2026-10-09）

## 已确认结果

在用户真实对话内容的隔离 Astella 窗口中，用户明确确认「软件合成 · WebGL 读回」不再闪烁。Electron 43.4.1 / Chromium 150.0.7871.224 / macOS 27.0.1 / Apple M4；原始报告还涉及 M1 Pro，但本轮没有在 M1 Pro 上复验。

| 对照 | 用户反馈 | 实际路径 |
| --- | --- | --- |
| 关闭 CoreAnimationRenderer | 仍然闪烁 | GPU 合成 |
| 关闭 GPU 栅格化和 Graphite | 仍然闪烁 | CPU 栅格化、GPU 合成、GaneshGL |
| 关闭 GPU 合成和 Graphite | 不再闪烁 | `gpu_compositing=disabled_software`、`webgl=enabled_readback`、GaneshGL / ANGLE Metal |

有效对照共记录 818 个滚轮事件，包含工具和用户实际鼠标输入。开发者监控不使用 CDP screencast，避免改变被测合成路径。此前录像未捕获异常、截到其他前台窗口或内容没有滚动的结果不构成修复证据。

原始用户录像有四次整张手记及目录瞬间消失，持续约 13–28ms，房间与伴星保留。默认路径真实滚动监控中，手记仍连接 DOM，位置和透明度稳定，无 GPU 进程退出、无 WebGL 上下文丢失；采集的默认 compositor trace 没有超过 50ms 的同步完整事件。上述对照将嫌疑收敛到 GPU 合成及显示提交链路，但没有锁定某个驱动、IOSurface、同步栅栏或 Chromium 缺陷。

## 实现

`DesktopRenderingPreferences` 在 Chromium 初始化前，为兼容模式添加 `disable-gpu-compositing`。2026-10-09 晚间升级 Electron 44.7.0，移除在 Chromium 152 上让 WebGL 不可用的 `disable-skia-graphite`；早先两开关的观测表保留为历史证据。健康设备仍使用默认渲染；Live2D 保留 GPU 绘制，软件合成时通过读回呈现，可能增加 CPU 与读回开销，未完成耗电或长时间性能评估。

按照用户「检测到了异常就自动用兼容模式」的要求，GPU 的 `crashed / abnormal-exit / oom / launch-failed` 和生产 Live2D 可信 `webglcontextlost` 事件自动原子保存兼容选择及 `automaticFallbackReason`。不强制重启，不在当前进程动态更换后端。普通掉帧、鼠标滚动、主动结束进程与签名完整性错误不当作故障；已在兼容模式运行时不循环保存，也不取消用户正在恢复默认的选择。

仅有像素闪烁时 Chromium 可能完全不报告错误，本轮正是如此。自动检测不能覆盖所有视觉闪烁；这种情况仍可在「设置 → 数据与维护 → 画面与滚动」手动开启兼容模式。旧手动选择保留，旧的未处理建议不会被当作新故障自动降级。设置同时说明当前模式与下次启动生效，并可撤回自动选择。

## 验证

- 主进程偏好、故障检测、IPC 边界、迁移、写失败重试、设置状态、启动失败守卫：3 文件 / 35 用例通过。
- 桌面包 `npm run typecheck` 通过。
- 房间构建产物资源守卫通过。
- 隔离窗口加载生产 `SettingsRenderingGroup`、`WindowLive2D`、生产 preload 与主进程偏好；触发原生 WebGL 丢失（`isTrusted=true`），开关自动打开，磁盘保存兼容模式及原因，原有测试输入保留，没有自动重启。
- 用户真实手记的软件合成对照无闪烁，是本轮视觉验收依据。截图、单元测试与 trace 的阴性结果不替代这项用户观察。

## 用户提供的排查建议核对

`disable-smooth-scrolling` 是 Chromium 150 保留的测试开关，但本轮没有验证它能解决此症状，未追加到生产。也未全面关闭硬件加速或修改系统显示设置。

用户提到的 Electron 36.9.2 修复实际针对 macOS Tahoe 的 WindowServer GPU 负载和私有 cornerMask API，并不是本项目滚动丢层的已确认修复；当前版本已是 43.4.1。43.7.6 发布说明没有明确对应本次症状，因此没有把升级当作已经验证的解决方法。

依据：[Chromium 150 开关定义](https://raw.githubusercontent.com/chromium/chromium/150.0.7871.224/content/public/common/content_switches.cc)、[Electron 36.9.2](https://github.com/electron/electron/releases/tag/v36.9.2)、[对应 cornerMask 修复](https://github.com/electron/electron/pull/48401)、[Electron 43.7.6](https://github.com/electron/electron/releases/tag/v43.7.6)。

运行时与定向日志保存在忽略目录 `apps/desktop-client/outputs/journal-flicker-20261009/`。监控只记录几何、图层、帧与进程状态，没有打印正文或凭据。
