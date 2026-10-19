# 拾星手机端

手机端现由两套独立原生 App 组成：iOS 使用 SwiftUI 与少量 UIKit（照片选择、音频采集、Keychain）；Android 使用 Kotlin 与 Jetpack Compose。React/Vite 浏览器客户端已退出产品构建链路，真实调用代码位于 `ios/Astella/` 与 `android/app/src/main/`。历史 `prototype/` 只供追溯，不参与原生构建。

两端复用同一账号、书房、伴星 inbox、消息、手记与 API 语义；界面和系统动作分别由宿主平台原生实现。一级入口按 Open Design 手机稿统一为“相伴／书房／星轨／我的”；“手边”是星轨中的分段内容，不单独占底栏。相伴页的“伴星／记录”继续切换同一份会话。视觉采用两端共享的中性色与系统蓝，浅色画布使用银白层次；页面按各自任务组织，不把原型演示数据伪装成真实产品数据。视觉层级、纸面与动效合同见 [原生界面与动效规范](DESIGN_SPEC.md)。

## 已接入的真实链路

- 日夜启动／会话恢复动效：日间为果冻软星，夜间为发光书房；原生恢复状态触发完成，伴星移到真实首页的位置，背景隐退。图片和渲染代码随应用离线打包，认证、数据与首页仍由 SwiftUI / Compose 承接。实现及构建说明见 [日夜启动动效](launch-motion/README.md)。
- Bearer 邮箱登录，凭据分别保存到 iOS Keychain 与 Android Keystore 加密存储。
- 注册、邮箱验证码登录、忘记密码与密码重置使用服务端邮件验证码流程；认证屏使用白底、正式图标与普通玻璃，不放伴星插画；键盘和大字号下紧凑排布，超出可用空间时滚动，切换登录方式和注册的入口保持可达。
- `/companion/inbox/ensure` 获取共享会话；鉴权 WebSocket `/companion/realtime` 订阅持久事件并提交回合，连接不可用时用相同 `clientMessageId` 回退 HTTP。
- 图片在用户发送时上传到 `/uploads/companion-images`，可以与文字同回合发送；历史私有图片通过登录态读取。
- 麦克风录音为 16 kHz 单声道 WAV，通过 `/voice/transcribe` 调用现有小米 MiMo 整段识别；结果可编辑并保留 `voiceArtifactId` 来源。没有流式 ASR。
- 对话消息可调用 `/voice/tts` 真实朗读；两端支持暂停、继续与停止，播放电平驱动伴星口型／粒子，页面退出或应用进入后台即停止。移动端没有流式 ASR，语音识别仍是整段上传。
- 对话附件支持照片及 PDF、DOCX、TXT、Markdown。文件正文在设备本机抽取（上限 20 MB 原件、10 万字符），对话发送时原件经鉴权上传并与抽取文字关联；单独导入手记只发送抽取文字。
- 手记正文使用平台原生选区。伴星可解释选段或生成改写提案，先展示原文／改写对照，由用户确认后通过伴星写入通道更新；过期建议与冲突不会覆盖原文。
- Live2D 模型通过鉴权 manifest 与运行时下载链路加载，按文件校验 SHA-256 并缓存；iOS 与 Android 均接 Cubism 原生渲染，加载失败降级为静态图。实际显示仍取决于服务端是否部署可用且获准分发的模型资源。
- `/notes` 与 `/search` 使用服务端游标分页，`/v2/notes/:id` 打开当前只读版本。正文支持标题、引用、代码、列表、表格和需要鉴权的图片；可把当前手记版本附到下一轮对话，也可将整段原文绑定当前版本，保存个人批注或发起原文讲解。
- 手记详情可打开速览、脑图、分步讲解和版本记录。派生内容使用真实任务创建、状态轮询、失败原因和重试；版本恢复用当前版本 ID 作并发基线。
- “手边”显示真实进行中的 run 与连接状态，包括等待确认的状态；不伪造任务历史或进度。
- 账户页通过真实 API 上传头像、保存或清除称呼、显示伴星权限、切换可访问书房、查看并更新账号级 AI 使用同意和数据策略。个人约定读写 `/me/companion/participation`；阅读字号、对话记录视图和本机动效偏好按账号分设备保存。
- iOS 与 Android 原生端已在启动、前后台、页面到达及安静状态调用 `POST /me/companion/awareness`；安静门槛与个人参与偏好由真实状态和服务端策略决定，不由客户端伪造主动消息。

## 服务能力对照（2026-10-18）

| 能力 | 后端已接通 | 后端条件／剩余缺口 | 客户端状态／剩余验证 |
| --- | --- | --- | --- |
| TTS 语音朗读 | `POST /voice/tts` 与 `/voice/tts/stream` | 生产部署开关默认关闭；实际请求受账号 AI 同意门禁控制 | 双端已接整段朗读、暂停／继续／停止及播放电平驱动；运行时与授权资源仍需按部署环境验收 |
| 对话发文件 | `/uploads/companion-files` 私有资产与 `file` 回合块 | 无 | 双端已接文件选择、本机抽取、发送、回显与失败保留；附件原件仅在用户发送对话时上传 |
| 文件导入手记 | `/import/markdown` | 无；接口只接收抽取后的文字 | 双端可在本机解析 PDF、DOCX、TXT、Markdown 后导入；单独导入仅发送抽取文字，不上传原件 |
| Live2D 模型分发 | `/companion/model/manifest` 与鉴权模型文件下载 | 当前本地开发 API 返回 `502 model_manifest_missing`；还需获批模型资产并发布清单 | 双端模型下载、完整性校验、缓存、Cubism 原生渲染和静态图降级已接入；本轮 Android 实际显示静态图，动态模型未运行 |
| 选段→伴星改写 | 选区、版本上下文、提案与决定接口 | 无 | 双端已接平台原生选区、解释／改写入口、原文对照和用户确认；手机本地不直接改正文 |
| 原生前台观察 | `POST /me/companion/awareness` | 无 | 双端已接启动、前后台、页面到达及安静事件；需在已登录应用中核对真实服务端事件 |

## 开发与构建

需要 Xcode 27（最低部署版本 iOS 18）、JDK 17、Android SDK Platform 37 和兼容的 Build Tools。API 地址在“我的 → 服务地址”设置。iOS 默认连本机模拟器的 `127.0.0.1:4000`；Android Debug 默认连模拟器宿主 `10.0.2.2:4000`。真机需要填写该设备可访问的 HTTPS API 地址。

### iOS

```bash
xcodebuild -project ios/Astella.xcodeproj -scheme Astella \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/astella-ios-derived \
  CODE_SIGNING_ALLOWED=NO build
```

### Android

```bash
cd android
JAVA_HOME="$(brew --prefix openjdk@17)" ./gradlew assembleDebug
```

如果 JDK 17 已在 `PATH` 且 `JAVA_HOME` 正确，也可以直接运行 `./gradlew assembleDebug`。

Android `local.properties`、Gradle 缓存和构建产物不会提交。开发清单只在 Debug 变体放开本机 HTTP；Release 只允许 HTTPS。

### 本轮构建与登录态窗口核对（2026-10-18）

- **Android 构建：** 使用外接拓展盘 `/Volumes/asklins/Android/sdk` 的 Android SDK 与 `/opt/homebrew/opt/openjdk@17` 下的 JDK 17，运行 `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew --offline assembleDebug` 成功。当前 API 36 Pixel 8 AVD 位于 `/Volumes/asklins/Android/avd`；ADB 使用 `/Volumes/asklins/Android/sdk/platform-tools/adb`。最新 APK 已安装并打开，认证态恢复成功。
- **Android 页面：** 在登录态真实查看对话、手边、手记列表、手记详情、速览空态、账户和使用设置；实际走过手记继续对话、伴星快捷入口、Dock 切换、详情返回、减弱动效开关和系统动画比例为 0 的状态。另用系统文档选择器选取 TXT，在本机抽取后经真实 `/import/markdown` 保存成手记，并在列表读回；没有发送对话或调用 AI。手记正文与版本由本地 API 返回。减弱动效及系统设置验后均恢复原值。截图和剩余页面范围见 [本轮手机审计](MOBILE_AUDIT.md#原生导航第二轮与真实登录态复核--2026-10-18)。
- **权限与模型：** 隔离开发账号未同意 AI 外发。速览页生成按钮禁用；没有创建派生任务或调用模型。只读检查 `/companion/model/manifest` 返回 `502 model_manifest_missing`，伴星保持静态图降级；现有 Live2D 源资产不具备发行／商业分发许可，没有上传到存储桶。
- **iOS 构建：** 同一轮 `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 成功，App 已安装并启动在 iPhone 18 Pro Max / iOS 27 模拟器。当前 Xcode 安装没有 Simulator 图形应用；最新截图已核对登录页，没有把 iOS 登录后路由记为窗口触控通过。
- **动效与验证边界：** 修复了 iOS 静态伴星降级动画绕过「减少动态效果」及 Android 动画中途开启减弱偏好后仍继续的问题。Android 最新包在系统动画比例 `0` 下实际打开输入器菜单，入口与菜单动作仍可用，截图见审计记录；系统动画与字号比例已恢复。`git diff --check -- apps/mobile-client` 通过，未运行自动化测试。模拟器结果不证明实体设备录音权限、TTS、刷新率或持续帧率；iOS 对应偏好路径尚未窗口点按验收。邮件有效验证码因 `.test` 邮箱无收件箱未核验。

### 历史构建与运行核对（2026-10-15，返工复核）

- iOS：标准 Debug 构建成功，最新 App 已安装到 iPhone 18 Pro Max / iOS 27 模拟器；实际查看登录页和注册第 1、2 步。后续复核时 Device Hub 报告主机已锁定，无法继续操作登录后页面、键盘和其余认证步骤。
- Android：使用 JDK 17、Android SDK 37 执行 `./gradlew --offline assembleDebug` 成功，最新 APK 已安装到 API 37 模拟器。主机锁定后 CUA 无法读取其窗口；此前的 Android 页面截图属于前一构建，不能代替本次界面复核。
- 2026-10-15 再次返工后的源码（包括代码块局部横向查看修正）通过 iOS `xcodebuild` 与 Android `assembleDebug`，并重新安装到上述两台已启动的模拟器；macOS 仍锁定，故没有新窗口截图或当前构建的触控验证。详细范围见审查记录最新一节。
- 新建本地隔离测试账号 `codex-mobile-redo-qa-20261015@example.test`，通过已有的开发注册旁路建立后已恢复原邮箱验证配置；真实密码登录 API 返回 200。该 `.test` 邮箱没有可访问的收件箱，因此有效验证码、注册邮件和重置邮件仍未验证。登录密码不写入仓库，解锁模拟器后由用户在设备上手动输入。
- 同一账号下创建了仅用于视觉复核的真实手记；`/notes`、`/v2/notes/:id`、版本与批注读取均返回 200。这证明本地服务端数据链可用，不代表最新 App 窗口已通过视觉或触控验收。
- AI 使用协议仍未签署，未触发外部模型生成。当前均为模拟器验证，没有实体 iPhone 或 Android 手机验收。
- 最新继续返工的双端 Debug 构建与安装成功：修正个人约定冲突保稿、书架查询乱序、外部 AI 数据开关前置校验和图片读取上限。最新 CUA 检查仍因 macOS 锁屏无法访问 Simulator 窗口，因此这些改动尚无新截图或触控验收；旧截图不代表当前安装版本。
- 本轮又修正了手记切换后的迟到批注响应，以及发送验证码期间仍可修改邮箱／路由的问题；双端重新构建并安装。当前主机仍锁定，尚无这一版的窗口截图与触控证据。
- 页面证据、已修正问题和未完成范围见 [原生手机页面多轮审查记录](MOBILE_AUDIT.md)。

## 当前限制

移动端语音识别仍为 MiMo 整段识别；不提供流式 ASR。扫描版／加密／损坏 PDF 和超过抽取限制的文件会明确失败；本机 Word 抽取读取正文 XML，不承诺复原复杂版式。生产 TTS 还受账号 AI 同意与服务端开关控制；可分发的 Live2D 模型资源及商业授权需在部署／发布前单独确认。邮箱验证码邮件投递、实体设备录音与系统音频中断、前后台长期运行和硬件刷新率仍未在真机验收；模拟器运行不能证明稳定 60/120 fps。

## White authentication implementation — 2026-10-15

The current authentication implementation follows the user's final decision: white background, official app icon only, no companion picture, ordinary neutral glass. Android authentication now lives in `ui/screens/AuthScreen.kt`; iOS uses `Auth/AuthScreen.swift` and `Auth/AuthComponents.swift`. The nine routes keep the existing API-backed login, registration, email-code and password-reset handlers. Earlier image concepts are historical references and do not override the current visual decision. See [the implementation review](../../docs/testing/mobile-auth-white-glass-2026-10-15.md) for verification coverage.
