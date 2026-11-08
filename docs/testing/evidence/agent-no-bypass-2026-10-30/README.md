# 证据索引：Agent 交付核对移除分档免检（2026-10-30）

- `changed-files.json` / `no-bypass.patch`：本轮 9 个源码文件的前后哈希与统一差异。
- `postgres-before.log`：修改前的完成套件，24 项中 16 通过、8 失败（真实绕过反例）。
- `postgres-first-fixture-iteration.log`、`postgres-fixture-iteration-2.log`、`postgres-fixture-iteration-3.log`：夹具迭代的失败记录，未删除。
- `postgres-after-first-fix.log`：首轮修复后 24/24。
- `postgres-final-before-last-edit.log`：加入 image-only 反例后 26/26。
- `postgres-final-after-last-edit.log`：最后一行批注收尾修改后重跑 26/26。
- `postgres-related.log`：8 份相关 PostgreSQL 集成 98/98。
- `structure.log`：文件规模、目录扇出、层次依赖检查 17/17。
- `focused-unit.log`：定向单测 35/35。
- `worker-typecheck.log`：最终 Worker 类型检查。
- `runtime-live-results.json` / `runtime-live.log`：真实模型与原生循环 4 项，注入标记在 trace 中。
- `run-runtime-live.mts` / `run-runtime-live.sh` / `image-only.png`：live 夹具脚本与合成测试图。
- `verification.json`：验证摘要、策略哈希、配置身份、清理状态与剩余边界。
- `manifest.json`：本目录文件的 SHA-256 清单。

完整日志与原始快照保留在 `outputs/agent-no-bypass-2026-10-30/`，本目录只归档本轮关键证据。
