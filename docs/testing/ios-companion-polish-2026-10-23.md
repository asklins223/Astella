# iOS 伴星、长笔记与学习卡补齐（2026-10-23）

本轮对应用户九张标注图，以及“缓存命中仍慢、没有骨架”和“长笔记不要一次加载全文”的后续要求。保留此前的真实 WebSocket、TTS、Live2D、附件缩略图和同次发送图片浮层。Android 本轮不改界面；新增 reader API 只由 iOS 使用。

## 体验与实际调用链

### 阅读与缓存

原来的 `loadNote` 在读到缓存后又清空正文，阅读页还等待批注请求结束才显现正文，因此缓存没有改善用户实际看到的空白。现改为先发布同账号、同 API、同书房的缓存内容，再刷新当前版本；正文可见性只取决于 WebKit 首帧，不等待批注。首次打开显示文章形状的骨架，WebKit 加载／渲染失败有重试，刷新失败保留本地副本。

- `GET /v2/notes/:id/reader` 默认只取 24 段，最多 32 段，正文预算 48,000 UTF-8 字节。固定不可变版本，保留原段号，不切断原文锚点；单个超长段落允许独占一页。
- 首屏只额外返回总段数和标题目录，不返回目录之间的正文。按 `afterOrdinal` / `beforeOrdinal` 向前、向后取一页；目录跳转直接读取目标附近，不依次请求中间各页。
- 本地缓存按 API／用户／书房隔离，读写移到后台，只保存首屏和目录元数据。缓存不是整篇长文的另一份主线程解码负担。
- WKWebView 保留现有段落 DOM，只向 JS 发送新增／前置／替换的窗口。视口外段落先占位，接近视口再排版，每帧最多两段；公式按段处理、图片延迟读取。追加页面不重建已经读到的正文与选区。
- 更多菜单从省略号下方展开，触点保留并可再次点按收起，点击外部也关闭；仅保留速览、脑图、版本记录、拓展笔记、学习卡。当前笔记的提问统一从浮动伴星发起。

主要实现：`apps/api/src/modules/note/reader-page.ts`、`App/Store/NotesMethods.swift`、`App/CacheManager.swift`、`Screens/Notes/NoteWebReader.swift`、`NotesWeb/reader.js`、`Screens/Notes/NoteReader.swift`。

### 浮动对话与记录操作

浮动对话改用完整记录组件，不再固定截取最后八条。每次打开落在最新消息；向上阅读后停止强制跟随，到顶部读取更早消息，前置完成后保留原消息锚点，提供“回到最新”。它的跟随状态独立于主记录页。笔记内的输入明确携带当前笔记 ID、固定版本与标题，也不会夹带首页尚未发送的草稿附件；提交失败保留输入。

同一次助手回复的复制、朗读使用整次正文。关闭记录正文内部的逐段原生选区，富文本引用／代码也遵循这一规则，展开到专门阅读面板后仍可选择文字。此前用户附件独立位于气泡上方、96pt 历史缩略图、同次图片浮层的结构继续保留。

主要实现：`Conversation/MessageHistory.swift`、`Conversation/MessageRow.swift`、`Shell/MainTabShell.swift`、`App/Store/ConversationMethods.swift`。

### 图片识别

问题并非缩略图上传失败：真实附件没有进入首步工具面，纯文字快捷路径可能直接回复“看不到”，读取工具还藏有与上传 10MiB 不一致的 2MiB 上限。

现在真实附件进入初始工具面和运行时，跳过纯文字快捷路径，在策略允许且用户没有明确拒绝看图时要求读取回执。模型仍按现有治理与视觉模型配置调用，不伪造“已看图”。上传与读取共用 shared 的 10MiB 常量。iOS 未开启图片外发策略时先解释并询问，保存同意后再发送；没有静默修改真实账号策略。

真实测试账户明确开启该策略，三张原生上传图片分别约 4.7MB、1.9MB、2.5MB。最终回合 `228b482b-c3eb-4958-97c3-b446e9bb2b6d` 调用实际配置的 MiMo 视觉模型，三张均取得成功读取回执；其中第一张一次连接重置，模型重试后成功，共四次工具调用。保留了失败到重试的证据，不把此前无工具、依赖历史猜测的回合算为成功。

证据：[real-vision-proof.json](assets/ios-companion-polish-2026-10-23/real-vision-proof.json)。

### 学习卡

生成采用独立场景：提交、排队／运行、质量核对、就绪／失败来自真实任务状态，显示实际等待时间，不编造百分比。可以返回笔记，后台任务继续；重进恢复状态，失败可重试。服务端同时返回 `generationStatus` 和 `generationStartedAt`，客户端支持带毫秒时间戳。

真实生成验收暴露了审题输出漏交题目的问题。审题改用现有 Agent provider 的结构化提交工具，声明精确题数及完整字段；MiMo 在 auto 工具选择下返回普通 JSON 时仍经过相同校验。逐题独立答案、逐字原文依据、歧义与重复考点校验没有放宽。最终真实生成四题、保存作答、交卷、批改与点评均成功，结果 100 分、5 星；同一份结果也已从原生学习卡打开核对。

练习页以实际已答数表示进度，题号网格可自由跳转。草稿保存按修订确认：旧请求不能清除后续输入，失败保留重试，交卷和返回等待待保存内容写完。开始接口可能恢复既有尝试，恢复答案在进入可操作题面之前完成，避免迟到读数覆盖首个点击。配对题严格沿用服务端“右侧选项完整文本”的合同。未答题在交卷确认后记为跳过。

结果页突出本次分数、星级、最佳纪录、正确／待回看／跳过统计，题目可展开答案、点评及原文依据；点评缺失可单独补生成。完成时约两秒蓝色星片散开、分数与星级点亮；同一次结果不因展开／筛选重复播放。系统／应用减少动态、离开前台时停止装饰。零分仍显示 0 分、0 星与历史最佳，不凭空奖励分数。最近练习时间不再因毫秒解析失败误写“刚刚”。

真实证据：[real-learning-card-proof.json](assets/ios-companion-polish-2026-10-23/real-learning-card-proof.json)。动效录屏：[learning-completion.mp4](assets/ios-companion-polish-2026-10-23/learning-completion.mp4)；录屏是阻断网络的 Debug 视觉场景，真实模型与成绩由前述独立证据证明。

### 星轨与导航

星空改为平涂深蓝、疏密星点、三颗近星呼吸和低频流星；系统减少动态、应用减弱动效、后台、切页与页首离屏均停止循环。状态栏外观提升到真正持有它的 TabView，夜空上方改为白色内容。底栏四枚 SVG 模板图标由代码绘制，统一线宽和轮廓，实际 iOS 27 系统 Tab 栏使用这些资源；旧系统自绘栏也采用同一语义。

## 真实接口与窗口证据

测试环境是本机 API／worker 与独立的合成测试账户，凭据只放私有临时文件。窗口为 `Astella Image Intake QA`、iPhone 17／iOS 27。所有窗口交互、截图、录制均通过 CUA 和 Device Hub；遇到主窗口呈现／输入不同步时切到独立设备窗口，不据未响应的点按宣称通过。

| 路径 | 实际结果 | 证据 |
| --- | --- | --- |
| 240 段长笔记 API | 首屏 24 段、41,939 字节，旧全文接口 425,698 字节；下一页、远跳 200 段、向前页游标正确 | [分页读数](assets/ios-companion-polish-2026-10-23/real-note-pagination-proof.json) |
| 原生首次打开长笔记 | 看到了文章骨架，随后第 1 版／240 段与首节正文 | [首帧](assets/ios-companion-polish-2026-10-23/reader-first-open.png)、[首屏](assets/ios-companion-polish-2026-10-23/reader-long-first-page.png) |
| 原生目录跳转 | 从首节直接到第 7 节、第 121 段；服务端只有首屏和 `afterOrdinal=119` 两次 reader 请求 | [章节跳转](assets/ios-companion-polish-2026-10-23/reader-long-chapter-jump.png) |
| 浮动对话 | 打开落在 15:44 最新消息，标题显示当前长笔记；向上翻到 09:51 旧消息，真实请求 `limit=50&beforeSeq=63`；点“回到最新”回到 15:44 | [最新](assets/ios-companion-polish-2026-10-23/mini-chat-latest.png)、[旧消息](assets/ios-companion-polish-2026-10-23/mini-chat-older.png) |
| 整次回复操作 | 长按显示整段回复预览与复制／朗读，无逐段选区手柄 | [菜单](assets/ios-companion-polish-2026-10-23/whole-response-menu.png) |
| 阅读更多菜单 | 原触点可见，五项工具，点原按钮关闭 | [工具](assets/ios-companion-polish-2026-10-23/reader-tools.png) |
| 学习卡生成 | 独立状态页、实际阶段、计时与先返回入口；真实模型另有成功和失败回执 | [生成界面](assets/ios-companion-polish-2026-10-23/learning-generating.png) |
| 答题与完成 | 选择答案、题号跳转、配对菜单全文、交卷确认、结果筛选与依据展开；录到星片与星级变化 | [练习](assets/ios-companion-polish-2026-10-23/learning-practice.png)、[动效帧](assets/ios-companion-polish-2026-10-23/learning-completion.png) |
| 真实成绩原生回看 | 四题 100 分、5 星与真实题干／点评一致 | [真实结果](assets/ios-companion-polish-2026-10-23/real-learning-result.png) |
| 最终构建真实保存与恢复 | 选择第一题后立即返回笔记，再打开显示“继续作答 · 已答 1/4”；历史最佳不变，最近练习正确显示“今天 14:52” | [草稿恢复](assets/ios-companion-polish-2026-10-23/real-learning-draft-restored.png)、[卡面时间](assets/ios-companion-polish-2026-10-23/real-learning-front.png) |
| 零分／深色／减少动态 | 实际 0 分、0 星、6 题待回看，历史最佳 83 分／4 星保留；大字号 Debug 环境入口已接入该页族 | [边界界面](assets/ios-companion-polish-2026-10-23/learning-zero-dark-reduced-large.png) |
| 星轨 | 白色状态栏、平涂夜空、新系统底栏图标可见 | [星轨](assets/ios-companion-polish-2026-10-23/orbit-sky.png) |

窗口操作对应的服务端请求另保留为 [native-pagination-proof.json](assets/ios-companion-polish-2026-10-23/native-pagination-proof.json)，只记录测试资源与游标，不含鉴权信息。

## 工程验证与边界

- iOS 增量 Debug 构建通过；固定 DerivedData，未 clean、未 archive、未重编 Cubism。最终界面修正后的构建 14.39 秒、覆盖安装 12.03 秒，安装后重新核对了真实卡片时间与立即返回的草稿恢复。
- `shared`、`api`、`ai-worker`、`desktop-client` 的 `npm run typecheck` 均通过。
- 相关测试 222 项通过：Swift 协议／记录 50，worker 工具面／对话／审题 124，shared 消息／附件／学习卡合同及评分 39，API 消息上下文／笔记投影／分页 9。不是全仓全量回归。
- `git diff --check` 通过。临时模型原始诊断输出已移除，仓库没有测试 token、私有环境文件或临时探针脚本。
- 上述长笔记数据证明首屏载荷有界，不证明本机 API 耗时按同一比例下降；首次可交互时间、真机峰值内存、持续帧率和实体设备音频本轮没有量测。单个不可切断的大段可能超过一页字节预算；长文章若持续读完，当前会话会逐步保留已读取段落，尚未做滚动窗口的内存淘汰。
- 本轮减少动态和深色使用 Debug 环境开关核验；没有冒充已在实体 iPhone 的系统设置下完成全部手势／性能验收。
