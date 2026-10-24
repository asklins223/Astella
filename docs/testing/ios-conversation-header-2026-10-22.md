# iOS 相伴页头：自动朗读并入分段胶囊 — 2026-10-22

## 用户决定与范围

用户在模拟器截图里标注了相伴（对话）页头：把声音按钮换到日夜切换按钮的位置，日夜切换按钮移除。本轮只改 iOS 相伴页头，Android 不改界面；工作区选择、伴星／记录分段、底部输入条与自绘 Dock 都不动。设计决定已写入 [DESIGN_SPEC.md](../../apps/mobile-client/DESIGN_SPEC.md)（页头与信息结构两处，并追加 2026-10-22 条目）。

## 实现

- `apps/mobile-client/ios/Astella/Conversation/ConversationScreen.swift` 的 `ConversationTopBar`：
  - 删除页头里的日夜切换按钮，同时移除只为它服务的 `@AppStorage("study.appearance.dark")`、`@AppStorage("study.appearance.mode")`、`@Environment(\.colorScheme)` 与 `isDark`，页头不再持有外观状态。
  - 原先独立在胶囊左边的 44×44 朗读按钮移入纸白胶囊，成为「伴星／记录」之后的第三格；触控位 44×38，与两段等高，按压沿用分段控件的 `AstellaPressStyle`。
  - 开启时钴蓝 `speaker.wave.2`，关闭时灰色 `speaker.slash`；符号切换用 `contentTransition(.symbolEffect(.replace))`，动画经 `Motion.gated(reduced || store.localReduceMotion, Motion.tap)`，系统减少动态或应用内减弱动效时直接换符号，不补动画。
  - 点按仍调用 `store.voicePlayback.toggleAutomatic()`，写入 `study.companion.speechEnabled`，真实链路未变。补了 `Haptics.select()` 与 `.accessibilityValue("已开启"/"已关闭")`；录音／转写期间 `.disabled(isVoiceBusy)`，避免关闭自动朗读时 `stop()` 释放共享 `AVAudioSession` 打断采集。
- 外观入口：日夜外观本来就在「我的 → 设置」的银白／深夜／随系统（`MobileSettingsScreen`、`ReadingSettingsScreen`），页头按钮只是重复入口。移除后外观仍可切换，对话页继续随根视图 `preferredColorScheme` 即时变化。
- 文档：更新 `apps/mobile-client/DESIGN_SPEC.md` 与 `apps/mobile-client/README.md`，README 链接到本记录。

## 验证

环境：iPhone 17、iOS 27.0 模拟器（`B669C1D3-56BF-4DAF-992B-BAE49FC738D4`），Xcode 27，Debug，`scripts/ios-dev.py open conversation` 本地示例（带「界面预览 · 本地示例」标识），未调用真实 AI、语音或写入接口。

- 构建：在 `apps/mobile-client/` 执行 `python3 scripts/ios-dev.py build`，只强制重编本文件所在批次，8.55s 通过，`BUILD SUCCEEDED`，无 error，无 `ConversationScreen.swift` 相关 warning。
- 版式（截图 01 → 02）：页头只剩工作区选择与一枚纸白胶囊「伴星｜记录｜朗读」；日夜月亮按钮消失，朗读按钮落在原月亮的位置。工作区文案、两段选中态（伴星浅蓝胶囊＋钴蓝字）与页头高度不变。
- 状态（截图 02、04）：默认 `study.companion.speechEnabled=true` 时第三格为钴蓝 `speaker.wave.2`；把模拟器应用偏好里的该键改为 `false` 并重启进程后变为灰色 `speaker.slash`，说明符号与颜色确实由真实偏好驱动（只改模拟器数据，不动仓库代码；验证后已恢复 `true`）。
- 深夜外观（截图 03）：`--ui-dark` 下胶囊、分段、朗读符号、页头文字与 Dock 仍可读，无低对比或裁切。
- 外观可达性（代码核对）：设置中心与阅读设置仍提供银白／深夜／随系统，并写入 `study.appearance.mode`；根视图据此设置 `preferredColorScheme`，页头移除不影响外观切换。
- 减少动态（代码核对）：符号替换动画和选中态动画都走 `Motion.gated`，`--ui-reduce-motion` 下退化为无动画的状态切换，功能不等待动效。
- 限制：模拟器没有触摸自动化，未做真实点按，朗读开关的点按行为只由源码链路确认；未在真机复核触感、VoiceOver 与音频会话边界；截图不能证明真机帧率。

### 并发说明

验证期间，同一工作区有另一项笔记目录重构（`NoteOutline`／`NoteWebReader`／`project.pbxproj` 等）在并发编辑和构建。首次构建因那份尚未完成的引用（`NoteReader.swift` 找不到 `NoteOutline`）失败，与本改动无关；其后的增量构建与本次强制重编均通过。页头文件的改动本身没有与并发改动重叠。

## 遗留（本轮未处理）

- `Design/Components.swift` 的 `AstellaAppHeader` 未接入任何页面，里面还有一枚旧日夜按钮，属于未渲染的死代码；本轮不扩大改动面，未删除。
- 伴星设置的「朗读回复」开关写入 `study.companion.autoRead`，但没有代码读取该键；页头按钮才是真正生效的自动朗读开关。这是既有不一致，等该设置页改动时再统一。

## 截图

| 截图 | 内容 |
| --- | --- |
| [01-before-light.png](assets/ios-conversation-header-2026-10-22/01-before-light.png) | 改动前：独立朗读按钮＋「伴星｜记录｜月亮」胶囊 |
| [02-after-light.png](assets/ios-conversation-header-2026-10-22/02-after-light.png) | 改动后：胶囊「伴星｜记录｜朗读」，日夜按钮已移除（自动朗读开启态） |
| [03-after-dark.png](assets/ios-conversation-header-2026-10-22/03-after-dark.png) | 深夜外观下的同一页头 |
| [04-after-auto-read-off.png](assets/ios-conversation-header-2026-10-22/04-after-auto-read-off.png) | 自动朗读关闭态：灰色 `speaker.slash` |
