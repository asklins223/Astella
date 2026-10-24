# iOS 交流记录、确认建议与后台任务 — 2026-10-23

## 本轮范围与设计

用户指出：没有思考或工具内容的回复也显示“思考与过程”，确认卡、手记卡、后台任务与动效缺乏完整设计。本轮覆盖相伴的记录模式、星轨的手边、建议详情、保存的手记／原句讲解面板。沿用“贴近说话”、苹方、中性纸面与钴蓝；Android 不在本轮范围。

| Before | After | Why |
| --- | --- | --- |
| 每个 run 都有“思考与工具”，仅有传输状态也显示“思考” | 只在实际存在非空思考或真实工具步骤时显示入口；思考和步骤可以分别展开 | 不让计数、状态节点和空白文本伪装成内容 |
| 同次自然分句回复反复出现过程头和建议卡 | 同一次回复只有一个身份头、一次过程与去重的成果；后续独立发言不重复过程 | 保持对话连续性，正文优先 |
| 手记只是过程里的小胶囊，完整批注挤进聊天 | 正文后展示手记／原句讲解成果卡，可读保存的版本、原句与完整内容 | 明确实际交付了什么，又不淹没交流记录 |
| 确认卡直接给出按钮，各入口维护独立状态 | 摘要卡先说明对象、影响；详情面板读原文对照与操作内容，再确认或拒绝 | 阅读与决定同处一页，共享真实状态，避免重复提交 |
| 后台页直接堆思考文本，“停止”取消全部任务 | 仅展示当前安全进展、已有成果与单次控制；不确定回执先核对再继续 | 用户能判断任务进展与下一步，而不用阅读后台日志 |

记录正文直接排版在页面上。过程是默认收起的一条轻量入口，展开后用细线串联步骤、状态和回执；它不再把正文包进过程卡。确认建议与保存结果各自拥有明确入口，过程详情只链接同一份内容，不再嵌套复制卡片。

2026-10-23 用户继续明确：附件必须独立在用户气泡上方，不能包进蓝色气泡；只发附件不生成空气泡。用户否定截图中庞大的“已停止”任务卡，因此记录里的停止／中断改为紧凑回执，原因、继续与核对仅在可用时出现；完整任务卡仅用于手边总览。输入器改占真实布局空间，记录列表裁切在内容区域，正文不会透进输入器和底栏。

引用选段、手记／日记来源、图片和文件都按当条用户消息归属。选段保留提交时的原文、换行、手记身份与版本；文件卡显示原始文件名、MIME 对应格式和大小，可阅读提交时提取的文字并通过原有鉴权地址打开原件；图片使用 96pt 方形缩略图，单张右对齐，多张并排且窄屏换行；不再用占满消息宽度的图片卡。蓝色气泡只装用户输入的正文，并按内容收宽（“123”也只占文字所需宽度）。图片通过当前层的浮层预览，底层页面、输入器和底栏一起模糊压暗，没有新页面导航；仅收集本次发送的图片，从点击项开始，可左右翻页、点下方缩略图、双击／捏合放大与下滑关闭。账号或会话切换会关闭当前图片。

## 实际调用与状态边界

- `CompanionRecordTurn` 将消息与 run 关联，以 run 身份稳定组织自然分句、流式草稿与最终消息。过滤 `status:` 节点，忽略空白思考，去重手记、讲解与 proposal 引用。已保存的文本不会被同一流式草稿再次拼入。
- `CompanionProposal` 使用类型化状态：pending / accepted / executing / succeeded / rejected / failed / expired / unknown。未知状态提供刷新，不推断成“正在写回”。过期建议不提供确认；删除与取消提醒有对应的对象文案和动作。
- `AppStore.proposalStates` 统一持有记录、手边与详情面板的加载、决定、错误和幂等身份。决定使用现役 `POST /companion/proposals/:id/decision`、payload hash 与同一重试键；旧的 pending 快照不能覆盖已收到的决定。账号、书房或会话切换后，旧请求不能回写新状态。
- 接收决定后刷新 proposal、run 与消息；accepted/executing 仅在前台轮询最新结果。加载失败保留已有建议与重试，不清空正文。原文与建议正文沿用原生 Markdown 排版。
- 任务控制绑定单个 run：停止传 run ID 和 generation；继续／核对走现役恢复接口。终态中仍未确认的工具回执先提供“核对保存结果”，核对后才允许继续。
- 全文、手记版本与建议共用 Shell 的一个成果面板宿主。不同入口切换成果时替换当前展示对象；面板不随着说话气泡消失而被撤走。保存的手记仍校验不可变版本，预览失败不冒充当前版本。
- 修复 iOS 消息 DTO 与实时字典路径忽略 selection 的问题，补上 MIME、byteLength 与来源引用。API 从用户消息对应的 run 中投影已存 selection 和有限的 `inputReference`，不返回编辑坐标、权限或后台上下文；普通消息列表与连续历史共用投影。新发送的手记标题也随本次上下文保存；旧消息缺少标题时明确显示“引用的手记”，不拿当前页面冒充历史。

## 动效与阅读

新回复与成果出现保留轻微过渡；首屏整批历史、读取更早消息和逐 token 增长不反复施加弹簧。用户离开最新位置后不强制追随，保留“回到最新”。已加载的历史窗口使用实际高度布局，避免图片、长引用和过程展开混合时惰性高度估算造成首次进入空白或落点偏移；保留更早记录的分页入口。过程、思考、单步回执与原文对照可快速反向切换，功能不等待动画。

沿用共享 Motion 与按压样式，系统减少动态和应用内减弱偏好共同控制位移／弹簧。后台停止建议轮询与任务计时。较大字号下，建议详情继承页面字号，决定按钮纵向排列；正文滚动区域和操作区分别布局。

## 自动检查与构建

- `swift test --scratch-path /tmp/astella-companion-protocol-tests`：16 项记录／建议／输入材料测试、12 项已有协议／正文排版测试通过。记录测试直接编译生产 Foundation 模型和消息 DTO，覆盖空过程、独立思考与工具、稳定回复身份、分句与成果去重、流式重复、旧快照、过期／未知状态、结果核对、删除动作、两种解码路径保留原文与附件，以及仅附件不伪造正文、本次图片集合的顺序／点击项／同 URL 不同项身份／跨消息隔离。
- iOS 固定 DerivedData 的增量 Debug 构建通过。过程中首次新文件注册脚本使用了错误目录，导致缺少类型；注册后恢复。补充 SwiftUI Preview 时漏传 `onOpenNote`，编译发现后修正。没有 clean、archive 或重编译 Cubism SDK。
- 用户补充输入材料问题后，同步修改 shared/API 投影。shared、api、desktop-client、ai-worker 的 `npm run typecheck` 在修改前基线和修改后均通过；7 项消息块／输入上下文单元测试通过。真实 PostgreSQL 集成用例通过，覆盖选段和来源版本的列表读取、分页、连续历史及搜索，确认普通消息和助手不会串用引用，也不暴露编辑上下文。`git diff --check` 在本轮相关范围通过。
- 新增 `#Preview` 与 `records-*` 整页直达场景；示例仅用于 Debug，继续受 MobileAPI 网络门禁约束，不混入真实账号。

## 实际窗口检查

使用 Device Hub 中独立的 `Study Speech 5c3656b8` / iPhone 17 / iOS 27 模拟器，操作、拖动和截图均通过窗口工具完成。

| 场景 | 已确认的行为 | 证据 |
| --- | --- | --- |
| 普通回复 | 无空思考／过程入口，正文正常显示 | [普通回复](assets/ios-companion-records-2026-10-23/plain-reply.png)；[修改前](assets/ios-companion-records-2026-10-23/before-empty-process.png) |
| 真实形状的过程数据 | 外层过程、思考与单步回执独立展开；快速开合可反向 | [展开过程](assets/ios-companion-records-2026-10-23/process-expanded.png) |
| 手记成果 | 相同结果只显示一份，打开第 2 版正文；可返回对应 run | [成果卡](assets/ios-companion-records-2026-10-23/record-and-note-card.png)、[版本预览](assets/ios-companion-records-2026-10-23/note-preview.png) |
| 确认建议 | 原文与建议分别阅读；确认后按钮消失，拒绝后显示未采用 | [原文对照](assets/ios-companion-records-2026-10-23/proposal-compare.png)、[示例确认完成](assets/ios-companion-records-2026-10-23/proposal-confirmed-preview.png) |
| 过期建议 | 保留原建议供阅读，只提供刷新状态，不提供确认 | [过期详情](assets/ios-companion-records-2026-10-23/proposal-expired.png) |
| 后台任务 | 深夜、减弱动效下显示安全进展与已保存成果；手边只有单次停止；停止后成果仍可从记录打开 | [早期记录任务样式，已被紧凑状态行取代](assets/ios-companion-records-2026-10-23/background-dark-reduced.png)、[手边](assets/ios-companion-records-2026-10-23/hand-task.png) |
| 不确定保存回执 | 先核对，核对后出现继续；成果始终可读 | [早期待核对样式，记录中已收为状态行](assets/ios-companion-records-2026-10-23/result-needs-reconciliation.png) |

以上 `records-*` 的窗口素材均为有明确预览标记的本地示例，不能代替真实模型、保存或确认接口证据。

## 真实接口与原生确认

使用此前的本地隔离测试账号和鉴权会话，真实模型读手记后调用 `companion_edit_note`，在 guided 权限下生成冻结建议。原生新详情面板读取原文与建议，点击“确认写回”后显示 accepted/executing，随后在同一面板更新 succeeded；打开关联手记，实际读到已修改的段落。API 再读 proposal 与 run 均为 succeeded，正文精确匹配。证据：[待确认](assets/ios-companion-records-2026-10-23/real-pending-proposal.png)、[原文对照](assets/ios-companion-records-2026-10-23/real-proposal-comparison.png)、[完成](assets/ios-companion-records-2026-10-23/real-proposal-completed.png)、[手记读回](assets/ios-companion-records-2026-10-23/real-note-after-confirmation.png)、[无凭据接口回执](assets/ios-companion-records-2026-10-23/real-api-proof.json)。

普通真实聊天历史不再出现空过程：[实际历史](assets/ios-companion-records-2026-10-23/real-ordinary-replies.png)。等待用户确认时首页不再显示忙碌转圈，提供直接的“查看并决定”入口：[等待决定](assets/ios-companion-records-2026-10-23/home-awaiting-decision.png)。大字号建议面板继承字号，按钮纵向排列，最后一段可滚动读完：[大字号](assets/ios-companion-records-2026-10-23/proposal-large-type.png)、[末段阅读](assets/ios-companion-records-2026-10-23/proposal-large-type-reading.png)。

输入材料另走真实上传／持久化：同一隔离账号分别提交带选段与来源版本的文字、Markdown 文件、仅图片消息，上传回执和三条消息重新读取成功，换行、标题与 noteVersionId 保留。该组 run 在 accepted 后立即取消，仅证明上传与消息保存，不计作模型理解材料的正向验收。[输入材料接口回执](assets/ios-companion-records-2026-10-23/real-input-api-proof.json) 不包含凭据。

## 图片和气泡的后续纠正

用户继续指出：图片仍然过大、短文字被拉宽、图片预览不该进入独立页面。本次修正使用当前展示层的浮层宿主（主界面、迷你对话和成果面板均安装），关闭后继续原列表位置；底部显示本次发送的图片缩略条与页码，单张不显示无意义的翻页入口。读取失败有重试，退出后取消读取，鉴权身份变化后不接收旧图片。

[紧凑缩略图与短气泡](assets/ios-companion-records-2026-10-23/compact-image-thumbnails.png)、[从第二张打开浮层](assets/ios-companion-records-2026-10-23/image-gallery-overlay.png) 为明确标记的 Debug 窗口素材；前一版大图卡截图不代表最终设计。初次浮层检查发现嵌套翻页与图片滚动层争夺触控，最终把翻页、缩放、图片平移和向下关闭统一到一个 SwiftUI 手势容器，首次拖动按方向锁定意图，图片原尺寸可翻页、放大后可平移，边缘拖动有阻尼。还原控件保留固定位置，不因为放大出现按钮而改变图片视口、重置缩放。用户又指出过渡中上下安全区露白，确认是遮罩与图片共用 scale 转场；已将遮罩独立到宿主层，始终忽略安全区并只变化透明度，只有图片内容缩放，避免中途收边。

最终窗口复查确认：点击第二张从第二张打开，左滑到第三张、右滑回第二张；双击放大后尺寸保持，拖动只平移当前图片，点击还原或下滑关闭均有效；关闭回到原记录位置。深夜＋应用内减弱动效同样可读，[窗口证据](assets/ios-companion-records-2026-10-23/image-gallery-dark-reduced.png)。[放大状态](assets/ios-companion-records-2026-10-23/image-gallery-zoom.png) 由实际窗口截取。

使用 Device Hub 自带录制按钮记录连续两次开关，保留 [7.3 秒原生窗口录像片段](assets/ios-companion-records-2026-10-23/image-preview-transition.mp4) 与 [过渡中间帧](assets/ios-companion-records-2026-10-23/image-preview-transition-midframe.png)。检查中间帧，状态栏、正文两侧和底部安全区同步淡变，遮罩不跟随图片收边；这是模拟器动画证据，不作为持续帧率保证。

真实账号重新读取后，[文件与缩略图](assets/ios-companion-records-2026-10-23/real-file-and-thumbnail.png)、[图片配短文字](assets/ios-companion-records-2026-10-23/real-compact-attachments.png) 均在气泡外部，文字气泡按实际内容收宽。真实上传图片可鉴权打开为 [单张浮层](assets/ios-companion-records-2026-10-23/real-image-overlay.png)，不显示多图翻页控件；文件 [提取文字](assets/ios-companion-records-2026-10-23/real-file-extracted-text.png) 和 [原件读取](assets/ios-companion-records-2026-10-23/real-file-original.png) 均实际可读。输入框已检查焦点、设置未发送草稿并清空；设备窗口未展示软件键盘，因此不计作键盘避让通过。

相册首批增量构建 55.39 秒；后续修复继续复用 DerivedData。另一个构建占用共享 build.db 时有一次锁冲突失败，未清缓存、未终止其他任务，释放后增量构建恢复。最终构建 13.08 秒、覆盖安装 2.11 秒，使用同一脚本完成；最终安装包再次确认第二张左滑到第三张，图片区域不再暴露重复的邻页或无意义的滑块值。

## 多图输入的真实链路补全

相册原来只取一张图片，共享合同只接受一个附件，worker 还会截断第三张以后的资产。现改为 iOS 有序多选，草稿 72pt 横排缩略图，逐张预览／移除与继续添加；单次最多九张，可以同时附一份文件。记录仍为 96pt 缩略图，独立于正文气泡。小缩略图解码为不超过 320px 的位图，原图只在预览中读取。

点击发送后才上传，每张保存真实资产回执；第二张上传中断时，第一张的回执和全部草稿保留，重试只上传剩余图片，所有材料完整后才提交同一条用户消息。回合提交失败复用相同的 clientMessageId，失败按钮重试发送，不再只刷新记录。移除图片／文件会更新草稿签名；整理和上传均有明确的当前项状态，账号或书房切换后不接收旧结果。

使用新建的独立 `Astella Image Intake QA` 模拟器（CC5B07E3-C79D-4049-9DBC-FBBBDFA75A8A）和本地隔离账号，系统 PhotosPicker 选入模拟器自带风景照片；预览第二张、横滑到第一张、关闭、移除第二张并继续补选，最终三张按花、峡谷瀑布、日照瀑布排列。[草稿缩略图](assets/ios-companion-records-2026-10-23/draft-three-images.png)、[草稿浮层](assets/ios-companion-records-2026-10-23/draft-multi-image-gallery.png)。未申请整个相册权限，PhotosPicker 只交回所选图片。

实际点击发送后，API 再读确认一条用户消息包含三个不同的资产，顺序与名称一致，三张均鉴权下载 HTTP 200，模型回合 succeeded；仅附件消息没有伪造文字或空气泡。[真实三图记录](assets/ios-companion-records-2026-10-23/real-three-image-record.png)、[真实浮层第三张](assets/ios-companion-records-2026-10-23/real-three-image-gallery.png)、[不含凭据的接口回执](assets/ios-companion-records-2026-10-23/real-multi-image-api-proof.json)。实际从第二张打开后左滑到第三张，下滑关闭回到原记录位置，顶部和底部安全区持续覆盖。

大字号（accessibility2）＋深夜＋应用内减弱动效下复查浮层，文件名、页码和关闭按钮没有重叠，点不同缩略图重新打开时起点正确，关闭后回到记录：[大字号图片浮层](assets/ios-companion-records-2026-10-23/image-gallery-large-dark-reduced.png)。这是带本地示例标记的 Debug 场景，不替代真实上传回执。

这次真实发送是仅图片回合：窗口工具对输入器设置的 AX 文本没有提交到 SwiftUI 草稿状态，不能把截图里的文字当作已发送文字。该隔离账号的图片内容授权保持关闭，模型确认收到三张并明确说明未读取图像；本次证明多图上传、持久化、鉴权回读和模型收到数量，不计作视觉理解验收。

本批自动检查：Swift 记录测试 19 项和语音／Markdown 等协议测试 28 项通过（新增中断后回执复用、顺序和草稿分组测试）；共享回合合同 28 项、worker 对话 86 项、API 回合／输入上下文 8 项通过。shared、api、desktop-client、ai-worker 四个包 `npm run typecheck` 均通过。九张合法、十张拒绝、九图与一个文件并存及语音仍为单文字块都有合同检查；第三至第九张资产全部进入模型上下文有 worker 检查。

同一 DerivedData 的增量构建成功，用时 298.28 秒；并发编译和其他调试操作使本机负载升高，日志还记录到另一构建的 build.db 锁失败，没有清缓存或终止对方构建。原 `Study Speech` 设备多次被通知调试强制退出／覆盖安装（系统回执为 `Termination requested by simulator host`），未把这些中断记作产品崩溃或验收通过；随后使用独立设备完成实际操作。独立设备首次系统准备 54.98 秒、首次安装 28.50 秒、首轮启动 49.06 秒，后续切换不重新构建。

## 验证限制

本轮没有实体 iPhone 的触感、音画同步和持续帧率数据；没有执行 VoiceOver、双指捏合或系统设置中减少动态的专项操作；双击放大／还原和放大后平移已在窗口验证，双指手势与软件键盘仍需实体设备确认。Debug 的大字号与应用内减弱场景不等同于覆盖所有系统字号／动效组合。声音与选段递送沿用 [此前的真实交付验收](ios-companion-delivery-2026-10-22.md)，不将本轮记录页截图再次计作 TTS 验收。
