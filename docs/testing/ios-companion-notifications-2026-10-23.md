# iOS 伴星消息通知 — 2026-10-23

## 本轮范围与决定

用户 2026-10-23 要求：iOS 端伴星的消息通知，覆盖**主动消息、任务完成、伴星回复**三类；开通通知通道，通知里放**伴星头像**与**缩略消息**。

| 决定 | 做法 | 原因 |
| --- | --- | --- |
| 先做本机通知通道 | 用 `UNUserNotificationCenter` 在 App 内投递本机通知，不接 APNs | 本机没有 Apple 签名身份与 APNs 凭据，远程推送无法端到端验收；本机通道可在模拟器完整验证，且与后台事件共用同一份内容模型，之后接远程推送只需增加传输层 |
| 只在 App 不在前台时弹 | `scenePhase != .active` 才投递；前台时 `willPresent` 返回空 | 前台已有伴星气泡和对话，系统横幅会重复打扰 |
| 进入书房后询问一次权限 | `requestAuthorizationIfNeeded()`：仅在 `.notDetermined` 时弹系统授权框 | 通知是伴星消息的默认出口；拒绝后 iOS 不会再次打扰，设置页仍可去系统设置改 |
| 三类消息共用一套内容规则 | 纯逻辑 `CompanionNotice` 决定副标题、缩略正文、去重身份 | 文案与去重可用 `swift test` 直接验证，不依赖模拟器 |
| 头像用 App 内同一张伴星图 | 把 `CompanionAvatar` 渲染成 PNG 写入缓存，作为 `UNNotificationAttachment` | 通知右侧缩略图与 App 内头像是同一张图；每条通知用独立副本，避免系统移动附件文件后互相影响 |
| 同一回合只留一条 | 通知身份优先用 `messageId`，其次 `runId`；并记录已通知的 run | 主动分条发言会先到 `assistant.utterance`、随后到 `turn.completed`，两条不能弹两次 |
| 回到前台清掉通知 | `scenePhase == .active` 时移除已投递与待投递的伴星通知 | 用户已经看到对话，旧通知不应留在通知中心 |

## 通知内容

- **标题**：伴星在账号里的名字；还没读到时用「伴星」。
- **副标题**：主动消息「主动想到你」；任务完成「任务完成」；普通回复不加副标题。
- **正文**：缩略消息。先按共享的 `companionSpeechSentences` 清理 Markdown 标题/列表/强调/链接，折叠换行与多余空白，再按整句累积到 60 个字符；超出时截断并补「…」。空正文不投递。
- **缩略图**：右侧显示 `CompanionAvatar`（与 App 内头像同一资源）。
- **其他**：`threadIdentifier = "companion"` 分组、默认声音、`interruptionLevel = .active`。
- **点击**：任务完成打开这次 run 的记录；回复/主动消息回到伴星对话并刷新，消息在底部。

## 真实调用链

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 内容模型 | `apps/mobile-client/ios/Astella/Companion/CompanionNotice.swift` | `CompanionNoticeKind`（reply/proactive/task）、缩略正文、通知身份、`CompanionNoticeOpen(userInfo:)` 点击落点；纯 Foundation，可单测 |
| 通知通道 | `apps/mobile-client/ios/Astella/App/CompanionNotifications.swift` | 授权读取/请求、`post` 投递、伴星头像附件、去重与已通知集合、前台/回前台清理、`UNUserNotificationCenterDelegate`（前台抑制 + 点击转发） |
| 触发 | `apps/mobile-client/ios/Astella/Companion/CompanionDelivery.swift` | `assistant.utterance`（`payload.proactive` 区分主动/回复）与 `turn.completed`（`silent`/工具调用/是否有用户消息区分任务与回复）调用 `postCompanionNotice` |
| 状态与路由 | `apps/mobile-client/ios/Astella/App/AppStore.swift`、`Store/ConversationMethods.swift` | 初始化时同步伴星名字并订阅通知点击；`postCompanionNotice`/`openCompanionNotice`；伴星改名后下一次通知用新名字 |
| 生命周期 | `apps/mobile-client/ios/Astella/App/AstellaApp.swift` | `AstellaAppDelegate` 在启动完成前挂通知代理；`scenePhase` 同步 `isAppActive` 并在回到前台时清理；进入书房询问一次授权；切后台时申请一段有限的后台执行时间，给"发完就走"的在途回复留窗口 |
| 设置文案 | `apps/mobile-client/ios/Astella/Screens/SettingsDetailScreens.swift` | 「设备权限 → 通知」改为伴星主动消息/任务完成/回复，并写清完全关闭 App 时不推送的边界 |
| 验收入口 | `CompanionNotifications.swift`（DEBUG） | 启动参数 `--debug-notice=reply|proactive|task`，可选 `--debug-notice-delay=<秒>`；只用于模拟器窗口验收 |

### 触发判据

- **主动消息**：`assistant.utterance` 的 `payload.proactive == true`。
- **伴星回复**：普通回合的 `turn.completed`；没有工具调用、不是静默成果时按回复处理。
- **任务完成**：`turn.completed` 且 `payload.silent == true`、或该回合有工具调用、或存在工具成果回执；没有用户消息的回合视为伴星自己发起。
- **App 前台**：触发函数照常进入，但通道按 `isAppActive` 跳过；`willPresent` 同时兜底返回空。

## 边界与限制

- **App 被系统挂起或完全关闭后收不到通知**：本机通知需要 App 进程还活着才有代码执行；WS 断开或进程挂起后没有投递者。这是本轮选择的通道边界，不是缺陷。切后台时会申请一段有限的后台执行时间，覆盖"发完消息马上离开、回复还在路上"的常见情况；模型慢于系统给的后台时间时仍会错过。远程推送（APNs）需要 Apple 开发者凭据与已签名构建，未在本轮接入。
- **横幅里不显示头像缩略图**：伴星头像作为 `UNNotificationAttachment` 已被系统接受（日志 `delivered=true attachments=1`），按 iOS 的通知布局，图片附件在展开视图/通知中心呈现；紧凑横幅保持"标题 + 副标题 + 缩略消息"。要让头像直接出现在横幅左侧（替代 App 图标），需要 Apple 的 Communication Notifications 权限（`INSendMessageIntent`），本机无签名与该权限，未接入。
- 只有当前主会话的事件会触发；其他书房的会话不订阅。
- 通知权限被拒绝时，App 内消息与气泡不受影响，设置页会显示「已拒绝」并提供去系统设置的入口。
- 不在前台弹的判据是 `scenePhase == .active`；下拉通知中心、App 切换器等 `inactive` 状态仍会投递，属于「不在前台」的预期范围。

## 验证

- `apps/mobile-client/ios` 的 Debug 增量构建通过（保留既有 DerivedData，不 clean、不 archive、不导出 IPA）；本轮最终构建无新增编译警告。
- `swift test --scratch-path /tmp/astella-companion-protocol-tests`：28 项通过（12 项既有语音/排版 + 16 项新增通知内容），覆盖缩略正文的 Markdown 清理、空白折叠、中文标点与 emoji、60 字符截断与省略号、三种类型副标题与 rawValue、通知身份回退与稳定性、`isDeliverable`、点击落点四键解析。
- 权限链路：模拟器上 App 的授权请求真实弹出（[权限弹窗](assets/ios-companion-notifications-2026-10-23/permission-prompt.png)）；本轮测试用模拟器已有授权数据让状态变成 `authorized`，日志确认为 `authorization=2 alert=2`。
- 通知横幅（最终构建、App 已切到后台、真实系统通知）：
  - [伴星回复](assets/ios-companion-notifications-2026-10-23/reply-notification.png)：标题「伴星」，正文为缩略消息，超出 60 字符显示「…」。
  - [主动消息](assets/ios-companion-notifications-2026-10-23/proactive-notification.png)：副标题「主动想到你」。
  - [任务完成](assets/ios-companion-notifications-2026-10-23/task-notification.png)：副标题「任务完成」。
- 原生日志（[native-log-evidence.txt](assets/ios-companion-notifications-2026-10-23/native-log-evidence.txt)）：`posted kind=reply/task`、`added … delivered=true attachments=1`（伴星头像附件被系统接受）；真实回合事件进入通知代码时前台抑制为 `skipped: app-active`，证明触发链已接上。
- 真实后台回复：把 App 切后台后通过 HTTP 提交真实回合，回复确实写入会话，但模拟器在当前构建下已挂起 App，未执行事件消费，因此没有弹出通知；这是「App 还活着才投递」边界的实测证据，不是通知代码失败。
- 说明：构建期间工作区有另一并行会话未登记进 Xcode 工程的新文件（图片草稿相关），本轮把它们补进 `project.pbxproj` 才能继续构建；未改动其文件内容，本轮通知实现不依赖它们。

## 实际窗口回路

2026-10-23 在独立 iPhone 17 / iOS 27 模拟器（UDID `912953CC-9AD5-4BF3-A81C-A506D8CC6F36`，headless `simctl`）安装本轮最终 Debug 构建，以真实合成账号会话启动；`simctl launch com.apple.springboard` 切到桌面让 App 进入后台，再触发通知：

1. 授权：App 启动后系统弹出「“拾星”想给你发送通知」，说明请求链路已接上（[弹窗](assets/ios-companion-notifications-2026-10-23/permission-prompt.png)）。本机没有可用的签名模拟器 GUI（Xcode 27 的 DeviceHub 不暴露 AX 窗口，前台被其他自动化占用），弹窗点击由模拟器侧已完成授权的测试数据替代，并在日志里核对为 `authorization=2 alert=2`。
2. 回复：后台收到通知横幅，标题「伴星」、正文为自然句缩略并带「…」，见[截图](assets/ios-companion-notifications-2026-10-23/reply-notification.png)。
3. 主动消息：同一路径加副标题「主动想到你」，见[截图](assets/ios-companion-notifications-2026-10-23/proactive-notification.png)。
4. 任务完成：同一路径加副标题「任务完成」，正文完整显示"整理好了…"，见[截图](assets/ios-companion-notifications-2026-10-23/task-notification.png)。
5. 前台抑制：App 在前台时真实回合的 `turn.completed` 到达通知代码，日志记录 `skipped: app-active`，不弹横幅；回到前台还会清掉已投递的伴星通知。

未完成/未验证：
- **头像在横幅里的直接呈现**：附件已创建并被系统接受，但紧凑横幅只显示文字；展开/通知中心的图片呈现没有可靠的自动化手势可复核（Device Hub 无 AX、坐标点击被其他前台窗口拦截）。让头像出现在横幅左侧需要 Communication Notifications 权限，见「边界与限制」。
- **点击通知回到对话/记录**：`didReceive` → `openCompanionNotice` 的映射由单元测试覆盖（四键解析），完整的"点横幅打开对应页面"未在本次窗口里点到；这是下一步真机或可交互模拟器要补的验收。
- 真机的锁屏、勿扰、通知摘要与横幅时长策略未验证；模拟器的后台存活行为不能代表真机。

## 外部依据

- [UNUserNotificationCenter](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter) 与 [UNNotificationAttachment](https://developer.apple.com/documentation/usernotifications/unnotificationattachment)：本机通知投递与图片附件。
- [UNUserNotificationCenterDelegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate)：前台是否展示与点击回调。
- [scenePhase](https://developer.apple.com/documentation/swiftui/environmentvalues/scenephase)：前台/后台判据。
