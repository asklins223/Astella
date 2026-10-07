# 伴星真实模型验收

这是显式启用的付费网络测试，不被常规单测入口自动运行。只使用合成检索材料、测试图与虚构对话；不取真实笔记、照片或私人记忆，不打印凭据与明文推理。

从 `workers/ai-worker` 运行，必须设 `REAL_MODEL_BATCH=1`：

```sh
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/context-probe.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/platform-probe.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/quality-repeat.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/voice-expression-probe.ts
REAL_MODEL_BATCH=1 LIVE_QUALITY_CURRENT_ONLY=1 LIVE_QUALITY_REVIEW=1 LIVE_QUALITY_REPEATS=1 LIVE_QUALITY_SUFFIX=reviewed node --import tsx src/live-tests/quality-comparison.ts
```

`context-probe` 默认检索 20K、128K、920K、1.03M 填充 token 附近的五个随机标记，输出上限 512。它特意直接探测平台容量，另行记录应用预算的判断；不能把平台接受的输入量当作应用在常规 131,072 输出预留下的可用输入量。设 `LIVE_CONTEXT_EXACT=1` 可比较接入后的本地 tokenizer，`LIVE_CONTEXT_UNITS=128000` 可缩小样本。超过声明窗口的探测是独立的合成验收，不绕过业务请求的预算闸。

`platform-probe` 覆盖主模型/专用模型两条识图路线、完整/裁剪图、兜底工具往返和思考开关。`quality-repeat` 复测漏读、知识方向与嵌入维度/相似度。图片由测试方生成，有确定答案；先在本机生成 `outputs/audits/2026-10-07-live/vision-full.png` 和 `vision-crop.png`。

`runtime-probe.ts` 使用真实模型、生产 Agent 循环、生产 delta 交付管线与一次性 PostgreSQL。必须先用仓库脚本建立 `astella_companion_live_20261007`，并显式把 `DATABASE_URL*` 指向它；程序会拒绝其他数据库名。测试调用治理层时使用测试用户与合成数据，未修改真实账号的同意或权限状态。

隔离库脚本输出中，夹具连接选 RLS 组的迁移角色 URL，赋给 `DATABASE_URL_MIGRATOR`；运行时选 RLS 组的 worker 角色 URL，赋给 `DATABASE_URL_WORKER` 和 `DATABASE_URL`。API 连接使用 API 角色 URL。不要使用脚本末尾的超级用户示例来证明受限 worker 权限；循环与内容测试的结构通过也不代替权限回归。

`quality-comparison.ts` 对完整咖啡解释、作用力与反作用力、相关与因果、自述有无记录和普通闲聊进行评测。参考事实只交给评审，不注入生成请求；评审必须引用回答中的连续原文，标准缺失、引文编造或 JSON 不完整不能算通过。原始回答仍需人工核对，模型评分不代表事实认证。默认旧底座/当前底座各两次，顺序交替；`LIVE_QUALITY_CURRENT_ONLY=1` 只测当前版，`LIVE_QUALITY_REVIEW=1` 显式启用实验审校，`LIVE_QUALITY_CASES` 可选逗号分隔的案例 id，`LIVE_QUALITY_SUFFIX` 区分产物。该对照同时改变了提示词、采样和自述路由，不能据此把效果归因于单独一个参数；baseline 仅模拟旧底座、身份边界和参数，并非完整旧生产环境。

运行实库回归时可设 `LIVE_RUNTIME_SUFFIX=reviewed-final` 保留旧产物；`LIVE_RUNTIME_EMPTY_SELF=1` 只测没有历史记录的自述，验证真实读取与无结果表达。`quality-comparison-harness-error.json` 是测试入口误用 JSON 默认格式的拒绝，`quality-comparison-incomplete-review.json` 是修复评审额度之前的中间采样，都不能当作最终质量结论。

`LIVE_RUNTIME_KNOWLEDGE_ONLY=1` 只测咖啡完整解释及杯内流动，便于在最后一次政策调整后核对生成、复核和发布参数。各阶段以产物中的 `systemHash`、请求回执和对应报告区分，不用文件名里的 `final` 推断它一定是最后一版代码。

产物逐步写入 `outputs/audits/2026-10-07-live/`。其中 `runtime-harness-error.json` 是首次验收脚本使用错误方法名的排障记录，不能计为产品或模型失败；修正脚本后的 `runtime.json` 才是连续对话样本。成功的结构/传输断言不代表知识内容正确，保留原始回答供人工核对。

发布前审校默认关闭。2026-10-07 的完整样本仍有漏判、修订中新断言与明显等待成本，未满足 40b §4.2/§4.4 的默认启用条件。仅在显式实验环境设置 `COMPANION_EXPLANATION_REVIEW_V1=true` 后，`runtime-probe.ts` 和生产循环才接管明确的无工具解释；最多额外一次模型调用，保持原总预算。它先输出 focus、带原文段落编号的 corrections 和最终 answer；程序从完整草稿恢复逐字证据，私有 JSON 不进入可见流。阶段失败或输出截断不发布草稿，无效协议不由队列自动重投。结构合法不等于事实通过；不得按模型自评自动扩大启用范围。

`knowledge-review-probe.ts` 仅以旧失败回答作为草稿测试审校，不将评测参考事实送进生成；用 `LIVE_REVIEW_CASES` 选择案例、`LIVE_REVIEW_SUFFIX` 保存不同产物。不要覆盖旧失败样本来制造全绿结论。

`natural-dialogue-probe.ts` 用于不附加“不要反问/不要建议”指令的逐轮接话测试。用同一个一次性空间、账号和会话连续写入真实消息记录，再走生产意图分类、Agent 循环、工具、治理和可见正文交付。输入一行普通用户话语，读完实际回答再输入下一句；`/quit` 结束并清理夹具。`LIVE_NATURAL_SUFFIX` 区分产物。它不让另一模型代演用户，也不把理想答案或评测参考放进请求。身份、记忆和页面素材仍是合成测试数据，不能冒充真实用户群体的体验研究；成功送达也不表示回答自然或事实正确。

这里的接话操作方可以是编码 agent，不应把它标成真实人类用户。夹具直接构造读取阶段上下文，不是完整 HTTP/UI 端到端测试。当前版本接入 `reserveCompanionProviderCall`，并保存实际出网 instructions 与哈希；只保存本夹具的合成材料，不记录凭据、请求头或 HTTP 错误正文。2026-10-07 的五场普通输入测试共 32 轮，含修复失败实录，见 `outputs/audits/2026-10-07-live/natural-dialogue-report.md`。前三场尚未接计数端口，应按 wire 回执检查请求数；`natural-dialogue-normal.json` 是早期夹具终态状态错误，不计为产品质量样本。

`voice-expression-probe.ts` 使用真实人格、首步请求与流式执行器生成安慰、祝贺、解释和轻笑四个合成样本，记录原始标记、干净正文和请求回执到 `voice-expression.json`。它不读取账号历史，不额外调用情绪分类器。标签出现率不能代表全部多轮对话；听感与真人验收记录见 `../handlers/__tests__/voice-expression-experience-qa.md`。
