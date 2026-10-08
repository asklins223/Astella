# 拾星笔记 API 与数据

中文 · [English](../en/api-and-data.md)

本页说明 Fastify API 的启动与停机、模块路由、鉴权与多租户、迁移和数据库角色、作业投递、SSE、对象传输与运维面板。实现入口在 `apps/api/src/`，共享契约在 `packages/shared/src/`，数据库权限在 `infra/postgres/`；具体端点字段以契约和路由为准。

- [运行形态与启动顺序](#运行形态与启动顺序)
- [路由与模块清单](#路由与模块清单)
- [鉴权与安全契约](#鉴权与安全契约)
- [多租户与行级安全](#多租户与行级安全)
- [数据库、schema 与迁移](#数据库schema-与迁移)
- [三个数据库角色](#三个数据库角色)
- [伴星笔记写入与对象传输](#伴星笔记写入与对象传输)
- [作业投递与 outbox 不变量](#作业投递与-outbox-不变量)
- [SSE 与流式响应](#sse-与流式响应)
- [配置项](#配置项)
- [观测](#观测)
- [运维管理面板](#运维管理面板)
- [请求体上限](#请求体上限)
- [API 侧的测试入口](#api-侧的测试入口)
- [相关分册](#相关分册)

## 运行形态与启动顺序

入口是 `apps/api/src/server.ts`：一个 Fastify 实例、**没有全局路径前缀**，各领域路由束平级 `register`（其中 `card-generation-v2` 只在 `CARD_GENERATION_V2_ENABLED=true` 时才注册）。监听地址由 `resolveApiBindHost()`（`apps/api/src/modules/desktop-trust/routes.ts`）决定——默认 `127.0.0.1`，只有 `ASTELLA_CONTAINER_MODE` 与 `ASTELLA_ALLOW_CONTAINER_WILDCARD` 同时为 `true` 才允许 `0.0.0.0`，否则启动即抛错；端口取 `PORT`，默认 `4000`。

插件层与钩子层：

| 层 | 内容 |
| --- | --- |
| 插件 | `@fastify/cors`（`CORS_ORIGIN` 逗号分隔白名单；白名单为空时 `origin: false`，即完全不发 CORS 头）、`@fastify/sensible`（`httpErrors` 与统一错误序列化）、`@fastify/compress`（`global: true`）、`@fastify/multipart`（单文件 10MB、每次 1 个文件、3 个非文件字段、字段值 1KB） |
| `onRequest` | 把 `request.id`（`genReqId` 用 `crypto.randomUUID()`）放进 AsyncLocalStorage（`lib/request-context.ts`），保证建 job 时能写进 `payload.traceId`，worker 日志因此可跨进程关联 |
| `onSend` | 全局安全头 `X-Content-Type-Options` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`；已 `hijack()` 的响应不经过这里 |
| `onResponse` | HTTP 计数与延迟直方图（route 用规范化模板，避免高基数与参数泄漏）、5xx 计数、401/403/429 统一记一条 `security event` 警告日志（放在这里而不是 error handler，因为限流与拒绝路径不走 error handler） |
| `setErrorHandler` | ≥500 一律返回 `{error:"internal_error"}` 占位文案，细节只进日志；Postgres `42501` 计入 `astella_db_rls_denied_total`；4xx 仅透传"短 code + ≤300 字 message"的受控错误形状，其余给占位文案 |
| `setNotFoundHandler` | 固定 `{error:"not_found", message:"资源不存在"}`——Fastify 默认文案会把路由模板（`Route /v2/notes/:id not found`）回显出去 |
| 进程级 | `unhandledRejection` 记日志后 `process.kill(SIGTERM)` 走同一条关停路径 |

启动顺序是刻意排的：`setLearningRunProcessingWaker(...)` 与优雅关停协调器、`SIGTERM`/`SIGINT` 处理**都装在 `app.listen()` 之前**（P0-9：原先装在之后，冷启动窗口里的唤醒是静默 no-op，用户要等最多 10 秒轮询；那段时间 SIGTERM 也走 Node 默认行为）。DB gauge、时序采样、session 清理、软删笔记物理清除、TTL 维护、轮次空闲扫描这**几发启动维护留在 `listen` 之后**——它们都会打库，挡在 listen 前面等于"库慢 → 容器一直 not ready → 被编排器杀掉"。

关停走 `createGracefulShutdown()`（`apps/api/src/server/graceful-shutdown.ts`）：清全部定时器 → `closeNoteCollaboration()` 再 `app.close()`（顺序不能反，Hocuspocus 的 `onStoreDocument` 是 debounce 的，先关服务器会丢掉窗口里最后一段编辑；`closeNoteCollaboration` 先刷 pending 快照、断连接，再等文档计数归零，5 秒封顶，没归零就打错误日志）→ `drainInFlight()` 等在途 tick 收尾（上限 `drainTimeoutMs` 15 秒）→ 关 NOTIFY listener 与私有解池 → 关 DB 池。三段各自收集错误、每段都有界，绝不把关停挂死。两份 compose 都给 `api` 服务 `stop_grace_period: 20s`，因为这个预算（10s closeServer + 5s 连接池 `end`）大于 Docker 默认的 10s。

## 路由与模块清单

路径都写在处理函数里，形态是 `/notes`、`/v2/notes/:id`、`/companion/memory/:id/pin` 这样的扁平集合；版本号（`v2`、`v3`）出现在资源名上，不是全局前缀。

| 域 | 模块目录（`apps/api/src/modules/`） | 路径前缀 | 说明 |
| --- | --- | --- | --- |
| 身份与工作区 | `identity` | `/auth/*`、`/workspaces*`、`/me/*`、`/invites*`、`/members*`、`/onboarding/*`、`/v1/auth/capabilities`、`/workspace/ai-audit-log` | 登录登出、会话、空间增删与转移、成员与邀请、引导状态、AI 同意与外发政策 |
| 桌面信任握手 | `desktop-trust` | `/_astella/desktop/trust/v1/challenge` | 未认证 origin 换签名凭据，用 `ASTELLA_DESKTOP_PAIRING_*` |
| 笔记 | `note` | `/notes*`、`/v2/notes/:id*`、`/note-doc`（WebSocket） | 列表与投影、文档状态读取、增量上送、版本与回收站、协同通道 |
| 笔记周边 | `note-annotations` / `note-overviews` / `note-recalls` / `note-expansions` / `note-learning-artifacts` / `note-learning-rounds` | `/v2/notes/:noteId/{annotation,overview,expansion,learning-artifact}-tasks`、`/v2/notes/:noteId/{recalls,expansions,learning-round*}`、`/v2/note-learning-rounds*` | 页首四张书签各自的任务与产物读写（速看 / 回想 / 往外学 / 学习记录），加上选句的写批注与原句解读；结果都回到笔记版本上 |
| 来源 | `source` | `/sources*` | 采集、重解析、编辑、恢复、由来源起笔记 |
| 制卡 V2 | `card-generation-v2` | `/v2/card-generation-runs*`、`/v2/cards*`、`/v2/initial-validation-reminders*` | 整个 bundle 只在 `CARD_GENERATION_V2_ENABLED=true` 时注册 |
| 复习 | `review` | `/v2/reviews/*` | 到期队列、延迟、目标暂停、原文揭示、一次性提醒、订阅 |
| 学习运行与目标 | `learning-runs`、`learning-objectives`、`learning-dashboard` | `/learning-runs*`、`/v2/learning-runs/:runId/*`、`/learning/assessments/:assessmentId/disputes*`、`/v2/learning-objectives*`、`/v2/learning-dashboard`、`/v2/home/*` | 运行需要 `LEARNING_RUN_ENABLED=true`，否则全部 404；争议与更正单独一条注册链 |
| 理解与深读 | `note-deepening`、`understanding` | `/v3/understanding/*`、`/understanding/projection*`、`/understanding/routes/plan` | 拓扑快照、深读、关系判定、投影与增量 |
| 伴星家族 | `companion-shell`、`companion-conversation`（含 `memory/`、`delivery/`、`discovery/`、`turn/`）、`companion-bridge`、`companion-journey` | `/me/companion*`、`/public/auth-surface-manifest`、`/companion/*`（对话、消息、thoughts、proposals、memory、deliveries、inbox、daily、journeys、pet-profile、room-profile、home-projection、history、runs 诊断、export） | 对话与记忆各按能力开关 fail closed（`COMPANION_DIALOGUE_V1_ENABLED`、`COMPANION_JOURNEY_V2`、`COMPANION_MEMORY_VECTOR_V1`、`COMPANION_PET_PROFILE_V1`、`COMPANION_BRIDGE_V2` 等） |
| Agent | `agent` | `/agent/runs*`、`/agent/long-goals`、`/agent/methods*`、`/agent/method-uses/:useId/feedback` | 运行与方法库的读写；这一层今天哪些真跑着、哪些只有后端，见 [统一 Agent 运行时（技术）](./agent-runtime.md) 的"已接通 vs 只有后端"，验收缺口另记在[方案索引](../../plans/learning-companion/README.md) |
| 语音 | `learning-sessions` | `/voice/tts`、`/voice/tts/stream`、`/voice/transcribe`、`/voice/preference`、`/voice/guidance-profile`、`/voice/tts/playback-outcome` | TTS/ASR；未开语音能力时 404 |
| 作业与检索 | `job`、`search`、`import`、`export`、`upload` | `/jobs*`、`/search*`、`/import/markdown`、`/export/*`、`/uploads/*` | job 只读投影（payload 与 `last_error` 脱敏）；上传三个端点 + 下载 |
| 统计与观测 | `stats`、`activity`、`observability`、`audit` | `/stats/overview*`、`/activity/today`、`/metrics/learning-events`、`/workspace/audit-log` | 业务读数；`/metrics/learning-events` 与 Prometheus 的 `/metrics` 是两条路由 |
| 运维面板 | `admin` | `ADMIN_PANEL_PATH`（默认 `/admin`）下的静态壳与 `<base>/api/*` | 见下一节 |

最常打的那几条（完整拼写，供 curl 与排障用）：

| 用途 | 方法与路径 |
| --- | --- |
| 登录 / 登出 / 当前身份 | `POST /auth/login`、`POST /auth/logout`、`GET /auth/me`、`GET /v1/auth/capabilities` |
| 笔记列表 / 详情 / 文档状态 / 增量 | `GET /notes`、`GET /v2/notes/:id`、`GET /v2/notes/:id/doc-state`、`POST /v2/notes/:id/doc-update` |
| 来源 | `GET /sources`、`POST /sources`、`GET /sources/:id`、`POST /sources/:id/reparse` |
| 作业 | `GET /jobs`、`GET /jobs/:id` |
| 探针 | `GET /health`、`GET /ready`、`GET /metrics` |
| 事件流 | `GET /learning-runs/:runId/events`、`GET /v2/card-generation-runs/:runId/events/stream`、`GET /companion/deliveries/inbox/stream`、`GET /companion/conversations/:id/events` |

## 鉴权与安全契约

- 凭据是**双通道**：`Authorization: Bearer <token>` 优先，其次 `astella_session` HttpOnly Cookie（`modules/identity/session-auth.ts`）。桌面端走 Bearer，浏览器场景走 Cookie。
- 登录成功同时下发 `astella_session`（HttpOnly）与 `astella_csrf`（可读），属性为 `Path=/; SameSite=Lax`，`remember=true` 时带 `Max-Age`；`Secure` 由 `AUTH_COOKIE_SECURE=true` 或 `NODE_ENV=production` 决定（显式 `false` 可以关掉）。
- Cookie 客户端的**写操作**做 double-submit CSRF：`x-csrf-token` 头必须与 `astella_csrf` 常量时间相等；`GET/HEAD/OPTIONS` 豁免；Bearer 请求不校验（浏览器不会自动带 Authorization）。`POST /auth/logout` 也不校验——低风险且 `SameSite=Lax` 已挡住跨站表单。
- 登录限流默认 15 分钟窗口 / 5 次（`AUTH_RATE_LIMIT_WINDOW_MS`、`AUTH_RATE_LIMIT_MAX_ATTEMPTS`），**两个桶**：`auth:login:ip:<req.ip>` 与 `auth:login:email:<email>`；超限回 429 带 `Retry-After`。登录成功只重置 email 桶——重置 IP 桶会让一次有效登录清空整机的失败计数，支持跨账户分布式爆破。
- 限流存储由 `AUTH_RATE_LIMIT_STORE` 选择：默认 `postgres`（表 `auth_rate_limits`，跨副本一致），`memory` 只在显式设置时生效；写别的值直接抛错。开发栈显式设成 `memory` 并把上界放宽到 100，属 dev-only。
- 口令用 `bcryptjs`，cost 10；查不到邮箱的登录也走一次 `DUMMY_PASSWORD_HASH` 比对，让响应时间不区分"账号存在吗"。哈希在主线程算，但都在开事务之前，避免占着连接池。
- 会话令牌落库前做 SHA-256（`sessions.token` 存十六进制摘要），库泄了也不是一条可用凭据；解码走 `withActorTransaction`，成员行缺失或 `left_at` 非空当场删会话。滑动续期由 `nextSessionExpiry()` 决定：TTL 30 天、剩余不足一半才续、绝对上限 180 天。过期清理在启动时与每小时各跑一次（`cleanupExpiredSessions()`）。
- 口令长度按流程不同：登录 `min 4`（只做形状校验，不是强度要求）、注册 `min 8`、改密新密码 `min 8`、Owner 为恢复用户初始化未设置的密码 `min 12`，上界统一 200。
- 归属判定只有一个谓词：`isWorkspaceOwner()`（`membershipRole === "owner"` 或 `workspaceOwnerId === userId`），`requireOwner`、`/v1/auth/capabilities` 与笔记投影共用它，避免"服务端允许写、界面判只读"。

## 多租户与行级安全

`db/client.ts` 提供三条事务入口，共同点是**下发 `app.*` 事务局部变量并读回校验**：`set_config('app.workspace_id'|'app.user_id'|'app.session_token', …, true)` 之后比对返回值，不一致就抛 `workspace_transaction_context_error`，绝不带着没生效的上下文继续查。

- `withWorkspaceTransaction({workspaceId, userId}, fn)`：已经在某个空间里的业务请求。同上下文嵌套复用活动事务；换租户、换隔离级别都先报错再执行；`allowNullUserId: false`——API 的业务工作必须有已认证 actor。
- `withActorTransaction({userId, workspaceId?, sessionToken?}, fn)`：登录、令牌解析、空间列表、兑换邀请码这些"还不知道是哪个空间"的边界动作。`app.workspace_id` 允许留空（那是"还没选空间"这个状态本身，不能拿 nil UUID 顶替）；嵌套时换 actor 或换令牌一律拒绝，唯一例外是占位 actor（`SYSTEM_USER_ID`）被 `assumeActor` / `commitAssumedActor` 换成令牌真正的主人。
- `adoptWorkspaceContext(tx, workspaceId)`：建空间那条路径在中途把租户抬到新空间，不改 actor。
- 兜底在数据库里：策略是 RESTRICTIVE 的租户守卫，`app.*` 没生效时读到的是 **0 行**而不是别人的行，所以求值顺序万一不成立，后果是响亮的 401 / 空结果，不是静默跨租户泄漏。
- Postgres 错误码 `42501`（RLS 拒绝）由全局 error handler 计入 `astella_db_rls_denied_total`——误拦因此可见。
- 棘轮在集成测试里：`apps/api/src/integration-tests/schema-isolation-gate-postgres.integration.ts` 对真实库比对两份基线，要求**完全相等**。当前基线：缺 `workspaces` 外键的表按测试基线登记（更新时只能收紧，新增缺口会失败），RLS 未启用的表 **0 张**（零容忍，任何新表忘 ENABLE 或有人再写批量 DISABLE 都立刻红），另有"启用了 RLS 但一条策略都没有"必须为 0 的检查。

## 数据库、schema 与迁移

| 项 | 事实 |
| --- | --- |
| 单一来源 | `apps/api/drizzle.config.ts` 的 `schema` 指向 `packages/shared/src/db-schema/index.ts`，`out` 是 `apps/api/src/db/migrations`。仓库里没有 `packages/db`，也没有应用侧副本或兼容垫片 |
| 守卫现状 | `.github/scripts/verify-schema-mirror.mjs`（由 `make verify` 调用）只做一件事：确认那个目录存在且含 `.ts` 文件，为空即抛错，并打印文件数。**它不比对两份 schema**——因为只有一份 |
| 迁移顺序 | 以 `apps/api/src/db/migrations/meta/_journal.json` 为准；新增迁移必须登记 journal 并补角色授权，不在手册维护固定总数 |
| 执行器 | `src/db/migrate.ts` 是自己实现的，不用 `drizzle-orm/migrator`（该包 exports map 把 `types` 排在 `default` 前，tsx 下会解析到 `.d.ts` 而模块为空） |
| 幂等判据 | 逐条比对 `sha256(SQL 文件内容)` 是否已在 `drizzle.__drizzle_migrations.hash`；**不看最新时间戳**——混进一条更大的时间戳会让后续迁移被静默跳过 |
| 事务粒度 | 每条迁移独立事务（不再整批一个）：锁窗口更小、失败可恢复，代价是不再整体原子，所以"建结构 + 回填"要写成幂等可重入 |
| 免事务指令 | 文件**前 20 行**出现 `-- migrate:no-transaction` 时逐条直发（给 `CREATE INDEX CONCURRENTLY` 这类不能进事务块语句用）；走这条路的迁移必须自己幂等，且 `__drizzle_migrations` 的插入放在全部语句成功之后 |
| 目录覆盖 | `MIGRATIONS_FOLDER` 可指向截断过的 journal（CI 用它先造"已部署基线"再验证前向迁移）；不随 `NODE_ENV` 推断 |
| 执行者 | 两份 compose 现在同一条链路，三个一次性服务：`role-bootstrap`（建角色）→ `migrate`（用 `DATABASE_URL_MIGRATOR` 跑 `npm run db:migrate`）→ `role-grants`（再跑一遍 `infra/postgres/apply-roles.sh`，带 `REQUIRE_RLS_DISABLED=true`）。`api` 与 `worker`（生产还有 `seed-owner`）`depends_on: role-grants` 成功退出。开发栈以前只有 `role-bootstrap` → `migrate`，`api` 直接依赖 `migrate`——全新卷上第一次启动因此拿不到迁移后对象的授权，2026-10-06 补成同一条链 |
| 扩展 | `uuid-ossp`（加密安全 UUID）、`pg_trgm`（证据对齐聚文相似度）、`vector`（pgvector 向量检索）必须**先于迁移**存在：新库由 `infra/postgres/init.sql` 建，既有 volume 由 `infra/postgres/roles.sql` 建。0052 起十余条迁移写 `CREATE EXTENSION IF NOT EXISTS vector`，但迁移跑在 `astella_migrator` 上而建扩展是超级用户权限，缺了就 `permission denied to create extension "vector"`；镜像因此必须是 `pgvector/pgvector:pg16` |

## 三个数据库角色

`infra/postgres/roles.sql` 是权限主源，可重复执行；它先 `REVOKE ALL` 再逐表授权，最后用 `DO` 块断言权限矩阵，不匹配就 `RAISE EXCEPTION`。

| 角色 | 属性 | 权限 |
| --- | --- | --- |
| `astella_migrator` | `LOGIN NOSUPERUSER NOINHERIT BYPASSRLS` | 数据库级 `CONNECT, CREATE`；`public` 与 `drizzle` schema 的 DDL 与 `ALL`；journal 表属它 |
| `astella_api` | `NOBYPASSRLS`，`public` 无 `CREATE` | 全部业务表 `SELECT/INSERT/UPDATE/DELETE`（无 DDL、无 `TRUNCATE/REFERENCES/TRIGGER`）；`drizzle` schema 只 `USAGE` + journal 只读（`/ready` 要查）；对 append-only 与私有 worker 状态逐表收紧 |
| `astella_worker` | `NOBYPASSRLS`，`public` 无 `CREATE`、无 `drizzle` USAGE | 一份显式读集 + 受控函数（`astella_claim_jobs`、`astella_renew_job_lease`、`astella_finish_job`、`astella_reap_stale_jobs`…）的 `EXECUTE` |

> **说明：** 迁移里写的逐表 `GRANT` 会被 `roles.sql` 那次 `REVOKE ALL` 抹掉——它是在迁移**之后**跑的。所以每条给 `astella_worker` 的新授权必须在 `roles.sql` 里再写一遍，漏掉的后果不是报错而是静默失效：0385 的 `agent_context_compaction_state` 就这么让 worker `permission denied`，整条压缩冷却链在真库上什么都没做；更早的 `assistant_thoughts`、`user_ai_settings` 同理（后者缺 `SELECT` 时所有 companion job 直接 dead）。

`REQUIRE_RLS_DISABLED=true` 那条检查现在的语义是"启用了 RLS 的表必须都有策略"：数量为 0 才放行，`role-grants` 因此会在策略没跟上时直接失败，而不是让应用带着裸隔离启动。

## 伴星笔记写入与对象传输

`companion_create_note` 在 Worker 中调用 `packages/agent-host/src/note-creation.ts`，通过受控数据库函数保存私有新笔记、初始版本与真实链接。保存时复核空间写权限、当前请求和关联笔记的可见性／版本，不能由全局 Agent 权限绕过 Member 的只读限制。

`companion_edit_note` 的授权工具由 API `modules/note/companion-edit-dispatch.ts` 领取，`companion-edit-document.ts` 核对冻结原文与版本，再修改现有 Hocuspocus Y.Doc。写入沿既有保存、正文投影与搜索链路提交；Worker 读取实际保存回执。工具身份用于幂等，取消或原文变化时停止替换。它不是另一条裸 SQL 覆盖正文的接口。

对象传输在 `modules/storage/`。远程客户端先请求 `/storage/transfers/config` 与限时签名上传地址，完成后由 API 校验并转存到最终对象；下载／导出先校验会话与可见性，再发短期签名 GET。主进程直传请求不携带 API token／Cookie。本机 local_loopback 继续使用原 API 上传路径；模式与集测见 [部署说明](deployment.md)。

## 作业投递与 outbox 不变量

`modules/job/service.ts` 的 `createJob()` 是 API 通用入队口；Agent 宿主还有声明式能力与推进的入队端口，均须保持同一配额和幂等合同。该函数**只往 `jobs` 表插行**，不认领、不执行（认领函数的 `EXECUTE` 只给 worker，矩阵断言会拦住 API 拿到它）。同一条事务里先取 `pg_advisory_xact_lock(hashtextextended('job-quota:<workspaceId>', 0))`，再做：

- **配额**：该空间 `pending` 作业数 ≥ `MAX_PENDING_JOBS_PER_WORKSPACE`（`@astella/shared`，值 50）时抛 `statusCode = 429`。锁保证了并发请求不能在 49 条时双双通过检查。
- **幂等键**：命中同 key 直接返回既有 job；key 已绑到别的 type 或别的 `requestedBy` 视为调用错误。
- **去重**：按 `payload->><指定字段>`（`noteVersionId` / `submissionId` / `runId` / `proposalId`）在 `pending` + `running` 里探一次；字段名是调用方按作业语义显式选的，因为伴星续跑作业同时带 `runId` 和 `proposalId`，按 `runId` 去重会把续跑丢掉。
- **调度**：`priority` 与 `resource_class` 由 type 映射（`companion_agent` 100 / `interactive_ai`，`note_annotation_explain` 85，`parse_source` 70，伴星后台类 10 / `maintenance`，默认 40）。
- payload 里带上会话 actor（worker 需要用户作用域时读它）与 `traceId`；`GET /jobs` 与 `GET /jobs/:id` 不回 payload，`last_error` 也只回 `"error occurred"` + 脱敏后的 `failureReason`。

worker 侧每轮 `SELECT * FROM public.astella_claim_jobs(p_limit, p_background_limit, p_max_attempts)`（`workers/ai-worker/src/queue.ts`）：`FOR UPDATE SKIP LOCKED` 认领、统一打租约、返回 `lease_token`；之后的续租与回写都按 `lease_token` 做 CAS，租约过期被别的实例重领后，本实例的置位自然失效。`p_background_limit` 让后台车道拿不到最后一个空槽，交互作业一入队就有槽。

运行中每 30 秒续租，迁移 0394 的 `lease_renewed_at` 用于失联判断；执行时长由独立 handler／provider 预算控制，120 秒租约不再是总时长上限。

投递给下游的是 outbox 表，事务内插入、至少一次投递、按键幂等：

| 表 | 用途 |
| --- | --- |
| `learning_run_processing_outbox` | Assessment / Commit 的唯一驱动；scope key 唯一索引，命令处理前检查当前行状态，重复 tick 不重复写结果 |
| `canonical_learning_event_outbox`、`practice_trail_event_outbox` | commit 阶段发布的规范事件与练习轨迹，分别按 `commitId`、`(runId, scope)` 唯一 |
| `card_generation_run_outbox_v2` | 制卡运行的域事件 |
| `learning_outbox_events`、`learning_session_processing_outbox` | 学习事件与会话（语音）侧的驱动队列 |

`learning_run_processing_outbox` **由 API 进程自己消费**（`server.ts` + `modules/learning-runs/processing/run-processing-tick.ts`）：每轮 `astella_claim_run_processing(workerId, 120_000, batchSize, now)` 按批量认领（批内并发默认 4，上界 16，`RUN_PROCESSING_CONCURRENCY` 可改），租约 120 秒、批内用 `Promise.allSettled` 做失败隔离，一次 tick 最多 50 条命令；节奏是 10 秒一跳，失败按 `10s × 2^streak` 指数退避封顶 60 秒，成功即复位；提交产出物后调 `wakeLearningRunProcessing()` 让下一轮立刻跑，10 秒轮询退化为兜底。

## SSE 与流式响应

三条长连事件流共用 `lib/sse-connection-limiter.ts`：每主体默认 5 条、每进程默认 200 条（`SSE_MAX_STREAMS_PER_USER` / `SSE_MAX_STREAMS_TOTAL`），主体键是 `userId:workspaceId`，命名空间分别是 `run-events`、`card-gen-events`、`inbox`。**判定发生在 `reply.hijack()` 之前**——一旦 hijack 就只能往流里写，那会把一个明确的拒绝变成一条语义不明的流；超限回 429 `too_many_connections`，并计入 `astella_sse_rejected_total`。计数是单进程内存态，多副本部署时真实总上限是副本数 × 本上限。

hijack 之后的响应**不经过 `onSend`**，所以全局安全头不适用，各路由在 `writeHead` 里自带 `Content-Type: text/event-stream`、`Cache-Control: no-store`、`Connection: keep-alive`、`X-Accel-Buffering: no`；写用 `safeSseWrite()`，慢客户端攒超过阈值就跳过而不是堆内存；关闭路径必须调 `release()`（幂等，重复调安全）。

| 端点 | 形态 |
| --- | --- |
| `GET /learning-runs/:runId/events`、`GET /v2/card-generation-runs/:runId/events/stream`、`GET /companion/deliveries/inbox/stream` | SSE，走公共限流器；支持 `Last-Event-ID`（缺失时用 `after` / `lastEventId` query） |
| `GET /companion/conversations/:id/events` | SSE，用自己的桶：每对话 ≤3、每账号 ≤10，超限 429；cursor 非法 400、过期 409，都在写响应头之前判完 |
| `GET /me/companion/events` | 账号级 SSE，自己的桶：每账号 ≤6，超限 429、cursor 非法 400 |
| `GET /companion/export` | NDJSON 流式导出，首行写出前仍可回错误 JSON |
| `POST /voice/tts/stream` | 音频字节流（非 SSE） |
| `<base>/api/logs/stream` | 面板日志实时尾随，用 `fetch` 流消费以便保住 Bearer 令牌 |

## 配置项

变量名与用途；取值看 [`.env.example`](../../../.env.example) 与两份 compose，本页不复述任何密钥。

| 组 | 变量 | 默认与要点 |
| --- | --- | --- |
| 数据库连接 | `DATABASE_URL_MIGRATOR`、`DATABASE_URL_API`、`DATABASE_URL_WORKER`、`DATABASE_URL` | 三条角色各一条；生产缺 `DATABASE_URL_API` / `DATABASE_URL_MIGRATOR` 直接抛错，`DATABASE_URL` 只是开发/测试兼容路径 |
| 池与超时 | `API_STATEMENT_TIMEOUT_MS`(60s)、`API_LOCK_TIMEOUT_MS`(5s)、`API_IDLE_IN_TRANSACTION_TIMEOUT_MS`(15s)、`API_POOL_IDLE_TIMEOUT_SECONDS`(30s)、`DB_GAUGE_INTERVAL_MS`(5s) | 池上限 25 是代码常量，不受 env 控制（面板里的 `DB_POOL_MAX` / `API_DB_POOL_MAX` 只是展示口径）；`application_name = 'astella_api'` 让池饱和度能按进程切开 |
| HTTP 与边界 | `PORT`(4000)、`API_BIND_ADDRESS`(`127.0.0.1`)、`ASTELLA_CONTAINER_MODE`、`ASTELLA_ALLOW_CONTAINER_WILDCARD`、`CORS_ORIGIN`、`TRUST_PROXY`(false)、`AUTH_SURFACE_MANIFEST_SECRET` | `CORS_ORIGIN` 为空即不发 CORS 头；`TRUST_PROXY` 支持 `true`/`false`/跳数/逗号列表；关掉它而有前置代理时，`req.ip` 全是代理地址——登录的 IP 桶退化成"整机共享 5 次"、面板的按来源退避认错人、安全日志里的来源地址也只有一个值 |
| 鉴权与限流 | `AUTH_RATE_LIMIT_STORE`、`AUTH_RATE_LIMIT_WINDOW_MS`(15min)、`AUTH_RATE_LIMIT_MAX_ATTEMPTS`(5)、`AUTH_COOKIE_SECURE`、`NODE_ENV` | store 默认 `postgres`；`Secure` 由 `AUTH_COOKIE_SECURE` 或 `NODE_ENV=production` 决定 |
| 能力开关（API 侧读取的 13 个） | `LEARNING_RUN_ENABLED`、`CARD_GENERATION_V2_ENABLED`、`COMPANION_DIALOGUE_V1_ENABLED`、`COMPANION_VOICE_DIALOGUE_V1_ENABLED`、`COMPANION_STREAMING_VOICE_V1_ENABLED`、`COMPANION_JOURNEY_V2`、`COMPANION_BRIDGE_V2`、`COMPANION_MEMORY_VECTOR_V1`、`COMPANION_MEMORY_STAR_MAP_V1`、`COMPANION_PET_PROFILE_V1`、`COMPANION_PROACTIVE_PERSONALIZED_V1`、`COMPANION_SUMMARIZER_V1`、`COMPANION_DAILY_SUMMARY_V1` | 一律严格 `=== "true"`，**fail closed**：未设即关，端点 404 或整组不注册。多数判据集中在 `config/learning-companion-flags.ts`，少数在各自路由里读（星图、日报、桥接、主动投递）。`make verify` 的 `.github/scripts/verify-companion-capability-config.mjs` 双向钉住"每个服务只声明它实际读取的开关"及默认值：伴星基础能力 dev/prod 都默认开，`LEARNING_RUN_ENABLED` / `CARD_GENERATION_V2_ENABLED` / 语音只有 dev 默认开、prod 关。worker 侧的同族开关见 [模型与 Worker 链路](./ai-and-companion.md) |
| SSE 与处理并发 | `SSE_MAX_STREAMS_PER_USER`(5)、`SSE_MAX_STREAMS_TOTAL`(200)、`RUN_PROCESSING_CONCURRENCY`(4，上界 16) | 计数单进程内存态 |
| 对象存储 | `STORAGE_MODE`、`STORAGE_ENDPOINT`、`STORAGE_PUBLIC_ENDPOINT`、`STORAGE_ACCESS_KEY_ID`、`STORAGE_SECRET_ACCESS_KEY`、`S3_REGION`(`us-east-1`)、`S3_BUCKET`(`astella-workspaces`)、`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`（回退 `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`）、`STORAGE_REQUEST_TIMEOUT_MS`(120s) | local 使用 MinIO 凭据；remote 使用远程专用凭据，不回退本地配置。凭证须成套，未配置时上传回 503。判定在 `@astella/shared/storage-config`，与 worker 共用 |
| 语音 | `EDGE_TTS_BASE_URL`、`EDGE_TTS_PORT`、`EDGE_TTS_AUTH_TOKEN`、`EDGE_TTS_MAX_CONCURRENCY`、`QWEN_TTS_MAX_CONCURRENCY`、`DASHSCOPE_TTS_WORKSPACE_ID`、`SILICONFLOW_API_KEY`、`VOICE_ASR_MODEL` | 本机 edge-tts 容器 + 外部 ASR |
| 学习运行密钥 | `LEARNING_DRAFT_ENC_KEY`、`PROJECTION_CHECKPOINT_SECRET`、`ASTELLA_DESKTOP_PAIRING_KEY_ID`、`ASTELLA_DESKTOP_PAIRING_SECRET`、`ASTELLA_DOMAIN_SCHEMA_REVISION` | 草稿加密、投影检查点签名、桌面信任握手 |
| 就绪与观测 | `MIN_READY_MIGRATION_CREATED_AT`、`LOG_LEVEL`、`GIT_COMMIT`、`MIGRATION_COUNT`、`npm_package_version` | 见下一节 |
| 运维面板 | `ADMIN_PANEL_TOKEN`、`ADMIN_PANEL_PATH`(`/admin`)、`ADMIN_LOG_BUFFER_SIZE`(500，封顶 5000)、`ADMIN_DOCKER_SOCKET`、`AI_PLATFORMS_CONFIG` | 见"运维管理面板"一节 |
| 种子 | `OWNER_EMAIL`、`OWNER_PASSWORD`、`OWNER_WORKSPACE`、`SEED_DEMO_DATA` | `db:seed` 在缺 owner 邮箱或密码时 fail closed，演示数据只在 dev profile 打开 |

## 观测

| 端点 | 语义 |
| --- | --- |
| `GET /health` | 存活探针：只证明进程和事件循环能回 HTTP，不碰数据库——依赖抖动不该让编排器杀掉一个本来健康的 API |
| `GET /ready` | `SELECT 1` + 查 `information_schema.tables` 比对一组核心表名（`users`、`workspaces`、`notes`、`jobs`、`sessions`、`learning_runs`、`learning_run_private_contracts`、`learning_tasks`、`learning_task_variants`）+ 取 `drizzle.__drizzle_migrations` 的 `max(created_at)` 与 `MIN_READY_MIGRATION_CREATED_AT` 比较；任一不满足回 503 并带上缺口 |
| `GET /metrics` | Prometheus 文本，**刻意不鉴权**——边界在网络策略（只让抓取方 reachable），不在应用层加一道"抓 metrics 要令牌" |

就绪那条形如"迁移完成度"的检查其实是**时间戳下限**：它只证明已应用迁移的最大 `created_at`（journal 的 `when`）不小于门槛，不证明每一条迁移都跑过；门槛默认 `1786683800000`，需要随版本上调，忘了调就会让"只有早期核心表"的库报 ready。这条口径写在这里，是因为它很容易被误读成 schema 校验。

值得知道的 `astella_*` 指标族（完整清单在 `lib/metrics.ts`）：

| 族 | 用途 |
| --- | --- |
| `astella_http_requests_total`、`astella_http_request_duration_seconds`、`astella_http_errors_5xx_total` | 按 method / 规范化 route 模板 / status class |
| `astella_db_pool_active_connections`、`astella_db_pool_max_connections`、`astella_db_server_connections`、`astella_db_transaction_failures_total`、`astella_db_rls_denied_total`、`astella_db_migration_version` | 两者相除即池饱和度——postgres.js 不公开排队数，饱和度是"池在排队"唯一可靠信号 |
| `astella_learning_run_processing_outbox_depth`、`_oldest_pending_age_seconds`、`_tick_duration_seconds`、`astella_learning_run_processing_commands_total`、`astella_learning_run_critic_*` | API 进程自己那条 outbox 链路的深度、滞后与 Critic 调用/ fail-closed |
| `astella_sse_active_streams`、`astella_sse_rejected_total` | 按 namespace 分维度，归零时摘 label，不留一串常驻 0 |
| `astella_readiness_status`、`astella_release_info`、`astella_funnel_events_total`、`astella_surface_*`、`astella_dashboard_*`、`astella_companion_*`、`astella_maintenance_rows_purged_total` | 就绪翻转、版本与迁移数埋点、漏斗与表面性能、伴星侧信号 |

日志走 pino（`lib/logger.ts`，`LOG_LEVEL` 可调，非 TTY 输出 JSON），同时把应用日志与已完成请求投影进两条独立的**有界环**（`lib/log-buffer.ts`：默认 500 / 300 条，进程内，不落盘），供面板的 `/api/logs`、`/api/logs/requests`、`/api/logs/stream` 读。指标时序另有两条采样（`lib/metrics-series.ts`，15 秒与 30 秒）——那一组是给面板画趋势的窗口，与给 Prometheus 抓的瞬时 gauge 口径不同，所以各走各的节奏。

## 运维管理面板

| 项 | 事实 |
| --- | --- |
| 注册条件 | `ADMIN_PANEL_TOKEN` 去空白后 ≥16 字符**且不含占位片段**（`change-me`、`placeholder`、`example`、`todo` 等）才注册；否则 `adminRoutes()` 直接 return，一条路由都不注册——"存在但永远 401"的端点是持续探测目标，不注册则它在路由表里不存在 |
| 另一条身份 | 面板用的是部署级运维令牌（`x-admin-token` 或 `Bearer`），不复用 `sessions`。原因：本仓库鉴权是逐租户的，owner 是**空间内**的角色，把它接到面板上只会得到"只能看自己那一个空间"的全局后台，而"有没有 run 卡在 assessing"恰恰是跨空间问题 |
| 挂载前缀 | `ADMIN_PANEL_PATH` 可换成随机前缀（如 `/panel-6b3f9c2d`）；形状非法或未设置回落 `/admin` 并打提示日志。这是降扫描噪声，不是鉴权 |
| 边界划分 | 静态壳（`index.html` + 若干 `.js` / `.css`，逐个显式列出，没有内联脚本样式）**公开**——否则第一次打开面板的人看不到输入令牌的地方；`<base>/api/*` 全部挂 `onRequest: requireAdmin`，用子作用域把边界钉在结构上而不是按路径判断 |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`，加 `Cache-Control: no-store` |
| 视图 | 六个：概览、指标（含时序）、日志（应用 / 请求 / 实时尾随）、队列（含 job 动作与失败聚类）、基础设施、配置；`/api/audit` 与 `/api/todo` 是数据端点，呈现在概览与队列页里。对应 `<base>/api/{overview,metrics,metrics/series,logs,logs/requests,logs/stream,queues,todo,audit,infra,config}` 与 `POST <base>/api/jobs/actions`、`GET <base>/api/infra/containers/:service/{logs,stats}`、`POST …/action` |
| 配置页 | 读写 `config/ai-platforms.json`（路径由 `AI_PLATFORMS_CONFIG` 给出）；写的是**补丁**，服务端合并回磁盘现状，避免整文件替换抹掉面板看不见的明文密钥；平台与能力形状在服务端校验，生产 compose 只读挂载时回 409 `config_read_only` |
| 容器动作 | 需要 `ADMIN_DOCKER_SOCKET`；未设置时基础设施页返回 `available: false`，面板显示"未接入" |
| 审计与退避 | 令牌常量时间比较；按来源 IP 记失败窗口，8 次后封 5 分钟（进程内表，只抬高猜测成本，不是安全边界）；每次进入面板都记审计 |

> **说明：** 开发栈把这两件事设成了本机方便调试的样子——`ADMIN_PANEL_TOKEN` 用一个固定的开发令牌、`ADMIN_DOCKER_SOCKET` 挂上 `/var/run/docker.sock`。socket 等价于宿主机 root 权限，所以只在 `docker-compose.dev.yml` 里默认开；生产 compose 两项都留空（即面板关闭、容器动作不可用）。把它们当默认配置带到别处是这次文档特意标出的尖角。

## 请求体上限

几处口径不一致是刻意的，改动时得同时看：

| 入口 | 上限 | 出处 |
| --- | --- | --- |
| multipart（全局） | 单文件 10MB、1 个文件、3 个字段、字段值 1KB；超限在流式读取阶段就断，`req.file()` 抛 `FST_REQ_FILE_TOO_LARGE` 转 413 | `server.ts` |
| `POST /uploads/avatars` | 2MB（`req.file({limits})` 覆写；`MAX_IMAGE_SIZE` 10MB、`MAX_AVATAR_SIZE` 2MB 在 `modules/upload/upload-service.ts`） | `modules/upload/` |
| `POST /v2/notes/:id/doc-update` | `bodyLimit` 8MB 只是粗筛，真正判据是**解码后字节数** ≤ 2MB（`NOTE_DOC_UPDATE_MAX_BYTES`），否则回 `update_too_large` | `modules/note/` |
| `POST /import/markdown` | `bodyLimit` 50MB，与 schema 上界对齐（100 条 × 500KB） | `modules/import/` |
| 其他 JSON 路由 | Fastify 默认 1MiB | — |

## API 侧的测试入口

- 单元与守卫：`cd apps/api && npm test` = `node --import tsx --test --test-concurrency=8 $(find src -name '*.test.ts')`。`src/__tests__/` 里除了服务单测，还有一族 `*-source-guard.test.ts` 与 `*-contract.test.ts`：它们读源码文本与迁移 SQL，钉住分层边界、错误信封、能力开关命名、迁移免事务指令这类不能靠运行时发现的约定。
- 集成：`*.integration.ts`（`src/integration-tests/`）**不在 `npm test` 里**，只能通过 `apps/api/package.json` 里那些 `test:*:postgres` 脚本显式跑；需要真实库和 `DATABASE_URL_*`。
- 一条命令跑全：`make test-postgres` 会遍历 `apps/api` 与 `workers/ai-worker` 里所有 `test:*:postgres` 脚本，并注入受限角色的连接串（超级用户会绕过 RLS，隔离断言变成假通过）。前提是要在**干净的一次性库**上跑：`bash scripts/dev-disposable-db.sh astella_it`——多个用例断言"库里只有自己的夹具"，共享开发库会假失败。
- 契约与路由覆盖：`npm run test:route-contract:postgres`、`test:users-rls:postgres`（含 schema 棘轮）、`test:db-integrity:postgres`（迁移与限流）。
- 类型检查：`cd apps/api && npm run typecheck`。本地基线是 `make verify`（与 CI 同集合，由 `.github/scripts/ci-workflow-contract.test.mjs` 钉住）；更完整的验证矩阵见[测试与质量](./testing-and-quality.md)。

## 相关分册

- [手册首页](../README.md)
- [产品总览](./overview.md)
- [架构](./architecture.md)
- [开发环境与运行](./development.md)
- [桌面客户端](./desktop-client.md)
- [模型与 Worker 链路](./ai-and-companion.md)
- [统一 Agent 运行时（技术）](./agent-runtime.md)
- [伴星体验（产品设计）](./companion-experience.md)
- [测试与质量](./testing-and-quality.md)
- [运维](./operations.md)
- [常见问题与排障](./faq-and-troubleshooting.md)
- [README.md](../../../README.md)、[PRODUCT.md](../../../PRODUCT.md)、[方案索引](../../plans/learning-companion/README.md)
