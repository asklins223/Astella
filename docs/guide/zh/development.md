# 理解引擎开发环境

中文 · [English](../en/development.md)

这篇讲什么：从一次干净检出到一个能操作的真窗口，中间每一步跑的是什么、哪些命令只做表面功夫、哪些变量必须自己填。所有条目按 `Makefile`、`docker-compose.dev.yml`、各包的 `package.json` 与 Dockerfile 逐行核对过；本页只覆盖本机开发栈，生产镜像构建与 Alpha 环境在 [operations.md](operations.md)。

- [前置条件](#前置条件)
- [从干净检出到能操作的窗口](#从干净检出到能操作的窗口)
- [/health 与 /ready 是两种断言](#health-与-ready-是两种断言)
- [端口表](#端口表)
- [热重载实际怎么生效](#热重载实际怎么生效)
- [一次性容器的约定](#一次性容器的约定)
- [数据库卷的安全边界](#数据库卷的安全边界)
- [日常命令](#日常命令)
- [开发窗口与安装包的不同](#开发窗口与安装包的不同)
- [跑起来之后建议读什么](#跑起来之后建议读什么)
- [常见首跑失败](#常见首跑失败)

## 前置条件

| 需要 | 为什么 | 核对方式 |
| --- | --- | --- |
| Docker + Compose v2 | 整套依赖（postgres、minio、edge-tts、api、worker）都在 `docker-compose.dev.yml` 里；本机**不需要**装 PostgreSQL | `docker compose version` |
| `make` | 所有开发入口都是 Make 目标，`make` 不带参数等于 `make up`（`.DEFAULT_GOAL := up`） | `make -v` |
| Node 22 | 镜像基座是 `node:22.11.0-alpine3.20`（`apps/api/Dockerfile:4`、`workers/ai-worker/Dockerfile:3`），CI 用 `NODE_VERSION: "22"`（`.github/workflows/main-ci.yml:43`） | `node -v` |
| 每个包各跑一次 `npm ci` | 九个包各有自己的 `package-lock.json`；`.ailearn/*` 是 `file:` 软链，但 `tsc` 要靠**被引包自己的** `node_modules` 解析 `zod` / `drizzle-orm` | `ls package-lock.json packages/*/package-lock.json apps/*/package-lock.json workers/*/package-lock.json` |
| `python3` | 一部分现场探针（`scripts/companion-inbox-sse-probe.py` 等）与 `edge-tts` 的服务脚本是 Python | `python3 -V` |

**这里要诚实写清楚的两件事**：仓库根、`apps/*`、`packages/*`、`workers/*` 的 `package.json` **都没有 `engines` 字段**，也**没有 `.nvmrc`**。"Node 22" 这条约束只活在镜像标签和 CI 变量里，换 Node 版本不会有任何东西拦你——出问题也不会有一行提示。另外仓库里散落着六个 `pnpm-lock.yaml`（根 + api + desktop-client + shared + ai-quality + ai-worker），**没有一条命令读它们**：`Makefile`、两个 Dockerfile 和 CI 全部是 `npm ci`。把它们当作历史材料，不要基于它们推断依赖关系。

## 从干净检出到能操作的窗口

### 1. 准备 `.env`

```bash
cp .env.example .env
```

`.env.example` 顶栏写着"生产环境配置模板"，但**开发栈确实要它**：`docker-compose.dev.yml` 的数据库口令、角色口令、MinIO 凭据全是文件里写死的本地默认值（`x-dev-database` 锚点与各服务的 `environment`），compose 只从 `.env` 读那几个 `${VAR:-默认}` 项。

开发栈**硬性要求**的只有一个变量——compose 用的是 `:?` 语法，缺失或为空时 `make up` 直接失败：

| 变量 | 用途 | 不填会怎样 |
| --- | --- | --- |
| `EDGE_TTS_AUTH_TOKEN` | `edge-tts` 容器与 api 共享的鉴权 token，两边必须同值 | compose 解析阶段就报 `Set EDGE_TTS_AUTH_TOKEN in .env` |

紧接着，**要让桌面窗口能登录**，还必须填这三个（`.env.example` 里默认留空，而留空 = fail closed）：

| 变量 | 用途 | 留空的真实表现 |
| --- | --- | --- |
| `AILEARN_DESKTOP_PAIRING_KEY_ID` | 配对密钥的 id，挑战请求带上它才能对上 | api 返回 503 `desktop_trust_unavailable` |
| `AILEARN_DESKTOP_PAIRING_SECRET` | base64url，解码后至少 32 字节；HMAC-SHA256 的密钥 | 同上；且主进程算不出 `local_loopback` 配置，连接状态直接是 `configuration_error: pairing_secret_missing` |
| `AILEARN_DOMAIN_SCHEMA_REVISION` | 领域契约修订号，写进被签名的挑战消息 | 同上，两侧任一边缺都拒 |

`openssl rand -base64 32` 生成的串是标准 base64（含 `+` `/`），而 `readDesktopTrustConfig` 要求 `^[A-Za-z0-9_-]+$` 且 `Buffer.from(v,'base64url').toString('base64url') === v`——用之前先换成 base64url 形式。

要真跑模型还要填 key：`DASHSCOPE_API_KEY`、`OPENAI_COMPAT_API_KEY`、`OPENCODE_GO_API_KEY`、`SILICONFLOW_API_KEY`、`BIGMODEL_API_KEY`、`TOKENRHYTHM_API_KEY`。具体哪个平台服务哪种能力由 `config/ai-platforms.json` 决定，而 `docker-compose.dev.yml` 只透传**显式列出**的那几个变量——2026-09-17 那次事故就是 compose 漏了 `OPENCODE_GO_API_KEY`，容器内解析为空，制卡 fail closed。**加平台时必须同时改这个文件和两份 compose**（dev 里 api 与 worker 各有一份同样的列表）。`ASSESSMENT_CRITIC_URL` / `_KEY` / `_MODEL` 是另一组：未配置时 LearningRun 的开放回答评估走确定性路径而不是猜。

其余变量（`COMPANION_*`、`LEARNING_RUN_ENABLED`、`CARD_GENERATION_*` 等）在 dev 里已经给了本机默认值，`make verify` 的 `.github/scripts/verify-companion-capability-config.mjs` 会检查 api 与 worker 声明的旗标是否成对，避免"API 收下的回合被 worker 当作功能关闭立刻拒掉"。

### 2. `make up`

```bash
make up
```

按 `Makefile:40-56` 逐行看，它做四件事：

1. `ensure-db-volume`：`docker volume inspect` 不到就创建一个带 `com.ailearn.protected=true` 标签的卷 `ailearn-dev_dev_postgres_data`。
2. `compose rm -f role-bootstrap migrate minio-init`：清掉上一轮留下的已退出初始化容器。
3. `compose --profile storage up -d --build --remove-orphans`：构建 `target: dev` 镜像并拉起 postgres / minio / api / worker / edge-tts。开发栈**默认带 storage profile**（`DEV_PROFILES`），所以头像与笔记图片上传开箱可用，不用再单独 `make storage`。
4. 对 `role-bootstrap`、`migrate`、`minio-init` 逐个 `docker wait`。

第 4 步的语义要说准：`docker wait` **阻塞到容器退出并打印它的退出码**，但 CLI 自身的退出码是 0（本机 2026-10-06 实测：容器 `exit 3` 时 `docker wait` 打印 `3`、`$?` 仍是 `0`），而 Makefile 又把输出重定向到 `/dev/null`。所以"等初始化跑完"是真的，"迁移失败就中断 `make up`"**不是**——`make up` 会绿着结束，故障要另外看。判断依据用 `/ready` 或 `docker compose -p ailearn-dev logs migrate`。

`migrate` 与 `role-bootstrap` 每次启动都跑（幂等，没有变化时是 no-op），不是"只在首次跑"；`minio-init` 与 `seed-*` 才是真一次性。

### 3. `make seed-demo`

```bash
make seed-demo
```

`compose --profile seed run --rm seed-demo`，容器内跑 `npm run db:seed`，`SEED_DEMO_DATA=true`。`apps/api/src/db/seed.ts:6-7` 定义演示凭据：

```text
邮箱：owner@ailearn.local
密码：ailearn_owner
```

**这对凭据只服务于本机开发**。`seed.ts:28-32` 里 `NODE_ENV=production && SEED_DEMO_DATA=true` 直接抛错，生产栈的 Owner 由 `OWNER_EMAIL` / `OWNER_PASSWORD` 显式给。

### 4. 装依赖并起窗口

```bash
make desktop-client-install   # cd apps/desktop-client && npm ci
make desktop-client-dev       # cd apps/desktop-client && npm run dev
```

`npm run dev` 展开是 `electron-vite dev --remoteDebuggingPort 9222`。这条命令要求 Docker 栈**已经在跑**：主进程默认打 `http://127.0.0.1:4000`（`desktop-gateway.ts` 的 `DEFAULT_API_ORIGIN`，可被 `DESKTOP_API_ORIGIN` 覆盖）。`electron.vite.config.ts:23-26` 会加载仓库根的 `.env`，注释明确写着这些值只交给**特权主进程**，不注入渲染层的 `import.meta.env`，也不经 preload 暴露。

## /health 与 /ready 是两种断言

| 端点 | 检查什么 | 失败意味着 |
| --- | --- | --- |
| `GET /health` | 进程活着、事件循环能应答 HTTP。`server.ts:125` 只返回 `{status:"ok",service:"api",timestamp}` | 进程本身有问题 |
| `GET /ready` | `SELECT 1`；`information_schema.tables` 里九张核心表都在（`users`、`workspaces`、`notes`、`jobs`、`sessions`、`learning_runs`、`learning_run_private_contracts`、`learning_tasks`、`learning_task_variants`）；`drizzle.__drizzle_migrations` 的最大 `created_at` ≥ `MIN_READY_MIGRATION_CREATED_AT`（默认 `1786683800000`） | 库可达但 schema 不完整——没迁移，或迁移跑了一半 |
| `GET /metrics` | Prometheus 文本格式 | 与存活/就绪无关 |

`/ready` 是 compose 给 api 用的健康检查目标。**worker 侧不对称**：代码里 `/ready` 存在（`workers/ai-worker/src/lib/metrics.ts:364`，探针是 `db.execute(sql`SELECT 1`)`），但 `docker-compose.dev.yml:369` 的 healthcheck 打的还是 `/metrics`——DB 挂了而 worker 容器不会被判不健康。这是已知的形状差，别把"compose 显示 worker healthy"读成"worker 能干活"。

## 端口表

| 服务 | 容器内 | 宿主 | 绑定地址来自 |
| --- | --- | --- | --- |
| api | 4000 | `${API_PORT:-4000}` | `${API_BIND_ADDRESS:-127.0.0.1}`；容器内监听由 `API_INTERNAL_BIND_ADDRESS:-0.0.0.0` 提供 |
| postgres | 5432 | `${POSTGRES_PORT:-5432}` | `${POSTGRES_BIND_ADDRESS:-127.0.0.1}` |
| minio | 9000 | `${MINIO_PORT:-9000}` | `${MINIO_BIND_ADDRESS:-127.0.0.1}` |
| minio 控制台 | 9001 | `${MINIO_CONSOLE_PORT:-9001}` | 同上 |
| worker metrics | 9100 | `${WORKER_METRICS_PORT:-9100}` | `${WORKER_METRICS_BIND_ADDRESS:-127.0.0.1}`；进程本身 `listen(port, "0.0.0.0")` |
| edge-tts | 8080 | `127.0.0.1:${EDGE_TTS_PORT:-8088}` | 硬编码回环 |
| Electron 主进程 | — | `127.0.0.1:9222`（CDP） | 只给采集与探针脚本用 |

`API_BIND_ADDRESS` 这条不是"想改成 `0.0.0.0` 就能改"：`resolveApiBindHost()`（`apps/api/src/modules/desktop-trust/routes.ts:62`）只允许字面量 `127.0.0.1`，或者同时满足 `AILEARN_CONTAINER_MODE=true` **且** `AILEARN_ALLOW_CONTAINER_WILDCARD=true` 时的 `0.0.0.0`，否则直接抛。dev compose 替容器把这两项都设好了，宿主机直跑 API 时改它只会得到一句 `API_BIND_ADDRESS must be literal 127.0.0.1…`。

edge-tts 有两套地址：Compose 内的 api 用 `http://edge-tts:8080`，在宿主机直接跑的 api 用 `http://127.0.0.1:8088`。两者的 `EDGE_TTS_AUTH_TOKEN` 必须是同一个，**不要把 Docker 服务名当作宿主 API 的地址**。

## 热重载实际怎么生效

镜像层：`apps/api/Dockerfile` 与 `workers/ai-worker/Dockerfile` 都有 `FROM base AS dev`，`NODE_ENV=development` + `CMD ["npm", "run", "dev"]`，而 `dev` 脚本是 `tsx watch src/server.ts` / `tsx watch src/index.ts`。生产目标 `prod` 是 `node dist/server.cjs` / `node dist/index.cjs`，完全没有 watch。

运行期挂载（`docker-compose.dev.yml`，api 与 worker 各一份，形状相同）：

| 挂载 | 覆盖什么 |
| --- | --- |
| `./apps/api/src` → `/app/src`（api）／`./workers/ai-worker/src` → `/app/src`（worker） | 本服务源码 |
| `./packages/shared` → `/app/packages/shared` | **整个包目录**，不只是 `src` |
| `./packages/agent-core/src` + `package.json` | agent-core 源码与它的 `exports` 清单 |
| `./packages/agent-host/src` + `package.json` | 同上 |
| `./packages/card-generation/src` + `package.json` | 同上 |
| `./config` → `/app/config:ro` | `ai-platforms.json` |
| `/var/run/docker.sock` → `/var/run/docker.sock` | 仅 api，且**仅开发栈**：给运维面板的容器视图用，等价于宿主机 root 权限 |

容器里的 `@ailearn/*` 是指向 `/app/packages/*` 的软链，`NODE_OPTIONS=--preserve-symlinks` 保证它们解析到同一份 `node_modules`，因此 drizzle/zod 只有一个实例。

`CHOKIDAR_USEPOLLING: "true"` + `CHOKIDAR_INTERVAL: "1000"` 在 api 与 worker 上都设了：macOS 的 Docker Desktop 跨 bind mount 不 reliably 传递 inotify 事件，不轮询的话 `tsx watch` 收了改动但不重启。代价是每秒扫一遍源码树。

**改依赖不热重载。** 镜像里的 `node_modules` 是 build 阶段 `npm ci` 的产物，挂载表没盖住它。改了任何 `package.json` 就要 `make rebuild`（`--no-cache` 重建，且**必须带 seed profile**——Makefile 注释里记着 2026-09-16 那次实测：漏了它 `seed-demo` 镜像仍是两周前的，`make seed-demo` 跑旧代码）。

## 一次性容器的约定

`role-bootstrap`、`migrate`、`minio-init` 都是 `restart: "no"`，跑完留在 `Exited` 状态**不删**。这不是脏，是刻意设计（`Makefile:6-18`）：Docker Desktop 的整组 **Start** 相当于 `docker compose start`，它只重启容器不重建，如果初始化容器被删掉了，从 GUI 点 Start 就跳过迁移；留着它们，Start 会重跑一遍迁移与角色授权（幂等，无变化时是 no-op）。真正的清理发生在**下一轮** `make up` / `make storage` 开头，或者你手动：

```bash
make clean-init   # 只删 role-bootstrap 与 migrate；minio-init 不在这条命令的名单里
```

`make seed-demo` 用 `run --rm`，执行完自己消失，所以 `ps -a` 里看不到它属于正常。

## 数据库卷的安全边界

```yaml
dev_postgres_data:
  name: ailearn-dev_dev_postgres_data
  external: true
```

`external: true` 意味着 compose 不拥有这个卷：`make down`（`down --remove-orphans`）、删容器、甚至 `docker compose down -v` **都删不掉它**。唯一的删除路径是显式确认：

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB
```

`Makefile:86-99`：值不完全是 `DELETE_DEV_DB` 就打印取消并 `exit 2`，不碰任何东西；值对时才 `down` + `docker volume rm` + 重新 `make up`。先备份再按。

要一个"库里只有我自己的夹具"的干净环境时，别Reset 开发卷——用一次性库：

```bash
make disposable-db DISPOSABLE_DB=ailearn_it   # scripts/dev-disposable-db.sh，只删/建 ailearn_* 且不等于 ailearn 的库
```

`make test-postgres` 就为这个准备：它按 `apps/api` 与 `workers/ai-worker` 的 `package.json` 枚举所有 `test:*:postgres` 脚本，逐个注入那批专用连接变量（`RLS_TEST_*`、`QUEUE_TEST_*`、`RATE_LIMIT_TEST_DATABASE_URL`、`CONTENT_HASH_TEST_DATABASE_URL`、`SEC02_TEST_DATABASE_URL`、`NOTE_VERSION_RESTORE_TEST_DATABASE_URL`）。这些套件在 2026-10-06 整体退出 CI，**文件与夹具全部保留**，只是没人默认跑。

## 日常命令

| 命令 | 实际做什么 |
| --- | --- |
| `make up` | 上面四步；`make` 不带参数就是它 |
| `make storage` | 与 `up` 同形，但显式点明 storage profile（现在 `up` 已默认带上，两条基本等价） |
| `make logs` | `compose logs -f`，全部服务 |
| `make down` | `down --remove-orphans`，保留数据 |
| `make config` | `compose config --quiet`：只验 YAML 与变量插值，**不碰 Docker**，`.env` 少填一个必填项在这里就会红 |
| `make rebuild` | `compose --profile seed build --no-cache` |
| `make clean-init` | 清 `role-bootstrap` 与 `migrate` |
| `make shell-api` / `make shell-worker` | `compose exec api sh` / `exec worker sh` |
| `make verify` | 先 `version-check`，再跑五个 contract 测试、schema 镜像校验、伴星旗标配对校验，然后七个包的 `typecheck` + `test`（`packages/ai-quality` 额外 `pr-gate`）。**这就是 CI 的本地基线**，由 `.github/scripts/ci-workflow-contract.test.mjs` 钉住两边一致 |
| `make test-postgres` | 真库集成套件，需干净的一次性库（见上一节） |
| `make disposable-db` | 创建/删除一次性开发库 |
| `make release-check` | `verify` + 发布输入校验 + `coverage-gate`（真卡阈值）+ manifest 生成与校验 |
| `make coverage-gate` / `make skip-todo-gate` | 两个独立门禁，**已不在 `verify` 链路里**，要显式调 |
| `make alpha-up` / `alpha-down` / `alpha-status` / `alpha-metrics` / `alpha-backup` / `alpha-restore-verify` | 走 `scripts/alpha-env-setup.sh` + `docker-compose.alpha.yml`（含 prometheus / alertmanager / 备份） |
| `make desktop-client-dev` / `-build` / `-dist` | `npm run dev` / `build` / `dist`（`dist` = typecheck + test + build + electron-builder） |
| `make desktop-client-dist-arm64` / `-mac` | `package:mac:arm64`：只打包，不跑那两道门禁 |
| `make desktop-client-dist-linux` / `-win` | `package:linux:x64` / `package:win:x64` |

## 开发窗口与安装包的不同

| 维度 | `make desktop-client-dev` | 安装包 |
| --- | --- | --- |
| 页面来源 | Vite dev server，主进程从 `ELECTRON_RENDERER_URL` 读 origin | `ailearn-app://bundle/index.html`，由 `protocol.handle` 从包内目录服务 |
| CSP | 给 dev origin 放开 `connect-src`（含它的 ws: 变体），`script-src` 额外允许 `'unsafe-inline'`（React refresh 的前导脚本） | 严格策略；artifact origin 另有一套 `default-src 'none'` |
| 导航闸 | 只放行 dev server origin | 只放行 `ailearn-app://bundle`，且要求无用户名、无密码、无端口 |
| DevTools | 可用（`webPreferences.devTools: !app.isPackaged`，`src/main/index.ts:595`） | 关闭 |
| CDP | `--remoteDebuggingPort 9222`，采集与探针脚本靠它附着 | 不开放 |
| 语音模型 | dev server 在自己的 origin 上服务那两个文件（自定义 scheme 不做 CORS 放行，跨源 fetch 实测 `TypeError: Failed to fetch`） | `ailearn-app://bundle/device/asr/`，同源可读 |
| 主进程重启 | `npm run dev` 不 watch main/preload，改主进程要重启命令；`npm run dev:watch-main`（`electron-vite dev -w`）才常驻重建 | 不适用 |

`out/` 是 `electron-vite build` 的产物目录（被 `apps/desktop-client/.gitignore` 忽略）。`npm run dev` 用 Vite dev server 服务渲染层，但 `preview`、capture 脚本直接 `electron .` 时读的是 `package.json` 的 `main: ./out/main/index.js`——**`out/` 过期不会报错，只会给你一个旧窗口**。凡是"看着不像我改的"的截图结论，先确认这次有没有 `npm run build`。

> **说明：** `VITE_HOME_SCENE_VARIANT` **不是**一个可用的运行旗标。它唯一的出现位置是 `package.json` 里 `capture:home-v2` 那条命令的赋值，源码没有读取点（`HomeV2Provider` 在 `renderer/src/App.tsx:136` 无条件挂载，`apps/desktop-client` 下也没有 `.env*` 文件）。这条由 `src/main/__tests__/docs-vite-vars-have-readers.test.ts` 守着：文档可以点名一个不存在的开关，但必须在那一行明说它不存在。想改首页构图就直接改组件，不要去找那个变量。

## 跑起来之后建议读什么

1. **先学会看真窗口，而不是只看接口。** `npm run capture`（`scripts/capture-scene.mjs`）与 `npm run capture:evidence` 会截图；后者显式带 `npm run build`，前者没有——它直接 `electron.launch` 起一个新实例，读的是当前 `out/`。凭据由 `scripts/load-capture-env.mjs` 从仓库根 `.env` 读 `OWNER_EMAIL` / `OWNER_PASSWORD`，缺失时以匿名模式跑。想看**你正在看的那个窗口**，用附着模式：

   ```bash
   AILEARN_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/capture-pages-v3.mjs
   ```

   不带这个变量时脚本会另起一个 Electron 实例（`electron.launch`，读 `out/`），那个副本的 profile、工作区与重载状态都和你眼前的窗口不同。同目录下的 `compare-mockup-geometry.mjs` 干脆不设默认值，缺 `AILEARN_CAPTURE_CDP` 直接抛错——附着真实窗口才有证据价值。`AILEARN_CAPTURE_NO_SANDBOX=1` 是给受限环境（CI 容器、被沙箱化的 agent shell）准备的逃生口，本机不要加。
2. **跑一遍门禁。** `make verify` 是最便宜的全量信号；它**真的**卡覆盖率阈值（2026-09-29 之前挂的是 `--report-only`，那时"验证覆盖率"是假话）。样式与契约类守卫集中在 `apps/desktop-client/src/main/__tests__/`（`css-var-resolution-guard`、`renderer-style-dead`、`component-size-guard`、`docs-vite-vars-have-readers` 等）和 `.github/scripts/`，改之前先看清它们保护的是哪个行为。
3. **再读结构与边界。** [architecture.md](architecture.md) 说进程与链路，[api-and-data.md](api-and-data.md) 说角色与迁移，[desktop-client.md](desktop-client.md) 说 IPC 与窗口，[testing-and-quality.md](testing-and-quality.md) 说门禁。产品边界以 [PRODUCT.md](../../../PRODUCT.md) 为准，视觉与交互以 [DESIGN.md](../../../DESIGN.md) 为准，协作约定以 [AGENTS.md](../../../AGENTS.md) 为准。

## 常见首跑失败

只列"命令与配置"这一层能自愈的三条，其余见排障分册：

- `make up` 在 compose 解析阶段就报 `Set EDGE_TTS_AUTH_TOKEN in .env`：`.env` 里那行还是注释状态。填上任意本机 token，`make config` 先验一遍。
- 窗口能开但登录报连接配置问题：`AILEARN_DESKTOP_PAIRING_*` / `AILEARN_DOMAIN_SCHEMA_REVISION` 没填，或 `.env` 改了但没重启主进程（`electron.vite.config.ts` 只在启动时 `loadDotenv` 一次）。
- 迁移或角色授权没生效但 `make up` 是绿的：见 [一次性容器的约定](#一次性容器的约定)里 `docker wait` 的那段——`docker compose -p ailearn-dev logs migrate` 与 `GET /ready` 才是判据。

完整的现象→原因→处理在 [faq-and-troubleshooting.md](faq-and-troubleshooting.md)，本页不重复那份清单。

## 相关分册

- [手册索引](../README.md)
- [产品总览](overview.md)
- [系统架构](architecture.md)
- [桌面客户端](desktop-client.md)
- [API 与数据](api-and-data.md)
- [AI 与伴星](ai-and-companion.md)
- [测试与质量](testing-and-quality.md)
- [运维](operations.md)
- [常见问题与排障](faq-and-troubleshooting.md)
- 仓库根：[README.md](../../../README.md)、[PRODUCT.md](../../../PRODUCT.md)、[DESIGN.md](../../../DESIGN.md)、[AGENTS.md](../../../AGENTS.md)
- 现行方案索引：[docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md)
