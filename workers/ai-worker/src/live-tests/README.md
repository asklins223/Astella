# 伴星真实模型验收

这是显式启用的付费网络测试，不被常规单测入口自动运行。只使用合成检索材料、测试图与虚构对话；不取真实笔记、照片或私人记忆，不打印凭据与明文推理。

从 `workers/ai-worker` 运行，必须设 `REAL_MODEL_BATCH=1`：

```sh
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/context-probe.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/platform-probe.ts
REAL_MODEL_BATCH=1 node --import tsx src/live-tests/quality-repeat.ts
```

`context-probe` 默认检索 20K、128K、920K、1.03M 填充 token 附近的五个随机标记，输出上限 512。它特意直接探测平台容量，另行记录应用预算的判断；不能把平台接受的输入量当作应用在常规 131,072 输出预留下的可用输入量。设 `LIVE_CONTEXT_EXACT=1` 可比较接入后的本地 tokenizer，`LIVE_CONTEXT_UNITS=128000` 可缩小样本。超过声明窗口的探测是独立的合成验收，不绕过业务请求的预算闸。

`platform-probe` 覆盖主模型/专用模型两条识图路线、完整/裁剪图、兜底工具往返和思考开关。`quality-repeat` 复测漏读、知识方向与嵌入维度/相似度。图片由测试方生成，有确定答案；先在本机生成 `outputs/audits/2026-10-07-live/vision-full.png` 和 `vision-crop.png`。

`runtime-probe.ts` 使用真实模型、生产 Agent 循环、生产 delta 交付管线与一次性 PostgreSQL。必须先用仓库脚本建立 `astella_companion_live_20261007`，并显式把 `DATABASE_URL*` 指向它；程序会拒绝其他数据库名。测试调用治理层时使用测试用户与合成数据，未修改真实账号的同意或权限状态。

产物逐步写入 `outputs/audits/2026-10-07-live/`。其中 `runtime-harness-error.json` 是首次验收脚本使用错误方法名的排障记录，不能计为产品或模型失败；修正脚本后的 `runtime.json` 才是连续对话样本。成功的结构/传输断言不代表知识内容正确，保留原始回答供人工核对。
