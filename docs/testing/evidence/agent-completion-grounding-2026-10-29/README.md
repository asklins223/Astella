# 来源与实际交付核对证据

对应[实施报告](../../agent-completion-grounding-2026-10-29.md)。全部模型输入、笔记口令、消息、账号和对象 ID 均为合成测试数据。本目录不含环境变量、解析后密钥、真实用户资料、会话令牌或隐藏思考。

- `audit-broad-v1.ts`、`audit-provenance-v2.ts`、`audit-provenance-v3.ts` 为当时的政策与解析逻辑快照，供审阅；文件按原位置引用模块，不能直接在本证据目录执行。
- `audit-corpus-v*.json` 与 `audit-independent-heldout.json` 保留每项输入、预期及范围。结果中的 `corpusSha256/policyHash` 绑定语料与政策；预期没有发给模型。
- `audit-*-results.json` 保留逐路由逐项结果和不可用项。V1 仅保存解析后判定，不可用项没有未解析文本；V2 起保存 `rawOutput`。不同阶段不可合并成总体成功率。
- V1 的知识/推理负例继续保留。V2/V3 将其中三个列为范围外对照，意味着该方案不检查它们，不表示错误被修复。`evaluation-summary.json` 统计时明确排除这三个对照。
- V3 的副档优先组合统计是从两路单独试验中按现行规则选取结果；独立保留集是之后另固定的 16 项，没有用于再调政策。两者都只是有限样本。
- `runtime-live-results.json` 为配置模型、实际原生循环和独立 PostgreSQL 的五项真实调用。夹具直接创建 provider，不是线上完整治理装配或客户端验收。
- `completion-postgres-final.log` 的 13 项使用脚本模型/审查器配合真实数据库，验证控制流与持久化。`worker-postgres-verified.log` 是此前 12 项新集成与 72 项相关集成的合并运行，不与最终 13 项相加。
- `completion.patch` 相对本轮开始前已有改动的工作快照，不能当成相对 Git HEAD 的完整补丁；`changed-files.json` 只列本轮十份源码/测试。期间出现的非本轮 schema 修改原样保留，单独在 `verification.json` 记录哈希，未纳入本轮验收。
- `verification.json` 记录测试命令、日志哈希、模型配置身份及本轮临时容器删除状态。完整 Worker 日志、前置原文件及可复用探针在 `outputs/agent-completion-grounding-2026-10-29/`，不纳入本目录的源码差异。
- `manifest.json` 对本目录除清单自身以外的全部文件逐一记录 SHA-256。没有部署或生产迁移。

相关测试使用包内 `npm test`、`npm run typecheck`，以及 Node `--import tsx --test --test-concurrency=1`。集成测试需独立测试数据库及受限 Worker/API 角色，不能将测试夹具指向生产数据。真实模型探针读取现有配置，重复执行会产生额外模型调用。
