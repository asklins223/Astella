# 常见问题与排障

中文 · [English](../en/faq-and-troubleshooting.md)

按症状定位当前调用链。先确认本机开发、Alpha 还是远程 HTTPS 环境，再看对应配置与日志；不要把历史故障记录当成当前限制。完整启动流程见 [开发环境](development.md)。

## 无法启动或登录

### 首次启动需要填什么？

复制 `.env.example` 后，填写 `EDGE_TTS_AUTH_TOKEN`、`ASTELLA_DESKTOP_PAIRING_KEY_ID`、`ASTELLA_DESKTOP_PAIRING_SECRET` 与 `ASTELLA_DOMAIN_SCHEMA_REVISION`。前者是 Compose 必填项；后三项是本机桌面配对所需配置，留空会出现 `desktop_trust_unavailable` 或客户端 `configuration_error`。

配对密钥必须是至少 32 字节的随机 base64url，可生成后填入 `.env`：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

远程 HTTPS 客户端使用公开 API 地址与契约修订，不使用本机配对密钥；证书仍必须有效。详见 [服务器部署](deployment.md)。

### 演示账号为什么登不进去？

开发栈不会自动创建账号。启动后执行 `make seed-demo`，默认凭据为 **`owner@astella.local` / `astella_owner`**，仅用于本机开发。该 Make 目标不转发 `.env` 中的 `OWNER_EMAIL` / `OWNER_PASSWORD`；已存在的邮箱会跳过，不重置密码。

需要自定义账号时，从 shell 导出这两个变量，再运行：

```bash
docker compose -p astella-dev -f docker-compose.dev.yml --profile seed   run --rm -e OWNER_EMAIL -e OWNER_PASSWORD seed-demo
```

种子密码至少 12 字符。生产使用显式的 `seed-owner` 与私有环境文件，不能使用演示种子，见部署分册。

登录返回 429 时按 `Retry-After` 等待。邮箱和 IP 分别计数；成功登录只清除邮箱计数，不能清除 IP 限流。默认窗口、次数与存储由 `AUTH_RATE_LIMIT_*` 控制，开发与生产默认值不同。

### 能找回忘记的密码吗？

当前没有邮件自助找回流程。`/auth/change-password` 需要当前密码；Owner 的 `/auth/recovered-users/:userId/reset-password` 仅初始化导入恢复用户尚未设置的密码，不能重置任意已有账号。不要把它当成通用找回接口。

### 端口被占用，或客户端连错地址？

| 服务 | 开发默认宿主端口 | 覆盖变量 |
| --- | --- | --- |
| API | `127.0.0.1:4000` | `API_PORT`、`API_BIND_ADDRESS` |
| PostgreSQL | `127.0.0.1:5432` | `POSTGRES_PORT`、`POSTGRES_BIND_ADDRESS` |
| MinIO | `127.0.0.1:9000/9001` | `MINIO_PORT`、`MINIO_CONSOLE_PORT` |
| edge-tts | `127.0.0.1:8088` | `EDGE_TTS_PORT` |
| Worker 指标 | `127.0.0.1:9100` | `WORKER_METRICS_PORT`、`WORKER_METRICS_BIND_ADDRESS` |

修改 API 端口时同步修改 `DESKTOP_API_ORIGIN`。执行 `make config` 检查开发配置，再 `make up` 应用。

## API 活着，但 `/ready` 失败

`/health` 表示进程存活；`/ready` 还检查数据库连接、业务表与迁移门槛。迁移由一次性容器执行，初始化顺序是 `role-bootstrap` → `migrate` → `role-grants`，API 与 Worker 在授权成功后启动。

```bash
curl -fsS http://127.0.0.1:4000/ready
docker compose -p astella-dev -f docker-compose.dev.yml logs role-bootstrap migrate role-grants
docker compose -p astella-dev -f docker-compose.dev.yml ps -a
```

一次性容器应为 `Exited (0)`。`make up` 等待退出，但不会检查 `docker wait` 打印的退出码，因此命令结束不能代替 readiness 与日志。不要只创建表或跳过角色补授；更详细的判据见 [API 与数据](api-and-data.md)。

## 伴星没有回复或一直在生成

按下面顺序检查：

1. **AI 使用同意**：本人在设置签署账号级同意并允许外发。未签时 `ai_consent_required` 是权限结果，Owner 不能代签，换空间不需要重签。
2. **能力与配置**：检查功能开关、`config/ai-platforms.json` 的能力槽位，以及对应 Key 是否实际传到 API／Worker。`.env` 新增变量不会自动进入容器。
3. **任务进展**：检查 run、job 与工具回执；`/companion/runs/:id/doctor` 提供当前用户可见运行的诊断。区分等待确认、未执行、不可用、失败与正在执行。
4. **时间预算**：普通 AI handler 默认 30 分钟，单次 provider 默认 15 分钟；实际调用受剩余预算与覆盖配置限制。两分钟租约每 30 秒续租，用于失联回收，不是任务时长上限。

超时覆盖、卡生成 outbox 与恢复边界见 [模型链路](ai-and-companion.md#超时阶梯) 和 [Agent 运行时](agent-runtime.md)。思考调用可能较慢，但不能只凭等待时间认定任务健康；应核对心跳和持久化事件。取消或失去租约的旧执行不能提交结果。

供应商探针见 [companion-provider-health.mjs](../../../scripts/companion-provider-health.mjs)，应在 Worker 配置与身份上下文中运行；它会产生真实模型调用和费用，普通单测不执行它。

## 模型报 400、401 或 403

400 先核对协议、Base URL、模型 ID、模型档案与推理档位。`opencode_go` 使用 `/responses`；当前 DeepSeek 对话槽位也走它。仅提供 chat/completions 的模型使用 `openai_compatible` 平台，不能按模型名称猜协议。视觉与思考能力以具体模型声明为准。

401／403、欠费或未配置通常是不可重试错误。补齐正确项目／区域的 Key、授权或额度，再重启对应服务；桌面端没有个人供应商 Key 设置页。开发可能使用 mock，生产 `AI_REQUIRE_CONFIGURED_PROVIDER=true` 时未配置明确失败，不用假文本冒充真实结果。

配置和协议依据见 [模型与 Worker 链路](ai-and-companion.md)。

## 搜索、写笔记和改正文没执行

联网搜索默认关闭，需要账号级搜索开关、AI 同意、外发允许与可用智谱凭据。额度不足后当前 Worker 按凭据冷却 30 分钟；它不是跨副本的全局限流。本轮仍可作答，但应说明没有完成联网核实。来源通过引用角标查看，不把 URL 或来源标题混入朗读。

普通聊天与解释原句不会自动写笔记。明确提出创建／修改要求，并核对权限档：只读禁止写入；引导档允许符合条件的可逆操作；六个学习动作在完全档仍需提案确认。

改正文先同步工作稿，再冻结光标／选区并核对版本和原文。被处理段落临时锁定，其他段落仍可编辑；冲突、失败或取消后解除状态。出现冲突时确认当前版本和选区后重新发起，避免用旧内容覆盖新稿。选文后的「让伴星改这段」只是准备指令，还需发送。

详见 [伴星体验](companion-experience.md) 和 [桌面客户端](desktop-client.md)。

## 语音没有声音，或识别不工作

识别与朗读是两条链：桌面本机 SenseVoice 模型负责识别，API 的 Qwen／Edge TTS 负责合成。先检查系统麦克风许可、本机模型下载与伴星静音设置，再看对应服务日志。

Compose 中 API 用 `http://edge-tts:8080`；宿主机直接运行 API 时用 `http://127.0.0.1:8088`，两侧 `EDGE_TTS_AUTH_TOKEN` 必须一致。Qwen 合成失败可降级 Edge；治理拒绝或用户取消不会重新外发。引擎、音色与模型配置见模型链路分册。

本机识别模型在 `<userData>/voice-models/`（可由 `ASTELLA_VOICE_ASR_DIR` 覆盖），不随安装包分发。真实麦克风、扬声器和人工听音需要单独验证，源码守卫不能证明声音质量。

## 全屏、缩放与动效

全屏笔记复用同一编辑器与工作稿；工具层覆盖正文，不压缩纸面宽度。Esc 先关闭上层浮窗，再收起工具，之后退出全屏。伴星在全屏中的临时座位不覆盖用户常驻设置。

⌘／Ctrl 加 `+`、`-`、`0` 调整或重置缩放。窗口最小尺寸由 `src/shared/window-geometry.ts` 定义，不能用默认尺寸截图替代高缩放验收。动效档位是 Full／Lite／Off；系统减少动态优先。Lite 保留交互讲解所需动作，Off 与减少动态应保留手动操作和全部信息。

## 数据存在哪，停止容器会删吗？

| 数据 | 位置与边界 |
| --- | --- |
| 开发业务库 | external 卷 `astella-dev_dev_postgres_data`，`make down` 与 Compose `down -v` 保留它 |
| 本地图片、附件与原文 | MinIO 对象卷；不享有上述 PostgreSQL external 保护 |
| 正式对象 | 私有远程 S3 兼容桶，与数据库分开备份 |
| 本机识别模型与互动页缓存 | Electron `userData` 下对应目录 |
| 会话凭据 | 主进程写在 Electron `userData` 下的 0600 本地文件；写入失败时不落盘，登录只保持到本次结束 |

`make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB` 会永久删除开发数据库卷并重新启动。Docker 管理操作仍可显式删除卷，不能理解为绝对防删除。数据库备份不会自动包含远程／MinIO 对象，迁移前同时核对长期资源。

## 类型检查和集成测试为什么没发现问题？

桌面根 tsconfig 只有 references，使用包内 `npm run typecheck`。首次装好各包依赖并构建桌面产物后再运行 `make verify`。

后端普通 `npm test` 发现 `*.test.ts`，不运行 `*.integration.ts`。真实数据库测试使用：

```bash
make disposable-db DISPOSABLE_DB=astella_it
make test-postgres COMPANION_HOME_TEST_DB=astella_it
```

第一条会删除已有同名测试库，不能指向生产库。远程 S3、真实模型与真实窗口另有独立入口；`make verify` 也不包含覆盖率与 skip/todo 门禁。详见 [测试与质量](testing-and-quality.md)。

## 如何判断功能是否已经验收？

代码接通、单测通过、实库通过、真实模型完成和窗口顺手是不同证据。上下文治理已经有实库、模型对照与部分窗口记录，不能继续写成「从未验证」；长期效果、并发恢复、声音质量与跨版本更新仍按具体记录确认。

查看 [现行方案](../../plans/learning-companion/README.md)、[测试与质量](testing-and-quality.md)、[运行与发布](operations.md) 和 [服务器部署](deployment.md)。PolyForm Noncommercial 自有源码与文档许可不替代第三方模型与素材的授权，见 [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md)。
