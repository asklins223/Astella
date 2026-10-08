# 伴星真实模型验收

这是显式启用的付费网络测试，不被常规单测入口自动运行。只使用合成检索材料、测试图与虚构对话；不取真实笔记、照片或私人记忆，不打印凭据与明文推理。

`companion-note-generation-routing-probe.ts` 核对速看、拓展草稿与纯聊天请求的分类边界，使用合成当前笔记与旧能力拒绝回复。以 `REAL_MODEL_BATCH=1` 显式运行，输出 `note-generation-routing-20261008.json`；它仅测试分类，不创建任务或读取真实账号数据。真实窗口生成与保存回执另见 `docs/testing/companion-note-generation-routing-2026-10-08.md`。

`companion-note-authoring-probe.ts` 使用 `astella_note_authoring_*` 一次性库、合成知识讨论和一篇相关笔记，走真实模型的搜索、阅读、创建笔记与最终流式交付。显式设置 `REAL_MODEL_BATCH=1` 及受限 API/worker 连接后运行；夹具自动清理，结果写入 `note-authoring-live-20261008.json`。这是生产工具循环与持久化/交付管线验证，不包括 HTTP 提交、队列派发或 Electron 操作；真实窗口与失败样本另见 `docs/testing/companion-note-authoring-2026-10-08.md`。

从 `workers/ai-worker` 运行，必须设 `REAL_MODEL_BATCH=1`：

```sh
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/context-probe.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/platform-probe.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/quality-repeat.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/voice-expression-probe.ts
REAL_MODEL_BATCH=1 LIVE_QUALITY_CURRENT_ONLY=1 LIVE_QUALITY_REVIEW=1 LIVE_QUALITY_REPEATS=1 LIVE_QUALITY_SUFFIX=reviewed node --import tsx src/live-tests/quality-comparison.ts
```

`context-probe` 默认检索 20K、128K、920K、1.03M 填充 token 附近的五个随机标记，输出上限 512。它特意直接探测平台容量，另行记录应用预算的判断；不能把平台接受的输入量当作应用在当前路由完整输出预留下的可用输入量。设 `LIVE_CONTEXT_EXACT=1` 可比较接入后的本地 tokenizer，`LIVE_CONTEXT_UNITS=128000` 可缩小样本。超过声明窗口的探测是独立的合成验收，不绕过业务请求的预算闸。

`platform-probe` 覆盖主模型/专用模型两条识图路线、完整/裁剪图、兜底工具往返和思考开关。`quality-repeat` 复测漏读、知识方向与嵌入维度/相似度。图片由测试方生成，有确定答案；先在本机生成 `outputs/audits/2026-10-07-live/vision-full.png` 和 `vision-crop.png`。

`runtime-probe.ts` 使用真实模型、生产 Agent 循环、生产 delta 交付管线与一次性 PostgreSQL。必须先用仓库脚本建立 `astella_companion_live_20261007`，并显式把 `DATABASE_URL*` 指向它；程序会拒绝其他数据库名。测试调用治理层时使用测试用户与合成数据，未修改真实账号的同意或权限状态。

隔离库脚本输出中，夹具连接选 RLS 组的迁移角色 URL，赋给 `DATABASE_URL_MIGRATOR`；运行时选 RLS 组的 worker 角色 URL，赋给 `DATABASE_URL_WORKER` 和 `DATABASE_URL`。API 连接使用 API 角色 URL。不要使用脚本末尾的超级用户示例来证明受限 worker 权限；循环与内容测试的结构通过也不代替权限回归。

`quality-comparison.ts` 对完整咖啡解释、作用力与反作用力、相关与因果、自述有无记录和普通闲聊进行评测。参考事实只交给评审，不注入生成请求；评审必须引用回答中的连续原文，标准缺失、引文编造或 JSON 不完整不能算通过。原始回答仍需人工核对，模型评分不代表事实认证。默认旧底座/当前底座各两次，顺序交替；`LIVE_QUALITY_CURRENT_ONLY=1` 只测当前版，`LIVE_QUALITY_REVIEW=1` 显式启用实验审校，`LIVE_QUALITY_CASES` 可选逗号分隔的案例 id，`LIVE_QUALITY_SUFFIX` 区分产物。该对照同时改变了提示词、采样和自述路由，不能据此把效果归因于单独一个参数；baseline 仅模拟旧底座、身份边界和参数，并非完整旧生产环境。

运行实库回归时可设 `LIVE_RUNTIME_SUFFIX=reviewed-final` 保留旧产物；`LIVE_RUNTIME_EMPTY_SELF=1` 只测没有历史记录的自述，验证真实读取与无结果表达。`quality-comparison-harness-error.json` 是测试入口误用 JSON 默认格式的拒绝，`quality-comparison-incomplete-review.json` 是修复评审额度之前的中间采样，都不能当作最终质量结论。

`LIVE_RUNTIME_KNOWLEDGE_ONLY=1` 只测咖啡完整解释及杯内流动，便于在最后一次政策调整后核对生成、复核和发布参数。各阶段以产物中的 `systemHash`、请求回执和对应报告区分，不用文件名里的 `final` 推断它一定是最后一版代码。

产物逐步写入 `outputs/audits/2026-10-07-live/`。其中 `runtime-harness-error.json` 是首次验收脚本使用错误方法名的排障记录，不能计为产品或模型失败；修正脚本后的 `runtime.json` 才是连续对话样本。成功的结构/传输断言不代表知识内容正确，保留原始回答供人工核对。

2026-10-08 已从生产 Agent 循环移除用途/阶段额外生成与发布前审校分支。先前样本的漏判、新断言和等待成本未满足采用条件；三项旧 `COMPANION_*REVIEW_V1` / `COMPANION_DIALOGUE_FRAME_V1` 标志不再启用生产功能。`runtime-probe.ts` 与 `natural-dialogue-probe.ts` 会在创建夹具和调用模型前拒绝这些旧标志，避免把普通生产调用错记成实验审校。纯诊断代码与测试移到 `diagnostics/` 和本目录 `__tests__/`，原失败材料保留。

`knowledge-review-probe.ts` 仅以旧失败回答作为草稿测试审校，不将评测参考事实送进生成；用 `LIVE_REVIEW_CASES` 选择案例、`LIVE_REVIEW_SUFFIX` 保存不同产物。不要覆盖旧失败样本来制造全绿结论。

`natural-dialogue-probe.ts` 用于不附加“不要反问/不要建议”指令的逐轮接话测试。用同一个一次性空间、账号和会话连续写入真实消息记录，再走生产意图分类、Agent 循环、工具、治理和可见正文交付。输入一行普通用户话语，读完实际回答再输入下一句；`/quit` 结束并清理夹具。`LIVE_NATURAL_SUFFIX` 区分产物。它不让另一模型代演用户，也不把理想答案或评测参考放进请求。身份、记忆和页面素材仍是合成测试数据，不能冒充真实用户群体的体验研究；成功送达也不表示回答自然或事实正确。

这里的接话操作方可以是编码 agent，不应把它标成真实人类用户。夹具直接构造读取阶段上下文，不是完整 HTTP/UI 端到端测试。当前版本接入 `reserveCompanionProviderCall`，并保存实际出网 instructions 与哈希；只保存本夹具的合成材料，不记录凭据、请求头或 HTTP 错误正文。2026-10-07 的五场普通输入测试共 32 轮，含修复失败实录，见 `outputs/audits/2026-10-07-live/natural-dialogue-report.md`。前三场尚未接计数端口，应按 wire 回执检查请求数；`natural-dialogue-normal.json` 是早期夹具终态状态错误，不计为产品质量样本。

`voice-expression-probe.ts` 使用真实人格、首步请求与流式执行器生成安慰、祝贺、解释和轻笑四个合成样本，记录原始标记、干净正文和请求回执到 `voice-expression.json`。它不读取账号历史，不额外调用情绪分类器。标签出现率不能代表全部多轮对话；听感与真人验收记录见 `../handlers/__tests__/voice-expression-experience-qa.md`。

### 2026-10-07 研究驱动复验

研究依据、源码版本和采用/撤回的判断见 [companion-research.md](companion-research.md)。`natural-dialogue-probe.ts` 现在沿生产历史查询和读取时钟构造元数据。可用 `LIVE_NATURAL_SEED=research-*.json` 在本次审计目录中提供带真实数据库发送时间的合成旧记录，种子不是评阅答案。`LIVE_RESEARCH_BASELINE=1` 关闭时间元数据并恢复旧示例标签；`LIVE_RESEARCH_CANDIDATE=1` 仅用于复现未通过的文案候选，不能作为发布配置。两者不能同时使用。实际默认不读取或修改这些实验文本。

研究复验的其余测试开关：`LIVE_CASUAL_EFFORT=low` 只在支持该档的同平台模型上，将闲聊 none 请求改为 low；分类器不改。`LIVE_NO_VOICE_EXAMPLES=1` 仅移除语音协议的两行格式示例，其他语音控制与参数不改。`LIVE_PAIRED_EXAMPLES=1` 添加话题独立的成对示例，未通过默认采用验证。`LIVE_MODEL_ID` 仅允许对当前已配置平台中已声明档案的其他模型做测试。开关互斥，不改正式路由；wire 收据记录实际发送字段，SSE 只取返回用量，不保存明文思考。所有实验结果单列，不能用成功交付宣称自然度通过。

用途与阶段的历史实验、失败和核对重放入口见 [dialogue-frame-experiment.md](dialogue-frame-experiment.md)；其旧生产开关已撤下。它区分来源绑定、模型语义判断与真实交付；结构测试通过不代表普通聊天自然度通过。

### 方案 46：固定前缀对照与独立评阅材料

`dialogue-cases.ts` 定义 10 个设计话题、20 个话题隔离的后续验收组。`dialogueGenerationFixture` 只给生成入口原生历史、当前话语与固定意图，不提供评阅判据和目标答案。隔离组需要 `LIVE_DIALOGUE_SPLIT=heldout LIVE_DIALOGUE_HELDOUT_RELEASE=1` 才能调用；设计时不查看隔离组的生成结果。材料是合成的，不冒充真实用户研究。

```sh
REAL_MODEL_BATCH=1 LIVE_DIALOGUE_MATRIX_SUFFIX=design-v1 LIVE_DIALOGUE_REPEATS=2 LIVE_DIALOGUE_MAX_CALLS=80 node --import tsx src/live-tests/dialogue-matrix.ts
REAL_MODEL_BATCH=1 LIVE_DIALOGUE_ABLATION_SUFFIX=examples-v1 node --import tsx src/live-tests/dialogue-persona-ablation.ts
REAL_MODEL_BATCH=1 LIVE_DIALOGUE_ABLATION_KIND=identity LIVE_DIALOGUE_ABLATION_SUFFIX=identity-v1 node --import tsx src/live-tests/dialogue-persona-ablation.ts
node --import tsx src/live-tests/dialogue-export-review.ts design-v1
```

产物后缀必须显式给出，已存在时拒绝覆盖；上面后缀是本轮已经用过的示例，复验应选新的后缀。矩阵最大 80 次真实调用，示例移除对照最大 20 次，无自动质量重试或额外模型评委。固定前缀中保持普通分享和真正求助，不给所有用户输入附“别建议/别反问”。当前默认候选是同平台已声明的 Muse，可由 `LIVE_DIALOGUE_CANDIDATE_MODEL` 指定该平台其他已声明模型；不修改正式路由。

矩阵复用生产人格装配、闲聊首步构造和流式执行器，但背景是明确标记的合成来源，意图固定；它不经过 HTTP/数据库或真实分类，不能声称是生产读取的完整请求。完整装配与相关装配保持原生消息、人格、权限、参数相同，仅去掉声明的无关来源；跨模型最低思考档不同，比较的是可用配置综合表现。示例移除试验只改账号 examples，其余条件相同。

`LIVE_DIALOGUE_ABLATION_KIND=identity` 是后续能力诊断：无示例现役人格与简洁身份各两次，最多 20 次调用。必需身份/宿主/权限/声音合同与原生历史、参数保持相同，但角色底座、账号人格与非必要前言同时改变，不能作为单变量原因或直接上线候选。

请求级快照与出网 payload 的白名单快照分别保存，保留分数温度的稳定 JSON 哈希、实际思考字段、工具 schema、额度和用量；不含请求头、凭据与生成的隐藏推理。非白名单字段记录省略数量，存在私有推理回放时拒绝保存该快照。连续聊天脚本也开始记录这些出网快照，工具后续轮不能保存时明确标出省略，不影响真实调用。

`dialogue-export-review` 完全离线，生成随机排序的匿名回复与空白多维评阅表；模型、条件、等待和哈希仅在独立 mapping 文件中。未独立填写的表保持 unrated，不能算盲评通过。第一版矩阵的 `firstTextMs` 是首个非空 provider 文本增量，可能仅为语音标签；不能算首个有效正文或 UI 等待。入口随后增加了 `firstVisibleTextMs` 单列投影时刻，旧记录不补造该数值。

本阶段 120 次真实调用、采用判断、embedding 截断修复和验证边界见 [实施记录](dialogue-design-implementation-2026-10-07.md)。

后续增加已配置跨平台候选与单变量思考对照，48 次新调用及 Go 断流修复见 [后续记录](dialogue-model-screen-and-stream-fix-2026-10-07.md)。候选默认仍来自当前平台；显式 `LIVE_DIALOGUE_CANDIDATE_PLATFORM` 与 `LIVE_DIALOGUE_CANDIDATE_MODEL` 可选择已有平台下已声明的模型，只支持本诊断驱动实现的协议，不改 capability 路由。跨平台的协议、档位与输出额度差异属于配置综合比较。

```sh
REAL_MODEL_BATCH=1 LIVE_DIALOGUE_CANDIDATE_PLATFORM=tokenrhythm LIVE_DIALOGUE_CANDIDATE_MODEL=qwen3.8-flash LIVE_DIALOGUE_CASES=resume,duck,practice-help LIVE_DIALOGUE_REPEATS=1 LIVE_DIALOGUE_MAX_CALLS=12 LIVE_DIALOGUE_MATRIX_SUFFIX=qwen-screen-v2 node --import tsx src/live-tests/dialogue-matrix.ts
REAL_MODEL_BATCH=1 LIVE_DIALOGUE_CANDIDATE_PLATFORM=tokenrhythm LIVE_DIALOGUE_CANDIDATE_MODEL=qwen3.8-flash LIVE_DIALOGUE_CASES=resume,piano,duck,song,practice-help LIVE_DIALOGUE_ABLATION_KIND=thinking LIVE_DIALOGUE_ABLATION_SUFFIX=qwen-thinking-v2 node --import tsx src/live-tests/dialogue-persona-ablation.ts
```

`thinking` 只对设计话题改普通聊天的思考开关，当前模型内比较、每条件两次、最多 20 次实际请求；显式求助两条件均保留开启。快照与返回用量区分请求字段和实际推理证据，不能将 chat/completions 的开关称为上游已生效的具体 high 档。失败前的正文只作收取现场，不当成成功答复或实际 UI 交付。


### 2026-10-08 完整链路与采用结果

[实施与验证记录](companion-integration-and-final-validation-2026-10-08.md) 覆盖来源尾部、长记忆与 embedding、断流后禁止重复生成、Responses 阶段、受限角色数据库回归、实际 HTTP/SSE 和当前仓库 Electron 窗口。Luna 的 20 个隔离话题四条件共 80 次对照已完成，发现无来源的时间/经历/当前状态断言，候选未采用；匿名评阅表仍是 unrated。试验档案已移除，不把失败候选列成待发布功能。DeepSeek Go 输出档案与 OpenCode 模型目录对齐为 384,000，思考模式省略无效温度；完整输出预留下的输入硬预算为 613,952 token。此次解锁后实际检查气泡/手记的超限输入保留、2499 字笔记选区送入模型、引用尾句展开与 SSE 保存一致性，发现并修复 selection 2400 字局部装配上限和确定性装配错误的重试。最终 Worker 单元 1484、实库 263、桌面相关 90、shared 合同 28 项及五包类型检查通过；这些结果不代表普通聊天自然度或等待稳定性已经通过。

2026-10-08 后续还修复取消/接替回合的正文留档和 HUD 跨回合串文，取消事务只保存已提交增量，空正文不造消息，迟到完整生成不再补写。分类 v7 区分回复内创作 task/none 与项目数据操作；没有选区和来源读取的直接回复可使用非来源引号与引用排版；相邻人物对白不参与现实引用归属，真实引文与选区仍核对。引文一次纠正后仍不匹配则失败，不随额度耗尽降为成功。24 次分类控制单列；新增六次来源表达候选仍编造动作/感受而淘汰，表达诊断累计 406 次。实际连续拉链对话虽完成于约 2–3s，内容仍失败，不能把时延样本或结构回归当自然度通过。证据见上述实施记录。


2026-10-08 拟人化后续：[输入分层与新模型初筛](dialogue-layer-diagnostic-and-model-screen-2026-10-08.md)完成 18 条 bare/protocol/full 定位请求，以及 Seed 2.1 Pro、Qwen 3.8 Max 各 6 条完整上下文初筛，累计表达诊断 436 次。现役裸聊也失误，支持优先筛表达模型，但不是唯一根因证明。两候选仍编造过程、时序或经历，均未采用。新增诊断单测与相关实验测试 13 项及 worker 类型检查通过；本轮没有新数据库/HTTP/原生窗口聊天验收。用户随后指定固定 deepseek-v4.1-flash，不再换模型；该决定覆盖前述筛选方向，已完成候选只作历史证据。后续在现役模型上调整输入与接话，再进入新话题连续验收。


固定 DeepSeek 后追加六条当前交流锚点对照，保留完整历史与参数，只重附当前交流原话；仍有编造细节、旧题牵回和安排休息，未进入生产。累计表达诊断 442 次；15 项相关测试与 worker 类型检查通过，所有本轮批次退出。详细口径见上面的分层诊断记录。

随后[连续接话指导验证](dialogue-continuous-guidance-validation-2026-10-08.md)完成 32 条新话题连续对照及 24 条窄纠正组件对照，累计表达诊断 498 次。后续回放模型实际正文，用户话语无附加输出约束；两候选仍出现无请求安排与无依据事实/亲身经验，均未采用。自动思考与完整回放的出网检查通过，17 项相关测试及 worker 类型检查通过。此阶段是固定意图、固定用户脚本的离线轨迹诊断，没有新增 HTTP/原生窗口验收，正式配置保持原状。

```sh
REAL_MODEL_BATCH=1 LIVE_DIALOGUE_CONTINUOUS_SUFFIX=unique-run node --import tsx src/live-tests/dialogue-continuous-probe.ts
REAL_MODEL_BATCH=1 LIVE_DIALOGUE_CORRECTION_SUFFIX=unique-run node --import tsx src/live-tests/dialogue-correction-probe.ts
```

这两个入口固定 DeepSeek，各有 32/24 次物理调用上限；不会覆盖既有证据，也不会将评阅判据送入模型。它们保留的是已失败候选的可复现诊断，不是正式功能开关。

用户追问原因后，[原因定位记录](dialogue-cause-localization-2026-10-08.md)补齐同 DeepSeek 的 none/0.9、none/0.2、low、high 共 24 次对照，再去掉剩余身份做六次。无系统提示、无历史的简历/练琴仍复现分析/帮助与补编细节；上游返回模型标识一致，实际推理用量不同。定位到当前调用链的正文生成，模型权重与 Go 处理机制仍未分离，不能称唯一底层根因。累计表达诊断 528 次，17 项相关测试和 worker 类型检查通过；正式配置没有改变。本轮同时纠正“一有建议就失败”的过宽判据，保留贴题关心与接管安排的区别。

```sh
REAL_MODEL_BATCH=1 LIVE_DEEPSEEK_MODE_SUFFIX=unique-run node --import tsx src/live-tests/dialogue-deepseek-mode-probe.ts
```

快速追加的三组 Go Chat/Responses 对照和第二条既有网关两项同版 Flash 核对均复现帮助/解释倾向，正式模型与配置未变；累计可观测表达请求 536 次。结果追加在原因定位记录。源码发现公共 HTTP helper 在 observer 内侧有重试，此前“物理调用上限”应按可观测 requester 调用上限理解，不能保证底层 HTTP attempt 总数；原始证据保留，不以计数证明内容改善。

用户问能否修改后，[生成目标修复尝试](dialogue-generation-goal-attempt-2026-10-08.md)完成通用目标对照十二次、手工交流动作三次及相同动作配 low 三次。仍有评价/心理归因/编造/安排，三候选均未采用；18 个可观测请求中 16 条完成、两条错误未完成。17 项相关测试与 worker 类型检查通过，正式配置未变，未为失败能力诊断扩建分类器。累计可观测表达请求 554 次，不代表自然度改善。

用户随后接受当前效果并要求启用：[正式启用记录](companion-formal-activation-2026-10-08.md)确认最小续接目标已移入正式 `companion-casual-policy-v2`，普通/预生成共用；主/备用均配置 DeepSeek v4.1 Flash，API/worker 已重载且健康。176 项相关测试与四包类型检查通过，普通与预生成容器构造检查退出 0。用户决定覆盖前述“小幅目标不采用”处置，不把旧失败数据改称通过；其余实验仍仅用于诊断，不再继续试调。没有新增模型调用。
