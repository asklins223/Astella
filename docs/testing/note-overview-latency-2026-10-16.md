# 线上速看卡住与「服务挂了一次」· 2026-10-16

用户报告：线上生成速看一直卡着出不来；同一时段还遇到一次服务挂。
本页记录实际读到的线上证据、根因判断、已落地的修复与验证范围。

## 1. 线上事实（只读查询：`docker logs` / `psql` / journald）

### 速看没有失败，它跑了 4 分 2 秒

| 项 | 值 |
| --- | --- |
| 任务 | `86209cb0-35df-4258-ada0-17868200abdc`（笔记 `a4e978cf…`，版本 `2ec6d4f5…`） |
| 起止 | 11:32:06.36 → **11:36:08.98 UTC**，`succeeded`，`attempts=0`，无错误 |
| 任务耗时 | 242.58 s（worker `astella_job_duration_seconds` 只有这 1 次，落在 120–300 s 桶） |
| 模型调用 | `ai_audit_log`：`note_learning_overview:chat_completion`，**`mimo-v2.6-flash`**，`duration_ms=242381`，prompt 1,838 tok / completion **9,411 tok** |
| 入队 | `POST /v2/notes/…/overview-tasks` → 200，`responseTime` 74 ms（API 层无关） |
| 产物 | 正文 289 字 + 12 条要点，`coverage={totalBlocks:17, textBlocksRead:17, imageBlocksNotRead:0, pointsDropped:0}`，抽查内容准确 |
| 客户端 | 每 1,600 ms 轮询一次，跟满 4 分钟；纸面从头到尾只写「正在整理整篇笔记」 |

同一操作的历史对照（同一张表）：10-09 三次速看在 **`deepseek-v4.1-flash`** 上是
9.5 s / 12.7 s / 16.1 s。档位切换来自 `f5fee8a2a`（2026-10-16 00:05「小米单平台与
Pi 模型层」）：`agent_turn` 由 `opencode-go/deepseek-v4.1-flash` 改为
`mimo-agent/mimo-v2.6-flash`，档案 `reasoning.default = "medium"`。今天这次是切换后
第一次速看。

### 「服务挂了一次」是 v1.8.8 部署，不是崩溃

```
11:18:40  拉取 v1.8.8 镜像
11:22:37  旧容器被手动停（exit 0）
11:22:47  nginx 10s 内未退出 → "using the force" → SIGKILL(137)
11:23:19  迁移前 dump 落盘
11:23:27  新 api / worker 起来；11:23:28 nginx 起来
```

- `RestartCount=0`、`OOMKilled=false`，dmesg/journal 无 OOM；8 GB 内存当时只用了 647 MB。
- 被杀的容器是 **nginx**：api 有 20 s、worker 有 60 s 宽限，只有 nginx 走 Docker 默认 10 s；
  官方镜像 `STOPSIGNAL SIGQUIT`（优雅退出）要等 SSE/WebSocket 结束，必然超时。
- **没有任务在中间被打断**：`jobs` 在 08:48:39–11:25:39 之间是空的。
- 桌面端同时在 11:25:37 / 11:26:37 各启动一次（1.8.7 → 1.8.8 自动更新重启），
  与接口空窗叠加，构成用户感知的「挂了」。

## 2. 根因

1. **模型切换后，速看（连同脑图/讲解/拓展）与伴星对话共用一个能力槽**，只能继承对话
   模型的思考档；这一次该档位产出了 9,411 completion token（解析出来只有约 1.5k token），
   242 s 全花在模型自己的长生成上。
2. **单发预算过宽**：`note_overview_generate` 的嵌套 provider 超时取
   `WORKER_PROVIDER_TIMEOUT_MS = 900000`（15 min），所以最坏可以安静地转 15 分钟。
3. **客户端没有进度、也没有出路**：1,600 ms 轮询会一直跟，纸面只有一句「正在整理」。
4. 部署侧 nginx 没有宽限时间，每次滚动更新都会在 10 s 时被 SIGKILL 掉连接。

## 3. 已落地的修复

| # | 改动 | 位置 |
| --- | --- | --- |
| A | 拆出 `note_generation` 能力槽，速看/脑图/讲解/拓展走它；档位由能力级 `reasoningEffort` 声明为 **`low`**（不是 `none`），伴星对话仍是 `medium` | [provider-capabilities.ts](../../packages/shared/src/provider-capabilities.ts)、[platform-config.ts](../../packages/shared/src/platform-config.ts)、[platform-config-node.ts](../../packages/shared/src/platform-config-node.ts)、[task-router.ts](../../packages/shared/src/task-router.ts)、[governance.ts](../../workers/ai-worker/src/lib/governance.ts)、[ai-platforms.json](../../config/ai-platforms.json) |
| B | 笔记产物有**单发** provider 预算（速看 120 s / 脑图 150 s / 讲解 90 s / 拓展 150 s），超时失败并给重试 | [handler-timeout-config.ts](../../workers/ai-worker/src/lib/handler-timeout-config.ts)、[docker-compose.yml](../../docker-compose.yml)、[docker-compose.dev.yml](../../docker-compose.dev.yml)、[.env.example](../../.env.example) |
| C | 纸签显示「已等 N 秒」，45 s 后改说「这次比平时久」，180 s 后给「重新整理」（计时器住在叶子组件里，不让纸面每秒重渲） | [task-slip.tsx](../../apps/desktop-client/src/renderer/src/components/surfaces/notebook/task-slip.tsx)、[use-notebook-overview.ts](../../apps/desktop-client/src/renderer/src/components/surfaces/notebook/use-notebook-overview.ts)、[note-hud.css](../../apps/desktop-client/src/renderer/src/components/surfaces/note-hud.css) |
| D | nginx 宽限时间对齐到 30 s | [docker-compose.deploy.yml](../../docker-compose.deploy.yml) |

配套：配置面板展示并**原样往返** `reasoningEffort`（整体替换映射时漏掉它会把
修复悄悄改回去），越档/非法值阻断保存。

## 4. 验证范围

- 单测：`packages/shared` 951 项、`workers/ai-worker` 1884 项、`apps/api` 3010 项
  （1 skipped）全部通过；desktop-client 相关 9 项通过（含新增纸签用例）。
- 类型检查：shared / api / ai-worker / desktop-client 全通过。
- 配置解析实测：真实 `config/ai-platforms.json` 下 `agent_turn` 仍是 `medium`、
  `note_generation` 解析为 `low`，模型档案的 `levels` 未被改动。
- **真实模型对照**（非用户内容，同一提示形状）：
  - 速看型抽取：`medium` 22.5 s / 1,167 tok；`low` 23.4 s / 1,317 tok；两次 JSON
    均可解析、引文逐字核得回原文。**没有复现出 242 s** —— 线上那一次是长生成的长尾，
    不是 `medium` 的稳定表现，所以真正兜底的是 B。
  - 档位确实下到线上请求体：同一道多步推理题 `none` 12.2 s/362 tok、`low` 20.4 s/450 tok、
    `high` 24.2 s/697 tok，单调递增；`low` 位于中间而不是"等于关思考"。
- compose 语法：`docker compose config -q` 通过（dev 与 prod 叠加）；nginx conf 用
  `nginx:1.28-alpine nginx -t` 通过。

## 5. 未完成 / 需要决定

- **这些改动要发版才影响线上**：代码与配置随镜像/部署 bundle 落地，生产上目前仍是旧行为。
- 想只靠配置立即止血的话，可在 `/etc/astella/production.env` 加
  `WORKER_PROVIDER_TIMEOUT_NOTE_OVERVIEW_GENERATE_MS=120000`（以及脑图/讲解/拓展三条）再重建
  worker——但**没有 A 的档位下调时，这会把一次 242 s 的慢成功变成 2 分钟失败**，因此建议
  与 A 一起发版，而不是单独上。
- `worker_shutdown_timeout` 只能写在 nginx 的 main context（conf.d 是 http context，
  实测被拒），要加需要换一份 `/etc/nginx/nginx.conf` 并同步 CI 的 bundle 文件清单
  （`.github/workflows/server-deploy.yml` 的 tar 列表）与 `infra/deploy/__tests__/bundle.test.py`。
- 本次只读排查未改动线上数据；workspace 里伴星语音重发的在途改动与本任务无关，未触碰。
