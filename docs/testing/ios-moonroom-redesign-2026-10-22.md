# iOS 页面重做与调试流程（2026-10-22）

## 用户决定与范围

本轮先重做 iOS 的伴星首页、记录、书房、阅读及手记子页、日记和伴星最小态。用户先后否定了"像 iOS 官方应用"、月白书房的拟物感、糖果色与"花花绿绿"的多色卡片，最终要求：正常、克制、有高级感和设计感，以**鲜亮的蓝色作为主体色**，同时保留圆润轮廓与 Q 弹反馈。视觉最终收敛为干净的中性白纸面、墨色文字、极细冷灰边界和一档鲜亮钴蓝主色（`#2F6BFF`），所有界面不使用渐变。界面与文档按用户要求使用中文。Android 只建立开发规则，此轮没有修改 Android 界面、共享协议或服务端。

视觉决定保存在 [DESIGN_SPEC.md](../../apps/mobile-client/DESIGN_SPEC.md) 开头。未覆盖认证页已有的用户修改。

## 实现

- 视觉系统：`Design/Tokens.swift` 收敛为纸与墨的单主色体系（canvas、paper、ink、muted、paperEdge、accent 钴蓝），紫、桃、薄荷、柠檬等名字只保留为近乎无色的纸面层次，不再作为多色卡片使用；`Surfaces.swift` 去掉全部渐变，画布改为干净的中性白（底色略冷，避免发灰发脏），纸卡使用 0.8pt 细边和单色轻阴影；`Motion.swift` 保留可中断的回弹按压。
- 相伴：首页改为"问候卡 + 角色 + 输入"的单列构图，角色直接落在纸面上，顶部模式切换收进一枚白色胶囊；记录页头部是一张独立纸卡，伴星消息为白纸气泡、用户消息为钴蓝气泡，时间收进小胶囊，日期分隔为居中小胶囊。
- 书房：搜索、继续阅读与手记列表重新组织为两列纸卡网格，卡片统一纸白与细边，仅用钴蓝小面积点缀；保留真实搜索、导入、导出与继续阅读调用链。
- 阅读：改为真正的无界阅读——正文直接落在纸面上，不再用卡片兜住内容；底部不放色带，速览／学习卡／脑图是三枚独立悬浮胶囊，内容从它们下方继续滚动，卷末由安全区留出可读空间。版本胶囊、原生选区与注释范围保留；进入手记的匹配缩放仍暂缓。
- 手记子页：速览 = 天空色 hero 卡 + 两列 bento 区块；版本 = 左侧日期轨道（圆形日期章 + 虚线）+ 右侧纸卡；批注与讲解 = 平涂引用卡 + 圆头像讲解卡；脑图 = 平涂彩色节点（已移除唯一渐变）；拓展与学习卡 = 大圆角选项卡，成绩放进平涂软形色块。全部保留原有真实数据、动作与导航。
- 日记：列表改为真正的纵向时间线（左侧圆形日期章、2pt 虚线轨道、右侧纸卡）；月份是一枚大胶囊；详情用 84pt 圆形日期贴纸压住纸卡，正文、引用与继续对话入口保留。
- 我的与设置：每个分区改为独立圆角行卡，图标收在浅蓝圆底，主色只落在关键操作与选中态。
- 底栏：iOS 27 使用原生 `TabView` 的选择透镜，额外伴星项使用 `TabRole.prominent`，由系统放到右侧独立位置。详情收起主栏，保留右下角伴星浮钮；浮钮改为软形纸底 + 探头的角色头像。
- 星轨页首：去掉全部渐变与流星，改为平涂深墨夜空、实心象牙月亮与一条固定星座虚线；只保留极轻的星点呼吸，减少动态、后台或离开星轨时停止。
- 加载：共用内容形状骨架屏，改为整体明暗呼吸而非扫光渐变；空态、失败与重试保留真实状态，不假造进度。
- 字体与按压：字体不更换，中文使用系统苹方（PingFang SC），系统圆体设计只作用于西文与数字，不打包第三方字体。按压反馈统一为短促的临界阻尼弹簧：圆形控件轻微压扁，行与卡片只轻微变暗，不再整块回弹。
- 动效（2026-10-22 全量重做，Telegram 级）：`Design/Motion.swift` 现在是全应用唯一的动效契约——语义 token（`tap` 0.22/0.9、`press` 0.26/0.86、`navigation` 0.38/0.92、`panel` 0.40/0.90、`sheet` 0.42/0.92、`selection` 0.30/0.88、`message` 0.34/0.90、`reveal` 0.46/0.94、`gesture` interactiveSpring）与 `MotionTransition.slide/pop/rise/fade`；进入沿触发点滑入、退出只淡出或沿原路；共享元素用 matchedGeometry/原生 zoom；Reduce Motion 全部退化为透明度。
  - 相伴：伴星/记录按分段左右方向换场；消息从输入条方向滑入、离开淡出；附件与引用 chip 跟手拖动、松手回弹；加号菜单从按钮锚点弹出；录音/播放/失败条自下托起；气泡从角色侧弹入；工具过程展开用面板弹簧。
  - 书房与手记：骨架→内容/空态/错误交叉淡入；阅读页头与工具坞出现；速览/版本/批注/拓展用面板 token；学习卡场景按前进/后退方向滑动，题目翻页带方向，进度条、选项选中、分数与星星分级出现；脑图画布弹入、手势保持 1:1。
  - 星轨与设置：日记/伴星记忆/手边按位置左右换场；月份切换按箭头方向滑动并让数量数字滚动；日记/记忆/回收站各阶段淡入淡出；账户、权限、AI 授权、连接反馈做状态交叉淡化；保存、删除、恢复等有分级触感。
  - 外壳与伴星：底栏伴星位恢复为系统 Liquid Glass 底栏最右侧的独立槽位：保留原生玻璃与选择透镜，只把真实 Live2D 头部叠加在系统槽位上（不随页面移动、不可拖走）；点按气泡从头部弹出，长按直接语音；迷你对话用半屏 sheet。标签切换保持系统原生行为。

## 验证与限制

验证环境：iPhone 17、iOS 27.0 模拟器（`B669C1D3-56BF-4DAF-992B-BAE49FC738D4`），Xcode 27，Debug。使用带"界面预览 · 本地示例"标识的本地内容，未调用真实 AI 生成、语音或写入接口。截图通过 `scripts/ios-dev.py open <route>` 直达路由启动后用 `simctl` 截取。

已检查：

- 页面族：相伴首页、记录、书房（正常／加载骨架／空态／失败重试）、阅读（正常／加载）、星轨的三个分段（日记／伴星记忆／手边）、日记详情、我的、设置与手记子页（速览／脑图／批注／版本／拓展／学习卡／练习／结果）。逐屏启动并截图，布局完整、状态可读，没有空白屏或启动崩溃。
- 字体：中文由系统苹方呈现；工程内没有字体文件、`Info.plist` 字体注册或资源引用。用户否决的 ChillRoundF 已删除，删除后重新构建通过。
- 无渐变：`grep` 确认 iOS 源码中 `LinearGradient`/`RadialGradient` 为 0。
- 交互（新增能力）：通过 Xcode Device Hub 暴露的 iOS 辅助功能树直接驱动模拟器，本轮真实点按并通过截图/辅助功能树复核了：底部四个标签与右侧独立伴星项、书房手记卡进入阅读页、阅读页速览抽屉、学习卡、脑图、返回阅读、返回书房，以及阅读页右下角伴星浮钮回到相伴首页。该能力来自本机编译的 `axctl`（AX 工具），不是 App 内测试代码。
- 导航：运行日志 `StudyNavigation depth=2 enabled=1` 覆盖阅读与手记子页，说明隐藏导航栏后系统侧滑返回手势已启用；模拟器内的合成拖拽尚未成功触发返回，见下方限制。
- 动效与降级：`--ui-reduce-motion` 下首页与星轨不运行动画循环；`--ui-dark` 下底栏、阅读、星轨与日记仍可读；大字号（`accessibility-extra-large`）下首页、书房与阅读没有截断或重叠。
- 按压反馈与弹性：源码检查确认小圆控件为横向轻展、纵向压扁的可中断弹簧，大面积为轻微明暗。

### 2026-10-22 问题修复（真实点按回归）

- 首页书房切换：示例数据补齐「高二语文 / 高二 · 三班 / 我的随笔」三间书房，示例模式下切换会本地更新书房名并给出提示；真实账号仍调用 `/auth/switch-workspace`。点按「切换书房」→ 选择「高二 · 三班」已验证书房名变化。
- 学习卡返回与重做：`close()` 不再因为一次较早的失败而拒绝关闭；示例模式下「再练一次」直接进入本地练习、交卷直接生成本地结果；真实账号仍走 attempt / complete 接口。点按验证：返回回到阅读页；再练一次进入第 1/6 题；作答后「检查并交卷 → 交卷并批改」进入结果页（本次练习、最佳 82 分 / 4 星）。
- 首页伴星：问候卡改为「在。今天想先读哪一页？」并给出两个真实入口（接着读《赤壁赋》、说说今天）；示例模式下的伴星回合完整走 思考点 → 工具节点（翻到第 1 段）→ 流式文本 → 定稿，气泡下方出现「存为手记 / 先不用」确认卡；「朗读」在示例模式走系统语音（AVSpeechSynthesizer），真实账号仍走服务端朗读；示例对话与手记摘要的占位文案已改写得更自然、可操作。
- 已用真实点按复核：书房菜单展开与切换、学习卡返回/再练一次/交卷、首页发送（思考、工具过程、流式、确认卡）与朗读按钮。
- 动效验证：用 `simctl io recordVideo` 录下手记打开过程并按 30fps 抽帧，确认从书房卡片到阅读页经过了共享元素缩放（中间帧可见卡片放大、阅读页填充），Reduce Motion 下不会播放；发送与切换标签的触感只能在真机上主观确认，模拟器不校验振动手感。
- 全局伴星（2026-10-22 方案 B）：保留系统 Liquid Glass 底栏与右侧 `TabRole.prominent` 槽位，把真实 Live2D 头部叠加在该槽位上（模型可用时用 `Live2DSlotView` 裁到头部，失败时回退头像图），不再变成自绘底栏；气泡挂在 overlay 上，展开不参与布局，避免点按伴星时底栏被推动；点按弹出页边气泡卡（当前页上下文 + 接着读 / 语音 / 展开），长按直接进入语音对话（真实账号走 `VoiceCapture` 转写并发送，示例模式本地演示）；展开为半屏迷你对话。伴星在书房、星轨、我的及所有 push 详情页常驻，不再跳回首页；页面切换时气泡文案跟随当前标签与正在读的手记。
- 学习卡练习底栏（用户指出「先跳过」夹在上一题／下一题之间、位置不合理）：把跳过并入「下一题」——不答直接下一题，交卷时该题记为跳过，提交确认弹窗已写明「未完成的题目会记为跳过」；底部只保留两枚 54pt 导航按钮。原先的「先跳过」是 13pt 裸文字，没有 44pt 触控高度，又正好处在拇指最常落下的位置，误触会把已选答案包成「跳过」导致 0 分；现在这层语义由主按钮承担，独立控件不再出现。改动只在 `NoteLearningCard.swift` 的 `practiceDock`，练习、交卷、结果与失焦重进的链路未改。核对截图 25（`note-learning-practice` 直达路由，第 1/6 题）：底栏只有「上一题」（第 1 题禁用灰）与「下一题」两枚等宽药丸，18pt 对称边距、10pt 间距、无第三控件、无截断，dock 仍在安全区之上；增量构建 15.61s 通过，无新增 warning。未做真实点按（本机无触摸自动化），「跳过并入下一题」的点按行为只由源码与提交弹窗文案确认。
- 开屏动画偏移：根因是开屏静态底图用 `scaledToFit` 在安全区里排版、再 `ignoresSafeArea`，底图按去掉状态栏后的高度缩放，整体变小并向右偏；Web 动画接管后才回到全屏，于是“先偏右、动一下才正常”。`LaunchMotionView` 改为用 `GeometryReader` 的整窗尺寸同时约束静态底图与 WebView，跳过按钮与状态文案仍留在安全区。逐帧测量（每 0.25 秒）开屏底图与动效画面相对设计稿的横向偏移，修复后为 0–2 px。
- 手记打开位置偏移（用户指出「打开笔记不是最上方，而是往下面偏移了很多」）：根因是阅读器把「上次停留段落」写进本机偏好，打开时又让 Web 正文先滚到那一段（`savedOrdinal`）；旧版阅读器留下的段落序号可能很深，于是每篇手记一打开就落在正文中段，标题与版本行被滚出视野。用户决定打开手记始终从顶部开始，因此移除打开时的位置恢复：原生侧 `NoteWebReader` 不再接收 `savedOrdinal`、也不再上报可见段落，`NoteReader` 去掉 `readingBlockOrdinal`，`NotesMethods` 删除 `savedNoteReadingBlock`／`saveNoteReadingBlock`，只保留「最近打开」记录（Web 层遗留的 `savedOrdinal` 分支已无调用方，不再生效）。验证：iPhone 17 / iOS 27 模拟器先把 `readingBlock.open-design-redwall` 预设为 3（模拟历史读得很深的状态）再启动 `read` 直达路由，正文停在 `contentOffset {0,0}` 且「第 2 版 · 共 3 段」与《赤壁赋》标题完整可见；用 JS 滚到卷末后结束进程再启动，仍回到同一顶部位置。未在真机与真实账号的长手记上复核；批注抽屉「回到原文」此前也没有滚动动作，本轮保持只关闭抽屉。

验证截图（存于 50% 尺寸，便于随文档保存）：

| 截图 | 内容 |
| --- | --- |
| [01-companion-home.png](assets/ios-moonroom-2026-10-22/01-companion-home.png) | 相伴首页：暖白纸面、问候卡与角色 |
| [02-records.png](assets/ios-moonroom-2026-10-22/02-records.png) | 记录：独立头部纸卡、白纸与钴蓝气泡、时间胶囊 |
| [03-library.png](assets/ios-moonroom-2026-10-22/03-library.png) | 书房：两列手记纸卡与继续阅读 |
| [04-reader.png](assets/ios-moonroom-2026-10-22/04-reader.png) | 阅读：无界正文、版本胶囊与三枚悬浮胶囊 |
| [05-orbit-starfield.png](assets/ios-moonroom-2026-10-22/05-orbit-starfield.png) | 星轨：平涂深墨夜空、象牙月与星座虚线 |
| [06-diary.png](assets/ios-moonroom-2026-10-22/06-diary.png) | 日记详情：圆形日期贴纸与纸卡正文 |
| [07-note-overview.png](assets/ios-moonroom-2026-10-22/07-note-overview.png) | 手记速览：hero 卡与两列区块 |
| [08-note-learning-card.png](assets/ios-moonroom-2026-10-22/08-note-learning-card.png) | 学习卡：成绩软形色块与统计 |
| [09-loading-skeleton.png](assets/ios-moonroom-2026-10-22/09-loading-skeleton.png) | 书房加载：平涂骨架的明暗呼吸 |
| [10-error-retry.png](assets/ios-moonroom-2026-10-22/10-error-retry.png) | 书房失败：说明与重新加载 |
| [11-dark-orbit.png](assets/ios-moonroom-2026-10-22/11-dark-orbit.png) | 深夜：星轨与底栏 |
| [12-large-type-library.png](assets/ios-moonroom-2026-10-22/12-large-type-library.png) | 大字号：书房不截断 |
| [13-reduced-motion-orbit.png](assets/ios-moonroom-2026-10-22/13-reduced-motion-orbit.png) | 减少动态：静态星空 |
| [14-me.png](assets/ios-moonroom-2026-10-22/14-me.png) | 我的：独立行卡与浅蓝图标底 |
| [16-home-companion-turn.png](assets/ios-moonroom-2026-10-22/16-home-companion-turn.png) | 首页伴星回合：流式回答、朗读入口与确认卡 |
| [17-workspace-switcher.png](assets/ios-moonroom-2026-10-22/17-workspace-switcher.png) | 书房切换菜单（三间示例书房） |
| [18-learning-result.png](assets/ios-moonroom-2026-10-22/18-learning-result.png) | 学习卡交卷后的本地结果 |
| [19-launch-artwork.png](assets/ios-moonroom-2026-10-22/19-launch-artwork.png) | 开屏底图与动效使用同一整窗尺寸（修复右偏） |
| [20-note-zoom.png](assets/ios-moonroom-2026-10-22/20-note-zoom.png) | 手记打开的共享元素缩放（30fps 逐帧截取） |
| [21-floating-companion.png](assets/ios-moonroom-2026-10-22/21-floating-companion.png) | 全局伴星：页边气泡与真实 Live2D 头部 |
| [22-companion-mini-chat.png](assets/ios-moonroom-2026-10-22/22-companion-mini-chat.png) | 展开后的半屏迷你对话 |
| [23-companion-voice.png](assets/ios-moonroom-2026-10-22/23-companion-voice.png) | 长按伴星直接进入语音对话 |
| [24-companion-bar.png](assets/ios-moonroom-2026-10-22/24-companion-bar.png) | 伴星在底栏最右侧独立槽位（锁死，不随页面移动） |
| [25-memory-detail.png](assets/ios-moonroom-2026-10-22/25-memory-detail.png) | 记忆详情：纸卡正文、来源说明与旧版本 |
| [26-memory-detail-candidate.png](assets/ios-moonroom-2026-10-22/26-memory-detail-candidate.png) | 记忆详情：待确认候选，首屏采用/暂不采用 |
| [27-memory-detail-archived.png](assets/ios-moonroom-2026-10-22/27-memory-detail-archived.png) | 记忆详情：已归档横幅与恢复使用 |
| [28-memory-detail-relations.png](assets/ios-moonroom-2026-10-22/28-memory-detail-relations.png) | 记忆详情：同组「另一种说法」入口 |
| [29-memory-detail-error.png](assets/ios-moonroom-2026-10-22/29-memory-detail-error.png) | 记忆详情：读取失败，保留重新读取与返回 |
| [25-companion-slot-live2d.png](assets/ios-moonroom-2026-10-22/25-companion-slot-live2d.png) | 系统液态玻璃底栏 + 槽位中的真实 Live2D 头部 |
| [15-note-mind-map.png](assets/ios-moonroom-2026-10-22/15-note-mind-map.png) | 脑图：平涂节点与画布工具条（真实点按进入） |
| [25-learning-practice-dock.png](assets/ios-moonroom-2026-10-22/25-learning-practice-dock.png) | 学习卡练习：跳过并入下一题，底栏只留两枚导航按钮 |

未覆盖与限制：

- 模拟器里的合成拖拽没有成功触发系统侧滑返回；运行日志确认手势已启用（`depth=2 enabled=1`），但真实触控手感仍需在带窗口的模拟器或实体设备上补验。键盘遮挡、快速重复点按同样未做真实触控验收。
- 未在实体 iPhone 上验证帧率、耗电、麦克风／扬声器、Live2D 下载或真实后端长文链路；未覆盖 iOS 18／26 的降级外观。
- 构建与日志仍保存在 `/tmp/astella-ios-dev/`；本轮完整增量构建约 24–36 秒，最后一次无改动重建约 10 秒。链接阶段现有的 Cubism 静态库警告与基线一致。

## 更快的调试路径

执行约定见 [手机 AGENTS.md](../../apps/mobile-client/AGENTS.md) 与 [DEVELOPMENT.md](../../apps/mobile-client/DEVELOPMENT.md)。新增 `scripts/ios-dev.py`，固定 DerivedData，读取 Xcode 的实际产物目录；一次增量构建后可直接打开多个页面，只有产物变化才覆盖安装。保留 App 数据，不 Archive、不生成 IPA、不默认 clean。Debug 示例阻断真实相对 API 请求，避免界面检查写入真实账号。

Xcode Debug 开启当前架构与 Debug dylib；Cubism shader 阶段声明输入／输出 file list，避免无改动时重复执行。实体 iPhone 的签名构建、覆盖安装和启动路径已提供命令，实际设备验收另记。

官方依据：

- Apple [SwiftUI Preview](https://developer.apple.com/documentation/xcode/adding-previews-to-your-interface-files) 与 [Preview 工作流](https://developer.apple.com/videos/play/wwdc2024/10144/)。
- Apple [新 SwiftUI 界面](https://developer.apple.com/videos/play/wwdc2025/323/)、[自定义 Liquid Glass](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views)、[TabRole.prominent](https://developer.apple.com/documentation/swiftui/tabrole/prominent)。最新 SDK 中 prominent 为 iOS 27 API，不能误写成所有 iOS 26 原生底栏都支持任意独立项。
- Android [Live Edit](https://developer.android.com/develop/ui/compose/tooling/iterative-development) 与 [Apply Changes](https://developer.android.com/studio/run#apply-changes)。没有在本轮声称实测 Android 热更新。
- [InjectionNext](https://github.com/johnno1962/InjectionNext) 仅作为待评估选项；没有安装，也没有声称 Xcode 27 真机注入已可用。

### 2026-10-22 伴星记忆 · 记忆详情重做

用户截图反馈：星轨 → 伴星记忆 → 记忆详情显示「这条记忆暂时没有打开 / 暂时连接不上书房，请检查网络或服务地址后重试」。根因有两层：

1. 详情页没有 DEBUG 示例分支。其他页面在 `--ui-review` 下有本地数据，这条详情页仍然直接发请求；而 `MobileAPI.url(_:)` 在预览模式统一抛 `status 0`，`mobilePageError` 又把 `status 0` 统一翻译成「暂时连接不上书房」。于是「预览模式没有示例数据」被误报成「断网」，整页只剩一张空错误卡，也没有重试按钮。
2. 旧详情页即使拿到数据也只是一张字段表（来源性质/说话者/适用范围/适用条件/依据/确认状态/有效期/修订）加一串版本列表。没有「她为什么记得」的叙述、没有候选/归档/争议/替代的独立状态、没有和另一条相似记忆的关系，也没有失败与未找到的区分，视觉与信息结构都和星轨列表不在同一个设计语言里。

改动（`Screens/MemoryDetailScreen.swift`，旧页面从 `OrbitDetailScreens.swift` 删除）：

- 首屏纸卡：种类、状态与固定标记、正文大字；候选记忆在首屏直接给出「暂不采用 / 采用这条记忆」，并说明采用与不采用的后果。
- 状态横幅：已归档（可恢复）、有争议、已被替代、已忽略各有说明，不再用同一个空错误卡糊过去。
- 「她为什么记得」：用一句话说明来源（你亲口说的 / 她整理的理解 / 你确认过 / 对话摘要），下面给时间、范围、适用条件与有效期，右下角用三格「她的把握」代替生硬的百分比。
- 「她记得更早的样子」：旧版本按时间从新到旧排列，每行给出「至 X 日 · 她修订的 / 你修订的」。不再显示「第 N 版」——真实接口的 `revision` 也会在确认、争议时自增，会把状态变化误读成内容改了很多次。
- 「她后来还记过」：被替代时链接到新的那条；`conflictGroup` 相同时给出「她还有一种说法」并可跳转对照。
- 动作区与修订表单：修订为主按钮，固定/暂时不用为并排胶囊，争议与删除保持次级；保存/确认/固定/归档/恢复/争议/删除各自有忙碌态、成功提示与失败说明；动作成功直接用响应刷新当前卡片与旧版本，不再整页重载。
- 加载改为内容形状骨架；失败与未找到分开：读取失败可以「重新读取」，找不到时说明可能已删除并提供「返回星轨」，两者都不再是死路。
- DEBUG 直达：新增 `orbit-memory-detail`、`-candidate`、`-pinned`、`-archived`、`-disputed`、`-superseded`、`-conflict`、`-long`、`-missing`、`-dismissed` 十条示例路由，接入 `AppStore`、`MainTabShell` 与 `scripts/ios-dev.py`；新增真实账号只读入口 `--open-memory=<uuid>`（配合 `SIMCTL_CHILD_ASTELLA_API_TOKEN`，不写 token、不改数据）。

真实契约核对（`outputs/ios-memory-api-probe-2026-10-22/report.md`）：详情仍用 `GET /companion/memory?focusMemoryId=…` 取当前这条，未知/已删除 id 返回 200 + 列表，所以由客户端合成「找不到」；`GET /companion/memory/:id/revisions` 只含旧版本、按新到旧；服务端时间戳带毫秒，日期解析补了 `withFractionalSeconds`，否则「今天/昨天」永远不生效；`dismissedAt` 非空的记忆仍是 `candidate=true`，界面按「已忽略」单独处理，避免再次出现采用按钮。

验证（本机模拟器）：

- `python3 scripts/ios-dev.py build` 通过；十条示例路由逐条截图，覆盖正常、候选、固定、归档、争议、替代、相似说法、200 字长正文、未找到、已忽略；默认、`--dark`、`accessibility-extra-large` 下均无截断与重叠。
- 真实链路：用探测账号的会话 token 以真实模式打开 `--open-memory=<active id>`，页面显示服务端的真实记忆（内容、种类、来源、时间均为接口返回值），确认不是只对示例数据可用。
- 独立验收（另一名 agent，只读）：10 条示例路由逐条截图，确认没有网络错误、没有无限骨架、missing 不是死路；预览模式下 45 秒内 API 日志里 memory/awareness 请求为 0；真实链路用探测账号 token 打开 active/candidate/revised/extractor 四条记忆，内容、来源句、日期与抓包 JSON 一致（「今天」说明毫秒时间戳解析生效）；暗色、长正文、减少动态正常。验收发现并已修复：
  - 预览模式的动作（采用/暂不采用/固定/暂时不用/争议/删除/保存修订）此前没有隔离，点击会重新触发 `status 0` 的「暂时连接不上书房」。现在预览动作只在本地演示状态，并明确标注「不会写入真实账号」。
  - 悬浮伴星浮钮会压住本页操作按钮；本页改为进入时隐藏浮钮（与脑图页同一做法），离开时恢复。
  - 真实 `appliesWhen` 本身就以「当」开头，页面又加了一次前缀，显示成「当 当用户…」；改为直接展示服务端原文。
  - `sourceType=model_inferred` 且 `sourceSpeaker=user` 时，来源句说「不是你原话」、meta 又说「你的原话」；现在 meta 统一写成「由你的话推断」。
  - 只有正文按辅助字号放大的问题：来源句、旧版本、适用范围文字也改为随 Dynamic Type 缩放，并限制上限避免极端字号撑破卡片。
  - 本页补上「界面预览 · 本地示例」标记；`revision` 因确认/争议自增留下的相同正文快照不再显示成「N 次修改」，改为「只有状态变化」；旧版本时间补到「至 10 月 22 日 15:26」，同一天多次修改也能区分；被替代的记忆不再提供修订/固定；争议后重新读取旧版本；补充 `-loading`、`-error`、`-goal` 三条示例路由，用于查看骨架、通用失败与有效期行。
- 仍未覆盖：模拟器没有可用的触控自动化，采用/暂不采用、固定、归档、争议、删除、保存修订这些动作只按接口契约、代码路径与本地状态演示核对，未执行真实点按；实体设备帧率与触感同样未验。真实模式下右下角伴星浮钮显示为空白白圈（模型/材质下载与 Live2D 裁剪属 Shell 范围，不是本页引入），需要单独排查。

## 验证与限制

验证环境：iPhone 17、iOS 27.0 模拟器（`B669C1D3-56BF-4DAF-992B-BAE49FC738D4`），Xcode 27，Debug。使用带“界面预览 · 本地示例”标识的本地内容，未调用真实 AI 生成、语音或写入接口。截图均通过 `scripts/ios-dev.py open <route>` 直达路由启动后用 `simctl` 截取，没有在两个页面之间重复构建。

已检查：

- 页面族：相伴首页、记录、书房（正常／加载骨架／空态／失败重试）、阅读（正常／加载）、星轨的三个分段（日记／伴星记忆／手边）、日记详情、我的（顶部与底部设置），以及手记子页：速览、脑图、批注、版本、拓展（含已收下状态）、学习卡、练习、结果（82 分与 0 星）。全部路由逐一启动并截图，布局完整、状态可读，没有空白屏或启动崩溃。
- 字体：中文全部由系统苹方（PingFang SC）呈现，西文与数字使用系统圆体设计。工程内没有字体文件、`Info.plist` 字体注册或资源阶段引用；用户否决的中文全圆体（ChillRoundF）下载包已从工程删除，删除后重新构建通过。
- 底栏与伴星最小态：iOS 27 的系统 `TabView` 选择透镜、同一行右侧 `TabRole.prominent` 伴星入口正常出现；进入详情页后主底栏收起、只保留右下角伴星浮钮，回到一级页恢复。
- 导航：运行日志 `StudyNavigation depth=2 enabled=1` 覆盖阅读与全部手记子页，说明隐藏导航栏后系统侧滑返回手势实际恢复；一级页为 `depth=1 enabled=0`。伴星独立入口出现时调用 `returnToConversation`，回到相伴首页；两处此前发现的返回问题都已有对应实现。
- 动效与降级：`--ui-reduce-motion` 下首页与星轨不运行动画循环；`--ui-dark` 下底栏、阅读、星轨和日记仍可读；大字号（`accessibility-extra-large`）下首页、书房与阅读没有截断或重叠。
- 按压反馈与弹性：源码检查确认小圆控件为横向轻展、纵向轻压的可中断弹簧，大面积为轻微明暗；本轮没有真实触控执行，见下方限制。

验证截图（存于 50% 尺寸，便于随文档保存）：

| 截图 | 内容 |
| --- | --- |
| [01-companion-home.png](assets/ios-moonroom-2026-10-22/01-companion-home.png) | 相伴首页：系统苹方标题、角色场景、输入区与系统底栏 |
| [02-records.png](assets/ios-moonroom-2026-10-22/02-records.png) | 记录：真实会话中的用户气泡与伴星消息 |
| [03-library.png](assets/ios-moonroom-2026-10-22/03-library.png) | 书房：搜索、继续阅读与手记列表 |
| [04-reader.png](assets/ios-moonroom-2026-10-22/04-reader.png) | 阅读：苹方正文、原生选区、底部工具胶囊与伴星浮钮 |
| [05-orbit-starfield.png](assets/ios-moonroom-2026-10-22/05-orbit-starfield.png) | 星轨：页首星空与下方日记分段 |
| [06-diary.png](assets/ios-moonroom-2026-10-22/06-diary.png) | 日记详情：日期区、正文与继续聊天入口 |
| [07-note-overview.png](assets/ios-moonroom-2026-10-22/07-note-overview.png) | 手记速览：主线、要点与原文引用 |
| [08-note-learning-card.png](assets/ios-moonroom-2026-10-22/08-note-learning-card.png) | 学习卡：最佳成绩、题量与再练一次 |
| [09-loading-skeleton.png](assets/ios-moonroom-2026-10-22/09-loading-skeleton.png) | 书房加载：按真实内容形状铺开的骨架屏 |
| [10-error-retry.png](assets/ios-moonroom-2026-10-22/10-error-retry.png) | 书房失败：错误说明与重新加载 |
| [11-dark-orbit.png](assets/ios-moonroom-2026-10-22/11-dark-orbit.png) | 深夜：底栏、日记卡与星空在深色外观下可读 |
| [12-large-type-library.png](assets/ios-moonroom-2026-10-22/12-large-type-library.png) | 大字号：书房在系统无障碍字号下不截断 |
| [13-reduced-motion-orbit.png](assets/ios-moonroom-2026-10-22/13-reduced-motion-orbit.png) | 减少动态：星轨保留静态星空，不跑流星循环 |

未覆盖与限制：

- 本会话环境没有 Simulator 图形界面或触控自动化（`Simulator.app` 不存在，`idb`／`cliclick` 未安装），无法执行真实点按、键盘输入、双向侧滑和快速重复点按。伴星独立入口的返回、隐藏导航栏后的侧滑返回只做了源码与运行日志核对，不能写成触控验收通过；键盘遮挡与返回手势的手感仍需要带窗口的模拟器或实体设备补验。
- 未在实体 iPhone 上验证帧率、耗电、麦克风／扬声器、Live2D 下载或真实后端长文链路；未覆盖 iOS 18／26 的降级外观，本轮结论只适用于 iOS 27 模拟器。
- 链接阶段现有的 Cubism 静态库警告与基线一致：库按 iOS Simulator 26.2 编译，项目部署目标为 18.0。

构建耗时与日志保存在 `/tmp/astella-ios-dev/`。改动前基线构建约 134 秒；页面批次的成功增量构建已记录为 47.23、34.02、27.51、19.96、11.10、24.04、18.85、18.51 秒，本轮字体收尾批次为 16.91 秒。失败记录也保留在 JSONL，包括一次辅助名称重复和一次 Xcode 文件 ID 冲突，修复后重新构建成功。

### 2026-10-22 手记卡去掉右上角箭头

用户截图标注书房「全部手记」两列卡右上角的 ↗ 箭头并写「去掉」，iOS 按图调整：

- 改动：`ios/Astella/Screens/NotesScreen.swift` 的 `NoteListRow` 删掉右上角 `arrow.up.right` 及包住它的 `HStack`，卡片顶部只保留 38pt 首字徽标；标题、摘要、日期、卡片高度、两列网格与整卡点按进入阅读的导航均未改。Android 未改。
- 验证：`python3 scripts/ios-dev.py build` 通过（增量 9.18 秒）；`NotesScreen.swift` 无新增 warning，24 条 warning 全是既有 Cubism 链接版本提示与 AppIntents 元数据提示。`python3 scripts/ios-dev.py open library` 直达书房示例路由，`simctl` 截图确认 5 张手记卡右上角箭头全部消失，徽标／标题／摘要／日期位置不变，网格未错位。
- 未覆盖：只截图核对了默认外观下的书房网格；暗色、大字号与真实账号数据下的卡片未另拍（本次只删一个静态灰色箭头，不涉及配色、字号或接口）。未做实体设备与触控复核。

| 截图 | 内容 |
| --- | --- |
| [30-library-card-no-arrow.png](assets/ios-moonroom-2026-10-22/30-library-card-no-arrow.png) | 书房：手记卡右上角箭头已去掉 |

### 2026-10-22 书房长按改名与删除

用户要求「不是加删除按钮，是长按一个卡片调出重命名和删除菜单」，iOS 按这个交互实现：

- 交互：`ios/Astella/Screens/NotesScreen.swift` 的「全部手记」两列卡仍是点按进入阅读；长按弹系统 `contextMenu`，只有「重命名」「删除」两项，页面不新增常驻按钮。菜单只对当前书房拥有者出现（`AppStore.canManageNotes`，与服务端 `requireOwner` 同一条判据），成员长按不弹菜单。
- 重命名：系统 `alert` 单行编辑，预填当前标题，最多 200 字符；清空或没改视为取消。提交走 `PATCH /v2/notes/:id`（`{version:1,title,baseVersionId}`），`baseVersionId` 用列表接口带回的 `currentVersionId`，搜索结果没有这个字段时先取一次详情。标题只写进文档 `meta` 并投影回 `notes.title`，正文与版本号都不变；成功后本地把标题与 `updated_at` 一起更新并按服务端排序规则移到最前。
- 删除：先弹确认（「会移入回收站，之后可以在电脑端找回」），确认后走 `DELETE /notes/:id`（软删除）。成功移除卡片并浮出 8 秒的「已移入回收站 · 撤销」胶囊；撤销走 `POST /notes/:id/restore`，并按原 `updatedAt` 把卡片插回列表原位。失败按状态码给出「网络／登录过期／只有拥有者可以…／已经不在书房里／刚有改动」的说明，不隐藏列表。
- 数据层：`ios/Astella/App/Models.swift` 的 `NoteSummary` 增加 `currentVersionId` 和 `updatedDate`（列表日期格式化改用它，删掉重复解析）；`ios/Astella/App/Store/NotesMethods.swift` 增加 `renameNote / deleteNote / restoreDeletedNote` 与本地顺序维护；示例模式（`--ui-review`）只改本地示例数据，不请求网络。
- 复核入口：新增 `library-rename`（改名对话框）、`library-delete`（删除确认）、`library-deleted`（删除后的撤销条）、`library-rename-done`（改名后的列表）四条 Debug 直达路由，接入 `AppStore` 的示例模式与选中页、`scripts/ios-dev.py`。

验证：

- 构建：`python3 scripts/ios-dev.py build` 通过（首次 18.82 秒，最终批次增量 1.39 秒）；Swift 编译无新增 warning。
- 示例模式截图（`simctl` + 四条直达路由）：改名对话框预填「赤壁赋」并显示「只改标题，正文和版本都不动。」；删除确认显示标题与回收站说明；删除后「全部手记」从 5 篇变 4 篇、赤壁赋卡片与「接着上次读」一起消失、底部浮出撤销条；改名后「接着上次读」与网格卡同时显示「赤壁赋 · 月夜泛舟」、日期变「今天」。
- 真实接口链路（本机 API `http://127.0.0.1:4000`，`clientKind=mobile` 的会话，临时笔记验完永久删除）：`GET /notes` 确实带回 `currentVersionId`；按客户端同一 payload 调 `PATCH /v2/notes/:id` 返回 200 committed，`versionNo` 仍为 1（标题写入不新建版本），列表标题已更新；`DELETE /notes/:id` 返回 204 后列表消失、`?trashed=true` 可见；`POST /notes/:id/restore` 恢复后标题与卡片都在；最后软删 + `DELETE /notes/:id/permanent` 清理，回收站里也查不到。脚本与日志见 `apps/mobile-client/outputs/library-note-actions-2026-10-22/api-probe.{py,log}`。
- 未覆盖：本机没有可用的模拟器触控自动化（`Simulator.app`、`idb`、`cliclick`、`axctl` 均不可用），因此**长按手势本身、菜单项点按与撤销按钮点按没有做真实触控复核**；菜单、对话框和撤销条是分别用直达路由铺出后截图的。示例模式下的改名/删除/撤销只证明界面与本地状态机，不能替代真实账号点按。Android 未改。

| 截图 | 内容 |
| --- | --- |
| [31-library-rename-dialog.png](assets/ios-moonroom-2026-10-22/31-library-rename-dialog.png) | 重命名对话框：预填标题，正文与版本不动 |
| [32-library-delete-confirm.png](assets/ios-moonroom-2026-10-22/32-library-delete-confirm.png) | 删除确认：移入回收站、可在电脑端找回 |
| [33-library-deleted-undo.png](assets/ios-moonroom-2026-10-22/33-library-deleted-undo.png) | 删除后：卡片与继续阅读消失、浮出撤销条 |
| [34-library-renamed.png](assets/ios-moonroom-2026-10-22/34-library-renamed.png) | 改名后：两处标题同时更新、日期变今天 |

### 2026-10-22 手记目录（iOS 悬浮窗）

用户先在手记阅读页截图里标注页头「书房」与「字」之间的空位，要求加目录按钮；随后纠正两点：**目录只列多级小标题，不是段落**，并且要**点击后展开的悬浮窗**，不要底部抽屉。

- 页头：`Screens/Notes/NoteReader.swift` 的 `readerHeader` 在返回胶囊与「字」之间新增 44pt 纸白圆钮（自绘 `AstellaGlyph .outline`），顺序为 书房 / 目录 / 字 / 更多，间距 10pt；402pt 屏上四枚控件不重叠。
- 目录层级：新增 `Screens/Notes/NoteOutline.swift`。只收 `type == "heading"` 的块，级别按客户端投影解析（`packages/shared/src/note/note-doc-schema.ts` 的 heading case）：`<hN>` 标签、`#{1,6}\s` 前缀，缺标记按 2 级；标题文字按正文同样顺序去掉 `<hN>`／`#` 标记，再用 `AttributedString(markdown: .inlineOnly)` 还原行内格式，避免正则删字符把 `snake_case`、`5 * 3` 吃掉。
- 悬浮窗：系统 popover（`.presentationCompactAdaptation(.popover)`）挂在按钮上，箭头指向按钮，纸白背景、细边；内容为「目录 / 第 N 版 · M 节」、关闭按钮、按层级缩进的标题行；缩进相对最小层级每深一级 +13pt，行高 44pt，当前节钴蓝＋右侧圆点，打开时用 `ScrollViewReader` 把当前节滚进可视区；没有小标题时给一句空态说明，按钮仍在。点标题收起并跳转，点窗外或关闭按钮收起。
- 跳转：`NoteReaderJump`（自增 id）由 `NoteReader` 发出；`NoteWebReader` 在正文未渲染或正在重渲染时先挂起，渲染完成再调用 `reader.js` 新增的 `window.scrollNotesToBlock(ordinal, smooth)`，平滑滚到块顶（约 0.4 秒；系统或应用内「减少动态」时传 `smooth=false` 瞬时到位）；同一节可重复触发。可见块改由 `NoteReaderPosition` 小对象上报（不触发 SwiftUI 失效），目录打开时读一次——打开位置恢复仍然保持删除，这次只服务目录高亮。
- 正文层级：`NotesWeb/reader.js` 的 heading 渲染同步按同一规则输出 h1–h6，`reader.css` 给 h1 1.2×、h2 1×、h3 0.86×、h4–h6 0.78× 的 heading-size；旧样式只定义 h2、其余落回浏览器默认，这次一并修正。
- 示例与路由：新增 `note-outline`（5 个 2/3/4 级标题，自动展开目录）、`note-outline-empty`（无标题空态）、`note-outline-jump`（跳到第二节）三条 Debug 直达路由，接入 `AppStore.swift`、`MainTabShell.swift` 与 `scripts/ios-dev.py`；示例正文只用本地数据，不调用 AI、不写接口。Android 未改。

验证（iPhone 17 / iOS 27 模拟器 `B669C1D3-56BF-4DAF-992B-BAE49FC738D4`，Xcode 27，Debug）：

- 构建：`python3 scripts/ios-dev.py build` 通过；触及文件无新增 Swift warning，既有 Cubism / AppIntents 链接提示与基线一致。期间一次构建被工作区里并发编辑的 `LAppModel.mm`（23:07 的未完成保存）挡住，等作者改完（23:10）后重建通过，本次改动本身没有报错。
- 截图：`read` 页头四枚控件（35）；`note-outline` 展开目录、5 节、2/3/4 级缩进与当前节高亮（36）；深夜外观（37）；无小标题空态（38）；`note-outline-jump` 跳转后「箫声与悲意」落在正文顶部、h3/h4 字号递减可见（39）。
- 跳转链路：`note-outline-jump` 用与目录行相同的 `jumpToBlock` 入口触发；该 Debug 路由在正文上报首段后再等 4 秒才跳，便于观察动画本身。截图确认正文从顶部滚到第二节（39）；目录能读到当前可见块（36 的「夜游赤壁」高亮）。
- 平滑滚动：`simctl io recordVideo` 录下跳转过程，`ffmpeg` 按 10fps 抽帧。默认外观下滚动发生在连续 4 帧（约 0.4 秒）内逐帧位移，到「箫声与悲意」后停住（40 是其中 4 帧）；`--ui-reduce-motion` 下同一跳转只跨 1 帧完成，即瞬时到位。
- 未覆盖／限制：本机没有模拟器触控自动化，**真实点按「目录」、点标题、点窗外收起没有做真实触控复核**，只按代码路径与系统 popover 行为核对；超长标题的两行截断、超过 8 节时打开目录自动滚到当前节只做了源码核对；减动态、横屏、实体设备手感未验。模拟器 WebKit 冷启动页面加载约 6–22 秒，截图统一等 28–30 秒。Android 未改。

| 截图 | 内容 |
| --- | --- |
| [35-reader-outline-button.png](assets/ios-moonroom-2026-10-22/35-reader-outline-button.png) | 阅读页头：书房 / 目录 / 字 / 更多 |
| [36-note-outline.png](assets/ios-moonroom-2026-10-22/36-note-outline.png) | 目录悬浮窗：2/3/4 级缩进、当前节高亮 |
| [37-note-outline-dark.png](assets/ios-moonroom-2026-10-22/37-note-outline-dark.png) | 深夜外观下的目录悬浮窗 |
| [38-note-outline-empty.png](assets/ios-moonroom-2026-10-22/38-note-outline-empty.png) | 无小标题时的空态说明 |
| [39-note-outline-jump.png](assets/ios-moonroom-2026-10-22/39-note-outline-jump.png) | 从目录跳转后正文落在第二节 |
| [40-note-outline-scroll-frames.png](assets/ios-moonroom-2026-10-22/40-note-outline-scroll-frames.png) | 跳转过程按 10fps 抽的 4 帧：平滑滚动的中间位置 |
