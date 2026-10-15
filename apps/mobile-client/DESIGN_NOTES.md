# 手机端界面设计心得与官方依据

日期：2026-10-14。本文从登录页的重设计提炼跨页面可复用的方法，供 iOS SwiftUI 与 Android Jetpack Compose 后续界面使用。它记录的是设计判断和推导方式；具体页面仍应围绕自己的内容与任务构图，不应被一套固定模板限制。正式实现约束见[原生手机客户端界面与动效规范](DESIGN_SPEC.md)。修订：2026-10-15——动效参数与节奏双端必须一致（以 [DESIGN_TOKENS.md](DESIGN_TOKENS.md) 双端参数表为准），弹性运动是默认而非例外，实现仍用各自平台原语。

## 这次登录页带来的设计心得

登录页的高级感主要来自清楚的层级和克制，而不是更多装饰。品牌标记先说明“这是哪个产品”，主标题再说明“用户回来做什么”，简短副文案交代同步收益。背景留给内容呼吸，系统蓝只承担主要操作和可识别的文字链接；不靠彩色渐变、发光描边或重复卡片制造存在感。

表单不需要先被包进一个大容器。邮箱和密码各自就是清楚、可触达的输入控件：标签留在输入框外，提示给出可理解的格式，焦点和验证状态能就地反馈。iOS 26 及以上可以把系统 Liquid Glass 直接用于可交互输入表面；本次输入框使用 `glassEffect(.regular.interactive())`，主操作使用系统 `.glassProminent`，让材质反馈跟随触摸和焦点。iOS 18 使用稳定、清晰的系统表面回退。玻璃放在输入、导航和短操作等真正可操作的地方，整页背景、说明文字和长内容不做成玻璃。

认证是一个任务流程，不应把所有能力同时塞进首屏。登录优先呈现邮箱与密码；忘记密码靠近相关流程；验证码登录作为清晰的替代路径；创建账号、邮箱验证和重置密码按步骤展开。每一步只保留该步要填的信息、下一步动作和返回路径。页面切换时保留已输入内容，错误说明紧邻问题并告诉用户怎样修正。

认证流程还需要视口稳定：用户切换登录方式、注册步骤或重置密码时，页面不应意外滚到别处。键盘出现后用紧凑构图收起品牌说明和页脚，把当前输入、反馈与继续操作留在可见范围；紧凑仍放不下时，只允许在表单区内滚动，不裁切字段、错误提示和主操作，也不让整页漫游。错误反馈应占据完整、稳定的行内区域，说明“哪里没完成”和“下一步怎么处理”；把后端泛化的“请求错误”直接显示成一小块红字，既不能帮助修复，也会破坏表单节奏。

这也是跨平台一致性的正确尺度：两端共享品牌、信息优先级、字段语义、文案意图、流程状态和主次关系；组件形状、键盘、导航手势、焦点、材质 API 与系统反馈由各自平台实现。iOS 使用 Apple 的 Liquid Glass 能力；Android 不宣称有同一个 Apple 材质，而是用 Compose 与 Material 3 组成同样轻、清楚、可操作的视觉层级。

## 后续页面可复用的设计方法

设计页面前，先回答几个具体问题：

1. 用户此刻正在做什么，屏幕最重要的内容或对象是什么？
2. 完成当前任务最关键的一步是什么，操作后应该看到什么真实状态？
3. 哪些元素属于内容，哪些元素属于导航或操作？玻璃是否能帮用户辨认这条边界？
4. 页面切换、键盘出现或内容更新时，哪些草稿、阅读位置、焦点和选择必须保留？
5. 用户在大字号、深色外观、减少动态、屏幕阅读器和较小屏幕下还能否完成同一件事？

据此选择最适合任务的页面骨架。不要因为登录页有输入面就给所有页面套表单卡片，也不要因为 Liquid Glass 是系统新材质就把每个区块都做成玻璃。

| 页面类型 | 视觉重心 | 适合的表达 |
| --- | --- | --- |
| 对话 | 伴星、当前交流和输入 | 伴星场景与完整记录保持同一会话；玻璃留给输入和短操作；正文与历史记录保持稳定易读 |
| 书架与搜索 | 找到或继续一份手记 | 搜索、标题、摘要、更新时间建立浏览层级；条目按内容密度采用列表或轻量预览，不给每行强套厚卡片 |
| 手记阅读 | 原文和正在读的位置 | 连续、稳定的纸面与清楚的文字节奏；目录和批注按需出现；悬浮操作不遮住原文 |
| 版本 | 内容如何随时间变化 | 保存时间线、当前版本和差异并列关系清楚；恢复动作与查看动作分开，避免用户误以为只是预览 |
| 讲解与学习 | 当前问题、材料和理解进度 | 让材料与当前步骤成为主体；解释、问题和回答围绕同一内容推进，不退化成后台统计面板 |
| 思维图 | 可操作的关系画布 | 画布获得主要空间；缩放、选择、定位等工具靠近画布但不遮挡；详情从被选节点就近展开 |
| 手边任务 | 真实进度与下一步 | 明确展示实际状态、可用操作和结果；不编造进度，不让状态卡重复呈现同一信息 |
| 个人与设置 | 身份、设备和偏好 | 按用户目标分组，先呈现当前状态，再展开相关选项；避免把简单偏好排成密集控制台 |

这些是起步方式，不是页面模板。长内容、学习材料和可操作画布应该获得主要空间；导航和工具围绕内容出现。信息分组、留白、位置、字重和尺寸先建立层级，阴影与材质再说明真正的前后关系。

这次把登录页的克制原则继续带到已登录页面时，最有用的检查点是：不要把统一误解为每页套同一个结构。对话让伴星和输入成为重心；书架用搜索和轻量条目；阅读保留连续纸面；版本用时间轨迹；设置按偏好分组。速览、脑图与讲解在没有生成结果时，也要告诉用户当前手记会怎样被整理：速览给主线和原文依据，脑图说明节点层级，讲解说明主题、讲述与引用的对应关系。这样的预览只说明输出契约，不伪造内容；主操作留在安全区，读者一眼能明白下一步。

阅读页还说明了一个细节：每段常驻一个“更多”图标，会把注意力从原文拉到控件上。让段落本身响应长按，再在触点附近出现批注和讲解操作，内容页就能维持安静；菜单使用当前平台的中性色面与轻层次，避免突然引入另一套装饰色。这个做法仍需把操作标签提供给辅助功能，并保留明显、可发现的操作提示。

## 从实机复审里补上的判断

设计稿或组件代码看起来齐全，不代表真实屏幕的重心已经成立。复审时把整屏作为一个纵向构图来读：如果人物、标题、说明和下一步之间隔着大块无含义的空带，就要把它们收成一个完整场景，再看剩余空间是否自然。对话欢迎态适合让伴星、问候和快捷提问彼此靠近；只有一篇手记时，用那篇手记的真实摘要和更新时间建立内容层级；手边空态用一个状态说明和明确出口，避免“数量为零”与“没有内容”重复讲同一件事。

编辑控件也必须在真实窗口里可见。白底表单里的透明边框会让输入框像消失了一样；没有未保存更改时仍显示高亮“保存”，会让用户误以为可以继续。输入面应有轻量但清楚的系统表面，保存状态应由实际内容差异驱动。这些不是装饰收尾，而是页面结构和操作语义的一部分。

后续复审又发现，“留白”不能靠把内容推到顶部、把操作钉在底部来凑。一个空页面仍要形成完整的视觉单元：真实状态、简洁解释和一条下一步彼此邻近；伴星只在她是当前交流对象时承担主视觉，其他空态用更轻的状态符号即可。书架行、正文、权限说明和设置项优先靠排版、分组与细分隔建立次序；只有当一个可交互或需要辨认的对象确实需要独立表面时才包成卡片。错误提示和静态说明使用稳定表面，玻璃只放在用户能直接操作的导航、输入或短控件上。页面剩余空间应让内容自然呼吸，而不是被大卡片或重复说明填满。

## 材质与颜色：用来说明关系

Apple 在 Liquid Glass 设计中将其定义为浮在内容上方的功能层。材质用来标记导航与交互，使它们与内容保持空间关系，不应盖住内容。Apple 的 Materials 指南按语义选择材质，并展示侧栏、文本输入和按钮使用不同材质权重的例子；这说明“是否可操作、承担什么角色”比“玻璃看起来是什么颜色”更适合作为选择依据。

因此采用以下规则：

- 先区分内容层与控制层；玻璃优先用于浮动导航、分段切换、短操作和确实需要触摸反馈的输入控件。
- 连续正文、长说明、表格和复杂对照放在稳定、不模糊的表面上。不要把整张页面、整份表单或每一张内容卡都套上玻璃。
- 使用系统提供的材质和交互状态。保持文字、图标与玻璃有足够对比；背景变化时也要检查可读性。
- iOS 26 及以上使用原生 Liquid Glass API；项目最低部署版本更低时，提供不依赖该 API 的高对比表面回退。
- Android 端按 Material 3 的 Surface、颜色角色、形状与交互状态组织层级。可以呼应轻透、浮起的观感，但不要将自制半透明背景称为 Apple Liquid Glass，也不要为追求“像苹果”而牺牲 Android 的系统行为。
- 色彩以动态、语义化的中性色为主，品牌蓝承担主要动作和可交互链接；成功、警告、错误使用各自稳定的语义色。颜色之外还要用文字、图标、位置或状态形状表达含义。

## 排版、输入和文案

- 标题说明当前任务，正文说明上下文，辅助文本只在用户需要时出现；通过系统字体、字号、字重、行距和间距组成层级，不靠放大所有文字争夺注意力。
- 支持 Dynamic Type 与 Android 字体缩放。字号变大时让布局重排、内容滚动，不裁切标签、错误、辅助动作或提交按钮。
- 输入框需要持续可见的字段名称；占位符提供格式例子或输入提示，不能代替标签。密码使用安全输入；邮箱、数字验证码和一次性验证码使用合适的键盘与自动填充能力。
- 多个字段按填写顺序排列；尽可能在离开字段或提交时验证，并在字段旁说明问题与修复方式。可以继续按钮应准确反映当前是否具备继续条件。
- 文案先说具体动作或收益。少用口号、抽象承诺、夸张形容和重复解释；错误信息清晰、克制、可执行。

## 动效与触感

动效解释状态和空间关系，不替代操作本身。按下、聚焦、发送、保存、展开、返回或失败时及时反馈；弹性运动（物理 spring）是默认而非例外，不只在手势带着明确位移或惯性时才出现——参数与节奏双端一致，以 [DESIGN_TOKENS.md](DESIGN_TOKENS.md) 为准，实现用各自平台原语。所有过渡可中断、可反转：页面进退沿着用户理解的来源和方向，允许用户快速重复、反向或中断操作，不让焦点或任务等待动画结束。

系统控件自带交互动效时，优先沿用。自定义动画需要对应一个真实状态变化，并尊重 iOS 减少动态效果和 Android 系统动画时长。减少动态时仍要显示选中、成功、失败和进度等信息，只去掉不必要的位移、弹跳和循环。

## 两端实现与检查

设计先共享“页面解剖结构”：内容是什么、主次动作是什么、状态如何变化、哪些上下文要保留。再分别实现：

- **iOS：**SwiftUI 与系统控件优先。使用语义色、Dynamic Type、原生输入与键盘、导航转场和 iOS 26 Liquid Glass API；iOS 18 及以上版本仍提供完整可读、可操作的材质回退。
- **Android：**Kotlin、Jetpack Compose 和 Material 3 优先。保留稳定的中性色与品牌蓝，并完整适配深浅色主题、字体缩放、输入法、系统返回与 48dp 触控目标。
- **两端共同：**相同任务与数据语义、主要信息顺序、空态／加载／错误／成功状态和用户可执行的动作。按钮外观、导航栏与转场由各自平台原语实现，不要求逐像素相同；但动效参数与节奏双端必须一致，以 [DESIGN_TOKENS.md](DESIGN_TOKENS.md) 双端参数表为准。

页面完成后在真实模拟器或设备中检查：构图重心；浅色与深色外观；小屏和放大字号；键盘展开及遮挡；长文与长标签；焦点和屏幕阅读器顺序；系统减少动态；连续点按、快速返回与反向切换。截图能帮助比较，但必须实际操作关键流程。构建成功不代表系统材质、权限、键盘和动画已经在设备上验收。

## 2026-10-15 重新对齐 Apple 材质规则

这轮返工先核对了当前版 Apple HIG，再逐项对照原生代码。发现旧实现把 `GlassSurface` 当作名称使用：iOS 实际绘制的是不透明纸面，Android 也只是普通白色 `Surface`。这样的代码既没有实现用户要求的液态玻璃，也容易让后续页面误把内容表面当成控制层。现已将这类状态／说明区域改名为 `NoticeSurface`，让材质名称和实际用途一致。

新的落地约束是：iOS 26 及以上的输入和发送控件使用系统 `glassEffect`，主操作使用 `glassProminent`，系统 `TabView` 与导航控件使用平台提供的外观；正文、状态说明、版本内容仍放在清楚稳定的系统表面。iOS 18 回退到高对比系统材质。Android 保持 Material 3 的 `Surface`、`OutlinedTextField`、主题颜色角色和系统导航行为；不仿造苹果模糊效果，也不把普通 Surface 称作玻璃。两端的重心、信息次序、控件尺寸和文案含义一致，平台材质分别原生实现。

官方依据：Apple HIG 明确把 Liquid Glass 放在导航和功能控件层，建议谨慎使用、避免覆盖内容；颜色随底下内容动态变化，强调色只用于明确的重点操作；文本字段应有持续可见的标签和安全密码输入。因此设计审查同时看“用了什么 API”和“这层是否真是交互控件”，不会仅凭名称或半透明颜色认定已经使用 Liquid Glass。

## 查阅的官方资料

以下为本心得使用的官方参考（查阅日期：2026-10-14）。实现前应按目标系统版本重新核对 API 和平台变化。

### Apple

- [Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)：Liquid Glass 的位置、材质选择和内容可读性；用于判断玻璃应属于哪一层。
- [WWDC25: Meet Liquid Glass](https://developer.apple.com/videos/wwdc2025/219/)：Liquid Glass 的动态、适应性和设计原则。
- [WWDC25: Build a SwiftUI app with the new design](https://developer.apple.com/videos/wwdc2025/323/)：SwiftUI 标准控件、导航和自定义 Liquid Glass 的实现方式。
- [SwiftUI `glassEffect(_:in:)`](https://developer.apple.com/documentation/swiftui/view/glasseffect%28_%3Ain%3A%29)：原生玻璃效果及形状 API。
- [Human Interface Guidelines: Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)：字段标签、提示、密码保护、字段排列、输入校验和键盘类型。
- [Human Interface Guidelines: Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data)：减少输入错误，以及让必填信息满足后再继续。
- [Human Interface Guidelines: Typography](https://developer.apple.com/design/human-interface-guidelines/typography)：系统排版和动态字号的依据。
- [Human Interface Guidelines: Color](https://developer.apple.com/design/human-interface-guidelines/color)：系统语义色、不同外观下的适配和避免只用颜色表达状态。
- [SwiftUI `GlassButtonStyle`](https://developer.apple.com/documentation/swiftui/glassbuttonstyle) 与 [`GlassProminentButtonStyle`](https://developer.apple.com/documentation/swiftui/glassprominentbuttonstyle)：主次操作采用系统按钮样式，而不是用不透明圆角块冒充玻璃。
- [Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)：动效应服务理解与反馈，保持精确、克制并可取消。
- [Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)：放大文字、对比度、可感知反馈与辅助功能。
- [Human Interface Guidelines: Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)：Purpose、Agency、Clarity、Flexibility 等平台设计原则。

### Android

- [Android Developers: Configure text fields in Jetpack Compose](https://developer.android.com/develop/ui/compose/text/user-input)：Compose 输入控件、标签、密码字段与状态管理。
- [Android Developers: Autofill in Compose](https://developer.android.com/develop/ui/compose/text/autofill)：使用 `ContentType` 语义标注邮箱、用户名、密码与新密码，让系统凭据服务识别字段；验证码应按实际来源选择语义，不把邮箱验证码误标成短信验证码。
- [Android Developers: Compose accessibility API defaults](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)：Compose 语义默认值与最小触控目标。
- [Android Developers: Make composables more accessible](https://developer.android.com/guide/topics/ui/accessibility/composables)：Compose 无障碍语义、角色和操作说明。
- [Material Design 3: Motion](https://m3.material.io/styles/motion)：Material 3 的标准与表现性动效方案，以及 Compose 中的动效系统。
