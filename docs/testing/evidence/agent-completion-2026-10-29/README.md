# 2026-10-29 Agent 发布证据

当前结论见[发布及验收记录](../../agent-completion-and-release-2026-10-29.md)。

- `source-manifest.json`：已发布文件快照及逐文件 SHA-256；实际运行镜像见 `deployment-identity.log`。
- `production-acceptance.json`：独立线上账号 16 条完整请求，原始客观检查 14/16，包含失败正文；`production-literal.json` 是另外账号的两条明确逐字请求，2/2。
- `manual-review.json`：实施者人工阅读后的判断，不是独立盲评；不将执行检查当作内容质量评分。
- `production-cleanup.json`／`cleanup.json`：合成账号禁用、会话撤销和自建资源清理；生产合成记录保留在其独立空间中供追溯。
- `batch-index.json` 与同名 JSON：本地完整 HTTP 试验，含多版本、重复场景及失败，不构成独立语义成功率。
- `entry-*.json`：分类与生成物理拆分／并行的真实模型诊断；`review-check*.json` 保留二次审稿放过已知错误与超时的负例。
- `holdout-cases.json`：试验前冻结的场景与人工核对维度；后续补充线上逐字用例另行标注，没有替换冻结样本。
- `*-final.log`、`worker-regression-current.log`、`postgres-integration.log`：自动测试、类型与结构检查。构建仍有仓库已有的 CJS `import.meta` 警告，构建及实际启动均通过。

时间含义：本地早期 `firstVisibleMs` 由测试器起点与首事件时间估计；线上记录改为服务端 run 接收到首个持久化可见事件，避免跨主机时钟偏差。均未测设备渲染、音频或用户感知首字。

可复用本地 probe 位于 `workers/ai-worker/src/live-tests/companion-reliability-probe.ts`，需要显式真实模型开关和独立本地测试库。它仍禁止访问生产库。

`production-acceptance.mts` 是此次窄范围线上验收脚本，不读取真实用户会话。需要已授权的 SSH 控制连接与本地端口转发，并显式设置 `REAL_PRODUCTION_AGENT_ACCEPTANCE=1`。原运行位置为仓库 `outputs/agent-completion-2026-10-29/`，该相对路径用于引用 PNG 夹具；在 worker 包目录以 `node --import tsx ../../outputs/agent-completion-2026-10-29/production-acceptance.mts` 执行。脚本默认 16 条；补充批设置 `ONLINE_ACCEPTANCE_LABEL=production-literal ONLINE_ACCEPTANCE_CASES=literal-create,literal-edit`。创建的账号只写自身空间，令牌仅在内存，结束后禁用账号能力并删除自身会话。不要把已过期的本次运行身份视作可复用凭据。

证据排除已解析密钥、密码、会话令牌、私有数据库 URL、真实用户文本、原始 provider 载荷和隐藏推理。原始私有工作材料留在忽略目录，公开包经已知凭据扫描。
