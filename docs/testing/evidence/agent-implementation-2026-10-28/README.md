# 2026-10-28 原生 Agent 实施证据

当前结论与限制见 [实施报告](../../agent-native-loop-implementation-2026-10-28.md)。本目录只包含合成材料；没有已解析凭据、账号令牌、私有数据库 URL、原始 provider 请求载荷或模型推理。

- `summary.json`：106 条已记录 HTTP 测试请求，另有 4 条测试器中止记录；100 次非 HTTP 诊断试验，包含重复案例与条件对照，不能相加当作独立场景数。
- `http-runs.json`：所有保留批次、公开回答、原自动检查、读取的实际文档／记忆来源、provider 耗时。未改写旧检查结果；两次编辑误报和一次物理措辞误报见人工核对。
- `http-events.json` / `first-visible-samples.json`：实际公开事件与工具状态；首事件时间不是设备上的有效正文或音频延迟。
- `diagnostics.json`：诊断的最终内容、原生工具请求／回执、模型设置与出网摘要。内存执行器与真实 HTTP 分开看；未接入导航和语音标签比较曾影响诊断自动判定。
- `semantic-review.json`：实施者阅读原文后核对的内容缺陷与客观状态误报，不是盲评。
- `manifest.json`：Git 基线、当前相关文件哈希、worker 启动时选取的源码哈希与候选配置哈希。这不是“全仓库全部依赖冻结”的声明。
- `runtime-config.candidate.json`：只在隔离进程测试过的 SiliconFlow DeepSeek V4.1 Flash 文本候选；API key 为 `${ENV}` 引用。根配置没有切换，资源调度默认关闭。TokenRhythm 备用只声明 high/max，不能充当真 none 对照；视觉仍由原有辅助视觉模型提供。
- `*-final-all.log`、`worker-types-probe-final.log`、`postgres-integration.log`、`editor-tests.log`、`api-structure-final.log`：最终回归与类型检查。

复用当前代码请从仓库 `workers/ai-worker` 运行 `src/live-tests/companion-reliability-probe.ts`。先用当前 API／worker、迁移、受限角色启动专属本地库（名称必须 `astella_note_authoring_*` 或 `astella_agent_*`），再用环境变量提供该库 URL，避免把凭据写到命令历史：

```sh
REAL_MODEL_BATCH=1 \
RELIABILITY_API_BASE_URL=http://127.0.0.1:4108 \
RELIABILITY_LABEL=unique-audit \
RELIABILITY_CASES=offer-first,accept-followup,after-quality-chat \
node --import tsx src/live-tests/companion-reliability-probe.ts
```

`RELIABILITY_DATABASE_URL` 须事先注入当前进程；必须与 API／worker 的专属数据库相同。验证调度候选时，只有隔离 worker 使用 `COMPANION_AGENT_RESOURCE_ROUTING=enabled`，API 与 worker 使用候选 `AI_PLATFORMS_CONFIG`。主配置与生产进程不因此改变。

本目录 `.mjs/.mts` 是实验脚本的原始快照，按当时 `outputs/agent-implementation-2026-10-28/` 相对路径运行，依赖本机私有服务夹具；不能直接在本目录执行，也不能把缺失的私有文件当作产品依赖。当前可复用入口以上述已纳入源码的 probe 为准。实验快照未按后来修复重写。

本轮验收数据库容器、API 与 worker 完成后停止；原有开发容器和工作区其他会话的声音改动保留。早期空测试库在共享 PostgreSQL 上的残留会话仍阻止删除，精确范围见 `cleanup.json`。
