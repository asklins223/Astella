# 手机端：简约玻璃与伴星交互

## 当前实施方向 — 2026-10-18

本日新增启动／恢复书房动效决定：日间采用用户选定的乳白果冻软星原画，夜间采用深蓝发光书房原画，随现有外观设置选择。该全屏阶段保留原画的材质、构图与伴星，作为常规中性页面之外的明确场景；完成加载时伴星归位至真实原生首页，场景隐退。会话恢复控制完成时机，失败保留真实重连入口，减少动态采用快速淡变。认证表单和已登录页面继续按各自规范渲染。正式源文件与调用链见 [日夜启动动效](launch-motion/README.md)。

OpenDesign Cloud 中的 `/Users/asklins/Library/Application Support/Open Design/namespaces/release-stable/data/projects/astella-3df6/index.html` 作为视觉与交互参照。真实产品行为、数据、账号入口和 API 流程由原生客户端承接。主导航采用稿件的四项：相伴、书房、星轨、我的；“手边”作为星轨内的分段，展示真实运行任务、待确认建议和可继续内容。原型演示的日记、语音与分享数据不伪装成真实记录。

iOS 沿用 SwiftUI 系统行为：保留 `NavigationStack`、原生返回手势、手记进入时的匹配缩放、系统弹簧、触感反馈和系统“减少动态效果”设置。转场须响应新操作并可中断，不另造返回手势。相伴页由 Shell 承载专属工作区／伴星记录／日夜页头；四项 Dock 在四个根页面保持一致，选中滑片跨页面连续移动。书房、星轨和我的页使用自己的标题与内容结构，详情页隐藏一级 Dock。

Android 独立评估。采用 Compose 弹簧与触控反馈，并针对 Android 的移动距离和按压反馈调校阻尼与刚度；不机械复制 iOS 数值。尊重系统动画时长缩放和应用内减弱动效偏好。

2026-10-18 纠正过往三标签实施：根 Dock 为「相伴／书房／星轨／我的」。书房页沿用真实手记搜索、继续阅读、工作区切换和本地文件导入；星轨页用真实日记与伴星记忆 API，并把真实手边任务放入“手边”分段；我的页承载账户、伴星与设置。每页分别采用原型中的页面层级和自绘产品 glyph，未接入原型的演示内容。

## 历史视觉决定 — 2026-10-15

用户要求简约玻璃风格，不接受堆叠系统控件、绿色纸面或装饰性英文编号。认证保留现有真实流程。关于 Android 与 iOS 数值对齐的早期要求已由上方 2026-10-18 的平台独立动效决定替代；材质与认证限制仍适用。

## Current decision — white authentication screens (2026-10-15)

The user requested direct implementation after the image exploration. This decision supersedes the earlier illustrated, iridescent authentication mockups: all nine authentication routes use a flat white background, the official app icon, typography and ordinary neutral glass. **Do not add companion portraits or hero illustrations to authentication pages.** The companion's name may remain in the approved copy. This restriction applies to authentication, not the actual companion conversation scene.

Inputs and submit/back buttons use a single blurred material plane, a uniform neutral edge and a small contact shadow. No caustics, colored sheen, rainbow borders, animated glow or opaque blue submit pill. Input labels remain outside the controls; focus uses a quiet blue outline. Verification uses six separate cells with one real native editing field. Existing API routes, session storage and server validation remain the owners of authentication.

Both clients use 24 pt/dp horizontal padding, 44 pt/dp brand and back controls, 56 pt/dp input/submit minimum heights, 26 pt/dp input corners, 28 pt/dp submit corners and 8 pt/dp spacing between verification cells. Titles and form spacing collapse when the keyboard or large text needs room. Authentication remains light even when the device uses dark appearance; the signed-in dark theme remains available. Forms scroll when necessary and never hide the alternate login/registration navigation solely because a field is focused.

## 视觉关系

白色画布、低饱和蓝色强调、深色文字。背景保持平整，不添加环境光、渐变、焦散或伴星插画。玻璃集中用于导航、输入、附件菜单和短交互浮层；正文保持清晰稳定。自绘图形、控件几何、留白和字阶共同形成身份，不把所有信息包成同样的玻璃卡。

普通玻璃由背景采样模糊、轻微中性染色、均匀细描边和轻接触阴影组成，不使用彩虹折射、方向性炫光或强发光。iOS 用自定形状的 Material，不使用认证页的 Liquid Glass 系统按钮样式；Android 用 Haze Blur 采样实际背景，不用不透明 Material Surface 冒充模糊。Android 31 以下采用有对比的半透明降级；iOS 减少透明度开启时使用实色表面。具体色值见 [DESIGN_TOKENS.md](DESIGN_TOKENS.md)。

## 信息结构

一级入口为相伴、书房、星轨、我的。相伴页呈现工作区选择、伴星／记录切换、日夜外观和角色回应；书房页负责空间选择、搜索、继续阅读与导入；星轨页以真实日记、伴星记忆和手边任务分段；我的页组织身份、伴星中心、阅读、隐私与高级设置。底栏固定四等分；读书详情和认证子流程使用独立层级。导航、输入、菜单都由应用设计；系统返回手势、文本编辑、选区、相册、文件选择与权限仍使用宿主能力。

星轨的“手边”分段呈现真实运行状态、等待决定的建议及可继续内容，不展示工具调用次数或虚构百分比。书房负责搜索和继续阅读；详情页收起一级导航，给原文独立空间。账户与偏好使用自定行、字段和开关，不恢复系统 Form 的分组外观。

## 伴星是交互的接收者

- 对话页完整呈现 Live2D，其他页以轻量入口与当前任务关联；避免每屏复制大角色。模型失败有静态降级，不把下载当作成功渲染。
- 「＋」从触点展开加图片、加文件、引用手记，关闭回到来源。文件和图片是独立选择路径。
- 图片／文件选择或拖入后，缩略图沿曲线进入伴星所在位置，角色作真实接收反馈；这表示材料进入待发草稿，不能暗示已经上传或已经读懂。只有发送成功才清除待发材料。
- 选区动作使用真正的所选范围，带上当前不可变笔记版本。解释与改写在原文附近延续；改写先展示服务端建议与前后内容，确认后再由伴星写入。建议过期、版本冲突、写入失败都保留原文。
- 麦克风粒子由真实录音电平驱动；朗读粒子与口型由真实播放音频驱动。文字流不能模拟语音幅度。提供取消录音、暂停、继续与停止，离开页面或进入后台停止音频。
- 动画可被快速点按、反向导航和新意图打断，功能与焦点不等待动画结束。减少动态时移除飞行、位移和装饰循环，保留静态状态。

## 数据与产品边界

文件解析在手机完成：PDF 提取文本、DOCX 提取文档正文、TXT／Markdown 解码。扫描件、加密／损坏文档、超限和无正文必须明确报错，不静默截断。当前限制为 20 MB 原件、100,000 字符抽取正文；图片先规范为 JPEG，最大 10 MB。

“解析在本机”不等于“原件永不上传”：对话发送文件时，原件经过鉴权上传到文件资产接口，抽取正文进入同一回合；单独存为手记只发送抽取的文字。AI 外发遵循账号级同意与数据策略；未同意仍可登录阅读，AI 请求由现有服务端门禁拒绝并解释下一步，不强迫为阅读功能签署 AI 同意。

运行时下载模型不绕过分发授权。正式发布仍必须使用具备相应授权的模型／资源；本地测试对象前缀不能当作公共发行渠道。

## 验证

构建、真实 API、实际窗口、真机手感是不同证据。只记录实际跑过的范围；未测的 TTS 正向播放、实体设备音频、硬件刷新率和极端字号不能写为已完成。当前实施与验证记录见 [MOBILE_AUDIT.md](MOBILE_AUDIT.md)，接口与构建入口见 [README.md](README.md)。

## Authentication continuity correction — 2026-10-15

The user rejected the fixed-header / whole-page replacement approach because it removed the earlier element continuity. Authentication now retains one view composition: keep the official icon visible, move and gently scale the same brand group to make room for Back, retain common input controls by stable field IDs, and reposition the same submit control as the form changes. Title and supporting content changes follow the current navigation direction. Return reverses the geometry. This replaces the previous instruction to preserve a fixed brand header during full-page pushes. White backgrounds, soft blue submit tint, ordinary glass, no companion art and no submit arrow remain required.
