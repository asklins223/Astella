# iOS 相伴、声音与原句讲解交付 — 2026-10-22 / 23

## 本轮决定

用户选择「贴近说话」：首页保留大伴星与当前一句气泡，只有存在更多正文或已保存的讲解时才显示查看入口，在当前页打开阅读面板；短句与等待状态不出现“展开”。记录仍保留完整对话。长讲解自然分句完整朗读，可以随时暂停、停止或插话。沿用苹方、中性纸面和鲜亮钴蓝，不增加渐变或多色过程卡。Android 本轮不改。

## 真实调用链

- `CompanionRealtime` 的鉴权 WebSocket 提交、事件订阅与相同请求身份的 HTTP 回退继续复用。`CompanionStreamLedger` 拦截历史与重复事件，正文按服务端 UTF-16 偏移合并，首批增量不再因 `isSending` 被忽略。新问题携带已知活动回合的 `supersedesGeneration`。
- `voice.segment.ready` V2 → `CompanionSpeechSegment` → `CompanionVoicePlayback` → `POST /voice/tts/stream`。实时回复提交签发的段引用，合成正文、账号音色与本轮语气由服务端解析；客户端不把思考内容或工具过程送入朗读。
- `URLSession.AsyncBytes` 增量读取 → `AudioFileStream` 解析 MP3 → `AudioQueue` 消费。播放器在下载结束前启动；网络读完后等待音频队列真正排空。暂停、停止、旧请求取消与后台停止共享同一世代围栏；缓冲数量与单段字节均有界。
- 手动回听和已保存的完整原句讲解按自然短句进入同一播放器；流式文本请求符合现役 V1 的身份、序号和长度合同。流式 V1 读取真实账号的音色与语速，与 `/voice/tts` 普通朗读保持一致。
- 实际播放电平驱动嘴部；段的语义 cue 驱动已有的 Live2D 表情。首页舞台与右下角模型共用状态。中性表情显式清除表情参数，模型加载期间保留待应用表情；离屏、后台与减少动态停止装饰循环。
- 首次消息快照不触发朗读；普通最终消息、主动分条发言、任务成果均有明确的展示入口。真实播放结果按签发段引用写入 `/voice/tts/playback-outcome`。来电和耳机断开暂停声音，恢复播放由用户控制。

## 笔记与阅读

阅读器的长按选段与拖动跨段复用一套动作条；移除重复的旧动作监听与未定义的指针处理器。选段菜单传递原句锚点、不可变版本与当前 viewport 的几何范围。Native 只做一次全局坐标换算，将选段副本沿曲线递给右下角伴星，原文仍在原处。请求与动画同时开始，减少动态直接进入可读状态。跨段摘录保留双换行，前后文各使用服务端合同规定的最多 120 个 UTF-16 单元；超出 2000 单元的选段仍能复制，但不能提交被截短的错误锚点。原位批注使用服务端已校验的当前版本坐标，不再被客户端的简化 Markdown 正则误判隐藏。

选段讲解改用共享 Agent 的 `replyPurpose: annotation` 与 `annotationTarget`，由 `companion_write_annotation` 写入完整正文。`agent.tool` 成功回执才会标为已保存、更新原位批注、展示成果并完整朗读；不再同时启动旧的 `annotation-tasks` 轮询。手写批注仍走真实增删改接口。

右下角气泡可打开保存的讲解；完整讲解、原句和回听入口也进入记录，并可从 run 快照重新读取。工具过程默认收起，思考独立展开；过程只展示人可读的动作与回执，不显示内部工具调用 ID。正文使用 Foundation 的 Markdown 块结构，分别排版标题、段落、列表、引用、代码和横向表格；行内强调与内部笔记链接保留。声音失败保留文字和保存结果，并在气泡内给出重听入口。首页和阅读页共用播放器，不重复出现两套播放控件；录音器只有在持有录音会话时才释放系统音频，离开首页不会误停跨页朗读。开始录音等待朗读会话释放，取消后的旧转写不再回填。音频会话激活与释放在串行 actor 中执行，并使用世代围栏处理打断。前台安静时保留主动参与，在正在输入、录音、发送或播放时明确报告不适合插话。同一段安静时间只上报一次 quiet 事件，成功上报后才登记，真实操作或前后台变化形成下一次活动基准，避免每 15 秒持续触发新话题。提交重试或断线时还会按原 requestId 读取 run 快照恢复已保存讲解，避免一直等待旧回执。

## 验证

- iOS 增量 Debug 构建通过，使用既有 `/tmp/astella-ios-derived`，未 clean、archive 或导出 IPA。
- `swift test --scratch-path /tmp/astella-companion-protocol-tests`：最终 12 项通过，覆盖事件重放、UTF-16 与 emoji 偏移、长文本分句的完整性与长度上限、服务端段引用与表情，以及标题、强调、列表、引用、代码、表格和内部笔记链接的解析；手动朗读不读出 Markdown 列表标记。续验新增中文引号强调、代码内字面标记、句末引号归属和展开入口的标点差异回归。
- `cd apps/api && node --import tsx --test ../mobile-client/scripts/__tests__/note-reader-selection.test.ts`：3 项通过。实际阅读器脚本生成的普通、跨段及长前文锚点交给共享 `noteAnchorMatchesV1` 校验，同时确认一次动作只提交一次，以及全选超限时不提交截短原句。
- API、shared、ai-worker、desktop-client 的对应 `npm run typecheck` 通过。
- API 的 voice-routes 与 tts-synthesis-profile 相关单测：9 项通过。
- 独立本地合成账号实测 `POST /voice/tts/stream` 返回 `audio/mpeg`，13 个音频块、96,639 字节，响应体传输约 816ms。原始音频与临时凭据只留在 `/tmp`，不写入仓库。
- iPhone 17 / iOS 27 模拟器上的真实账号已接到启动问候与模型回复，真实 Live2D 渲染。原生音频日志：短句 1 约 500ms 开始，762ms 时收齐，随后正常播完；短句 2 约 523ms 开始，691ms 时收齐，随后正常播完。证明本轮播放器在传输结束前启动，不能由此推导实体设备听感或硬件帧率。
- 同时运行的另一项调试会重启共用 iPhone 17，后续先使用 `Astella Companion QA`，最终使用独立的 `Study Speech 5c3656b8`。2026-10-23 用户确认另一会话已暂停后，完成最终窗口续验。

## 实际窗口回路

独立模拟器的真实测试账号打开导入笔记《赤壁赋 · 相伴验收》，长按“清风徐来，水波不兴。”并点击讲解：

1. 看到选段副本沿曲线向右下角递送，原文与滚动位置保留；小伴星展示真实等待与工具进展。
2. Agent 读取原笔记并写入完整讲解，`GET /v2/notes/:id/annotations` 返回与选段一致、状态为 `current` 的保存结果，任务为 `succeeded`；没有用本地预制讲解替代。
3. 阅读页原句出现真实批注高亮，小气泡逐句展示并朗读保存的讲解，小模型正常裁切显示，播放时有嘴部变化。
4. 点暂停后控件变为继续；打开“查看原句讲解”是在当前阅读页上呈现面板；点击继续后原生日志确认后续第 14、15 段开始和完成，证明跨段队列没有卡在下载终态。

2026-10-23 最终窗口续验使用真实合成账号、真实笔记与已保存结果，未启用 Debug 示例接口。发现并修复：

- 首次点击高亮曾进入无原句的空编辑框；改为 `sheet(item:)` 一次携带锚点与结果，重新安装后首次打开正确显示原句及完整讲解。
- 中文引号紧邻汉字时，Foundation 会将两处 `**「词」**` 误配，导致符号泄漏或中间文字加粗；规范化边界后再移除临时边界，标题、列表、强调与代码保持原有语义。新增测试第一次暴露误配，修正后 12 项全部通过；实际窗口确认“「乐」”不再显示星号。
- 句末引号曾落入下一只气泡；手动分句保留连续的结束引号及括号，保持正文完整。
- 全文面板曾随着气泡的定时退场一起关闭；将其提升到 Shell 持有。实际打开原句讲解、停止声音并等待气泡消失后，面板仍留在同一笔记页，可继续阅读及完整回听。
- 保存讲解的回听保留原句身份；小气泡“查看原句讲解”打开同页面板。暂停、继续、停止均显示真实播放状态；阅读页返回首页后同一队列继续，当前句移到大伴星上方，没有从头播放。
- 原生流式分句可能暂时少一个句号；展开判断忽略标点与空白差异，避免为相同内容提供无意义的展开。确有后续正文或完整讲解时仍保留查看入口。

最终增量构建通过，用时 8.39 秒；围绕以上实际缺陷的前几次增量构建分别为 22.11、8.47、6.25、17.09、6.60 秒。未清理缓存或重编译 SDK。全量协议／排版、选区合同及服务端声音相关检查共 24 项通过；四个包的类型检查沿用本轮此前已通过的结果，续验未再改共享或服务端代码。

最终短句按钮的逻辑回归和构建已通过。捕获期间曾遇到 Mac 锁屏，用户解锁后完成实际复核：在真实记录中长按已保存的单句回复，选择“朗读”，返回伴星页并暂停；气泡完整显示该句，仅保留继续和停止，没有“展开”或“查看完整内容”。全过程使用真实账号数据及真实 TTS，无须重新生成模型回复或使用预览数据；[最终单句截图](assets/ios-companion-delivery-2026-10-22/single-sentence-without-expand.png) 已保存。此项窗口复核现已完成。

窗口素材见 [原句讲解](assets/ios-companion-delivery-2026-10-22/saved-explanation.png)、[修正中文强调后的长文](assets/ios-companion-delivery-2026-10-22/explanation-cjk-emphasis.png)、[同页全文](assets/ios-companion-delivery-2026-10-22/same-page-detail.png)、[气泡退场后保留的全文](assets/ios-companion-delivery-2026-10-22/detail-after-caption-dismissal.png)、[跨页续读](assets/ios-companion-delivery-2026-10-22/home-continuing-speech.png) 和 [无正文、无凭据的原生声音日志](assets/ios-companion-delivery-2026-10-22/native-voice-timing.log)。旧的空闲截图仅表示朗读后状态，不当作短句按钮的证据。新实例从 API 重新取得已保存原位批注并渲染高亮，成果不依赖内存中的本次请求。

构建保持增量缓存。两次构建遇到同时进行的 Live2D 诊断改动中的 SDK 顶点类型与不存在的 `csmFloat64` 类型错误；对应类型已修正，重新构建通过，没有清理或重编译 SDK 框架。

实体设备麦克风、耳机切换、来电、VoiceOver、系统减少动态与极端字号组合、实际音画延迟仍需专项验收；本记录不以构建、截图或模拟器日志替代这些结果。

## 外部依据

[Foundation PresentationIntent](https://developer.apple.com/documentation/foundation/presentationintent) 用于原生 Markdown 块结构；[Apple Audio File Stream Services](https://developer.apple.com/documentation/audiotoolbox/audio-file-stream-services) 与 [Live2D 口型文档](https://docs.live2d.com/4.2/en/cubism-sdk-manual/lipsync/) 分别作为增量音频解析、实际音量驱动口型的依据；耳机断开按 [Apple 音频路由说明](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes) 暂停。
