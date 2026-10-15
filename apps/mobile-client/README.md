# 拾星手机端

手机端现由两套独立原生 App 组成：iOS 使用 SwiftUI 与少量 UIKit（照片选择、音频采集、Keychain）；Android 使用 Kotlin 与 Jetpack Compose。React/Vite 浏览器客户端已退出产品构建链路，真实调用代码位于 `ios/Astella/` 与 `android/app/src/main/`。历史 `prototype/` 只供追溯，不参与原生构建。

两端复用同一账号、书房、伴星 inbox、消息、手记与 API 语义；界面和系统动作分别由宿主平台原生实现。一级入口统一为“对话／手边／手记”，个人页从右上角进入。对话中的“伴星／记录”切换始终呈现同一份会话。视觉使用 Apple 系统中性色与单一系统蓝，适配深浅色外观，不用装饰性多色渐变；视觉层级、纸面与动效合同见 [原生界面与动效规范](DESIGN_SPEC.md)。

## 已接入的真实链路

- Bearer 邮箱登录，凭据分别保存到 iOS Keychain 与 Android Keystore 加密存储。
- 注册、邮箱验证码登录、忘记密码与密码重置使用服务端邮件验证码流程；认证屏固定视口，状态说明就近呈现。
- `/companion/inbox/ensure` 获取共享会话；鉴权 WebSocket `/companion/realtime` 订阅持久事件并提交回合，连接不可用时用相同 `clientMessageId` 回退 HTTP。
- 图片在用户发送时上传到 `/uploads/companion-images`，可以与文字同回合发送；历史私有图片通过登录态读取。
- 麦克风录音为 16 kHz 单声道 WAV，通过 `/voice/transcribe` 调用现有小米 MiMo 整段识别；结果可编辑并保留 `voiceArtifactId` 来源。没有流式 ASR 或 TTS 播放。
- `/notes` 与 `/search` 使用服务端游标分页，`/v2/notes/:id` 打开当前只读版本。正文支持标题、引用、代码、列表、表格和需要鉴权的图片；可把当前手记版本附到下一轮对话，也可将整段原文绑定当前版本，保存个人批注或发起原文讲解。
- 手记详情可打开速览、脑图、分步讲解和版本记录。派生内容使用真实任务创建、状态轮询、失败原因和重试；版本恢复用当前版本 ID 作并发基线。
- “手边”显示真实进行中的 run 与连接状态，包括等待确认的状态；不伪造任务历史或进度。
- 账户页通过真实 API 上传头像、保存或清除称呼、显示伴星权限、切换可访问书房、查看并更新账号级 AI 使用同意和数据策略。个人约定读写 `/me/companion/participation`；阅读字号、对话记录视图和本机动效偏好按账号分设备保存。

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
./gradlew assembleDebug
```

Android `local.properties`、Gradle 缓存和构建产物不会提交。开发清单只在 Debug 变体放开本机 HTTP；Release 只允许 HTTPS。

### 本轮构建与运行核对（2026-10-15，返工复核）

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

移动端 TTS、流式 ASR 和手记正文编辑仍未实现；服务端目前提供的整段语音识别、只读正文和派生学习内容已由原生页面直接接入。批注入口以整段原文为范围；若 Markdown 结构无法与服务端锚点规则精确对应，会显示服务端冲突并保留原文，不会写入错位批注。相机／麦克风权限、不同 Android 设备音频行为、实体设备长时间交互和硬件刷新率／帧率仍待真机验收；模拟器不能证明稳定 60/120 fps。
