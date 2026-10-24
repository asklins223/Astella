# iOS 伴星场景、日夜海景与任务交互

日期：2026-10-24。范围为 iOS 原生已登录伴星页面；保留认证、Android 和工作区已有的其他修改。用户要求本轮使用中文。

## 当前体验

移除首页“在，慢慢说。”和常驻身份标题等占位寒暄，实际回复才出现气泡。海景铺到状态栏、输入器、原生底栏和底部安全区；输入器继续占用真实布局空间。原来的输入器底色会截断海景，已仅在伴星模式改为透明。键盘弹出时保留海景原始画布高度，避免海岸突然缩放；角色根据剩余空间缩小。

采用柔和的俯瞰海岸，没有天空或云团。五张原画共用海岸构图，按真实时间平滑交接。天气设置可临时预览时段，关闭面板恢复实时。系统外观控制控件颜色，时段由实际时钟决定。

“动态形象”状态弹层曾因滚动内容只取自身宽度，出现中间不透明、左右透出海景的边带。滚动区、根容器和 presentation 背景现各自铺满弹层；失败信息自然换行，重试使用行动色，加载成功显示就绪状态。

## 原画及生成方式

使用内置 `image_gen`，正午图从零重画，其他四幅以正午图为目标编辑光照。最终完整提示词保存在 [image-prompts.md](assets/ios-companion-stage-2026-10-24/image-prompts.md)。应用只包含下列最终版本，不包含被否定的云团和风格草稿。

| 时段 | 应用中的最终文件 |
| --- | --- |
| 清晨 | [CompanionOceanDawn/ocean.png](../../apps/mobile-client/ios/Astella/Assets.xcassets/CompanionOceanDawn.imageset/ocean.png) |
| 正午 | [CompanionOceanNoon/ocean.png](../../apps/mobile-client/ios/Astella/Assets.xcassets/CompanionOceanNoon.imageset/ocean.png) |
| 午后 | [CompanionOceanAfternoon/ocean.png](../../apps/mobile-client/ios/Astella/Assets.xcassets/CompanionOceanAfternoon.imageset/ocean.png) |
| 傍晚 | [CompanionOceanDusk/ocean.png](../../apps/mobile-client/ios/Astella/Assets.xcassets/CompanionOceanDusk.imageset/ocean.png) |
| 夜间 | [CompanionOceanNight/ocean.png](../../apps/mobile-client/ios/Astella/Assets.xcassets/CompanionOceanNight.imageset/ocean.png) |

每张 852×1846，使用 asset catalog 随包携带。`OceanSceneModels.swift` 计算两幅相邻图及融合比例，`CompanionSceneBackground` 每 30 秒读取真实时钟，不按屏幕帧率重新计算页面。

## 时间、天气与动态调用链

`ConversationScreen → CompanionSceneBackground → OceanDayCycle / CompanionOceanSurface → OceanSceneMotion + OceanWater.metal`。

没有天气数据时使用本机时区、Calendar 墙上时间，覆盖清晨、正午、午后、傍晚、夜间及跨午夜。获取当地日出日落后按实际白昼比例安排时段；太阳数据必须属于当天且有效，缺失或极地无日出时回退到时钟。使用 Unix 绝对时间，不二次叠加时区偏移；夏令时用 Calendar 的下一日边界。

水域由单一原生 Metal 水体材质驱动，目标更新间隔为 1/30 秒；原画纹理在不规则流场中平流，反光由水面法线决定，近岸原有浪花随潮汐涨退。Canvas 只承接阴雨、雾、雪等低密度天气反馈，不再画规则白色浪线或月光横杠。干沙岸、角色容器、文字和控件保持稳定。切离伴星、进入后台、关闭海面动态、开启系统减少动态或应用减弱动效后停止连续海面绘制。任务/成果面板、天气设置完全展开时暂停海面循环；半屏天气设置保留可见海面的实时预览，开关的结果可以直接看到。关闭动态仍保留真实时间的日夜变换。

用户选择定位同步当地天气，入口在首页波浪按钮及“我的 → 设备权限”。天气开关默认关闭，仅明确开启后请求前台定位；使用一次性粗粒度位置，不使用后台定位。坐标先四舍五入到 0.1° 网格，约十公里级，才发给天气服务；不写磁盘、日志或伴星上下文。定位和天气请求均有超时；离开前台或关闭开关时取消并隔离迟到回执。成功结果缓存 30 分钟，失败自动重试有 5 分钟间隔。

实际天气过期后不继续伪装为晴天或雨天；日夜仍正常运行。同日有效太阳数据可继续使用，其他情况回退到本机时间。拒绝授权时显示系统设置入口，不反复弹权限框。Debug 界面夹具与正式首次体验均阻断真实定位/天气请求，预览开关不会保存为用户偏好。

默认评估端点为 Open-Meteo；保留数据来源链接。请求字段、WMO 代码和 Unix 时间依据 [官方文档](https://open-meteo.com/en/docs)。**公共免费端点仅用于符合其许可的非商业评估；商业发布需要配置有许可的服务**，参见 [许可](https://open-meteo.com/en/licence) 和 [价格](https://open-meteo.com/en/pricing)。`Info.plist` 可配置 HTTPS `OCEAN_WEATHER_URL`，接入兼容的自有代理，由代理持有商业凭据；不要把服务密钥放入原生包。当前没有接入商业代理。

## 任务、确认与成果调用链

`CompanionProcess` 的真实回执 → `CompanionStageActivity.make` → 首页活动卡 → 共用 `CompanionSheetTarget.activity` 宿主 → 处理过程/确认/手记或讲解预览 → 返回当前任务。

- 待确认优先，其次运行中、需要关注、已完成。普通聊天没有真实步骤或成果时不制造任务卡。
- 当前工具仍在执行才显示工具状态；工具成功而回复继续时显示思考，不继续伪装为调用工具。
- 思考与工具回执独立展开。首次进入任务详情展示处理过程，完整记录保留原有默认收起行为。
- 确认必须查看实际建议和影响，再明确确认或拒绝；原文可展开对照，各入口共享同一状态。终态移除重复说明和多余操作行。
- 任务面板复用既有成果组件，打开保存时的手记版本。查看预览后可回到原任务；只有明确选择完整记录或打开手记才离开当前场景。
- 停止、核对、继续绑定当前任务。回执不确定时先核对成果，继续不再强制切换到记录。已有成果在停止后仍可查看。
- 完成反馈留在首页直到主动收起，收起不删记录；被继续的任务会重新出现。多任务选择按稳定 run ID 保持，不被其他任务更新抢走。

相关逻辑位于 `CompanionActivityPresentation.swift`、`CompanionActivityView.swift`、`CompanionSheetHost.swift`、`CompanionTaskCard.swift`、`CompanionProposalCard.swift`、`CompanionProcess.swift`。笔记生成轨道、完成提醒与过程反馈进入场景底部区域；模型失败详情收进“形象状态”，不再整块盖住角色。

## 验证

修改前相关 Swift 记录测试基线为 41 项通过。新增活动筛选/优先级/已保存版本/收起与继续、真实工具状态，以及五时段、逐分钟连续性、跨午夜、时区、夏令时、太阳数据、天气代码、过期数据、空日出字段、粗粒度 URL 等测试后，`swift test --filter CompanionRecordsTests` 为 **55 项通过**。一次旧文案断言已随“等待确认”的新决定更新，不保留旧引导语。

`node --test scripts/__tests__/ios-source-registration.test.cjs` 通过；`Info.plist` 与 `project.pbxproj` 的 `plutil -lint` 通过。Swift、Metal、图片和定位配置均完成增量 Debug 构建；最近两次成功批次分别为 58.79 秒、19.01 秒。固定 DerivedData，无 clean/archive/IPA。

在 Device Hub 的 iOS 27 可交互模拟器实际点按、拖动和输入检查：

| 路径 | 覆盖 |
| --- | --- |
| 首页与底部 | 整屏海景、输入器、原生底栏、安全区；记录/伴星往返 |
| 键盘 | 实际软件键盘弹出、输入临时草稿、清空；海景锚点稳定，角色和输入器让位 |
| 日夜与动态 | 五幅预览快速往返、恢复实时、夜间深色、雨天；应用 Off 与系统减少动态 |
| 任务 | 工具详情、独立步骤、停止保留成果、保存回执核对与继续；保存版本预览返回同一任务 |
| 确认 | 大字号标题换行、长稿拖动、固定确认/拒绝动作、确认后的共享终态与返回任务 |
| 形象状态 | 复现侧边透底；修复后浅色、深色大字号、半屏和展开状态的背景连续且文字完整换行；完成按钮回到实时首页 |

系统减少动态开启时，间隔 8.34 秒两幅截图的海面区域逐像素相同；关闭后 12 秒录屏中的水域帧发生变化。这说明动态开关生效，不代表已验证真机帧率。天气 API 使用公开测试坐标 52.5/13.4 做过字段与 HTTP 200 连通检查，没有读取用户当前位置。

证据：

- [全屏正午](assets/ios-companion-stage-2026-10-24/ocean-noon-fullscreen.png)、[夜间深色](assets/ios-companion-stage-2026-10-24/ocean-night-fullscreen.png)
- [真实软件键盘](assets/ios-companion-stage-2026-10-24/ocean-keyboard.png)、[减少动态](assets/ios-companion-stage-2026-10-24/ocean-reduced.png)
- [大字号确认](assets/ios-companion-stage-2026-10-24/confirmation-large-type.png)、[海面录屏](assets/ios-companion-stage-2026-10-24/ocean-motion.mp4)
- [形象状态半屏](assets/ios-companion-stage-2026-10-24/model-status-dark-large-type.png)、[形象状态展开](assets/ios-companion-stage-2026-10-24/model-status-expanded.png)
- [最后回到实时首页](assets/ios-companion-stage-2026-10-24/ocean-home-final.png)

调试入口位于 `scripts/ios-dev.py`：`stage-thinking / tools / confirmation / complete / problems / multiple / cancelled` 与 `ocean-dawn / noon / afternoon / dusk / night / rain / snow / fog / overcast / storm / settings / weather-error`，均为禁止真实写入的 Debug 界面夹具。可搭配 `--dark`、`--large-type`、`--reduce-motion`。

此次使用 `Astella Journey QA 2026-10-24` 模拟器。后续同时存在多个 QA 模拟器时，脚本会拒绝模糊匹配；使用 `--simulator <确切 UDID>` 即可。最后已恢复正常字号、浅色和真实时间模式，没有遗留时段预览或测试草稿。

未确认：真实设备的定位授权与当地天气端到端、网络切换和后台恢复的硬件行为、真机 GPU 帧率/能耗。界面夹具中的确认和恢复不是服务端真实笔记写入验收。本轮未修改共享 API/服务端协议，不声称完成全仓回归。

## 后续：从叠加线条改为动态水体材质

用户指出背景不会动。复现录屏确认旧实现有像素变化，但原画扭曲只有 1–2pt，三条浪线只在海岸前的 54pt 窄带里移动，大部分被角色挡住；上方露出的海面几乎静止。此前“检测到帧变化”的检查只能证明绘制启动，不能证明用户能感知流动。

扩大规则浪线、增强白色光带的中间版本随后也被用户否定。当前已删除该路径，保留同一组五时段原画，改用统一水体材质：

- `oceanSurface` 是一个原生 Metal `layerEffect`，一次采样和着色承接水纹平流、水面法线反光和近岸涨退；删除此前分离的 `distortionEffect`、`colorEffect` 及 Canvas 浪线。接口遵循 [Apple layerEffect 文档](https://developer.apple.com/documentation/swiftui/view/layereffect(_:maxsampleoffset:isenabled:))。
- 海岸由原画读取的 17 个干湿边界点限定，干沙岸不进入流场。两股错相纹理流交替接管，重置接缝处权重归零；潮汐推动原画已有浪花，不额外画等距亮线。反光使用连续噪声的解析梯度，避免规则条纹。
- 半屏海景设置保留实际动效，完全展开才暂停；关闭面板恢复实时，减少动态和手动 Off 继续停止所有连续绘制。
- 时间驱动仍限制在背景层，未增加页面逐帧状态或整页移动。

初始实现备份在 `/tmp/astella-ocean-motion-fix-20261024/`；被否定的亮线试作备份在 `/tmp/astella-ocean-line-trial-20261024/`。这些都没有成为应用的第二条渲染路径。改动后的原生窗口检查和录屏见下方后续验收记录。

### 水体材质验收

增量 Debug 构建通过，用时 63.66 秒；原生源文件注册检查和本轮差异的空白检查通过。安装完成后比较应用动态库与 `default.metallib`，确认模拟器中实际运行的文件和刚完成的构建一致，避免把正在构建时读取的旧动态库当成新效果。

实际录制 [15 秒动态水面](assets/ios-companion-stage-2026-10-24/ocean-flowing-water.mp4)，展示现行的水纹流动、岸边涨退和反光。该视频来自 iOS 应用，不是原画缩放或后期给截图加动效。编码为 604×1314、30 fps；编码帧率不代表真机性能验收。

在原生窗口打开海景设置、关闭再开启海面动态、切换夜间预览并返回实时首页。手动关闭与应用减弱动效两个路径下，间隔截图的同一露出水域分别逐像素相同；开启时检查原画水纹与近岸浪花随时间变化，同时确认干沙岸和控件稳定。最后恢复正常字号、动态开启和实时海景。此前的亮线试作录屏不作为这一版的视觉依据，已移出文档素材目录。外观是否合意由当前播放效果评估，像素变化只用于判断绘制有没有停止。
