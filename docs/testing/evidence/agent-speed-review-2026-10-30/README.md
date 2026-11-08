# 证据：伴星速度恢复与图片交付（2026-10-30）

对应记录：[agent-speed-restore-and-image-delivery-2026-10-30.md](../../agent-speed-restore-and-image-delivery-2026-10-30.md)。

| 文件 | 内容 |
| --- | --- |
| verification.json | 本轮各检查的命令、计数、日志哈希与结论 |
| change-manifest.json | 20 个改动文件的前后 SHA-256；批注测试以 HEAD 为基线 |
| runtime-live-results.json / runtime-live.log | 五个真实模型样本、出站像素哈希与耗时 |
| vision-probe-results.json | 短提示下两个模型对纯蓝 64/512px 的识图对照 |
| fallback-replay-results.json | 逐字重放抓到的备用模型请求体 |
| fallback-vision-bisect.json | 上下文各部分的拆分实验（工具、系统提示、送达记录） |
| fallback-limit-bisect.json | `max_tokens` 与系统提示长度拆分 |
| fallback-question-bisect.json | 显式颜色问题、图片顺序、512px 图的对照 |
| fallback-shape-results.json | 白底红圆形状图在完整上下文里的识图结果 |
| worker-final-2.log / shared-final.log | 最终完整回归 |
| postgres-related-final.log / postgres-annotation-final.log | 真 PostgreSQL 集成（84 + 5） |
| postgres-initiative-final-2.log / postgres-initiative-before.log | 主动参与集成（修复前 31/34 → 34/34） |
| api-memory-final.log | API 记忆 HTTP 真库集成 |
| structure-final-2.log | 文件规模、目录扇出、层次依赖检查 |

方法与原始请求在 `outputs/agent-speed-review-2026-10-30/`；没有部署、生产迁移或设备验收结论。
