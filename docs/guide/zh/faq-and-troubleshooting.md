# 常见问题与排障

中文 · [English](../en/faq-and-troubleshooting.md)

这篇讲什么：把本机跑理解引擎时真会撞上的问题按「现象 → 原因 → 处理」列清楚，每条答案都对着仓库里的 compose 文件、Makefile 与代码核对过。不写通用建议，只写这条链路上真正起作用的那一步。

- [登录与账号](#登录与账号)
- [端口与本机服务](#端口与本机服务)
- [数据库与就绪检查](#数据库与就绪检查)
- [伴星语音](#伴星语音)
- [模型调用](#模型调用)
- [伴星没有回复](#伴星没有回复)
- [桌面客户端与类型检查](#桌面客户端与类型检查)
- [数据存在哪](#数据存在哪)
- [测试跑不动](#测试跑不动)
- [还没解决的已知限制](#还没解决的已知限制)

## 登录与账号

### 无法登录 → 演示账号从未创建 → `make seed-demo`

**现象：** 桌面端用 `owner@ailearn.local` / `ailearn_owner` 登不进去，或 API 直接回 401 `invalid credentials`。

**原因：** 开发栈启动时不建任何账号。`seed-demo` 服务在 `seed` profile 下，只有显式运行才创建。Makefile 的 `seed-demo` 目标是 `docker compose -p ailearn-dev -f docker-compose.dev.yml --profile seed run --rm seed-demo`；该容器带 `SEED_DEMO_DATA=true`，`apps/api/src/db/seed.ts` 才允许用内置的演示邮箱与密码。

**处理：** 栈起来后执行 `make seed-demo`。账号已存在时脚本只打印 `Owner already exists` 并退出，可重复执行。这对凭据**仅用于本机开发**，生产环境不会自动创建演示账号。

生产栈走另一条路：`docker-compose.yml` 里的 `seed-owner` 一次性服务，需要显式运行

```bash
docker compose -f docker-compose.yml --profile seed run --rm seed-owner
```

它不带 `SEED_DEMO_DATA`，且 `NODE_ENV=production`。此时 `seed.ts` 是 fail-closed 的：缺 `OWNER_EMAIL` 或 `OWNER_PASSWORD` 直接抛错（"Production seeding never uses a default owner account"），`OWNER_PASSWORD` 少于 12 位同样抛错，`SEED_DEMO_DATA=true` 配 production 更是直接拒绝启动。

### 登录被拒 429 → 命中登录限流 → 等窗口过去，别指望登录成功清掉它

**现象：** 密码明明对，却收到 429 `rate_limited`，带 `Retry-After` 头。

**原因：** `POST /auth/login` 有两条独立的计数键：`auth:login:ip:<ip>` 与 `auth:login:email:<email>`。默认窗口 15 分钟、默认最多 5 次，由 `AUTH_RATE_LIMIT_WINDOW_MS`（毫秒）与 `AUTH_RATE_LIMIT_MAX_ATTEMPTS` 控制；开发栈把次数放宽到默认 100（多条 E2E spec 连续登录），生产 compose 保持 5。`AUTH_RATE_LIMIT_STORE` 决定计数存哪：未设置时一律用 `postgres`（跨副本正确），只有显式写 `memory` 才用进程内实现——开发 compose 默认给的是 `memory`，生产默认 `postgres`。填别的值会抛 `AUTH_RATE_LIMIT_STORE must be memory or postgres`。

**处理：** 按 `Retry-After` 等。要长期放宽就改 `AUTH_RATE_LIMIT_MAX_ATTEMPTS`。注意**成功登录只重置邮箱那一格，不重置 IP 那一格**（2026-08-11 收紧：否则攻击者用任一有效凭据登录一次就清空自己的 IP 失败计数，支持跨账户爆破）。所以本机反复试错之后，即使登录成功，同一 IP 仍可能在窗口内被继续挡住。

## 端口与本机服务

### 启动报端口占用 → 宿主机映射写死了几个常用端口 → 改对应的 `*_PORT`

**现象：** `make up` 失败在 `port is already allocated` / `address already in use`。

**原因：** 开发栈默认把这些端口发布到宿主机，且默认只绑回环：

| 服务 | 宿主机默认 | 覆盖变量 | 备注 |
| --- | --- | --- | --- |
| API | `127.0.0.1:4000` | `API_PORT`（`API_BIND_ADDRESS` 改绑定地址） | 容器内监听由 `API_INTERNAL_BIND_ADDRESS` 决定，默认 `0.0.0.0` |
| PostgreSQL | `127.0.0.1:5432` | `POSTGRES_PORT` / `POSTGRES_BIND_ADDRESS` | 本机已装 Postgres 时最常撞 |
| MinIO | `127.0.0.1:9000` / `:9001` | `MINIO_PORT` / `MINIO_CONSOLE_PORT` | 在 `storage` profile 下 |
| edge-tts | `127.0.0.1:8088` | `EDGE_TTS_PORT` | 容器内是 8080，映射写死 `127.0.0.1:${EDGE_TTS_PORT:-8088}:8080` |
| Worker 指标 | `127.0.0.1:9100` | `WORKER_METRICS_PORT` / `WORKER_METRICS_BIND_ADDRESS` | 健康检查打的是 `/metrics` |

**处理：** 改 `.env` 里对应变量后 `make up`。改了 API 端口要**同步改 `DESKTOP_API_ORIGIN`**（默认 `http://127.0.0.1:4000`），否则桌面客户端仍然连旧端口。`make config` 会校验开发配置。

## 数据库与就绪检查

### `/ready` 返回 503 或迁移没跑 → 迁移不是 API 进程干的 → 看一次性容器的日志

**现象：** Postgres 健康、API 起得来，但 `http://localhost:4000/ready` 一直 503；正文里的 `error` 是 `business schema is incomplete — run migrations`，附带 `missingTables`、`appliedMigration`、`requiredMigration` 三个字段。

**原因：** 迁移由一次性服务 `migrate` 执行（`restart: "no"`，命令 `npm run db:migrate`），不是 API 进程启动时顺手做的。`/ready` 检查两件事：核心业务表是否都在（`users`、`notes`、`jobs`、`learning_runs` 等），以及 `drizzle.__drizzle_migrations` 里最新的 `created_at` 是否不低于门槛。门槛由 `MIN_READY_MIGRATION_CREATED_AT` 提供，代码缺省是一个**时间戳**（`1786683800000`）而不是迁移条数，这样"只存在早期几张核心表"不会被误报成就绪；这个值不是正的安全整数时 `/ready` 也直接 503。数据库连不上时返回的是另一条 `database connection failed`。

**处理：**

```bash
docker compose -f docker-compose.dev.yml logs migrate role-bootstrap
docker compose -f docker-compose.dev.yml ps            # 一次性容器应停在 Exited(0)
```

`make up` 会先清掉上一轮的一次性容器再重建，并 `docker wait` 等本轮 `role-bootstrap` 与 `migrate`（storage 模式下还有 `minio-init`）跑完，所以正常情况下迁移不需要手动触发。生产栈的依赖链不同：`api` 等的是 `postgres` 健康 + `role-grants` 成功退出，而 `role-grants` 又等 `migrate`；开发栈里对应的一次性服务名叫 `role-bootstrap`。残留容器可用 `make clean-init` 手动清除。

## 伴星语音

### 语音没有声音 → 引擎选择、地址或令牌任一处不符 → 先分清哪一路在响

**现象：** 伴星回应有文字没声音，或整段静音；日志里出现 `qwen tts failed; falling back to edge-tts`。

**原因：** 默认引擎是 Qwen，合成失败时自动降级到 Edge TTS。引擎与音色读 `config/ai-platforms.json`：`tts.engine`（`"qwen"` 或 `"edge"`，其余值按缺省处理）、`tts.qwen.{model,voice,workspaceId,instruction}`、`tts.edge.{voice,rate}`（Edge 音色缺省 `zh-CN-XiaoxiaoNeural`）。降级只在真实合成失败时发生：Qwen 缺 `workspaceId` 时不报 502 而是转 Edge；**被治理门拒发或用户取消时不降级**，那两种情况本来就不该再外发一次。

地址有两个世界，混用是这里最常见的错：

| 谁在调用 | 该用的地址 | 由谁给 |
| --- | --- | --- |
| Compose 里的 API | `http://edge-tts:8080` | `EDGE_TTS_BASE_URL`，compose 已注入 |
| 直接在宿主机跑的 API | `http://127.0.0.1:8088`（`EDGE_TTS_PORT` 可改） | 代码里的宿主回环缺省；Docker 服务名从宿主解析不到 |

令牌由 `EDGE_TTS_AUTH_TOKEN` 提供，**两侧必须一致**。compose 用 `${EDGE_TTS_AUTH_TOKEN:?...}` 声明，缺了整组栈起不来；容器侧 `docker/edge-tts/server.py` 在读不到该变量时 fail closed——除 `/health` 外一律回 401，声音不会有任何输出。并发另有 `EDGE_TTS_MAX_CONCURRENCY`（缺省 4）。

**处理：** 先确认在哪个世界调用（宿主机跑 API 却填了 `edge-tts:8080` 是典型症状），再核对 `EDGE_TTS_AUTH_TOKEN` 两侧一致，最后看 `docker compose -f docker-compose.dev.yml logs edge-tts`。若 Qwen 完全不可用，把 `tts.engine` 显式设为 `edge` 可以让 Edge 成为主路，跳过每次先试一遍 Qwen。

## 模型调用

### 调用报 400 → 协议、模型档案或 baseUrl 与服务商不匹配 → 按槽位核对声明

**现象：** AI 调用返回 400，或任务反复重试后仍然失败。产品里没有「测一下这个模型」这类界面入口——模型与供应商只由 `config/ai-platforms.json` 与环境变量决定，所以 400 只会从真实调用里出来。（旧根 README 的「模型测试返回 400」「重新填写 API Key」讲的是按用户配置供应商的界面，本仓库没有这样的界面。）

**原因：** 这个仓库的原则是**声明即真相**，不做运行时能力探测。能力到模型的映射在 `config/ai-platforms.json` 的 `capabilities` 里（`agent_turn`、`text_generation`、`companion_fallback`、`vision`、`embedding`），每个平台的模型能力挂在**具体模型**上：`platforms.<id>.models.<model>` 下的 `contextWindowTokens`、`maxOutputTokens`、`vision`、`reasoning.levels`/`reasoning.default`。没声明的模型会用 provider 内置缺省并打一次告警，上下文与思考档位因此常常不对。识图路由按声明三档走：当前对话模型声明 `vision: true` 就用它，否则用 `capabilities.vision` 且其模型没被显式声明 `vision: false`，两者都不满足就明确失败——绝不把图交给看不见的模型。

协议类型也是声明的一部分。`opencode_go` 说的是 OpenAI **Responses** API（`/responses`），与 `chat/completions` 的 messages/choices 契约不同，不能靠改写 endpoint 复用同一实现；所以同一家供应商里，只在 `/responses` 提供的模型走 `opencode_go`，仍走 `chat/completions` 的模型要另开一个 `openai_compatible` 平台指向同一个 baseUrl（配置里 `siliconflow` 与 `siliconflow-chat` 就是这么分的）。`dashscope` 是独立的 provider 类型，缺省基址 `https://dashscope.aliyuncs.com/compatible-mode/v1`，embedding 还要求 baseUrl 必须以 `/compatible-mode/v1` 结尾，否则解析时抛错。

**处理：** 检查 Base URL 是否与服务商协议一致、模型 ID 是否正确、账号是否拥有该模型权限、账户是否还有可用额度；DashScope 的新模型优先用兼容模式地址。然后为该模型补上正确的档案，而不是让代码猜。

### 调用报 401 或 403 → 凭据或授权问题会被判为不可重试 → 补 key，别等重试

**现象：** 任务很快变成失败而不是反复重试；日志里 provider 返回 401/403。

**原因：** `workers/ai-worker/src/lib/non-retryable-errors.ts` 把鉴权、授权与欠费类错误判为不可重试，直接标 dead，以免烧掉租约时间：包含 `invalid api key`、`unauthorized`、`authentication failed`、`api key is required`、`access denied`、`permission denied`、`insufficient balance`、`account suspended` 等精确短语，以及要求出现在 HTTP 状态语境里的 401/403 识别（裸数字不再触发，避免 "card 403 not found" 被误杀）。DashScope 欠费的真实报文 `please make sure your account is in good standing` 也在名单内。

凭据不从界面录入：本机与生产都靠环境变量注入，配置文件里只留 `${VAR}` 占位符，所以这里的修法是补好变量并重启对应服务，而不是去某个页面重新粘贴 key。

**处理：** 确认这个 key 属于正确的项目、区域并被授权给目标模型；账户侧再看是否欠费或额度耗尽。开发栈里 key 来自 `config/ai-platforms.json` 的 `${VAR}` 占位符，对应变量是 `DASHSCOPE_API_KEY`、`OPENAI_COMPAT_API_KEY`、`BIGMODEL_API_KEY`、`SILICONFLOW_API_KEY`、`TOKENRHYTHM_API_KEY`、`OPENCODE_GO_API_KEY`。

> **说明：** 占位符对应的环境变量没设置时，`${VAR}` 会原样留着，这条平台被判定为"未配置"，于是**回退到 mock provider**（输出固定假文本并打告警），而不是抛错。生产 compose 默认 `AI_REQUIRE_CONFIGURED_PROVIDER=true`，此时未配置会抛不可重试的 `ai_provider_not_configured`，用户看到"AI 未配置"，编造内容不会写进学习记录。

## 伴星没有回复

### 伴星不回或一直转圈 → 同意门、平台配置或思考档位的真实延迟 → 按这三步定位

**现象：** 消息发出去没回音，状态长时间停在生成中；或者回复是"一两个字"就结束。

**原因与处理，按顺序排：**

1. **同意门。** 外发 AI 的闸门是账号级同意，`PUT /me/ai-consent`（`user_ai_settings`，判据是 `consentAt && consentVersion` 都在）。没签时语音与文字路径都会拿到 403 `ai_consent_required`，界面应当说"先去设置里同意"，而不是"服务坏了"。同意与空间无关，换空间不需要重签。
2. **平台到底解析成了谁。** 供应商健康探针必须**在 worker 容器里跑**：

   ```bash
   docker exec -i -w /app ailearn-dev-worker-1 \
     node --import tsx --eval "$(cat scripts/companion-provider-health.mjs)"
   ```

   在宿主机跑时 `AI_PLATFORMS_CONFIG` 指向容器看不到的路径，结果会是 `provider=mock` 加一句"平台未配置"，测不出任何真东西。探针复用生产同一个退化判据，`agent_turn` 槽位出现任一退化时退出码为 1。
3. **它只是慢，不是卡住。** 2026-10-06 全链路开思考之后，单次取回从实测 7.6s 涨到 36s，摘要器一类的单次调用实测 36s。所以各类 handler 超时不再写死数字，而是从租约预算派生：`LEASE_TIMEOUT_MS = 120s`，减去 10s 安全余量得到上限，`companion_agent`、`agent_run_advance`、`companion_memory_extract` 等都取这个上限；单次 provider 调用缺省 75s（仍受 handler 预算减 15s 约束），日记类任务放宽到上限是因为一次 job 最多两次采样。要按部署调整，用 `WORKER_MODEL_TIMEOUT_MS`、`WORKER_TIMEOUT_<TYPE>_MS`、`WORKER_PROVIDER_TIMEOUT_MS`、`WORKER_PROVIDER_TIMEOUT_<TYPE>_MS`。租约超时严格大于每个 handler 超时，这样 abort 抢在 reaper 收回任务之前——症状若是"任务停在 running 后被人抢走"，通常是有人把这两个数改坏了。

## 桌面客户端与类型检查

### 类型检查"通过"但一行都没检查 → 根 tsconfig 只有 references → 用各包自己的 `npm run typecheck`

**现象：** 在 `apps/desktop-client` 下跑 `tsc --noEmit`，秒过，改坏类型也不报错。

**原因：** `apps/desktop-client/tsconfig.json` 是 `{"files": [], "references": [tsconfig.node.json, tsconfig.web.json]}`。没有 `files`、没有 `include`，`tsc --noEmit` 直接对这份工程做什么都检查不到。该包的 `typecheck` 脚本显式跑两遍：`tsc --noEmit -p tsconfig.node.json --composite false && tsc --noEmit -p tsconfig.web.json --composite false`。

**处理：** 用 `npm run typecheck`，或在仓库根用 `make verify`——它对七个包各跑 typecheck + 单元测试：`packages/shared`、`packages/agent-core`、`packages/agent-host`、`packages/ai-quality`、`apps/api`、`apps/desktop-client`、`workers/ai-worker`。其余包的 `typecheck` 就是普通 `tsc --noEmit`，可以直接用；涉及共享类型时把 shared、api、desktop-client、ai-worker 一起看。

### 窗口里内容被裁或伴星叠在纸上 → 最小尺寸与缩放规则 → 按缩放快捷键调

**现象：** 小窗口下操作放不下，或者感觉缩放"没生效"。

**原因：** 原生窗口最小尺寸 `1280×720`，由 `apps/desktop-client/src/shared/window-geometry.ts` 的 `HOME_WINDOW_MINIMUM_SIZE` 管理（同文件给出初始内容尺寸 `1440×810`）。房间底板的坐标空间是 `1672×941`（`scene-geometry.ts` 的 `room-1672x941`、`home-v2/home-scene-profile.ts` 的 `WORLD`），底板始终按这个世界比例等比裁切铺满，不露填充色条、不拉伸变形。缩放由主进程接管快捷键（`src/main/window-zoom.ts`）：macOS 用 ⌘、其它平台用 Ctrl，配 `+` / `-` / `0`，每档 0.25，上限 3 倍，`0` 回到 1；输入法正在合成时和 `keyUp` 都会被忽略，所以中文输入过程中按组合键不会误缩放。

**处理：** 验收口径是 `1440×810` 与 125% / 150% / 200% 缩放（200% 时得到 `720×405` 的有效 CSS 视口）。首页在有效 CSS 视口宽度不高于 `720px` 或高度不高于 `480px` 时切到紧凑语义房间，全部操作仍可完成。动效档位是 `full` / `lite` / `off`，在设置中心选；系统 `prefers-reduced-motion` 始终优先，命中时动画直接落到终态。

## 数据存在哪

### 重启后数据还在吗 → 数据库卷是 external，不随 compose 生命周期走 → 只有带确认值的命令会删它

**现象：** 担心 `make down` 或 `docker compose down -v` 把练习记录清掉；或者反过来，想彻底清空却删不掉。

**原因：** 开发库使用固定卷 `ailearn-dev_dev_postgres_data`，在 compose 里声明为 `external: true`，由 `make up`（`ensure-db-volume`）在首次启动时创建并打上保护标签。`make down`、删容器、`docker compose down -v` 都不会动它。唯一删除路径是带确认值的 reset：

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB
```

`CONFIRM_RESET_DB` 不等于 `DELETE_DEV_DB` 时，命令打印取消提示并以退出码 2 结束，什么都不改。卷不存在时也会明确说已经不在。MinIO 的数据在另一个卷 `dev_minio_data`，桶名由 `S3_BUCKET` 决定（开发缺省 `ailearn-workspaces`）。

**位置一览：**

| 东西 | 在哪 | 说明 |
| --- | --- | --- |
| 业务数据 | Docker 卷 `ailearn-dev_dev_postgres_data` | external，需先备份再 reset |
| 上传的图片与附件 | 卷 `dev_minio_data`，桶 `ailearn-workspaces` | `make storage` 起 MinIO 与 `minio-init` |
| 本机语音识别模型 | `<userData>/voice-models/`（`AILEARN_VOICE_ASR_DIR` 可改） | 约 228 MB，**不进安装包**，由用户在设置里自行下载 |
| 桌面会话凭据 | 主进程用 Electron `safeStorage` 加密落盘 | macOS 钥匙串 / Windows DPAPI / Linux libsecret；平台没有加密后端时 fail-closed，不写盘，登录只在本轮会话有效 |

## 测试跑不动

### 测试一片绿但集成没跑 → `*.integration.ts` 不在 `npm test` 的匹配里 → 用 postgres 专用目标

**现象：** `npm test` 全过，改坏数据库契约却没有红色。

**原因：** `apps/api` 与 `workers/ai-worker` 的 `test` 脚本按 `*.test.ts` 收集用例，集成测试文件是 `*.integration.ts`，**根本不在里面**。它们各自挂在 `test:*:postgres` 这一组脚本上。桌面端则是 `vitest run --passWithNoTests`。

**处理：**

```bash
make test-postgres          # 遍历 apps/api 与 workers/ai-worker 的 test:*:postgres
make disposable-db DISPOSABLE_DB=ailearn_scratch
```

`test-postgres` 需要一套真实但可丢弃的 Postgres：`make disposable-db` 会在全新库上跑完全部迁移并重新授权，用完即弃——因为 `rls-policies`、`queue`、投影分页这类用例断言"库里只有我的夹具"，在共享开发库上会因历史残留行**假失败**，反过来它们又会写删数据。前置条件是开发 compose 的 postgres 容器在跑。该脚本只接受匹配 `ailearn_*` 且不等于 `ailearn` / `postgres` 的库名，避免误删开发库。

还有一类坑：这些用例除了 `DATABASE_URL_*` 还各读一个专用变量（`RLS_TEST_*`、`QUEUE_TEST_*`、`RATE_LIMIT_TEST_DATABASE_URL`、`CONTENT_HASH_TEST_DATABASE_URL`、`SEC02_TEST_DATABASE_URL`、`NOTE_VERSION_RESTORE_TEST_DATABASE_URL`）。少给一个是**显式抛错**而不是静默跳过，表现为"整份文件红在读环境变量上，一条用例都没跑"。`make test-postgres` 已经把这些都注入；手工单跑时要自己带全，脚本结束时会打印可复制的变量赋值。

## 还没解决的已知限制

以下不是"你没配好"，而是当前代码与文档如实记录的状态。出处以文件为准。

- **桌面客户端 0.1.0 尚未发布**，服务端栈记 0.5.0；两条版本线不同步（`release/version.json`、`release/desktop-version.json`）。
- **仓库根没有 `LICENSE` 文件**，许可尚未落地声明；第三方组件与素材许可见 [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md)。
- **2026-10-06 起 CI 不再构建与扫描生产镜像**，生产镜像与真实 HTTPS 部署链路只在本地手动验证过。
- **方案 43（伴星带路与空间到达）与方案 44（上下文治理与压缩）未实现、未通过窗口验收**；方案 44 的 §8 验收尚无一条真实模型、实库或窗口证据，迁移 0382–0389 从未在实库上跑过。方案 42 已按 2026-10-05 本轮验收，但 §14.6 记录：没有严格同负载的 p95 或长期试用效果证明，未知 stream 用量不当作零，长期效果不能由闭环通过推导。详见[方案索引](../../plans/learning-companion/README.md)。
- **旧"插入排序的稳定性"测试卡仍在详情里提前摊出答案**，且详情没有可用的可恢复删除/归档入口；本轮没有绕过产品直接改写已发布记录（[全流程测试 2026-10-05](../../testing/full-qa-2026-10-05-final.md)）。
- **macOS 自动更新在有 Developer ID 签名时的真实替换安装仍未验证**（本机造不出签名包），Windows NSIS 路线同理。
- **人工听音未做，跨天 / 并发 / 生产环境性能未验证**；已有的只是本地内存快照，不能替代压测。
- **`test:users-rls:postgres` 在同一次复测中有 3 项失败**，全部归为环境/基线问题（`RLS_TEST_MIGRATOR_DATABASE_URL` 未注入 2 项、`schema-isolation-gate` 建表基线 1 项），与当时改动无关，但仍未在干净基线上闭环。
- **当前学习房间素材仍标记 `reviewOnly / IN_REVIEW`**，授权与发布验收完成前不能作为生产素材使用。
- **没有自助找回密码**：缺少邮件通道与重置令牌，只有 Owner 代初始化的管理端接口；忘记密码只能请工作区 Owner 处理。

## 相关分册

- [手册首页](../README.md)
- [总览](./overview.md)
- [架构](./architecture.md)
- [开发环境与运行](./development.md)
- [桌面客户端](./desktop-client.md)
- [API 与数据](./api-and-data.md)
- [AI 与伴星](./ai-and-companion.md)
- [测试与质量](./testing-and-quality.md)
- [运维](./operations.md)
