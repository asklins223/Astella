# 设计参数与动效合同（双端唯一参数源）

日期：2026-10-15 建立。本文件是 iOS 与 Android 共享的设计参数合同：动效、间距、圆角、字阶与伴星事件映射的**唯一权威参数源**。任何动效/间距/层级调整先改本表，再改两端代码；两端参数必须同值（实现用各自平台原语：iOS `spring(duration:bounce:)`，Android `spring(stiffness, dampingRatio)`，换算关系随数值一同记录）。

状态：动效合同与结构已定；iOS 实测值随 iOS 设计系统 token 化回填，Android 映射随 Android 对齐阶段回填。表格中的「待回填」在对应阶段完成前不构成验收依据。

## 一、动效合同（原则）

1. **默认弹性、可中断、可反转**：一切状态变化使用 spring 物理；过渡跟随最新意图，快速往返、连续输入与打断时保持连贯。弹性是默认而非例外。
2. **功能与焦点不等待动效**：操作立即生效，焦点路径与可用性不被动画阻塞。
3. **连续性**：菜单/面板从所点控件的实际位置展开、关闭收回来源；连续点击、反向返回、关闭中再打开接续当前几何；退出层只有视觉作用，不参与定位、滚动或操作。
4. **共享元素**：列表→详情、输入区→消息气泡、页头→选区伴星等跨页承接使用共享元素转场（iOS `matchedTransitionSource`，Android shared element / 同构 spring 位移退化方案）。
5. **reduceMotion 降级**（系统减少动态或 App 内「手动减弱」）：粒子→静态波形条；飞行/共享元素→短淡入淡出就位；Live2D→静止或 PNG 降级；直接就位并清理退出层。
6. **动效偏好口径**：App 设置只提供「跟随系统减少动态」与「本机手动减弱动效」两项；跟随系统 + 本机覆盖、不跨设备同步；不提供动效风格/时长调节。

## 二、逐条动效表（自方案 51 §4.2a 升格，2026-10-15）

以下操作层级表 2026-10-11 来自真实 Demo 走查，2026-10-15 起升格为原生动效合同的基准素材；原型证据仅作手感参考，正式参数以本文件后续各表为准。

| 操作 | 呈现与返回 |
| --- | --- |
| 菜单／书房／递材料 | 从所点控件的实际位置展开，按可用空间避让；关闭收回来源 |
| AI 说明、选择已有笔记 | 从所选行接续到面板；返回只退一层，恢复父层位置和触发行；关闭整组回到底页 |
| 伴星中心、个人中心、设置与子页 | 独立内容页，复用现有页面进退；逐层返回真实来源，账户切换清理旧展示 |
| 打开笔记／图片／修改对照 | 详情推入（共享元素 zoom），返回退出并露出原来源；保留实际对象、阅读位置和段落选择 |
| 一级分区、内容类型、修改前后 | 选中玻璃垫连续移动，内容立即切换；一级分区保留各自位置，输入框只在对话 |
| 左沿右滑、拖动面板标题 | 跟随手指，距离不足／取消则回弹；满足返回条件接回上一层 |
| 发送与到达 | 消息就地递入（从输入区共享元素飞入），发送后回到输入；状态更新保留输入节点、光标及选区，不重建整屏 |
| 拖文件／图片给伴星（2026-10-15 新增） | 缩略图跟随手指（微旋转、速度拉伸阴影）→ 松手沿贝塞尔曲线飞向伴星缩成光点 → 伴星三拍反应（眼神跟上→身体前倾→胸口光晕涟漪）→ 输入区「已添加」chip；失败时光点散成轻烟 + 行内错误面板 |
| 选段交给伴星（2026-10-15 新增） | 迷你伴星从页头飞抵选区（共享元素），选区亮成光带 → 底部纸面 sheet 升起流式呈现；确认后选区逐字替换波浪动画；取消光带退回选区消失 |
| 「+」二级菜单（2026-10-15 新增） | 项圆形图标从 + 位置弹簧散开（stagger 24ms），轻遮罩，点外关闭；收起向 + 归位 |

## 三、MotionTokens（iOS 值已定（阶段 2 实测），Android 换算已回填（阶段 7））

| 语义名 | 用途 | iOS | Android（换算） | reduceMotion 降级 |
| --- | --- | --- | --- | --- |
| press | 主按钮按压缩放 | `spring(duration: 0.22, bounce: 0.06)`（scale 0.985） | `spring(dampingRatio 0.94, stiffness 255)` | 无缩放，仅颜色/透明反馈 |
| pressSoft | 次级按钮按压缩放 | `spring(duration: 0.2, bounce: 0.04)`（scale 0.99） | `spring(dampingRatio 0.96, stiffness 305)` | 无缩放，仅颜色/透明反馈 |
| routePush | 页面推入/退出 | `spring(duration: 0.32, bounce: 0.06)` | `spring(dampingRatio 0.94, stiffness 120)` | 短淡入淡出（120ms） |
| segment | 分段/页签切换 | `spring(duration: 0.38, bounce: 0.08)` | `spring(dampingRatio 0.92, stiffness 85)` | 即时切换+淡入 |
| menuStagger | 菜单项散开间隔 | 24ms | 24ms | 0ms（整组淡入） |
| messageSend | 气泡飞入 | 待回填（阶段 5 定义） | 待回填 | 淡入就位 |
| absorbFlight | 吸收飞行 | 待回填（阶段 5 定义） | 待回填 | 缩略图淡出+chip 直接出现 |
| selectionBeam | 选区光带亮起/退回 | 待回填（阶段 5 定义） | 待回填 | 选区底色变化 |
| sheetRise | 底部 sheet 升起 | 待回填（阶段 5 定义） | 待回填 | 淡入 |

代码落点：iOS `ios/Astella/Design/Motion.swift`（`Motion.*` + `Motion.gated` 统一门控）；Android `ui/design/MotionTokens.kt`（`MotionTokens.*` + `enabledMotion()` + `Modifier.pressScale`）。换算式 `dampingRatio = 1 - bounce`、`ω0 ≈ 3.5 / duration_s`、`stiffness = ω0²`（2026-10-15 阶段 7 回填）。

## 四、间距 / 圆角 / 字阶（iOS 值已定（阶段 2），Android 映射已回填（阶段 7））

- 间距 scale（`StudySpacing`）：xs 4 / sm 8 / md 12 / lg 16 / xl 20 / xxl 24（dp/pt 同值）。
- 圆角 scale（`StudyRadius`，全部 continuous）：sm 10 / md 14 / lg 16 / xl 20 / xxl 24；纸面默认 lg、按钮胶囊。原调用点的 15/17/18/21 魔法值已归一到最近档（2026-10-15）。
- 字距（`StudyTracking`）：largeTitle −0.45 / title −0.25（iOS 实测）；Android typography **letterSpacing 全 0**（`ui/design/TypeTokens.kt`，不抄 iOS 负字距——Roboto 负 tracking 发糊），lineHeight 按 iOS lineSpacing 感觉取 sp 显式值（headlineLarge 41 / titleLarge 28 / titleMedium 25 / bodyLarge 23 / bodyMedium 21 / bodySmall 18）。
- 字阶：iOS 系统字阶；Android M3 slot 映射：headlineLarge 34 / headlineMedium 28 / titleLarge 22 / titleMedium 20 / bodyLarge 17 / bodyMedium 15 / bodySmall 13 / labelMedium 12 / labelSmall 11。
- 颜色：iOS 系统语义色（`StudyPalette`，blue/blueDeep 已合并为 accent）；Android M3 角色映射（`ui/design/ColorTokens.kt`）：ink→onSurface、muted→onSurfaceVariant、accent→primary（固定系统蓝，不用 Material You 动态取色）、sky→primary 9% alpha、canvas→background、paper→surface、inset→surfaceVariant、paperEdge→outline、success→tertiary（自定义绿）、danger→error；surfaceContainer 七槽显式中性值替换 M3 baseline 紫调。两端业务代码只用语义名（ink/muted/accent/canvas/paper/inset/paperEdge/success/danger）。

## 五、伴星事件 → Live2D 动作映射（两端共用；代码落点 `ios/Astella/Companion/CompanionEvents.swift` 的 `CompanionEventMap`，阶段 4a 定表，4b/9 绑定核对）

| 事件 | expression | motion | PNG 降级微反应（已实现参数见 CompanionStageView.react） |
| --- | --- | --- | --- |
| idle | — | "Idle"（4b 核对条目名） | 无 |
| attention（拖拽悬停/选区工具条出现） | — | 视线跟随（ParamAngleY/ParamEyeBallX） | 有 |
| absorb(true)（文件/图片吸收成功） | "surprised" | 前倾类 motion（4b 绑定） | scale 0.97→1.03→1 弹簧脉冲 |
| absorb(false)/fail | "question" | 歪头（4b 绑定） | rotation −2°→0 |
| thinking（回合运行中） | — | 循环 motion（4b 绑定） | opacity 1→0.85→1 单次 |
| speak（TTS 播放） | — | 口型 ParamMouthOpenY（mouthOpen 驱动） | 0.6s 呼吸 scale 循环 |
| reduceMotion / PNG 降级 | 静止或静态图 | 见降级路径 | 全部微反应冻结 |

## 六、粒子参数（阶段 5/9 回填）

| 语义名 | 用途 | 参数 |
| --- | --- | --- |
| voiceRecord | 录音侧：麦克风振幅驱动伴星身周粒子 | 待回填（粒子数/半径/阻尼/色） |
| voiceSpeak | 回复朗读侧：自口部涌出波带 | 待回填 |
| reduceMotion | 降级为静态波形条 | 固定条数/低饱和 |
