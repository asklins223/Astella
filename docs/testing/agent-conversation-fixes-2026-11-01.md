2026-11-03 当前补充：[公开网页读取范围回归](evidence/agent-conversation-fixes-2026-11-01/web-read-scope-2026-11-03.json)。候选 s-v2.0.20 修正公开网页研究被应用数据核验器误映射为必须读取笔记的问题；混合请求仍核验实际保存的笔记，网页原文和引用核验继续独立执行。现有 MiMo 主模型／DeepSeek 回退未改变。真实四例范围判断与六段 NASA 回合通过，后者实际读取三篇原文，但耗时 121.524 秒，不能计作速度通过。最终 worker 全量 1,975 项通过、类型检查通过；该候选的部署仍待正式流水线。

Earlier release acceptance: [2026-11-02 batch record](evidence/agent-conversation-fixes-2026-11-01/release-acceptance-2026-11-02.json). The source/native checkpoints below retain their original observation scope; they do not supersede the dated follow-ups.

2026-11-02 补充：真实验收新增的主动发言内部收尾泄漏、搜索来源与原位引用错配，见[发布边界复查](agent-initiative-publication-followup-2026-11-02.md)。
# Agent 对话与交付修复

Latest checkpoint: [source review and native verification](evidence/agent-conversation-fixes-2026-11-01/source-review-and-native-2026-11-02.json). The real task matrix is 14/14; source-grounded delivery and premature preflight cancellation have new fixes. Native source-list collapse and remaining conversational details still require acceptance. Release remains held. Earlier sections retain their original observation scope.

2026-11-01，Asia/Shanghai。对应 [原始审计](agent-conversation-audit-2026-11-01.md)。本记录区分实现、真实模型观察与上线状态；单测通过不代表所有回答正确。

**Current checkpoint: 2026-11-02, execution and public-document reading.** See the [current implementation and evidence record](evidence/agent-conversation-fixes-2026-11-01/execution-and-reader-2026-11-02.json). A fast-opening experiment regressed to 10/14 tasks; the corresponding execution/read-catalog corrections subsequently passed 14/14 through the actual restricted development services. Later reasoning and reader changes are still undergoing acceptance. The current ordinary 10-turn presence cohort has a first-visible median of 6.046 seconds and a 22.006-second maximum; research v4/v5 did not complete within the observer window. These are remaining performance failures, not a release pass. The MiMo/DeepSeek pairing and selected Responses protocol are unchanged. No server/iOS release or production migration has occurred.

This checkpoint adds an independent, governed conversation-expression/coherence review before unpublished ordinary messages, as well as evidence and requested-execution obligations. Earlier statements below that describe having no review model are historical. The native author still uses text and actual tool calls, not a universal JSON author envelope. Only a fresh explicit conversation verdict permits a non-reasoning opening; knowledge analysis retains reasoning. Actual process information is preserved. Host partial settlements remain partial through recovery/finalization and cannot replay the failed request through an unsolicited `reply.finished` answer.

The local development database also had a catalog-index insertion loop during grants. Reindexing `pg_shdepend` restored the existing role matrix. Role reconciliation now runs in one transaction; a real injected SQL failure on the isolated integration database leaves its ACL fingerprint unchanged. Production was not altered. Current production `/health`, `/ready`, `/auth/me` and `/me/companion` were read successfully using an existing session that was explicitly signed out afterward. This does not establish that the local fixes are deployed.

The earlier [evidence/calendar record](evidence/agent-conversation-fixes-2026-11-01/evidence-and-calendar-2026-11-02.json) remains historical. Its temporary read-requirements transcript path was reused by a later probe; the original recorded hash is preserved and annotated as unavailable at that mutable path. Independent timestamped task-matrix records remain available. Counts and current limitations are tracked in [validation](evidence/agent-conversation-fixes-2026-11-01/validation.json) and [quality review](evidence/agent-conversation-fixes-2026-11-01/quality-review.json).

## 已实现

1. **普通答复不再被迫补跑结束合同。** 是否具备写工具不代表这轮执行了写操作。普通交流和读取后的答复可以直接结束；实际写入、产物及未发完的独立消息仍须用真实回执交付。补结束元数据时保留已发正文，不自动换模型重写。
2. **流式与历史统一。** 先 flush 节流尾字，再取最终交付快照；已公开的片段不在历史拼接时消失，短句重复 finish 不生成第二份。降级保留前缀时记录 `delivery_receipt.outcome=partial`。畸形 JSON 空正文不能把内部字段泄漏为回复。
3. **人格与参与复盘分开。** 使用 V15 表达底座，保留用户选择的名字、性格和语气。用户写的人格文档继续进入上下文；助手或未标来源的自我复盘改为可检索文档，正文未删除。后台复盘把主动频率和失败经验写入带适用条件的经历。普通用户发言不再常驻主动参与安排协议。活跃表示参与感，不要求每轮扩写或自我表态。口头禅只作为表达数据提供，移除容易被念成自我说明的长段执行要求。默认预设中没有对应用户语境的独立台词不再反复注入；用户或助手自己写的示例、无法归为预设的自定义示例仍保留，存储档案未重写。
4. **快速入口与意图区分。** 未分类入口不再假定用户正在闲聊，也不把占位的 `question/uncertain` 当作模型判断注入。运行策略也使用中性的未分类分支，不再让占位的 question 进入“逐项解题、汇报结果”的执行手册；尚未调用工具时不注入全部编辑场景。原生消息位于输入末尾时，不再额外复制成“本轮要回答的问题”；工具返回材料后需要重申目标时，用中性的“用户原话”提示。真实表达设置、明确执行限制和已解释的注意力仍保留。知识与数量判断继续受事实／推理核对规则约束，补充核对因果前提的生成要求；它不等于已经执行独立事实核查。没有新增词语黑名单、统一长度上限、路由模型或口气改写模型。
5. **确认删除与恢复修复。** 已解析出 memoryId 的冻结删除卡可以通过领域参数校验，原始账本参数仍逐字对比。重入快照复用本轮成功写回执；修订版本从真实编码载荷取值。续跑按注册操作身份识别扁平别名／领域工具，调用 ID、不同操作及用户后续修改仍会拦截。
6. **终态与观测修复。** 新迁移 `0466_companion_terminal_steps` 关闭终态 run 遗留的 running 模型步骤，不编造工具副作用结果；后台终态也有完成时间。最终运行信息记录本次实际使用的 provider/model。
7. **声音格式与说话内容分开。** 当前使用声音标记协议 V2，保留完整控制标记、解析及 TTS 规则，移除 V1 中“已经很棒了、今晚先歇一会儿、接下来看看适用条件”等正文示例。它们原先排在角色表达后面，让格式协议也成了夸奖、安排休息和追加讲解的语气样本。V1 保留供历史回放，不修改旧记录。
8. **供应商限流接续。** 429 不再反复请求同一账号，也不因“不能在同一路线改传输重试”而跳过配置中的独立备用线路。只有当前步骤未公开正文、仍有有效租约／时限且备用能装下同一请求时才接续，已完成回执继续携带。两路都不可用时保留真实部分结果。显式加深请求映射至模型声明的最高可用档，避免在仅有 high/max 的模型上仍重复请求 high。
9. **恢复搜索配置与真实来源回执。** 现有 BigModel 密钥还在环境中，但平台配置入口缺失，现已恢复；未新增密钥或订阅，联网默认仍关闭、用户开关继续生效。读取搜索回执同时识别当前 `web.search` 和历史 `agent_web_search`，修复引用与来源读取漏掉当前工具的问题。账号仍开启联网时，可展开当前账号、空间、同一运行中真实成功搜索回执的精确 HTTPS 链接；不同路径、不同查询参数、其他运行及网页正文中的链接不因此获得授权。用户直接给的网址仍走原有读取路径，外发同意、SSRF 与内容类型检查保留。真实 HTTP → worker → MiMo 样本已成功搜索并读取故宫官网原文，保存标题、网址与来源身份；本次耗时 25.40 秒，证明可用，不证明速度达标。记录见 [搜索回归](evidence/agent-conversation-fixes-2026-11-01/web-search-regression.json)。
10. **权限拒绝不再误报可重试故障。** 未授权的网址读取得到明确 blocked 与安全原因，避免被抹成“执行失败，请稍后再试”。实测曾因该问题反复猜网址，单轮 78 秒；修复后的 NASA 样本只出现一次明确拒绝，但随后收到上游英文拒绝文本，仍判请求未满足，不把它当作搜索验收通过或提速证明。

iOS 原生代码位于同级手机仓库：每轮只有一个过程入口，放在同一个回复气泡内、正文前并默认收起；完整保留真实思考与 finish／设置／装载等步骤，使用可读标题；过程事件不切断正文，最终消息按 messageId 对齐并取代流式投影。另修复普通朗读预取等待完整下载、通话未接入预排队的问题，按收到的音频包连续解码，前一条收到首包后才放行后一条预取。详细记录：`astella-mobile/docs/testing/ios-conversation-process-fix-2026-11-01.md` 与 `ios-voice-continuity-fix-2026-11-01.md`。

## 模型线路与舍弃的方案

用户最新要求是保持原有搭配。`config/ai-platforms.json` 中 `agent_turn` 仍使用 **MiMo `mimo-v2.6-flash`**，`companion_fallback` 仍使用 **TokenRhythm `deepseek-v4.1-flash-1017`**；两条线路与线上原有配置一致。此前本地交换主备的尝试已撤回，其他候选对比已停止，未部署任何模型更换。配置差异只恢复了已有 BigModel 搜索入口。

当前初始与工具后续步保留 low，修复步 high，显式加深映射至各自声明的最高档。[MiMo 官方 Responses 文档](https://mimo.mi.com/docs/zh-CN/api/chat/responses)说明：none 关闭思考，其余档位开启思考，并非不同强度。因此不能靠把 high 改名 low 宣称提速。同一 MiMo 的关闭思考实测及六轮 HTTP 小样仍有表达问题；该小样有真实计算回执，但不足以证明整体可靠性，已逐字恢复 low 实现。额外资源分类器增加冷启动等待，也已撤回。

尝试过将正文和交付声明强制放入新的 JSON 协议，真实模型出现工具遗漏和协议问题，已完整撤掉该适配。最终保留原生工具循环，没有第二套回复协议。上述失败样本保留在忽略目录，不混进最终成功率。

## 最终验证

| 验证 | 结果 |
| --- | --- |
| ai-worker 全量测试 | 1926 通过，0 失败 |
| shared 全量测试 | 536 通过，0 失败 |
| API 全量测试 | 2032 通过，1 跳过，0 失败 |
| shared / API / ai-worker / desktop-client 类型检查 | 均通过 |
| PostgreSQL 运行／备用线路／续跑围栏／终态步骤 | 原有 18 项 + 新增搜索回执 1 项分别通过，另有 9 + 1 项通过 |
| 当前模型真实对话 | MiMo 主／DeepSeek 备：20 轮合成日常对话 + 4 轮隔离复制人格，全部交付成功；SSE 与保存正文、最终 hash 均一致 |
| 当前模型真实任务矩阵 | 14/14；包括真实计算、手记与记忆写入、两条独立消息、计划启动、确认删除与续跑 |
| iOS Swift 测试 | 全包 230 项通过，其中记录域 117 项、协议/音频 54 项，音频预取新增 5 项 |
| iOS 原生构建 | 增量签名 Debug 真机构建、安装、启动成功，62.84 / 4.41 / 0.45 秒；后续输入区玻璃与提示位置按用户反馈继续验证，没有 archive 或发版 |

当前模型的 24 轮对话共 24 次已审计的主调用，`FINISH_CONTRACT_INCOMPLETE` 为 0。运行中的预留计数不代替物理调用审计，后台观察或后处理调用不混算为主模型补跑。普通对话的分组耗时如下，包含排队与交付：

| 样本 | 首字中位数 | 完成中位数 | 最长完成 |
| --- | --- | --- | --- |
| 咖啡连续对话 10 轮 | 4.74 秒 | 6.13 秒 | 10.93 秒 |
| 另一组生活对话 10 轮 | 3.78 秒 | 4.93 秒 | 9.06 秒 |
| 隔离复制人格 4 轮 | 3.88 秒 | 5.92 秒 | 8.56 秒 |

普通对话 20 轮合并的首字中位数为 **4.02 秒**、完成中位数 **5.82 秒**。原始本地 20 轮为约 1.88 / 6.24 秒；样本、并发和队列负载不同，不能据此宣称首字也提速。取消补跑消除了无必要的第二轮生成，首次响应仍慢。此前 DeepSeek 主线路的对照数字已从最终验证中移出。

受控慢速音频下载对照使用真实 HTTP 合成的 MP3、应用原有的 MP3 解码器与新的预取实现；输出设备替换成确定性的 PCM 时钟。在下一段首包 1 秒、EOF 5 秒的相同条件下，三个长短段组合的旧等待方式产生约 **1.45–2.17 秒**队列空档，增量预排队均为 **0 毫秒**。随后真实 App 回听在模拟器采样 12 段/11 个边界，真机自动朗读与回听采样 5 段/3 个边界，均未观察到额外段间排队等待；这不代表任意网络或蓝牙均无卡顿。

测试覆盖普通回答、尾字 flush、重复 finish、畸形信封、人格来源、真实写回执、删除确认、别名恢复、用户后续纠正与终态步骤。真实对话通过 HTTP → 队列 → worker → 配置模型 → SSE／数据库核对；操作矩阵同时检查真实业务回执与成功交付终态，不能仅凭工具成功计通过。

个人事实的记忆用例替代了旧的“九点后不打扰”：后者可以正确存成参与偏好，不能随后假定它必有记忆 ID。确认测试在事件到达时读取真实卡片，并确认其冻结 hash，不跳过用户确认路径。

## 表达与知识质量仍未全过

当前模型样本仍有明确失败：问候硬接吃饭话题，约束或纠正触发自我说明；普通分享偶尔变成叮嘱或推定用户时间安排；复制人格中仍有过多角色表演与追问；咖啡苦味解释把未测量条件说成已知因果。对应样本保存在 [合成对话](evidence/agent-conversation-fixes-2026-11-01/synthetic-transcripts.json)，人工判定在 [质量复核](evidence/agent-conversation-fixes-2026-11-01/quality-review.json)。复制真实人格的正文不公开。

苦味的温度效应随刺激物和测试条件变化，不能套成“接近体温最不敏感、变凉就更苦”的普遍规律。[人体味觉原始研究](https://pubmed.ncbi.nlm.nih.gov/28119357/)讨论了这种差异；[咖啡内酯研究](https://pubmed.ncbi.nlm.nih.gov/27719962/)讨论的是烘焙形成的苦味成分及酶水解，也不是“冲好的咖啡冷却便新生苦味”的证据。这条知识答复记失败，没有为单个题目写固定答案或把措辞检查当事实验证。

新增联网开关样本也没有冒充质量通过：关闭时确实没有发起搜索，但回答混淆了火星太阳日和恒星日。NASA 的 [Mars24 技术说明](https://www.giss.nasa.gov/tools/mars24/help/notes.html)分别给出约 24 小时 39 分 35 秒与 24 小时 37 分 23 秒。开启时一次上游返回英文拒绝与零 token 用量，请求未满足；当前审计不足以还原上游有无结构化拒绝标记，未按正文关键词私自判别或绕过拒绝。

曾并发四个真实会话触发供应商 429 与账号熔断，其中一轮矩阵的计划启动、确认删除未完成；该压力样本保留，没有计入最终 14/14。随后修复备用线路接续，使用真实 PostgreSQL 与受控 429 验证同一 durable turn 接续、实际供应商归属和完整交付。最新真实矩阵使用较低并发通过，不能冒充供应商高负载验收。

## 边界与发布状态

- 按“全部修好再一起上线”的要求，当前发布仍被质量回归拦下。**没有发布服务端版本、运行生产迁移或触发 iOS 发布**，模型主备仍是原搭配。已有客户端需安装包含原生展示修复的新构建；资产热更不能替代 SwiftUI 修改。
- 生产 `/health` 与 `/ready` 于 2026-11-01 17:34（Asia/Shanghai）重新读取均正常；这不表示本轮修复已上线。此前线上 20 轮与人格调查见原始审计。
- 本地全量迁移命令遇到既有 `0461` 对象与迁移记录漂移；只事务性应用并登记了新增 `0466`，没有覆盖旧迁移历史。生产迁移历史还需在正式发布流程检查。
- 本地 PostgreSQL 有既有 GRANT 后端长时间占用，受限角色测试没有冒充通过；新增数据库回归使用显式指定的管理员连接与隔离夹具。回归结束后关闭 42 个隔离账号的会话与主动运行权限，重启本地 PostgreSQL 清理遗留 GRANT；API 就绪、worker 与数据库连接恢复正常。没有改生产权限或旧迁移记录。
- Device Hub 可操作模拟器与配对 iPhone；已验证普通朗读采样衔接、气泡内过程、真实搜索开关与引用/来源交互。蓝牙、通话打断及所有网络仍没有全面覆盖。
- iOS tag 发布流水线仍产出 unsigned IPA 并登记 `signed:false`，不能把它称为可直接安装的客户端更新；本轮未触发该流程。
- 速度数字是小样本、不同并发负载下的观察，包含排队、模型和交付；不能当生产 SLA 或保证每次都一样快。模型仍可能给出差的措辞或知识判断，不能把 `succeeded` 当作质量合格。

原始实验、复制的真实人格与临时凭据不进入可提交证据。最终合成对话、指标及测试摘要见 `evidence/agent-conversation-fixes-2026-11-01/`。


## iOS 联网与提示补齐

新增账号联网设置入口、真实搜索词/站点/结果过程、正文原位编号与网页汇总，元数据同时经过 SSE 与归档。来源编号仅绑定执行回执，系统把 Markdown 脚注解析成内部 ID 时恢复为可信编号；代码、未知和半截标记按协议处理。实际点击、复制、浏览器打开、重启恢复及关闭后旧来源查看已验证。产品文案不出现搜索供应商名称。

搜索供应商曾返回域外镜像，已在执行层核对域名与真实子域；最终显式 `domain=dpm.org.cn` 的真实搜索只保留 6 条站内来源，完成 8.778 秒。搜索/计算后的指导语明确可以直接回答，不必为读取补 finish；仅下发读取工具时不再注入整段笔记/后台目标交付手册。真实计算 6.415 秒、检索 10.935 秒、后续生活对话 4.110 秒，全部使用原有 MiMo 主线路，没有额外 finish 事件，审计物理调用分别为 2 / 3 / 1。详见 [iOS 联网与引用证据](evidence/agent-conversation-fixes-2026-11-01/ios-web-search.json)。这些局部回归不覆盖原有全部表达和知识失败。

AI 提示为固定界面文字，主对话按用户最后指示从输入框上方移到顶部栏下方；抽屉放在伴星名字下方，每处一份，不写入生成正文或朗读。用户取消新增底部磨砂与底板，各处沿用伴星模式原有的原生玻璃输入框，系统底栏保持原实现。用户真机复查又发现记录列表提前截断造成整块空白底，已将记录/抽屉的滚动视口延伸到控件后方，只在最后滚动目标内留透明间距，底部不再添加材质、渐变或遮罩。实际真机已见记录滚到输入器和底栏后方；最终模拟器已验证记录页键盘收放后最新消息完整可见，抽屉半屏与展开/聚焦检查通过。顶部提示批次模拟器构建 40.87 秒、真机构建 20.98 秒、安装 4.64 秒和启动 0.39 秒通过。详情见手机仓库验收记录；统一正式发布尚未触发，表达与知识质量仍按上述失败样本继续复核。

上述顶部位置随后被用户否定；新增头像与双层页头试作也被否定并撤回，没有装到手机。用户最终明确选择「回复末尾，与朗读按钮同一行」，现已统一记录页、抽屉及伴星气泡的回复尾行，移除页头/名字下方/输入区的重复提示，保留原单排控件。最新模拟器构建 17.19 秒通过，实际核对了三处尾行及历史回复的朗读入口；签名真机构建 22.17 秒、安装 4.90 秒、启动 0.55 秒成功。更新只用于用户手机试用，未触发正式发布；主备模型未更换。

用户随后指出原有顶部磨砂渐变丢失：先前顶部提示布局把记录裁在顶栏下方并移除了顶部渐变，属于本轮引入的无关改动。已恢复整页滚动与原有 `StudyScrollEdgeFade` 参数，回复尾行及底部悬浮保持；模拟器构建 15.60 秒并实际窗口核对通过，签名真机构建 17.96 秒通过。首次安装连接中断，使用同一包重试安装、启动成功，已更新用户手机。正式发布状态未变。


## Agent 状态复核：仍未全部修复

用户追问完成情况后，重新用原来的 MiMo 主路由跑了 10 轮真实 HTTP 对话。每轮只有一条实际供应商调用，首字中位 3.097 秒、完成中位 4.941 秒，最慢 12.243 秒。问候纠正寒暄时刻、约束与纠正变成自我说明、把简短回应当告别，以及咖啡因果解释过度确定等问题仍可复现。这批样本没有通过表达和事实质量验收，不能把传输成功写成全部修好；也不能与较早样本直接归因为提速。

主动参与的提示链还存在强制按内部 job 身份轮换话题、每次都找一个新念头的要求。现已移除这两项：启动问候本身可以构成完整发言，闲聊仍可主动参与或自然接着共同话题，不强凑新内容。近期助手发言以转义的数据块回放，不能伪造观察消息边界；参与触发、节奏与前台条件不变。

真实回归又发现，主动轮只返回语音控制标签时会被当成退化答复，触发备用模型并发布“没有生成有效回复”的宿主提示。已按实际可见文字判断静默：仅在没有待交付写入/消息、没有工具调用、输出未截断的主动轮允许安静完成。普通用户请求仍保留空回复恢复路径。修后 3 次真实启动观察均只有一次主模型调用，无步骤错误；一次发言、两次快速连续启动选择安静结束。首条问候仍带对作息的猜测，因此这项功能验证不等于自然度通过。

ai-worker 全量 1926、shared 全量 537 条测试通过，四个包类型检查通过。新建独立 PostgreSQL 容器，462 条迁移全部执行通过；两条运行时实库用例验证了主动轮空正文/控制标签/标签后空白的安静结束，以及普通用户控制标签回复不能悄悄成功。连接为明确指定的管理员测试夹具，不冒充受限角色授权验收。旧本机 PostgreSQL 的首次隔离库准备遇到授权/策略语句卡住和无关的 note-expansion 目录漂移，该尝试不计通过；生产库没有改动。

证据与可复跑脚本见 [本次复核](evidence/agent-conversation-fixes-2026-11-01/proactive-naturalness.json) 和 [主动参与 HTTP 审计](evidence/agent-conversation-fixes-2026-11-01/proactive-naturalness-audit.py)。模型搭配不变，服务端、生产迁移与正式 iOS 发布继续暂缓。

## 2026-11-02 current recheck

The active expression base is V17, preset version 5, voice-expression V3 and voice-style V2. Historical prompt variants remain immutable. Factory-owned style/catchphrase data uses the current preset; user-authored and unknown-origin custom fields are preserved. Assistant-authored style is labeled as past self-description rather than a user instruction. Voice tags are optional, and a valid plain reply does not require a neutral tag or an extra finishing call. These changes improved the private copied-persona sample, but do not establish naturalness for all conversations.

Two further runtime defects were reproduced and fixed:

- A completed SDK request could still invoke text, reasoning and tool-start callbacks. Synchronous abort callbacks also ran before the outer catch closed the stream. Every callback now checks request acceptance and governing cancellation signals; acceptance closes when the provider settles. Reasoning from the active request and previously accepted flushes remain intact. Both black-box regressions failed before the fix and pass after it; the targeted streaming/watchdog suite passes 25 tests.
- Repeated argument failures appended both a validation result and an exhaustion result for the same native tool-call ID. A real research run contained two duplicated result IDs and ended with HTTP 400, not rate limiting. Exhaustion now adds metadata to the single `not_executed` result. A valid argument correction clears the consecutive-failure counter, so isolated mistakes cannot withdraw a domain tool that is otherwise working. Both PostgreSQL regressions failed before the fix and pass after it.

Ordinary non-deep attempts now have a 30-second primary / 45-second recovery deadline for their first text or tool progress. Reasoning bytes still keep idle detection alive, but cannot postpone useful output indefinitely. Explicit deepening retains the longer path, and healthy text/tool streams have no new lifetime cap. A real request reached 30,008 ms without meaningful progress and continued successfully on the existing fallback in 4,038 ms. This proves the attempt boundary, not fast completion of the entire research task.

Provider adapters distinguish structured refusal/content filtering from ordinary rejection words. An explicit MiMo terminal usage record with all three counts zero despite nonempty text/tool output is also a typed failure. Missing usage, cache accounting or zero cost alone do not trigger it. Neither failure retries through another model. This is metadata validation, not a phrase blacklist or a guarantee that a prefix already streamed before terminal metadata can be withdrawn.

Search now tries the existing service's Sogou index once after a valid empty basic-index result. Both requests use the same credential, query, domain and recency, with fresh switch/consent checks, per-engine cooldown and separate HTTP auditing. Errors, quota denials and malformed responses do not trigger the second index. An actual NASA search and original-page read completed in 27,432 ms with a trusted citation. The model-attempt audit in that sample contains four MiMo attempts and one existing-fallback attempt; search HTTP calls are counted separately.

Oversized query receipts now include actual field lengths without echoing private field values into logs, and the contract asks for a few short keywords. Unavailable-search reasons survive recovery and distinguish user-off, service configuration and quota. Internal instructions about missing evidence stay in the model receipt; public process summaries remain concise. The long live research recheck still rejected three overlong queries, so query repair is improved but not certified as solved.

### Validation and observed performance

| Check | Latest result |
| --- | --- |
| Worker unit tests | 1,941 passed, 0 failed |
| Shared unit tests | 538 passed, 0 failed |
| API unit tests | 2,035 passed, 1 skipped, 0 failed |
| Type checks | shared / API / desktop / worker passed |
| Fresh PostgreSQL 16 / pgvector | 462 migrations applied; 68 agent / initiative / model-budget tests passed |
| Current-route dialogue | 20 synthetic everyday turns + 4 private copied-persona turns completed; 25 audited model attempts |
| Delivery integrity | All 27 latest dialogue/search/research replies match their durable SSE text and final hash |
| Real task matrix | 14/14 task and receipt checks; ran before the final callback/watchdog/argument-receipt edits, which have separate targeted coverage |

The fresh database uses explicit administrator fixture URLs and does not certify restricted-role grants. It does not modify the development or production database schema. Native iOS source is unchanged in this recheck: the reply-footer AI label, same-bubble process, continuous playback, native floating controls and restored original top gradient remain as recorded above. The signed Debug preview installed on the phone still uses the production API and is not a backend or formal iOS release.

| Current-model cohort | First visible median | Completion median | Outcome |
| --- | --- | --- | --- |
| V17 coffee conversation, 10 turns | 4.815 s | 6.172 s | Delivery passes; expression/factual failures remain |
| Second everyday conversation, 10 turns | 3.357 s | 4.523 s | Delivery passes; unsolicited advice remains |
| Private copied-persona, 4 turns | 2.836 s | 3.525 s | No staged physical activity or closing admonition in this sample |

The 20 ordinary turns combine to 3.747 s first-visible / 4.908 s completion medians. These are small, separately sampled observations, not a causal speed comparison or production SLA. Reserved `modelCallCount` is not used as a physical-call count.

The research case that previously failed with duplicated tool results now completes in 123.983 seconds. It performs 12 searches and rejects three oversized queries. It is still too slow, too long for the requested short response, and does not retrieve the requested original study; it also overstates this search gap as absent literature. The following casual purchase description becomes a care guide the user never requested. These are retained failures, not successful quality acceptance.

Current remaining issues are unsolicited life instructions and inferred circumstances, occasional self-commentary after a tone correction, and unsupported causal explanations with search off. Stronger prompts and offline classification/editor probes did not reliably fix these behaviors. No extra online classifier, reviewer, model-role swap, source-specific canned answer or hidden prose deletion was deployed. The existing MiMo primary / DeepSeek fallback roles remain unchanged.

Release therefore remains held under the user's instruction to finish all fixes before a joint release. No server version, production migration or formal iOS release has been published. See [quality review](evidence/agent-conversation-fixes-2026-11-01/quality-review.json) and [current evidence](evidence/agent-conversation-fixes-2026-11-01/latest-2026-11-02.json) for the exact unresolved cases.

## Later protocol, fragmented-tool and goal-handoff checks

An initial exact-marker diagnostic suggested that the current MiMo Responses endpoint ignored policy while Chat Completions followed it. Repeating raw controls produced counterexamples on both dialects. That protocol root-cause claim was withdrawn, and the selected configuration was restored to its original Responses protocol. Model IDs, primary/fallback roles and thinking defaults remain unchanged. The adapter now honors an explicitly selected model protocol and has coverage for MiMo Chat's documented thinking switch, output-limit field, developer messages, reasoning replay and terminal usage accounting; that compatibility is not presented as a proven naturalness improvement.

The candidate Chat dialogues completed 20/20 with matching streamed/saved text and hashes, but still invented context, gave unwanted advice and asserted unsupported mechanisms. The candidate task matrix was 13/14: a stats request returned a fabricated failure explanation without an actual read. A later targeted stats read succeeded, which does not erase the earlier failure. A same-pair critique/primary-rewrite experiment retained some errors and added 8.4–16.6 seconds. Compact prompts and thinking-off probes also failed the quality review. None of those quality experiments was adopted. Detailed evidence is in [protocol and stream recheck](evidence/agent-conversation-fixes-2026-11-01/protocol-and-stream-recheck-2026-11-02.json).

A separate deterministic Chat tool-fragment defect was fixed. The first delta commonly declares the tool-call ID, while subsequent argument deltas carry only the index. The raw observer split those into different calls and falsely rejected valid JSON. Index-to-ID binding now joins ordinary continuation, interleaved calls and a late-arriving ID; truly separate no-index calls remain separate. Four black-box cases failed before the correction and pass after it. The provider/observer target suite passes 41 tests. This is an adapter invariant; it is not proof that every historical production failure had this cause.

The current Responses route then exposed a material-handoff contract mismatch. `companion_goal_start` required a model-authored `goal`, but operation normalization and the canonical executor intentionally discarded it so the original user request could not be rewritten. The model placed the note body into that discarded field instead of supplying versioned inputs. The resulting background goal had no materials and paused asking for content already present in the conversation.

Start now exposes actual material references and adopts the current user request directly. An extra `goal` is rejected explicitly, rather than required and then silently dropped. The domain tool documents that `goal` belongs to revision, and that note artifacts need real frozen note/version identities. Self-contained calculations and user-provided public URL requests still permit empty note inputs. User intent is not replaced by a model paraphrase, and history is not silently converted into authorized business material.

The same native goal tool also lacked `runId` for revision/control. It now declares and requires that target identity, carries it through normalization, and registers it against `agent_runs.id`. Two shared contract regressions failed before these corrections and pass afterward.

Actual HTTP verification on the original model pair and Responses route read stats, created a note, searched/read that note, passed one frozen input to the background goal and waited until overview generation reached `completed`. A separate real dialogue cancelled one paused target and verified its database status was `cancelled`. The handoff turn took 43.253 seconds, followed by 24.047 seconds until background completion; these are functionality checks, not speed acceptance. Replies still contain unsolicited suggestions and unnecessary execution details, so conversational quality remains unpassed. See [goal handoff evidence](evidence/agent-conversation-fixes-2026-11-01/goal-handoff-2026-11-02.json).

Latest unit counts are worker 1,948 / shared 540 / API 2,035 passed, with one API skip. Four package type checks pass. Final database and task-matrix results are recorded in the linked validation evidence; earlier candidate and failed samples remain distinguishable. Release remains held.

The final selected-configuration matrix is **13/14**, not the older 14/14. `observe-stats` again returned without a read: it asserted specific September/August learning activity and mastery history absent from the frozen handoff and native input messages. A settled checkpoint contains that text as generated output; it must not be mistaken for input evidence. This inspection found no loaded cross-account record explaining those claims, and does not amount to a complete privacy certification. The failed sample remains in [the final task recheck](evidence/agent-conversation-fixes-2026-11-01/final-task-recheck-2026-11-02.json). The other 13 receipt/task checks pass; separately, frozen-material handoff and real cancellation pass. A fresh independent database rerun after the final contract changes applies all 462 migrations and passes all 68 cases. These engineering checks do not override the failed task/quality gate.
