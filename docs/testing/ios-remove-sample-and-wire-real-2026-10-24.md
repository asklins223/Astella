# iOS 移除示例内容并接线真实能力（2026-10-24）

日期：2026-10-24，Asia/Shanghai。

## 用户决定

2026-10-24 用户要求：删除所有“示例／模版”内容，把没有真实接线的功能改为调用真实 API；开发验收不再保留 Debug 示例夹具或直达预览路由。本文记录 iOS 客户端的执行范围与验证边界；历史测试记录不改写。

## 删除范围

- 首次相伴引导示例（方案 59，11 站）：`ios/Astella/Journey/` 全部源码（JourneyContent、JourneyProgress、JourneySampleEngine、FirstJourneyCoordinator、JourneyAudio、JourneySettings、FirstJourneyView、JourneyLibrary）、`Journey/Audio/` 的 9 个随包 mp3 与清单，以及 App/Shell 中 `firstJourney` 状态和入口。
- DEBUG UI-review 夹具系统：`AppStore` 的 `reviewMode`/示例注入，`api.isUIReview`/`journeySample`，`reviewImageInputs`，Shell 的 `--ui-review` 路由排队与 dock 示例入口；`--ui-dark`/`--ui-reduce-motion`/`--ui-large-type`/`--ui-long-content` 等预览启动参数。
- Screens/Auth/Design、Companion/Conversation 中的示例数据、`#Preview` 示例快照与“示例／样例／演练／界面预览”用户文案；删除 `Astella/Conversation/CompanionRecordFixtures.swift`。
- 构建与工程：`ios/Package.swift` 的 FirstJourneyCore target 与 FirstJourneyTests testTarget；`ios/JourneyTests/`；Xcode 工程中上述源文件、Journey Audio 文件夹引用与 CompanionRecordFixtures 的 PBXBuildFile/PBXFileReference/group/Sources/Resources 条目。
- 脚本：`scripts/ios-dev.py` 删除 ROUTES、open_route、open 子命令与 device --route；保留增量 build 与 device 安装/启动。
- 服务端随功能一起清掉的死代码（客户端已无调用方）：`/me/companion/first-journey` 两个方法、`modules/companion-shell/first-journey-state.ts` 与其测试、`integration-tests/ios-first-journey-postgres.integration.ts`、`scripts/generate-ios-journey-audio.ts`、shared 的 `IOS_FIRST_JOURNEY_*`/`iosFirstJourney*` 合同；`personalization-routes.ts` 只保留 `/me/companion/personalization`，原来的称呼 schema 边界测试移入 `__tests__/personalization.test.ts`。
- 文档：AGENTS.md/README.md/DEVELOPMENT.md/DESIGN_SPEC.md 中要求 Debug 示例、直达路由和首次引导的现行指引（历史测试记录保留原样）。

保留的真实账号 Debug 入口：`--open-memory=<uuid>`、`--open-account=<id>`、`SIMCTL_CHILD_ASTELLA_API_TOKEN` 注入；它们读写真实后端，不作为示例数据。

## 接线范围（已由 Lead 定稿）

1. 我的 → 我的伴星 →「名字与称呼」：伴星名字走 `GET/PATCH /companion/pet-profile`；私下称呼走 `GET/PUT /me/companion/personalization`（revision CAS，409 保留草稿并提示另一方设备已更新）。两者都调用真实后端，失败保留输入。
2. 「熟悉的声音」去掉随包示例音频：方言列表来自新增 `GET /voice/catalog`（服务端从共享音色目录派生），默认声音来自 `GET /voice/preference`；试听改为新增 `POST /voice/audition` 的真实 TTS 合成（qwen 优先、edge 兜底，固定预听句，按方言选音色，试听不写账号偏好）；只有点“使用”才 `PATCH /voice/preference`。
3. 「表达与相处」只编辑 `speakingStyle`（名字归「名字与称呼」），保留 revision 冲突与“采用这份设置”。
4. 相机权限脚注改为与真实拍照入口一致的文案。
5. 服务端：`apps/api/src/modules/learning-sessions/voice-routes.ts` 新增 `GET /voice/catalog` 与 `POST /voice/audition`；iOS 侧新增 `Astella/App/Store/VoiceMethods.swift`（已加入 Xcode target），`Astella/App/MobileAPI.swift` 增加 `auditionSpeech`，`Astella/Companion/CompanionVoicePlayback.swift` 增加 `playAudition`。
6. `apps/mobile-client/API_SURFACE.md` 已更新：新增 `/voice/catalog`、`/voice/audition` 两行，`/voice/preference` 改为已恢复真实客户端调用；`/me/companion/personalization` 恢复 ✅ iOS；proposals、awareness、文件导入手记、模型清单按审计改为已接线。

## 验证（Lead 集成执行，2026-10-24 13:51–13:58 CST）

- **源码/工程静态检查**：`python3 -m py_compile scripts/ios-dev.py` 通过；`plutil -convert xml1` 解析 pbxproj 通过；工程对象交叉引用检查通过；所有 `path = Astella/...swift` 引用均指向真实文件；`grep -rn "Journey\|CompanionRecordFixtures\|ui-review\|uiReviewMode\|isUIReview\|reviewMode:" ios/Astella --include=*.swift` 无结果；`ios/Astella` 全量 `swiftc -parse` 通过；`git diff --check` 只剩已修的空白项。
- **Xcode Debug 集成构建**：通过，0 error。首次删除后构建 48.49 s；新增真实账号调试直达（`--open-account=companion-identity|companion-voice`）后 12.59 s；方言选择器横向溢出修复后 9.53 s（日志 `/tmp/ios-build-after-removal.log`、`/tmp/ios-build-routes.log`、`/tmp/ios-build-voicefix.log`）。未 clean/Archive。
- **服务端清理**：`apps/api` 与 `packages/shared` 的 `npm run typecheck` 均通过（`/tmp/api-typecheck-journey-cleanup.log`、`/tmp/shared-typecheck-journey-cleanup.log`）；`companion-shell` 单元测试 12 项通过（含迁移后的私下称呼边界测试）。
- **SwiftPM**：90 项通过、0 失败（CompanionProtocol 30、CompanionRecords 55、NoteGeometry 5；FirstJourneyTests 已随 target 删除）。日志 `/tmp/ios-final-swift-test.log`。
- **服务端**：`apps/api npm run typecheck` 通过（`/tmp/api-typecheck-voice.log`）。用真实账号会话对运行中的本地 API 实测：
  - `GET /voice/catalog` → 200，返回固定预听句与 21 个方言项（普通话 + 20 种方言）。
  - `GET /voice/preference` → 200，返回该账号真实默认 `qwen / longhua_v3.1`；`GET /me/companion/personalization` → 200 `{revision:0, preferredAddress:null}`（未写入真实账号数据）。
  - `POST /voice/audition` 普通话 → 200 `audio/mpeg` 97,893 字节；河南话 → 200 `audio/mpeg` 89,116 字节（真实上游合成，非随包录音）；非法方言 → 400 `INVALID_DIALECT`。
- **模拟器真实窗口**（注入真实账号 token，非示例夹具）：App 安装启动正常，首页为真实会话与真实 Live2D 模型；「名字与称呼」显示真实账号里的伴星名「爱吃白饭的大肥鱼」，私下称呼为空、等待填写；「声音」显示真实默认「普通话」、真实方言目录、真实预听句。截图：`apps/mobile-client/outputs/ios-remove-samples-2026-10-24/`（`home-real-account.png`、`companion-identity-real-account.png`、`companion-voice-real-catalog.png`）。
- 本次验证直接促成的修复：方言目录 21 项在原实现中用单行 `HStack` 把整页撑出屏幕宽度；现改为窄屏横向滚动、大字号两列网格，窗口复核通过。

## 剩余限制

- 真机与真实听审未完成：模拟器无法确认试听音量、延迟与耳机/后台中断；TTS 合成字节与解码播放链路分别验证，未做听感验收。
- 未提交真实账号的写入：私下称呼保存、默认方言保存、409 冲突只做代码级核对与真实账号读路径实测，避免改动用户现有账号数据。
- 远程推送未接线：全仓库没有 APNs/FCM 服务端设施，本机通知仅在 App 后台存活时有效。
- `GET /app/version` 与 `GET /app/client-assets/manifest` 服务端仍未实现；客户端已有 404 诚实降级，不宣称资源热更新可用。
- `.build/` 与 DerivedData 中旧的 Journey 编译产物未清理，不影响源码构建。
