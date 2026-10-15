# 原生手机页面多轮审查记录

## Latest authentication update — 2026-10-15

The current implementation uses white backgrounds, ordinary glass controls and the official icon only, with no companion artwork on authentication pages. iOS simulator build and Android Debug APK build passed. The actual window checks and unverified downstream email flows are recorded in [the authentication review](../../docs/testing/mobile-auth-white-glass-2026-10-15.md). Earlier visual descriptions and verification claims below belong to earlier builds.

审查日期：2026-10-15。iOS 是界面、颜色和动效的标尺；Android 保持同样的信息层级、留白、纸面质感和单一系统蓝，再用 Compose 与 Android 控件表达。审查依据是模拟器中的实际窗口和服务端响应，不把源码或构建成功单独当作运行验收。

## 测试账号与数据

- 专用开发账号：`codex-mobile-qa-20261014@example.test`。账号用一次性、本地开发专用的邮箱校验旁路建立，旁路进程随后已关闭；之后的密码登录、会话恢复和页面 API 均连接正常本地服务。密码与会话令牌没有写进仓库，临时密码文件已在验收后删除。
- 测试手记：`手机端实机验证 · 阅读与交互`，包含标题、段落、引用、列表、代码和版本记录。用来检查真实列表、正文、批注和版本接口。
- 账号的 AI 使用协议仍未签署，`sendToExternal` 为关闭状态。没有替用户签署协议，也没有触发外部模型生成。

## 页面与真实调用链

| 页面 / 流程 | 原生实现 | 本轮实际核验 |
| --- | --- | --- |
| 密码登录、邮箱验证码登录、注册、找回与重置密码 | iOS `Screens/RootView.swift`；Android `ui/screens/LibraryScreens.kt` | Android 输入真实测试账号登录成功；错误密码收到服务端失败并显示行内说明。注册与找回真实请求到达验证码步骤；错误验证码返回服务端错误并显示状态卡片。 |
| 会话恢复 | iOS `Screens/RootView.swift`；Android `ui/screens/NoteFeatures.kt` 与 `AstellaRoot.kt` | 两端均使用本地凭据恢复同一测试账号；iOS `/auth/me` 返回 200。Android 登录后显示真实书房与“已连接”。 |
| 对话、伴星与记录 | iOS `Screens/RootView.swift`、`App/AppStore.swift`；Android `ConversationScreen.kt`、`AppViewModel.kt` | iOS inbox、消息与 run-nodes 请求返回 200；Android WebSocket 显示已连接。验证了伴星中心“翻开完整记录”回到同一对话，不误进手记讲解页。没有发送 AI 消息。 |
| 手边 | iOS `HandAndAccountScreens.swift`；Android `LibraryScreens.kt` | 两端查看当前真实工作与连接空态；页面提供返回伴星的入口，没有伪造任务历史。 |
| 手记列表、正文、批注与版本 | iOS `NotesScreen.swift`、`AppStore.swift`；Android `LibraryScreens.kt`、`AppViewModel.kt` | 两端展示真实测试手记。iOS `/notes`、`/v2/notes/:id`、`/annotations` 与版本请求均返回 200；Android 点开正文、查看版本，并从手记点击“在对话里继续提问”，确认上下文入口回到对话且携带手记标题。 |
| 速览、脑图、讲解 | iOS `NotesScreen.swift`；Android `NoteFeatures.kt` | 实际打开页面并核对当前无生成内容时的说明和操作入口。因未签署 AI 协议，未触发生成任务。iOS 对应查询返回 200。 |
| 账户与使用设置 | iOS `HandAndAccountScreens.swift`；Android `LibraryScreens.kt`、`SettingsAndCompanionScreens.kt` | 检查账号资料、权限说明、AI 协议与数据开关、服务地址、字号、记录视图、减少动效和个人约定。Android 三个偏好开关均实际切换后恢复原值；AI 同意和个人约定没有写入。 |

## 多轮审查与修正

1. 对照入口、导航和共享 API 合同，逐项列出认证、三项主导航、手记派生页、账户、设置和伴星中心。
2. 在 Android API 37 模拟器用触屏输入、打开软键盘、按钮点按、滚动和返回；在 iPhone 18 Pro Max / iOS 27 模拟器用原生构建逐页截取。认证、主要空态、长手记、账户和设置均复核过。
3. 修复走查发现的问题：认证错误改成带标题和可执行说明的状态面板；安卓登录错误文案去掉标题与正文重复；手记、对话错误使用页面化说明和重试；伴星中心与手记“继续提问”清除旧的手记子路由；AI 许可空字段不再显示字面量 `null`；iOS 验证码步骤避免重复邮箱与多余句点。
4. 修正后重新构建并回到模拟器复核。Android 登录错误、验证码错误、验证码步骤、手记续问路由、账户授权状态和设置恢复值已重查；iOS 认证与登录后页面在最新原生构建上重截。
5. 清理了只为走查加入的 iOS 路由跳转、令牌注入和 HTTP 记录钩子；标准构建完成后又检查源码中不再残留这些 QA 入口。

## 构建、运行证据与边界

- Android：JDK 17 与 Android SDK 37，`./gradlew --offline assembleDebug` 成功；Pixel 10 Pro 配置的 API 37 模拟器 `emulator-5554` 完成真实 UI 登录和页面操作。认证登录、注册步骤、找回步骤、记录键盘状态、手记与账户页均有屏幕截图。登录、注册、找回和邮箱登录输入时，Accessibility 树未发现可滚动节点；键盘出现后当前字段和主要操作仍在屏内。
- iOS：Xcode Debug 构建成功；iPhone 18 Pro Max / iOS 27 模拟器实际启动原生 App，逐页截取 9 个认证路由及 11 个登录后页面。请求记录确认 `/auth/me`、伴星 inbox、消息、run-nodes、手记、批注、版本、速览和脑图读取均为 200。截图目录是 `/tmp/astella-mobile-ios-round3/`，总览图为 `/tmp/astella-mobile-ios-round3-contact.jpg`。
- Android 逐屏截图散存在 `/tmp/astella-android-*.png`；本轮覆盖认证、错误态、键盘、手记、版本、派生页、账户、设置和伴星中心。总览图为 `/tmp/astella-mobile-android-round3-contact.jpg`。模拟器可执行 ADB 触屏操作，但它仍不是实体手机。
- iOS 所在主机没有可操作的 Simulator 图形界面，本轮用 `simctl` 启动、读取真实 API 并截图，没有手动点按 iOS 屏幕，也没有实体 iPhone。iOS 键盘连续操作、系统边缘返回等只做了源码和静态窗口核对。
- 服务端公开能力位显示邮箱通道已配置。测试注册与找回请求均走到了验证码输入步骤；`.test` 测试邮箱没有可访问的收件箱，所以无法核对真实邮件收取、输入有效验证码完成注册或完成密码重置。邮箱验证码登录的无效验证码路径已实际核验。
- AI 生成页已核对空态与入口；因为账号明确未同意外部 AI，未发起速览、脑图或讲解生成。这是账号权限边界，不记作生成调用通过。
- 实体设备上的相机／麦克风授权、录音质量、TTS、不同机型触感、刷新率与持续帧率仍未实测；不据模拟器构建承诺稳定 60/120 fps。

## 既有能力限制

移动端尚无流式 ASR、TTS 播放和手记正文编辑。整段语音识别、只读正文与服务端派生学习内容由原生页面直接接入；批注锚点冲突时保留原文并显示服务端状态。更多产品能力边界见 [README](README.md#当前限制)。

## 2026-10-15 视觉重构后的复核

本轮按已确认的登录页标准重新梳理已登录页面：iOS 用系统语义色、iOS 26 原生 Liquid Glass 输入与短操作面、轻纸面阅读层；Android 用 Material 3 的中性色、同一系统蓝、Compose 原生状态与触控。两端共享信息重心和用户任务，不复制同一组卡片骨架。

- 对话重组为书房状态、伴星主体、当下提示和输入；提示短语点按后只填入输入框，没有自动发送。手边把真实空态和书房连接分开表达。书架与阅读页改成搜索列表、连续正文和较少的操作控件；段落批注／讲解改由长按打开。
- 速览、脑图、讲解各自使用不同的空态结构，按当前手记解释真实输出会怎样保留主线、层级、讲述和原文依据；没有填入虚构生成结果。主要生成操作固定在底部安全区。手记长按菜单改为白色 Material 3 表面和轻阴影，去掉了系统默认的紫调。
- iOS：最新源码 Debug 构建成功，iPhone 18 Pro Max / iOS 27 启动成功，并重新截图检查登录页（`/tmp/astella-redesign-ios-final-login-latest.png`）。本机没有可操作的 Simulator 图形界面，Xcode 项目也没有 UI 测试目标，因此本轮没有手动点按登录后的 iOS 页面。先前 API 路由核验仍覆盖其真实调用链，但不能作为这次视觉修改的 iOS 屏幕验收。
- Android：最终 APK 构建成功并安装到 API 37 模拟器。触屏逐页查看了对话与提示词预填、手边、书架、手记正文、版本、速览、脑图、讲解、账户、使用设置和伴星中心；真实长按段落确认菜单出现。代表性截图在 `/tmp/astella-redesign-android-final-current2.png`、`/tmp/astella-redesign-android-chip.png`、`/tmp/astella-redesign-android-final-hand.png`、`/tmp/astella-redesign-android-final-notes.png`、`/tmp/astella-redesign-android-final-detail.png`、`/tmp/astella-redesign-android-final-versions.png`、`/tmp/astella-redesign-android-overview-final2.png`、`/tmp/astella-redesign-android-mindmap-final.png`、`/tmp/astella-redesign-android-final-explain.png`、`/tmp/astella-redesign-android-final-account.png`、`/tmp/astella-redesign-android-final-settings.png`、`/tmp/astella-redesign-android-final-companion.png` 与 `/tmp/astella-redesign-android-context-final.png`。
- 最终构建：`xcodebuild ... build CODE_SIGNING_ALLOWED=NO` 成功；Android `./gradlew --offline assembleDebug` 成功。没有触发 AI 生成；测试账号尚未签署 AI 协议，页面真实生成结果因此未验收。登录、注册与找回的验证码输入交互使用此前认证流程的真实请求核验；`.test` 邮箱没有可收件箱，不能验证有效邮件验证码。
- 以上是模拟器核验，不是实体 iPhone 或实体 Android 设备测试。当前版本还未核验 iOS 认证后所有页面的逐页视觉结果、实体设备权限／键盘／手势和硬件帧率；不能据模拟器构建推断 60/120fps。

## 2026-10-15 授权状态与外观切换复核

- 深色外观触发 Android Activity 重建时，生成页先前只保存在页面局部的授权错误会消失，导致按钮重新可点。现已改为进入速览、脑图或讲解页时读取账号级 AI 设置；授权状态未知或要求同意时禁用主操作。服务端明确返回未授权后，同步锁定 ViewModel 状态。iOS 也按账号设置禁用按钮，并在每个生成方法里再次校验。
- 用测试账号重新登录 Android API 37 模拟器，打开真实手记的脑图页；未同意时看到授权说明和“查看 AI 使用设置”，主按钮为禁用样式。Accessibility 树里按钮父节点在浅色和深色外观下均为 `clickable=true, enabled=false`。打开账户入口后核对账号及 AI 数据说明，再返回脑图。切换深色并恢复浅色，授权说明和禁用按钮均保持；没有签署协议，也没有触发模型生成。
- iOS 用最新 Debug 包在 iPhone 18 Pro Max / iOS 27 模拟器重新启动，分别截取浅色和深色登录页，检查系统颜色和输入面材质。双端最新源码再次构建成功：Android `assembleDebug`、iOS `xcodebuild ... build CODE_SIGNING_ALLOWED=NO`。
- 本机图形会话处于锁定状态，CUA 确认无法访问 Simulator 窗口。因此 iOS 本轮仅验证构建、启动及浅／深色首屏截图，没有手动点按登录后的页面；上一轮 iOS 认证后截图不能替代本轮页面操作复核。测试设备仍为模拟器，不是实体手机。

## 2026-10-15 第二次返工复核（最新构建）

这次复核从用户已认可的认证页规范重新开始：语义中性色、单一系统蓝、玻璃只放在可交互面、正文保持稳定表面；每个页面依内容和任务排版，不复制同一套卡片骨架。对话欢迎态、手记书架、手边空态、版本和生成前说明作了针对性调整；设置和个人页减少重复卡片，并让保存按钮反映实际未保存状态。认证屏保持固定视口；Android 在系统字体放大时也切换紧凑排布。没有新增模拟生成内容，也没有改变现有 API 契约。

- **iOS 构建与窗口：** 最新 SwiftUI Debug 构建成功，并安装到 iPhone 18 Pro Max / iOS 27 模拟器。通过 Device Hub 实际打开登录页和注册第 1、2 步，确认邮箱、称呼、密码、返回、步骤进度和禁用的主操作可见。未输入密码、发送验证码或登录。没有手动检查软键盘、放大字号、验证码错误、其余认证步骤及登录后页面。
- **Android 构建与窗口：** 使用 JDK 17、Android SDK 37 执行 `./gradlew --offline assembleDebug` 成功，APK 已安装到 API 37 `AstellaQA` 模拟器。为了让模拟器窗口可由桌面工具识别，曾正常重启该开发 AVD；重启后主机锁定，CUA 返回无法访问窗口。因此，本次 Android 源码修改尚无新窗口截图或触屏复核。此前 `/tmp/astella-redesign-android-*.png` 是旧构建证据，不能用来证明本次布局。
- **本轮修正：** 构建发现的 Swift 字体 API 用法、Compose 布局参数和图标导入错误均已修复；Android 字体缩放较大时会提前切换认证紧凑版式。验证码下方的重复标签改成“没有收到邮件？”，邮箱、登录密码和新密码字段补上 Compose `ContentType` 自动填充语义。最新双端标准构建均成功，最新 APK 与 iOS App 已安装到各自模拟器。Android Gradle 仍报告既有 Gradle 10 弃用警告，不影响当前构建。Android 官方的 Compose 自动填充指南已补入[设计心得](DESIGN_NOTES.md)。
- **账号边界：** iOS 注册表单中只填入了 `codex-mobile-qa-ios-20261015@example.test` 用于检查表单状态；未发送验证码。现有开发测试账号的密码不在仓库或可用凭据中，因而没有自动输入或尝试密码登录。`.test` 邮箱没有可访问的收件箱，不能据此完成有效邮箱验证。
- **其余真实链路：** 本轮没有改动 API 或模型权限链；之前记录的接口状态和页面调用仍是之前构建的证据。AI 使用协议仍未签署，因此没有触发外部 AI 生成，也没有把生成空态误记成结果验收。
- **下一步尚需窗口复核：** 主机解锁后，在新 APK 上实际逐屏检查 Android 对话、手边、手记、版本、速览、脑图、讲解、账户、设置和伴星中心；在 iOS 上继续查看所有认证路由和登录后页面。两台模拟器完成后还需要用户在自己的测试账号登录字段中输入凭据，才能验证认证后的 iOS 真实页面。模拟器之外的实体设备、麦克风／相机授权和持续帧率仍未验证。

## 2026-10-15 按已认可规范重新返工

本轮把页面审查退回到用户认可的 Apple 风格基准，检查了整个原生 UI 的共享组件与页面入口。代码里曾把不透明内容面命名为 `GlassSurface`：iOS 显示系统纸面，Android 显示普通白色 Surface。现已改称 `NoticeSurface`，不再把内容卡片误当作 Liquid Glass。iOS 背景改用系统动态背景色；主操作采用系统 `glassProminent`，认证输入、手记搜索、对话输入和发送控件采用 SwiftUI 原生 Glass API；内容正文、错误说明、权限和状态仍使用稳定表面。iOS 18 通过系统材质回退。Android 采用 Material 3 中性色角色、系统蓝、白色主表面和圆角 filled action，不模拟苹果模糊材质。

这轮也对注册、邮箱确认、找回密码与验证码登录调整了步骤标题和指引文案；Android 登录页改为和 iOS 一样的顶部层级，认证错误出现时进入紧凑排布。对话发送按钮改为 iOS 系统玻璃控制，内容页的主要 CTA 使用同一套原生主操作，既有的各页面独立布局、真实 API 和路由保持连接。

- iOS 最新标准 Debug 构建成功：`xcodebuild -quiet ... -derivedDataPath /tmp/astella-ios-redesign-derived CODE_SIGNING_ALLOWED=NO build`；已安装到 iPhone 18 Pro Max / iOS 27 模拟器。
- Android 最新 Debug 构建成功：`./gradlew --offline assembleDebug`；已安装到 API 37 `emulator-5554`。Gradle 输出既有 Gradle 10 弃用提示。
- 本轮重新调用 CUA 检查时，macOS 仍处于锁定状态。没有对最新两端构建进行新的屏幕截图或触控走查；旧截图不作本轮证据。当前可以确认的是源码、构建和安装，不能确认最新窗口的实际材质、键盘压缩和每页视觉重心。
- 页面结构覆盖面与上一节一致；需主机解锁后逐页再审 Android 登录后各页、iOS 所有认证路由及登录后各页，并让用户本人在模拟器输入测试凭据。验证码收件箱、AI 授权和实体设备仍有前述边界。

## 2026-10-15 本轮返工续记：账号、真实数据与窗口边界

上一节记录的是当时的安装状态和窗口限制。本次继续清理认证流程，并重新核对材质规则：iOS 26 使用系统 Liquid Glass 输入／操作样式，正文与说明保持清晰的系统表面；Android 使用 Material 3 中性色和同一系统蓝。双端最新标准构建成功并重新安装。此后 CUA 再次查询系统窗口，仍返回“Mac is locked”，因此这里不把旧截图或上一构建的触屏记录算作最新包验收。

静态压力检查还发现连续代码字符串没有局部溢出处理。现已在 iOS 和 Android 把代码块改为自身横向滚动区域，并保留正文的纵向阅读；两端最新构建均重新通过并安装。此修正尚未在窗口里验证滚动手势、长按批注是否冲突或圆角裁切效果。

- 为登录后的真实页面准备了新的隔离开发账号 `codex-mobile-redo-qa-20261015@example.test`。仅在本机 API 容器中短暂启用已有开发邮箱验证旁路来注册，随后恢复原配置；当前旁路未启用。真实 `/auth/login`、`/auth/me`、`/auth/workspaces`、`/companion/inbox/ensure`、会话消息与 run-nodes、`/me/ai-settings`、`/me/companion` 与 `/me/companion/participation` 均返回 2xx。没有真实邮箱收件箱，因此这不等于有效邮箱验证码、注册邮件或密码重置链路已验收。密码不写入仓库。
- 通过同一真实 API 创建了复核手记“移动端复核 · 学习科学”，包括标题、段落、引用、列表和代码。`/notes`、`/v2/notes/:id`、`/notes/:id/versions`、`/v2/notes/:id/annotations` 均返回 200。当前服务端内容可用于登录后逐页复核，不触发 AI 生成。
- 另建了压力手记“移动端边界复核：中英文混排、超长标题、长段落、窄屏换行与段落操作测试记录”：标题 36 字符、长段落 1,152 字符，含 442 字代码块连续字符串，用于小屏与代码溢出复核。该数据只写入隔离 QA 账号，尚未在窗口中查看。
- 压力手记的鉴权列表、搜索、正文、版本、批注、速览、脑图及讲解任务读取路由均返回 200；这些都是读取请求，没有创建派生任务或调用外部模型。
- 随后把包含代码块局部横向查看修正的最新 iOS App 与 Android APK 安装到已启动的 iPhone 18 Pro Max / iOS 27 和 `emulator-5554` 模拟器。安装命令成功；安装后 CUA 仍报告 Mac 锁屏，所以当前构建的页面截图、触控与无障碍检查仍未完成。
- 上述 API 响应只证明鉴权及数据端点可用。最新 iOS／Android 窗口中的登录、键盘、认证错误、导航、手记正文、批注、账户设置及其余页面仍待模拟器实际操作；没有新截图、触屏或无障碍树证据。需要先解锁 Mac，再由用户在模拟器登录表单输入这组临时测试凭据；不要把密码发回聊天。
- AI 使用协议仍未签署，不会触发外部模型。模拟器检查也不能替代实体设备对系统权限、硬件帧率和音频表现的验收。

## 2026-10-15 继续返工：状态一致性与数据权限

本轮继续按登录页与 `DESIGN_SPEC.md` 核验真实交互链，修复了三类可复现于状态逻辑中的问题：

- **个人约定冲突：** 两端遇到服务端 revision 冲突时，原提示声称重读仍保留草稿，但实际加载会覆盖输入。现在会保留本机草稿、读取并展示另一设备的版本，让用户在输入框里合并，或明确选择用云端版本替换后再保存。
- **书架请求乱序：** iOS 搜索结果及分页没有校验请求是否仍对应当前查询；Android 重复同一查询刷新时也可能让旧响应覆盖新状态。双端现按请求代次和游标校验，只允许当前查询更新列表与错误状态。
- **外部 AI 与图片输入：** 速览、脑图、讲解现在同时检查 AI 使用授权和账号的 `sendToExternal` 数据策略；关闭时禁用生成并提供账户设置入口，服务端拒绝后刷新策略。Android 认证中的密码、确认密码、邀请码和一次性验证码不再进入可恢复的 saved-instance-state。
- **图片上传资源边界：** Android 头像与伴星图片现在流式读取并在超过 10 MB 时立即停止；iOS 头像在解码前检查文件大小，并先生成最长边 1024 px 的缩略图再压缩。
- **最新验证：** `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 和 `./gradlew --offline assembleDebug` 均成功，最新 App/APK 已重新安装到 iPhone 18 Pro Max / iOS 27 与 Android API 37 模拟器；`git diff --check` 通过。Gradle 仍提示项目已有 Gradle 10 弃用项。
- **窗口边界：** 最新 CUA 查询仍返回“Mac is locked”。所以本节只记录源码、构建和安装；没有新截图、触控操作、无障碍树或最新包页面验证。上文较早版本的模拟器截图不作为最新构建的证据。解锁后仍需逐页核对双端，包括外部 AI 关闭时生成按钮状态、个人约定冲突保稿、快速搜索与长代码块横向查看。
- **真实数据边界：** QA 账号的 `.test` 邮箱没有收件箱，仍不能完成有效验证码、注册邮件及密码重置；AI 使用协议未签署，不会生成真实 AI 输出。当前也没有实体设备的麦克风／相机、系统手势、热态、持续帧率验收。

## 2026-10-15 再次续审：跨手记请求与认证提交

- 手记正文与批注存在全局可观察状态。旧的正文、批注读取或保存任务若在快速切换手记后返回，可能覆盖当前详情页的批注或状态。iOS 与 Android 现为正文读取、批注读取和批注写入／讲解任务增加请求代次及当前手记校验；切换手记会使旧结果失效。
- 发送邮箱验证码时，表单原先仍能修改邮箱或切换路由，晚到的成功响应可能进入新邮箱的验证码步骤。iOS 在认证请求期间禁用认证表单；Android 在请求期间禁用认证输入、验证码编辑、重发与导航操作。
- 上述改动后的 iOS `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 与 Android `./gradlew --offline assembleDebug` 均成功；最新包已重新安装。`git diff --check` 通过。
- 本轮开始与安装后检查的 CUA 仍报告 macOS 锁定，故此处没有声称页面在窗口内通过。需要解锁后在当前安装包上实际复查认证请求状态、快速切换两篇手记及批注列表；其余页面的逐屏视觉与触控复核也仍未完成。

## 2026-10-15 继续全页返工：记录空态

在逐屏静态复核时补出“交流记录为空”的布局遗漏：此前提示留在列表顶部，底部输入框与提示之间形成无意义空带。现在 iOS 与 Android 都把空态放到记录区中部，用一条标题和一条说明告诉用户可以从底部输入开始；记录出现后空态立即消失，输入框、草稿及真实消息列表逻辑保持原样。

- iOS `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 成功，最新 App 已安装并由 `simctl` 启动于 iPhone 18 Pro Max / iOS 27 模拟器。
- Android `./gradlew --offline assembleDebug` 成功，最新 APK 已重新安装，`MainActivity` 启动命令成功。
- 本机 CUA 仍报告 macOS 锁屏；这次新增空态以及此前全页布局改动尚未在当前模拟器窗口通过截图和触控验证。旧版截图不作为当前构建证据。

## 2026-10-15 用户拒绝当前视觉质量：重新梳理页面构图

用户指出，最近构建出来的界面与认可的登录页标准不符，并要求整套手机页面重做。之前的截图属于更早的构建；它们只能用于理解当时的问题，不能证明本次代码在当前模拟器窗口中的呈现效果。检查这些旧图能看到几个具体问题：欢迎页人物、文案和输入区相隔过远；手边空态重复使用角色图与大白卡；书架首条手记、阅读正文和设置被卡片边框分割；速览、脑图和讲解在首屏留白过多，内容层级不清。

这次重新以已认可的登录页为视觉基准；认证版式方向保留，其余页面按各自任务重构，不复制登录卡片结构：

- 对话欢迎态缩小伴星形象，让问候、解释与快捷问题组合成一个连续场景；回复态改用左对齐阅读排版。手边空态去掉重复伴星插画，压缩为待办状态、下一步和连接信息。
- 书架的最新手记改为无卡片的内容预览，其他条目按标题、真实摘要、更新时间和细分隔线排列。正文页继续使用连续阅读纸面，版本页保留时间线语义。
- 速览／脑图／讲解的未生成预览不再嵌套白卡，改为不同的结构预览；实际引用仍来自当前手记，标签明确说明这不是模型生成结果。三页的内容区域改为围绕主体组织，不再只把一段说明贴在顶部。
- 账户中的开发服务地址收进可展开的进阶入口，账户默认视图优先展示身份、书房、伴星权限与 AI 数据选项；伴星中心缩小重复的角色图，集中呈现名称、连接状态、最近回应与返回交流入口。
- 清理非交互状态块中的半透明材质；Liquid Glass 仅留在 iOS 可操作的输入、导航和短操作面。Android 继续使用 Material 3 实色表面与系统蓝，不仿制苹果玻璃。

**本次证据：** iOS SwiftUI 标准 Debug 构建成功，并重新安装、启动于 iPhone 18 Pro Max / iOS 27 模拟器；Android Compose `assembleDebug` 成功，APK 已重新安装到 API 37 模拟器。`git diff --check -- apps/mobile-client` 通过。没有运行 UI 测试。

**尚未验收：** 本轮 CUA 发现 macOS 仍处于锁定状态，无法看到最新模拟器窗口或进行触控。因此上面列出的改动目前是源码与构建事实，不代表新版本已经视觉通过；更早截图不作为本轮验收。解锁后仍要在最新包逐页查看双端的对话、手边、书架、阅读、批注、版本、速览、脑图、讲解、账户、设置、伴星中心以及所有认证步骤，并按实际窗口继续修正。有效邮件验证码、AI 生成和实体设备行为仍受上文所述账号与设备边界限制。

## 2026-10-15 全量重构裁决

用户复核前述各轮返工后作出裁决，后续工作不再沿旧轮局部修补推进，而是双端全量重构。裁决要点：

- **动效：** 达到 Telegram 级——物理 spring、共享元素转场、可中断可反转手势；默认弹性而非例外，iOS 参数为 Android 标尺，双端参数以新增的 `DESIGN_TOKENS.md` 双端参数表为准；动效偏好统一为“跟随系统减少动态 + 本机手动覆盖”，不跨设备同步。
- **伴星形态：** 接入 Live2D 模型，Cubism SDK 双端原生；模型资产不进 App 包，走对象存储 + 服务端临时签名下载链接在运行时下载、客户端缓存，静态 PNG 保留为降级；动作映射 idle 呼吸／视线跟随／吸收／说话口型／思考／失败。在场矩阵：对话页完整在场，手边／手记／派生页轻量形态可召唤，非对话空态不重复大幅角色图，生成／吸收事件用全屏浮层。仓库记录该模型 `redistributionAllowed:false`、`commercialReleaseAllowed:false`，运行时下载不改变发布前需再确认分发合规的要求。
- **对话输入：** 「+」二级菜单（加图片／加文件／引用手记），Telegram 式弹簧散开、stagger 24ms，语音保留独立按住说话键；对话可发文件并在手机本机解析（iOS PDFKit、Android pdfbox，docx 为 zip/XML 抽正文）导入手记，原件不出本机，回合上送抽取正文、原件资产留档。
- **语音与粒子：** 录音由麦克风振幅驱动伴星身周粒子；回复朗读接服务端 TTS（`POST /voice/tts`）与口型，reduceMotion 降级静态波形条；完整语音体验需部署侧开启 `COMPANION_VOICE_DIALOGUE_V1_ENABLED` / `COMPANION_STREAMING_VOICE_V1_ENABLED`（生产默认关）。
- **选段→伴星：** 选区工具条（复制／批注／伴星解释／伴星改写）→ 底部纸面 sheet 流式呈现（改写给前后对照 diff）→ 确认后经伴星写入通道落库；服务端“手机上人不改正文，伴星改”闸门不动，复用已有 selection／pageContext／`companion_edit_note` 地基。
- **认证与授权：** 认证页改为优先紧凑排布、放不下时表单区内滚动且绝不裁切字段／错误／主操作（验收＝150% 字号 + 最小屏可完成登录）；AI 外发同意改为进入门槛，新用户注册后强制签署方可进入、老用户未签先补签。
- 同轮完成 16 条方案审阅修订，依据优先于旧文档。

后续双端重构以本轮裁决、`DESIGN_SPEC.md` 2026-10-15 修订段与 `DESIGN_TOKENS.md` 双端参数表为准；本文件此前各轮返工与修正记录仅作问题追溯，不再作为新重构的验收基线。裁决落地情况按重构进度在后续章节续记。
