# macOS 滚动画面闪烁的兼容处理（2026-10-09）

用户报告 M1 Pro 上滚动时整个应用闪烁，随后确认更新系统后恢复正常，并要求检测到异常后自动使用兼容模式。原故障系统版本未提供，本机为 M4 / macOS 27.0.1，不能复现原故障。系统更新的效果支持系统/GPU 路径的兼容性判断，但不足以锁定某个驱动或 Chromium 缺陷；本次提供自动选择、可手动撤回的备用渲染路径，不宣称已复现并根治原故障。

代码检查：主窗口没有透明窗口或 vibrancy；普通纸面滚动没有一条全局滚轮处理器反复刷新整页。Electron 43.4.1 / Chromium 150.0.7871.224 的本机 GPU 实测显示默认页面后端为 `GraphiteDawnMetal`。开启 `disable-skia-graphite` 后实际后端为 `GaneshGL`，ANGLE 仍为 Metal，`gpu_compositing / rasterization / webgl / 2d_canvas` 均保持 enabled。

用户入口：设置中心 → 数据与维护 → 画面与滚动 → 渲染兼容模式。健康设备使用 Chromium 默认路径；macOS 默认开启图形故障检测，不需要用户开启另一个自动检测开关。选择只写本机 userData 下的 `desktop-rendering.json`，原子写成功后才更新开关；当前生效模式与已保存模式分别呈现。改变后提示先保存笔记，再退出重开，避免主动重启中断草稿。启动时在 `app.whenReady()` 前读设置并选后端，退出兼容模式也在下一次启动生效。

自动检测通过真实调用链接入：

- 主进程在 `app.whenReady()` 之前订阅 Electron 的 `child-process-gone`。GPU 进程的 `crashed / abnormal-exit / oom / launch-failed` 自动持久化兼容选择；其他进程、正常退出、主动终止、主动内存回收和签名完整性问题不触发。`will-quit` 后忽略故障，取消 `before-quit` 不会永久关掉检测。依据：[Electron 进程事件](https://www.electronjs.org/docs/latest/api/app#event-child-process-gone)。
- 生产 `WindowLive2DDriver` 的原生、可信 `webglcontextlost` 事件，经 `WindowLive2D` → 生产 preload → 受信主文档 IPC 上报。模型/脚本加载或参数错误不当作 GPU 故障；合成事件、销毁后的事件不触发。驱动器仍通过回调传递信号，不直接依赖 Electron。
- 成功保存后推送设备状态，打开的设置页即时显示自动选择和下次启动生效；旧的首次读取不会覆盖较新的故障状态。写失败不声明成功，后续故障可重试。已在兼容后端运行或已保存兼容选择时不反复写入，也不循环重启。
- 不强制重启当前窗口；Graphite 后端开关在启动时应用。无故障事件的纯视觉闪烁没有可靠的应用级自动检测信号，不能宣称所有闪烁都能识别，也不靠滚动、掉帧或低帧率猜测异常。

底层开关依据：[Chromium 的 Graphite 后端选择](https://github.com/chromium/chromium/blob/main/gpu/config/gpu_finch_features.cc)。这个来源说明开关的作用，不证明本次用户故障由 Graphite 导致。

## 最可能的原因与证据边界

首要怀疑是 Chromium 的 GPU 绘制/合成结果与旧 macOS 的 Metal/CoreAnimation 显示链路之间的兼容问题。滚动会更新可见内容与合成帧；如果这个共享链路出现问题，不同页面都可能同时表现为闪烁。用户反馈的「所有页面都闪」和「系统更新后恢复」最符合这一方向。系统更新也包含重启，因此目前无法区分系统修复与 GPU/窗口合成状态在重启后恢复，不能断言某个驱动缺陷已经被系统修复。

具体排查优先级：

1. **GPU 合成帧提交与系统显示。** Chromium 的 [CALayerTreeCoordinator](https://github.com/chromium/chromium/blob/main/ui/accelerated_widget_mac/ca_layer_tree_coordinator.mm) 负责 Metal fence、合成帧排队及 CALayer 提交，图像通过 IOSurface 或远程图层交给系统显示。这说明真实链路中的同步与共享图层位置；没有原故障 trace，不能据此断言本次发生了 fence 失效、空帧或 IOSurface 损坏。
2. **Graphite/Dawn/Metal 页面绘制路径。** 本机默认后端实测为 `GraphiteDawnMetal`，是可单独切换验证的具体嫌疑点。原 M1 Pro 的故障后端未采集；没有找到能直接对应本项目版本和症状的已确认上游缺陷，所以优先验证 Graphite 不等于已经确认 Graphite 有错。当前兼容模式只替换此处，仍使用 ANGLE Metal 和 macOS 的显示合成链路。
3. **应用合成负担作为触发因素。** `WindowLive2DDriver.ts` 使用带 alpha/antialias/stencil 的 WebGL 画布，私有 ticker 上限 60 FPS、分辨率上限 2；HUD 的部分控件仍有 `backdrop-filter`。滚动纸面与持续更新的透明画布、模糊图层共同参与合成，可能暴露上述兼容问题。这些是触发因素的候选，尚无证据证明 Live2D 或某条 CSS 自身产生全窗口闪烁。首页前景混合层已被 Home V2 的 `display:none` 覆盖，任务内容宿主的旧 filter/transform/perspective 也被集成层清除，不能把仅存在于旧样式中的声明当成当前原因。

页面业务逻辑的优先级较低：检查到的滚动处理主要保存局部阅读位置、更新局部状态或关闭浮层，没有发现滚动时重建整个窗口的公共处理器。主窗口为不透明背景，没有开启原生透明窗口、vibrancy 或 backgroundMaterial，因此原生透明窗口相关的相似上游案例不构成本次根因证据。

确认具体原因仍需要原故障环境中的对照：同一正文与滚动操作，依次比较默认后端/兼容后端、伴星显示/隐藏、局部背景模糊开启/关闭，并采集 GPU 后端、GPU 进程退出和合成 trace。现在已恢复的 M4 新系统窗口只能验证代码与切换流程，不能补出原故障的因果证据。

验证：

- 桌面 `npm run typecheck` 通过。
- 定向 Vitest 8 文件 / 54 用例通过：设备偏好与 GPU 健康检测、IPC 通道来源、设置样式守卫、启动失败守卫、设置兼容开关、设置册、Live2D 驱动器和组件。覆盖下次启动生效、自动选择原因、重复故障、撤回、恢复默认、损坏配置、写入失败后重试、非 macOS 平台、非法模式/故障来源、外部窗口及子帧拒绝、读取/保存重试、打开的设置页接收自动状态、原生/合成上下文丢失和销毁后的回调。
- 桌面构建及源/产物房间资源验证通过。
- 用隔离 userData 的真实 Electron 窗口核验生产 `DesktopRenderingPreferences`、`registerDesktopRenderingIpc`、`SettingsRenderingGroup`、设置触感与 `WindowLive2DDriver`：开关保存成功，重启后状态和 GPU 后端均切换；默认和兼容两种模式下长正文正向、反向滚动后文字完整，Live2D 保持 ready 并呈现不同动作。关闭兼容模式可保存为默认，并提示下次启动生效。
- 最终构建的整套应用在隔离 profile 中启动至登录页，`boot-trace.log` 记录 `main-window-created-and-loaded / renderer-ready-to-show` 与恢复默认后的 `GraphiteDawnMetal`。未登录、未在真实账户的设置页验证，设置交互由上述生产组件隔离窗口覆盖。
- 自动检测的真实窗口补验使用生产 `SettingsRenderingGroup / WindowLive2D / WindowLive2DDriver`、本次构建的生产 preload、生产主进程偏好与健康检测模块，并使用独立 userData。通过浏览器的 `WEBGL_lose_context` 扩展触发真正的 `isTrusted=true` 事件（只存在于隔离夹具），设置立即显示自动选择；偏好文件实际保存 `automaticFallbackReason: webgl-context-lost`，当前窗口与修改过的测试输入仍保留。退出后重新启动，后端实测为 `GaneshGL`，GPU 合成、栅格化和 WebGL 仍启用，伴星恢复 ready 并可见。没有在用户应用上故意破坏 GPU 进程；GPU 原生事件分类由主进程事件测试覆盖。

本机运行时对照与隔离窗口夹具保存在 `apps/desktop-client/outputs/rendering-compatibility-20261009/`。夹具不进入生产构建，未读取或修改用户笔记。核验初期整套应用启动曾被工作区另一项进行中的能力声明改动挡住（`maxInputChars` 超过 schema 上限），因此采用独立窗口；那项改动随后已同步上限。本次没有修改该链路。

仍需确认：原 M1 Pro 旧系统环境中的闪烁是否因这条备用路径而消失。窗口滚动后的截图和本机 GPU 对照不能替代该环境的连续运行验证，也没有测量兼容模式的耗电或性能变化。

## 同日跟进：备用路径的代价测不出来，于是取消静默自动降级（2026-10-09 下午）

用户报告两件事：开启渲染兼容模式后「所有操作都卡、像慢动作」；笔记页滚动时仍会闪烁，表格附近最明显。

实测（`scripts/measure-rendering-backend-cost.mjs`，隔离 profile、真实登录、真实笔记「唐朝由盛转衰…」816 个表格单元格，两种后端各起一次进程）：

- 判据先过自己的考卷：第一版用「JPEG 帧字节数骤降」判空白帧，人为把整张纸藏掉都抓不到 → 判为无效，弃用。第二版对 `Page.startScreencast` 的真实合成帧在页面里解码成 256x144 灰度，统计逐帧最大色块占比与相邻帧平均亮度差；正对照（整窗子树隐藏 220ms）实测把平色从 24.8% 推到 42.4%、剧变从中位 6.0 冲到 48.7 → 判据可用。
- 在这套判据下，两种后端在 1440x810 与 2560x1440 下都是 **0 空白帧、0 整屏剧变帧**，rAF 帧间隔中位同为 6.9ms、`>34ms` 0 次。也就是说这台 M4 / macOS 27.0.1 上复现不出闪烁。
- 兼容模式的代价**没能测出来**：1440x810 那趟 compatible 的 GPU 进程 CPU 更高（0.42s vs 0.35s），2560x1440 那趟反而更低（0.27s vs 0.39s）。两次符号相反 → 这个采样分辨不了后端差异，先前写下的「多烧 20% GPU CPU」已撤回，不作为任何一侧的证据。canvas 微基准（模糊 1.2/1.3ms、200 行文本 0.97/1.0ms）同样在噪声内。

结论：既然备用路径既没被证明能治这台机器上复现不出的闪烁，也没被证明更贵或更便宜，那就不该由一次进程退出替用户选它。改为：

- `recordGraphicsFailure` 只写 `suggestedFallbackReason`，**不再改写 mode**；GPU 进程异常与伴星 WebGL 上下文丢失都只换来设置页里的一次询问（「改用兼容渲染」/「不用了」，后者走 `desktop-rendering:dismiss-suggestion`）。
- 用户无论选哪边都算答过，建议随之清掉；关掉之后再次故障还会再问。已经处于兼容模式时不再重复建议，也不重复写盘。
- 健康检测本身保留（`child-process-gone` 分类不变，`killed`/`clean-exit`/`memory-eviction`/`integrity-failure` 仍不算故障），boot-trace 文案改成 `rendering-fallback-suggested; user decides`。

同时量到并修掉一件与后端无关的结构问题：`.room-camera-rig` / `.room-depth-layer` 常驻 `transform-style: preserve-3d`，而书房子树没有任何真实 3D 变换（相机只做 `translate+scale`，D0–D6 各带的 `parallaxFactor` 在 `scene/scene-depth.ts` 之外没有消费者）。它让每个深度带在任务页上也各自成为一个整窗合成层：实测整窗层 **16 → 9**（2560x1440 下 10），`Transform3DSceneLeaf` 归零，首页实拍无视觉变化。

`release/version.json` 里 v1.3.3 的说明写着「GPU 进程异常或图形上下文丢失会自动落下兼容选择」——那是 1.3.3 发布时的事实，不改写；下一次发布的说明要写清这条改成了询问。

仍未确认：用户体感的「慢动作」在这台机器上没有任何指标能对上，可能是窗口更大、并存的 Electron 实例与容器争用、或那台机器的其它条件；闪烁也仍只在 M1 Pro 旧系统的口头报告上。要坐实需要在用户真实窗口里做一次被动录制（`scripts/probe-note-scroll-flicker.mjs` 的 `ASTELLA_FLICKER_PASSIVE=1`）。
