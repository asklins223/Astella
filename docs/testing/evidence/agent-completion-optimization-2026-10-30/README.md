# 本轮证据

对应[优化报告](../../agent-completion-optimization-2026-10-30.md)。保留上一轮证据，本目录只记本轮差异。

- `probe-before.json/probe-after.json`：同一份合成长材料的输入字节数、正文副本数和宿主材料追加后的回执可见性；不代表 token 或延迟改善。
- `model-corpus.json/model-results.json`：调用前冻结的 8 项合成输入及逐项判定，预期没有发给模型。范围限来源/实际交付，不能代表总体准确率。
- `runtime-live-results.json/runtime-live.log`：当前配置模型、实际工具循环与独立测试数据库的 4 项样本，含资源判断超时并走副档的慢路径。合成用户、笔记、口令不涉及真实用户资料。
- `model-probe-source-identity.json` 与 `receipts-used-during-model-probes.ts`：模型调用所用代码身份。随后只修正请求边界兼容和测试收尾，政策与索引格式保持不变；重新生成的 8 项输入哈希相同。快照供审阅，不作为本目录下可直接运行的模块。
- `postgres-before.log`：新增两个反例在修改前失败；`postgres-after.log` 为初次修复后 15 项通过；`postgres-verified.log` 为最终边界修正后的 87 项，不把重复执行相加。模型/审查输出使用脚本夹具，数据库和控制流是真实的。
- `watchdog-hang.json/watchdog-focused.log`：一次测试子进程未退出及收尾加固后的定向结果；被终止的那次仍是失败，完整正常通过的日志哈希另见 `verification.json`。没有证明唯一挂起根因。
- `changed-files.json/optimization.patch`：相对本轮开始时已有改动的工作区快照，共 7 份源码/测试/脚本登记文件，不是相对 Git HEAD 的全部改动。
- `verification.json/evaluation-summary.json/manifest.json`：测试、模型和配置身份、分项统计以及目录逐文件 SHA-256，清单本身不包含在自身哈希中。

完整 Worker 日志、初版类型错误、压缩边界失败、原文件及复用脚本留在 `outputs/agent-completion-optimization-2026-10-30/`。本目录不保存环境变量、凭据、会话令牌或隐藏思考。未部署；本轮独占临时数据库已删除。
