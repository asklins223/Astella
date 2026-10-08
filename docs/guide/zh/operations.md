# 运行与发布

中文 · [English](../en/operations.md)

这篇讲什么：拾星笔记现在怎么被跑起来与发出去——三份 compose 文件各自的职责、生产环境必填与可选的变量分组、统一版本与桌面端的打包发布链、Alpha 环境的巡检与备份恢复、监控与告警的真实口径，以及面向运维者的安全边界与仍然存在的缺口。所有端口、变量名、任务名、卷名和告警名都从 `docker-compose*.yml`、`Makefile`、`scripts/alpha-env-setup.sh`、`infra/**`、`.github/workflows/**` 与 `apps/desktop-client/electron-builder.yml` 当场核对；叠加后的项目名与卷名用 `docker compose config` 验证过。这份文档只写名字与用途，不写任何凭据值。

- [三份 Compose 文件](#三份-compose-文件)
- [环境变量分组](#环境变量分组)
- [统一版本与打包发布](#统一版本与打包发布)
- [Alpha 环境](#alpha-环境)
- [可观测性](#可观测性)
- [备份与恢复](#备份与恢复)
- [数据库：卷保护与角色姿态](#数据库卷保护与角色姿态)
- [面向运维者的安全姿态](#面向运维者的安全姿态)
- [已知的运维缺口](#已知的运维缺口)
- [相关分册](#相关分册)

## 三份 Compose 文件

| 文件 | 顶层 `name:` | 定位 | 由谁驱动 |
| --- | --- | --- | --- |
| `docker-compose.dev.yml` | `astella-dev` | 本机开发栈：`target: dev` 镜像、源码 bind mount 热重载、写死的本机凭据、`seed-demo` 在 `seed` profile 下、全部端口只发回环、挂了 `docker.sock` 给 `/admin`、伴星能力开关默认打开 | `Makefile` 的 `COMPOSE := docker compose -p astella-dev -f docker-compose.dev.yml`，即 `make up` / `storage` / `seed-demo` / `rebuild` / `config` / `logs` / `down` / `reset-db` / `shell-*` / `desktop-client-up` |
| `docker-compose.yml` | `astella` | 生产形态：`target: prod` 镜像 + `user: node`、无源码挂载、三条 `:?` 必填的数据库 URL、角色引导与迁移的一次式服务、能力开关 fail-closed、`AUTH_RATE_LIMIT_STORE` 默认 `postgres`、edge-tts **不发端口** | 没有 Makefile 目标接它（有意如此，见 README）。手动验证或 Alpha 流程使用 |
| `docker-compose.alpha.yml` | `astella-alpha` | **叠加层（overlay），不能单独使用**：给 `postgres` 加一个 `restore-postgres` 网络别名，新增本地 `minio`／`minio-init`、监控与备份服务及对应卷，覆盖 API／Worker 为本地存储模式 | `scripts/alpha-env-setup.sh`，形如 `docker compose -f docker-compose.yml -f docker-compose.alpha.yml --profile storage` |

> **说明：** 叠加时顶层 `name:` 取后一份文件，所以整条 Alpha 链的项目名是 `astella-alpha`，卷也跟着变成 `astella-alpha_postgres_data`、`astella-alpha_minio_data`、`astella-alpha_prometheus_data` 等（`docker compose -f docker-compose.yml -f docker-compose.alpha.yml --profile storage config` 实测）。只跑 `docker-compose.yml` 时前缀是 `astella_`。`docker-compose.dev.yml` 文件头明确写着**不要**把它叠在 `docker-compose.yml` 上。

一次性服务链（`restart: "no"`，幂等，每次部署都要；`docker-compose.yml` 与 `docker-compose.dev.yml` 同一条跑）：

| 服务 | 顺序 | 做什么 |
| --- | --- | --- |
| `role-bootstrap` | 迁移前 | 跑 `infra/postgres/apply-roles.sh`：创建/轮换 `astella_migrator`、`astella_api`、`astella_worker`，并把历史对象归属转给 migrator |
| `migrate` | role-bootstrap 之后 | `npm run db:migrate`，只读 `DATABASE_URL_MIGRATOR` |
| `role-grants` | migrate 之后 | 再跑一次 `apply-roles.sh`，带 `REQUIRE_RLS_DISABLED=true`，对迁移新建的对象补授权 |
| `seed-owner` | `seed` profile，需显式 `run --rm` | `npm run db:seed`。生产路径 fail-closed：缺 `OWNER_EMAIL` 或 `OWNER_PASSWORD` 直接抛错，`OWNER_PASSWORD` 少于 12 位同样抛错，`SEED_DEMO_DATA=true` 配 `NODE_ENV=production` 直接拒绝 |

`api` 与 `worker` 依赖 `role-grants` **成功退出**才启动。两个服务的 `stop_grace_period` 是被代码预算决定的：`api` 为 20s（`graceful-shutdown.ts` 的 closeServer 10s + `db/client.ts` 的 `end({timeout:5})` 5s + 余量），`worker` 为 60s（45s drain + 2s notify + 5s DB + 余量）。**改代码里的任一预算必须同步改 compose**，否则编排器会在预算跑完之前 SIGKILL，租约交还与优雅关闭形同虚设。

发布的端口（默认全部只绑回环，前缀变量可覆盖）：

| 端口 | 变量 | 出现在 |
| --- | --- | --- |
| `5432` PostgreSQL | `POSTGRES_BIND_ADDRESS` / `POSTGRES_PORT` | 仅 dev |
| `4000` API（含 `/metrics`） | `API_BIND_ADDRESS` / `API_PORT` | dev、prod |
| `9100` Worker 指标（`/metrics`、`/ready`） | `WORKER_METRICS_BIND_ADDRESS` / `WORKER_METRICS_PORT` | dev、prod |
| `9000` / `9001` MinIO API / 控制台 | `MINIO_BIND_ADDRESS` / `MINIO_PORT` / `MINIO_CONSOLE_PORT` | dev、prod（`storage` profile） |
| `8088` edge-tts | `EDGE_TTS_PORT` | 仅 dev；prod 的 `edge-tts` **没有 `ports:`**，只在 compose 内网 `http://edge-tts:8080` 可达 |
| `9090` Prometheus、`9093` Alertmanager | `PROMETHEUS_*` / `ALERTMANAGER_*` | 仅 Alpha 叠加层 |

容器内部的监听地址与宿主发布是两回事：`API_BIND_ADDRESS` 变量在 compose 里被显式区分成宿主发布用的 `API_BIND_ADDRESS` 与容器内监听的 `API_INTERNAL_BIND_ADDRESS`（默认 `0.0.0.0`）。

## 环境变量分组

`.env.example` 是生产模板（70 条未注释赋值 + 一批注释掉的可选项），`.env.alpha.example` 是 Alpha 的精简模板。**只列名字与用途，不列值。**

必填由 compose 的 `${VAR:?…}` 决定，缺一个就在 `docker compose up` 阶段直接拒绝启动。实测把 `--env-file .env.example` 叠给生产 + Alpha 两份文件，报出的缺项是：`POSTGRES_PASSWORD`、`DATABASE_URL_MIGRATOR`、`DATABASE_URL_API`、`DATABASE_URL_WORKER`、`EDGE_TTS_AUTH_TOKEN`（以及 anchor 里的 `MIGRATOR_PASSWORD` / `API_PASSWORD` / `WORKER_PASSWORD`）。

| 组 | 变量 | 生产 | 开发 |
| --- | --- | --- | --- |
| 数据库角色口令 | `POSTGRES_PASSWORD`、`MIGRATOR_PASSWORD`、`API_PASSWORD`、`WORKER_PASSWORD` | `:?` 必填 | dev 文件写死本机值，不读 `.env` |
| 应用连接串 | `DATABASE_URL_MIGRATOR`、`DATABASE_URL_API`、`DATABASE_URL_WORKER` | `:?` 必填（分别给 `migrate`、`api`、`worker`） | dev 文件写死，且 `_API`/`_WORKER` 也指受限角色 |
| 语音共享令牌 | `EDGE_TTS_AUTH_TOKEN` | `:?` 必填，且必须与 edge-tts 容器一致 | `:?` 必填——**dev 唯一真正要填的一项** |
| 对象存储 | `STORAGE_MODE`、`STORAGE_ENDPOINT`、`STORAGE_PUBLIC_ENDPOINT`、`STORAGE_ACCESS_KEY_ID`、`STORAGE_SECRET_ACCESS_KEY`、`S3_BUCKET`、`S3_REGION` | 正式部署固定 `remote`，端点和密钥必填；没有 MinIO 服务或卷。Alpha 单独提供本地 MinIO | dev 固定 `local`，使用本机 MinIO |
| 首个账号 | `OWNER_EMAIL`、`OWNER_PASSWORD`（≥12 位）、`OWNER_WORKSPACE` | 只在显式 `seed-owner` 时读 | 用 `make seed-demo`，不读这三项 |
| 网络与来源 | `CORS_ORIGIN`、`TRUST_PROXY`、`API_PORT`、`API_BIND_ADDRESS`、`POSTGRES_BIND_ADDRESS` | 可选，默认见 compose | 同左 |
| 会话与安全 | `AUTH_COOKIE_SECURE`、`AUTH_SURFACE_MANIFEST_SECRET`、`AUTH_RATE_LIMIT_STORE`、`AUTH_RATE_LIMIT_WINDOW_MS`、`AUTH_RATE_LIMIT_MAX_ATTEMPTS`、`LEARNING_DRAFT_ENC_KEY`、`PROJECTION_CHECKPOINT_SECRET` | 可选但有 fail-closed 后果，见下表 | 同左 |
| 桌面接入与合同 | `ASTELLA_DESKTOP_PAIRING_KEY_ID`、`ASTELLA_DESKTOP_PAIRING_SECRET`、`ASTELLA_DOMAIN_SCHEMA_REVISION`、`DESKTOP_API_ORIGIN`、`DESKTOP_DEPLOYMENT_CONFIG_REVISION` | 可选 | dev 给了固定的本机兜底值（配对口令仍为空） |
| 运维面板 | `ADMIN_PANEL_TOKEN`、`ADMIN_PANEL_PATH`、`ADMIN_LOG_BUFFER_SIZE`、`ADMIN_DOCKER_SOCKET` | 可选：留空即 `/admin` 不注册 | dev 有默认值且挂了 socket |
| 模型凭据 | `DASHSCOPE_API_KEY`、`OPENAI_COMPAT_API_KEY`、`SILICONFLOW_API_KEY`、`BIGMODEL_API_KEY`、`TOKENRHYTHM_API_KEY`、`OPENCODE_GO_API_KEY`、`ASSESSMENT_CRITIC_URL` / `_KEY` / `_MODEL`、`AI_PLATFORMS_CONFIG` | 可选，未配置时按 fail-closed 分支处理 | 同左 |
| 运行参数 | `LOG_LEVEL`、`WORKER_DRAIN_TIMEOUT_MS`、`WORKER_MODEL_TIMEOUT_MS`、`WORKER_PROVIDER_TIMEOUT_MS`、`WORKER_TIMEOUT_PARSE_SOURCE_MS`、`V3_ALLOW_DETERMINISTIC_PROVIDERS`、`AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS`、`AI_REQUIRE_CONFIGURED_PROVIDER`、`EDGE_TTS_BASE_URL`、`EDGE_TTS_PORT`、`EDGE_TTS_MAX_CONCURRENCY`、`QWEN_TTS_MAX_CONCURRENCY`、`TOPOLOGY_SNAPSHOT_CACHE_MS`、`V2_EVIDENCE_*` / `V2_LEASE_RENEWAL_INTERVAL_MS` / `V2_PIPELINE_BUDGET_MS` / `V2_SOURCE_CONTENT_MAX_CHARS`、`V2_E2E_DEBUG_ERRORS` | 可选，多数只在 worker 侧生效 | `V2_E2E_DEBUG_ERRORS` dev 默认为 1 |
| Alpha 叠加层 | `PROMETHEUS_BIND_ADDRESS` / `PROMETHEUS_PORT`、`ALERTMANAGER_BIND_ADDRESS` / `ALERTMANAGER_PORT`、`BACKUP_BUCKET`、`SOURCE_RELEASE`、`SOURCE_MIGRATION` | 只在叠加层出现 | — |

> **注意 URL 编码：** 角色口令与连接串是两套变量。`apply-roles.sh` 拿的是**原始**口令，三条 `DATABASE_URL_*` 里嵌的是**编码后**的同值——口令含 `@`、`:`、`/`、`#` 等保留字符时必须百分号编码，否则 URL 解析出的用户名/主机/库名都会错位。`.env` 已被 Git 忽略；不要把真实口令或 Key 提交进仓库。

几个 fail-closed 的形状值得单独记住：

| 变量 | 未配置时的行为 |
| --- | --- |
| `AUTH_COOKIE_SECURE` | compose 生产默认 `true`；代码默认是"`NODE_ENV=production` 时 Secure"。用明文 HTTP 直接测生产栈时要在 `.env` 里显式写 `false`，真实 HTTPS 部署必须保持 `true`。Cookie 另带 `SameSite=Lax`。 |
| `TRUST_PROXY` | dev 与 prod 默认都是 `false`。只有外部代理**已覆写** `X-Forwarded-For` 时才显式设真，否则登录限流的 IP 维度可被伪造。 |
| `AUTH_SURFACE_MANIFEST_SECRET` | 未设置时伴星 grant 签发返回 503（`turn-service.ts`）。 |
| `AUTH_RATE_LIMIT_STORE` | 生产默认 `postgres`（跨副本正确），dev 默认 `memory`；填这两个之外的值直接抛错。 |
| `ADMIN_PANEL_TOKEN` | 见[安全姿态](#面向运维者的安全姿态)。 |
| `LEARNING_DRAFT_ENC_KEY` | 未配置时草稿读写返回 409 `draft_encryption_unavailable`。 |
| `PROJECTION_CHECKPOINT_SECRET` | 未配置时不签发 checkpoint，envelope 永远 pending、星图投影不推进。 |
| `AI_REQUIRE_CONFIGURED_PROVIDER` | 生产 compose 默认 `true`：未配置 provider 时抛不可重试的 `ai_provider_not_configured`，不回退 mock 假文本。dev 与桌面端不设，保留降级。 |
| `CARD_GENERATION_V3_PROVIDER` | 两份 compose 都给 `deterministic`。在 `NODE_ENV=production` 且没有显式 `V3_ALLOW_DETERMINISTIC_PROVIDERS=1` 时，`resolveCardGenerationV3Providers()` 抛不可重试错误——也就是这条链接线真模型之前，**生产部署出不来卡**。 |

能力开关由 `.github/scripts/verify-companion-capability-config.mjs` 做**双向**断言（`make verify` 每次都跑）：每个服务声明且只声明它实际读取的开关——多一个是死配置，少一个是运维无法在不改 compose 的前提下开启能力；表达式必须精确等于 `${NAME:-<期望默认值>}`。表给出当前两份文件里的默认值。

| 开关 | prod | dev | 谁读 |
| --- | --- | --- | --- |
| `LEARNING_RUN_ENABLED` | `false` | `true` | api |
| `CARD_GENERATION_V2_ENABLED` | `false` | `true` | api |
| `COMPANION_DIALOGUE_V1_ENABLED` | `true` | `true` | api + worker |
| `COMPANION_VOICE_DIALOGUE_V1_ENABLED` | `false` | `true` | api + worker |
| `COMPANION_STREAMING_VOICE_V1_ENABLED` | `false` | `false` | api |
| `COMPANION_JOURNEY_V2` | `true` | `true` | api |
| `COMPANION_BRIDGE_V2` | `true` | `true` | api |
| `COMPANION_MEMORY_VECTOR_V1` | `true` | `true` | api + worker |
| `COMPANION_MEMORY_STAR_MAP_V1` | `true` | `true` | api |
| `COMPANION_PET_PROFILE_V1` | `true` | `true` | api |
| `COMPANION_PROACTIVE_PERSONALIZED_V1` | `true` | `true` | api |
| `COMPANION_SUMMARIZER_V1` | `true` | `true` | api + worker |
| `COMPANION_DAILY_SUMMARY_V1` | `true` | `true` | api + worker |
| `COMPANION_MEMORY_EXTRACTOR_V1` | `true` | `true` | 仅 worker |
| `COMPANION_THOUGHTS_V1` | `true` | `true` | 仅 worker |
| `CARD_GENERATION_V3_PROVIDER` | `deterministic` | `deterministic` | 仅 worker |

## 统一版本与打包发布

服务端与桌面客户端共用 `release/version.json` 和 `v<版本>` tag。修改此文件后运行 `node .github/scripts/version-contract.mjs --write`，同步 API、Worker、Shared、Desktop 四个包及 lockfile；`--check` 检查一致性。桌面打包也通过 `desktop-version.mjs` 调用同一契约。推送版本 tag 同时触发服务端 CI 与部署、桌面质量检查与安装包发布，版本不一致时停止。

`make` 侧的相关目标：`make version-check` 检查服务端与客户端版本一致性；`make release-manifest` 生成 `release-manifest-generate.mjs` 的机器可读清单；`make release-check` 依次跑 `verify-release-inputs.mjs` → `make verify` → `coverage-gate.mjs` → `release-manifest-generate.mjs` → `release-manifest-contract.mjs`。在精确的 release tag 上，最后一步除非用 `RELEASE_MANIFEST_PATH` 指到一份完整的 CI/release JSON，否则 fail-closed。

electron-builder 的配置在 `apps/desktop-client/electron-builder.yml`，目标是：

| 平台 | target | 架构 | 命令 |
| --- | --- | --- | --- |
| macOS | `dmg` + `zip` | 由命令行决定（yml 里**故意不写 arch**，避免与脚本互相覆盖） | `npm run package:mac:arm64` / `package:mac:x64`，对应 `make desktop-client-dist-arm64`（Apple Silicon）与 `desktop-client-dist-mac` |
| Windows | `nsis` | `x64`（yml 里写死） | `npm run package:win:x64`，`make desktop-client-dist-win` |
| Linux | `AppImage` | 命令行给 `--x64` | `npm run package:linux:x64`，`make desktop-client-dist-linux` |

几个刻意的选择：

- **`nsis.oneClick: true`**（2026-10-04 由 `false` 改）。原因是向导式安装器有一个 `PageEx custom` 的选目录页，`/S` 静默模式下 NSIS 跳过绘制但 MultiUser 仍需一次显式决策，安装器就一直等着——CI 上表现为安装 step 挂到超时，症状和"安装器坏了"一模一样。代价是用户不再能自己挑安装目录，改装到 `%LOCALAPPDATA%\Programs\Astella`（2026-10-06 起包名是 ASCII 的 Astella，开始菜单与"应用和功能"里的条目才用中文显示名 拾星笔记）。`requestedExecutionLevel: asInvoker` 也写明，不提权。
- **`artifactName: astella-${version}-${os}-${arch}.${ext}` 写死前缀**。`productName` 现在也是 ASCII 的 Astella，但产物名不取 `${productName}`：Release 资产名会进 `latest.yml` / `latest-mac.yml` 被客户端解析，显示名以后再怎么调，已发出去的更新元数据里的文件名都不该跟着漂；GitHub 资产 URL、NSIS 差分下载与 Squirrel.Mac 对非 ASCII 文件名也都有边角问题。`desktop-release.yml` 里核对的正是 `astella-<version>-win-x64.exe`、`.blockmap`、`-mac-<arch>.zip`、`.dmg` 这四个名字。
- **更新源是 GitHub Releases，不是本项目 API**。`publish: provider github / owner asklins223 / repo Astella`；`apps/desktop-client/src/main/desktop-update.ts` 里重复了同一组 owner/repo 常量用于拼"去下载页"的链接——**改仓库地址时两处要一起改**。检查走 `api.github.com`，下载走 GitHub CDN，`apps/api` 完全不在这条链路上，因此更新带宽不落在自家服务器上，也不会因为自家 API 挂了而更新不了。
- **没有配置 Apple 证书与公证凭据。** `electron-builder.config.cjs` 在无证书时使用完整 ad-hoc 签名；`scripts/macos-signature.cjs` 把主应用的 designated requirement 固定为 `identifier "com.asklins.astella"` 并检查包体完整性，使下一版能够满足旧版更新要求。macOS 首次打开或更新后仍可能需要在系统隐私与安全中允许；这种签名不提供 Apple 开发者身份认证。已有 Developer ID 签名保持不变，可继续公证。流水线检查最终 ZIP 和 DMG 内应用的签名。Windows 无证书时仍可能出现 SmartScreen 提示。

发布流水线 `.github/workflows/desktop-release.yml` 只在 `push` tag `v*` 上发 Release，`resolve` job 先把 tag 版本与 `release/version.json` 对比（不一致直接停，否则会产出"标题写 A、包是 B"的 Release），再由 `build` job 以 `workflow_call` 复用 `desktop-package.yml` 并行打两端，最后 `release` job（`if: from_tag == 'true'`）：下载 `desktop-*` 工件 → 断言两端版本一致且四个文件非空 → **必须存在 `latest.yml`**（缺了直接失败，Windows 拿不到版本信息）、**必须存在 `latest-mac.yml`**（缺失直接失败） → 用 `softprops/action-gh-release@v2` 以 `draft: true` 建 Release 并上传全部资产 → 再用 `gh api --method PATCH … -F draft=false` 翻成公开。先 Draft 后公开是为了更新器：边传边公开可能让它读到一个只传了一半的 `latest.yml` 或半成品安装包。手动 `workflow_dispatch` 触发的那次**不发** Release。

## Alpha 环境

Alpha 是一套用 compose 起在单机上的"带监控与备份基础设施"的环境，`make` 目标包一层 `./scripts/alpha-env-setup.sh`：

| make 目标 | 转调 | 做什么 |
| --- | --- | --- |
| `make alpha-up` | `alpha-env-setup.sh up` | 起 `postgres minio alpha-ops-sidecar` → 等 `pg_isready` → 依次跑一次式服务 `minio-init`、`role-bootstrap`、`migrate`、`role-grants`（每次都删掉旧容器重建并 `docker wait`）→ 起 `api worker prometheus alertmanager` → 逐个 `wait_http` 探测 API `/ready`、worker `/metrics`、Prometheus `/-/healthy`、Alertmanager `/-/healthy` → 打印 status |
| `make alpha-backup` | `… backup` | 在 `backup-runner` 容器里跑 `infra/backup/backup.sh` |
| `make alpha-restore-verify` | `… restore-verify` | 先在 `postgres` 上 `DROP DATABASE IF EXISTS astella_restore_verify WITH (FORCE)` + `CREATE DATABASE`，再跑 `infra/backup/rc-restore-verify.sh` |
| `make alpha-status` | `… status` | `docker compose ps` + 端点清单 + `curl :9090/api/v1/alerts` 与 `/api/v1/targets`（需要 `jq`） |
| `make alpha-metrics` | `… metrics` | `curl :4000/metrics` 里 `^astella_` 的前 20 行 + 一条 PromQL `astella_job_queue_depth` |
| `make alpha-down` | `… down` | `docker compose down --remove-orphans` |

脚本接受 8 个子命令，其中 **`init` 与 `freshness` 没有对应的 make 目标**，`down`/`status` 之外的运维步骤同理要直接调脚本：

```bash
./scripts/alpha-env-setup.sh init        # 生成 age 密钥对 + 建备份 bucket
./scripts/alpha-env-setup.sh freshness   # 检查最近一次已验证备份的新鲜度（阈值 24h）
```

第一次把环境跑起来之前需要 `.env` 里有这 8 项（脚本的 `check_env` 会逐个点名）：`MINIO_ROOT_PASSWORD`、`POSTGRES_PASSWORD`、`MIGRATOR_PASSWORD`、`API_PASSWORD`、`WORKER_PASSWORD`、`DATABASE_URL_MIGRATOR`、`DATABASE_URL_API`、`DATABASE_URL_WORKER`。`down` 与 `status` 走另一条路：`prepare_compose_control_env` 会给缺失项填**惰性占位值**，让运维在口令文件不可用时仍能查看或停掉一个坏掉的栈；会真正连接/变更的 `up`、`backup`、`restore-verify`、`init`、`freshness` 仍然用 `check_env` 硬卡。

备份基础设施的状态放在哪（都是名字，不含内容）：

| 东西 | 位置 |
| --- | --- |
| age 公钥（备份加密用）与私钥（恢复解密用） | 命名卷 `astella-alpha_backup_keys`，挂在 `backup-runner:/etc/astella` |
| manifest 与 RC 报告 | 命名卷 `astella-alpha_backup_manifests`，挂在 `backup-runner:/var/lib/astella/manifests`；`alpha-ops-sidecar` 以只读挂同一份 |
| 备份对象本体 | S3 兼容 bucket `BACKUP_BUCKET`（默认 `astella-backups`），在 MinIO 上，数据落 `astella-alpha_minio_data` |

迁移号是**动态**取的：`backup` 与 `restore-verify` 都用一行 `node -e` 从 `apps/api/src/db/migrations/meta/_journal.json` 的最后一条 `entries[].tag` 读当前末端（现在 388 条，末端 `0391_summary_verified_revision_backfill`），历史上这里曾硬编码 `0039` 而过期。

**`.env.alpha.example` 里的 `SOURCE_MIGRATION` 不是"当前迁移号"**。它是 `rc-restore-verify.sh` 的 `--migration` 入参，语义是"这次要验证的那份备份出自哪个迁移"，模板里给的 `0039` 只是示例值——按最新迁移号去改它是错的。想覆盖它就在 `.env` 里显式设 `SOURCE_MIGRATION`，脚本用 `${SOURCE_MIGRATION:-<journal 末端>}` 取值。`SOURCE_RELEASE` 同理（默认 `0.5.0-alpha`），`SOURCE_COMMIT` 由脚本自己从 git 取。

## 可观测性

`infra/prometheus/prometheus.yml`：`scrape_interval` 与 `evaluation_interval` 都是 15s，外部标签 `monitor: astella-alpha` / `environment: alpha`，规则文件 `alerts.yml`，Alertmanager 静态目标 `alertmanager:9093`；Prometheus 启动参数含 `--storage.tsdb.retention.time=30d` 与 `--web.enable-lifecycle`。

| job | 抓取目标 | 路径 | 端口 |
| --- | --- | --- | --- |
| `prometheus` | `localhost:9090` | 默认 | 9090 |
| `astella-api` | `api:4000` | `/metrics` | 4000 |
| `astella-worker` | `worker:9100` | `/metrics` | 9100（relabel 把 `instance` 固定成 `worker`） |
| `astella-backup` | `alpha-ops-sidecar:8080` | `/metrics` | 8080，只在 overlay 内网可达，不发宿主端口 |
| `alertmanager` | `alertmanager:9093` | 默认 | 9093 |
| （注释掉的）`postgres` | `postgres-exporter:9187` | — | 未启用 |

规则文件 `infra/prometheus/alerts.yml` 有 **7 个组、21 条告警**（13 warning、7 critical、1 info）。仓库里那个本该多查一层的脚本——`.github/scripts/verify-alerts-syntax.mjs` 会解析 YAML、逐个校验组与规则的字段形状、提示重复告警名，并检查 15 个必需指标是否被 `alerts.yml` 引用——**没有接在任何链路上**，所以现在只有 Prometheus 加载时的校验在把关；改这个文件之后要自己确认。

| 组 | 告警 |
| --- | --- |
| `astella_http_health` | `AstellaAPIDown`、`AstellaWorkerDown`、`AstellaHighHTTP5xxRate`、`AstellaHighHTTPLatency` |
| `astella_job_health` | `AstellaJobQueueBacklog`、`AstellaStalePendingJob`、`AstellaHighJobDeadRate`、`AstellaJobLeaseLost` |
| `astella_provider_health` | `AstellaHighProviderErrorRate`、`AstellaProviderHighLatency`、`AstellaProviderSchemaFailure`、`AstellaProviderQuotaExceeded` |
| `astella_database_health` | `AstellaHighTransactionFailureRate`、`AstellaHighRLSDenialRate`、`AstellaBackupStale` |
| `astella_funnel_monitoring` | `AstellaLowInviteConsumptionRate`、`AstellaLowCardGenerationSuccessRate` |
| `astella_release_info` | `AstellaReleaseDeployed`、`AstellaReleaseRolledBack` |
| `astella_search_consistency` | `AstellaSearchIndexDrift`、`AstellaHighSearchDriftRatio` |

通知链路只有一条：`infra/prometheus/alertmanager.yml` 的唯一 receiver 是 `log-receiver`，`webhook_configs.url` 指向 `http://alpha-ops-sidecar:8080/alerts`，而 sidecar 收到之后只做一件事——`print("[alpha-ops] alertmanager webhook " + <json>)` 到自己的 stdout。**也就是没有配置任何寻呼、Slack 或 PagerDuty；要看到告警，得去读容器日志。** 路由参数：`group_by: [alertname, service]`、`group_wait` 30s（critical 10s）、`group_interval` 5m、`repeat_interval` 4h（critical 1h）、`resolve_timeout` 5m，并有一条"同一告警的 critical 抑制 warning"的 inhibit 规则。配置文件里那段 `slack_configs` 是注释掉的示例。

值得在面板上画出来的指标族（按声明处数）：API 侧 `apps/api/src/lib/metrics.ts` 声明 28 族，Worker 侧 `workers/ai-worker/src/lib/metrics.ts` 声明 15 族，sidecar 3 族。常用的几组：

| 想看的 | 指标 |
| --- | --- |
| API 存活/就绪与流量 | `astella_readiness_status`、`astella_http_requests_total`、`astella_http_errors_5xx_total`、`astella_http_request_duration_seconds`、`astella_sse_active_streams` |
| 队列是否堵 | `astella_job_queue_depth{status="pending"}`、`astella_job_oldest_pending_age_seconds`、`astella_job_terminal_total`、`astella_job_lease_lost_total`、`astella_job_non_retryable_dead_total` |
| 模型调用与配额 | `astella_provider_calls_total`、`astella_provider_call_duration_seconds`、`astella_provider_call_tokens_total`、`astella_ai_circuit_open_total`、`astella_ai_circuit_observer_healthy` |
| 租户隔离与库健康 | `astella_db_rls_denied_total`、`astella_db_transaction_failures_total`、`astella_db_pool_active_connections`、`astella_db_migration_version` |
| 学习闭环推进 | `astella_learning_run_processing_outbox_depth`、`astella_learning_run_processing_outbox_oldest_pending_age_seconds`、`astella_learning_run_critic_fail_closed_total`、`astella_funnel_events_total` |
| 备份是否真的可用 | `astella_backup_verified_manifests_total`、`astella_backup_manifest_scan_errors`、`astella_db_last_successful_backup_timestamp`（后一个在深度校验通过前**根本不出现**） |

日志侧：pino 从 `LOG_LEVEL` 读级别，默认 `info`（可选 `trace`/`debug`/`info`/`warn`/`error`/`fatal`）；非生产且不在测试上下文时挂 `pino-pretty`。真正的落点仍是 stdout，由容器运行时收集。**进程内另有一条有界环给 `/admin` 的日志页用**：`apps/api/src/lib/log-buffer.ts` 通过 pino 的 `hooks.logMethod` 在序列化**之前**捕获，所以 `scope` / `runId` / `workspaceId` 字段还在。它是两条独立的环——应用日志默认 500 条（`ADMIN_LOG_BUFFER_SIZE` 可调，上限 5000），请求/访问日志固定 300 条。这条缓冲**不是审计日志**：重启即清空、不落盘、不可检索、不导出，跨重启追因仍要走 stdout 与审计表。

## 备份与恢复

脚本都在 `infra/backup/`，由 `backup-runner` 容器（`infra/backup/Dockerfile.backup`，基于 alpine）承载。

| 脚本 | 职责 |
| --- | --- |
| `setup-backup-infrastructure.sh` | 生成 age 密钥对、建独立的备份 bucket、校验访问权限。age 公钥与私钥的路径由它打印 |
| `backup.sh` | `pg_dump`（custom format，一致性快照）→ SHA-256 → 用 age 公钥信封加密 → 上传 S3 → 写 manifest JSON（记 release / commit / migration / 校验和）。缺 `age` 或 S3 时有本地目录回退分支，**那条分支的产物不能当可发布证据** |
| `rotate.sh` | 保留最近 14 份 daily 与 4 份 weekly；**只删 `verificationStatus=verified` 的超期备份**，未验证的一律留着 |
| `restore.sh` | 下载 → age 私钥解密 → 恢复到目标库。目标必须通过安全 allowlist 检查，不允许指向生产主机/库名 |
| `rc-restore-verify.sh` | 端到端验证：新建一份备份 → 恢复到隔离库（Alpha 流程里目标主机写的是网络别名 `restore-postgres`）→ 比对迁移末端与核心表行数 → 用 `infra/postgres/roles.sql` 复核角色姿态 → 产出 RC 报告 |
| `freshness-check.sh` | 扫描 manifest 目录，找最近一次 `verificationStatus=verified` 的备份，超过阈值（默认 24 小时）就以非零码退出，`AstellaBackupStale` 因此亮起 |
| `alpha-backup-cron.sh` + `alpha-cron-setup.sh` | 每 12 小时的调度：`backup.sh` → `rotate.sh` → `freshness-check.sh`，日志到 `/var/log/astella/backup-cron.log`。**这两个脚本没有被 make 目标或 compose 接线**，需要在宿主机上显式安装 crontab |
| `backup-scripts.test.sh` | 这组 shell 脚本自身的测试（manifest 形状、rotate 保留策略、restore 的 allowlist 拒绝、`manifest.schema.json` 校验）。以前只能 `bash infra/backup/backup-scripts.test.sh` 手动跑、没有任何自动链路调用它；2026-10-07 起它同时挂在 `make verify` 与 `main-ci.yml` 的 `Backup scripts` job 上，两边缺一侧就会被 `ci-workflow-contract` 判红 |

运维上必须区分两件事：`make alpha-backup` 只是产出一份加密备份与 manifest；`make alpha-restore-verify` 才是"这份备份真能恢复出来"的证据，而 `AstellaBackupStale` 看的是**已通过深度校验**的最近时间戳。只跑备份不跑恢复校验，这条告警会因为指标根本不出现而**永不触发**——它不会替你说"没问题"。

## 数据库：卷保护与角色姿态

开发库的卷刻意放在 Compose 生命周期之外：`docker-compose.dev.yml` 声明 `dev_postgres_data` 为 `external: true` 且固定名字 `astella-dev_dev_postgres_data`。`make up` 依赖 `ensure-db-volume`，卷不存在时按 `com.astella.protected=true` / `com.astella.purpose=postgres-data` 两个标签创建它。因此 `make down`、删容器、以及 `docker compose down -v` **都删不掉它**。真正清空只有一条带确认的路：

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB   # 值不对就打印取消信息并以 2 退出，不动任何数据
```

删之前先完成备份。需要隔离环境跑集测时用一次性库（`make disposable-db` / `bash scripts/dev-disposable-db.sh`），脚本只删/建匹配 `astella_*` 且不等于 `astella` 的库名。生产与 Alpha 用的是**普通命名卷**（`astella_postgres_data` / `astella-alpha_postgres_data`），没有 external 保护，也不由 Makefile 管理。

角色与隔离的姿态（完整口径见 [API 与数据](./api-and-data.md)）：三个应用角色都由 `infra/postgres/apply-roles.sh` + `roles.sql` 创建，全部 `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`；`astella_migrator` 带 `BYPASSRLS` 并拥有表、序列、视图与类型（迁移需要 DDL），`astella_api` 与 `astella_worker` 是 `NOBYPASSRLS`、没有 DDL 权限。业务请求在事务里设 `app.workspace_id` / `app.user_id`，由 FORCE RLS 收窄可见行；跨边界动作（登录、令牌解析、空间列表、兑换邀请码）走 actor 事务。这套约定的当前缺口由 `schema-isolation-gate-postgres.integration.ts` 以棘轮方式登记：**89** 张带 `workspace_id` 的表还没有指向 `workspaces` 的外键（清单只能缩短），而"RLS 未启用"的基线自迁移 0257 之后**是空的并且必须一直是空的**。dev、CI 与 prod 现在都是受限角色形状——超级用户会绕过 RLS，让隔离断言变成假通过。

## 面向运维者的安全姿态

可以据此设防的既有事实：

- **容器非 root（生产）**：`api`、`worker`、`migrate`、`seed-owner` 都设 `user: node`，prod 镜像 stage 自带 `USER node` 与 `chown -R node:node /app`；`edge-tts` 用 `user: nobody`；`docker-compose.yml` 与叠加层里的每个服务都带 `security_opt: [no-new-privileges:true]`。
- **端口默认只发回环**：上表所有宿主映射的 bind 地址默认 `127.0.0.1`，dev 的 edge-tts 更是把 `127.0.0.1` 写死。对外暴露要显式改 `*_BIND_ADDRESS`。
- **`/metrics` 无鉴权**：`apps/api/src/server.ts` 的 `app.get("/metrics")` 没有 preHandler，代码注释直接写明"不需要认证，但应在生产环境通过网络策略限制访问（仅 Prometheus scraper 可达）"。边界是**网络层**，不是应用层：这一层的责任在部署方的防火墙/安全组，仓库里没有替你做完。worker 的 9100 与 sidecar 的 8080 同理（sidecar 不发宿主端口）。
- **`/admin` 未配置即不存在**：`apps/api/src/modules/admin/auth.ts` 的 `MIN_ADMIN_TOKEN_LENGTH = 16`，低于 16 个字符**或**含 `change-me` / `changeme` / `placeholder` / `example` / `your-token` / `your_token` / `todo` 任一子串的令牌都视为未配置；此时 `adminRoutes()` **不注册任何路由**（不是注册后拒绝），面板在端口扫描与 Fastify 路由表里都不存在。令牌走 `x-admin-token` 头或 `Authorization: Bearer`，比较用常量时间。挂载前缀由 `ADMIN_PANEL_PATH` 决定，默认 `/admin`，非法形状回落并告警——前缀是混淆**不是鉴权**。dev compose 给了一个足够长的固定默认值并挂了 `docker.sock`，因此本机面板是可用的，且能看容器状态、start/stop/restart。
- **HTTP 基线**：`onSend` 全局补 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`；会话 Cookie 是 HttpOnly + `SameSite=Lax`，`Secure` 由 `AUTH_COOKIE_SECURE` 决定。
- **桌面客户端**：主进程对响应头做 CSP 三路分流（主文档 / 产物 origin / 其余一律 `rejectAll`，并先删掉上游同名头）；窗口 `contextIsolation: true` + `sandbox: true`；`connect-src` 收紧到 `'self' blob:` 一类。安装包另外排除 `out/renderer/assets/3d**` 与 `out/renderer/models**`，语音识别模型不进包（用户自己在设置里下）。

**目前还没做的事**，按现在仓库状态：

- TLS 终结由 `docker-compose.deploy.yml` 的 Nginx 提供，IP 证书与续期见 [部署说明](./deployment.md)。单独使用基础生产 Compose 时仍需要 TLS 代理。
- 没有密钥管理器：PostgreSQL 与对象存储凭据通过环境变量注入，`docker inspect` 可见（`docker-compose.yml` 末尾的 SEC-18 备注明写这一点，并提醒"只加 `secrets:` 配置而不改应用代码不会生效"）。
- macOS ad-hoc 包仍需用户确认首次启动；真实 ShipIt 替换安装需要单独验收。
- 没有邮件自助找回密码：`apps/api/src/modules/identity/routes.ts` 只有 `POST /auth/change-password`（验证旧密码并撤销全部会话）和 `POST /auth/recovered-users/:userId/reset-password`（需 `requireSession + requireOwner`，给被恢复的用户初始化口令）。忘记密码只能请工作区 Owner 处理。
- 没有自动扩缩容方案：三份 compose 都是单机编排（`restart: unless-stopped`），`AUTH_RATE_LIMIT_STORE=postgres` 只是让限流在多副本下不失真，不代表仓库提供了扩缩容链路。

Tag 自动部署、私有配置、IP HTTPS 和迁移回退流程见 [部署说明](./deployment.md)。服务端 tag 现在通过 CI 构建并推送 GHCR 镜像，以 digest 部署；`docker-compose.deploy.yml` 提供 Nginx TLS 终结配置。

## 已知的运维缺口

以下都在本次核对中确认过，不是推测：

1. **`infra/prometheus/alerts.yml` 里 5 条告警永远不会触发**：`AstellaHighProviderErrorRate`、`AstellaProviderSchemaFailure`、`AstellaProviderQuotaExceeded` 依赖 `astella_provider_errors_total`，`AstellaSearchIndexDrift` 与 `AstellaHighSearchDriftRatio` 依赖 `astella_search_drift_total` / `astella_search_documents_total`——这四个指标族在 `apps/api`、`workers/ai-worker`、`packages` 的源码里**没有任何生产者**（全仓 grep 只在 `alerts.yml`、`prometheus.yml` 注释和归档审计文档里出现）。规则文件本身没被 `--web.enable-lifecycle` 之外的任何检查校验过。
2. **没有告警出口**：`log-receiver` 只把告警 POST 给 sidecar 打印到 stdout。没有 Slack / PagerDuty / 邮件 receiver，因此"告警响了"这件事本身需要有人主动去看日志或 Prometheus UI。
3. **`verify-alerts-syntax.mjs` 没接线**：它本来会校验规则形状与重复告警名，并提示 15 个必需指标里有哪些没被 `alerts.yml` 引用，但它不在 `verify`、`release-check`、任何工作流或包脚本里。同样未接线的还有 `verify-shared-exports.mjs`（专防"文件存在但 `exports` 没登记、typecheck 绿而运行时 `ERR_PACKAGE_PATH_NOT_EXPORTED`"这一类）、`coverage-baseline-save.mjs`、`capture-image-digests.mjs`、`.github/ci/ai-platforms.mock.json`。
4. **镜像 digest 链路是断的**：`release-manifest-generate.mjs` 支持 `--images` 读取 `capture-image-digests.mjs` 的产物，但 `make release-manifest` 与 `make release-check` 都没传这个参数，所以 RC manifest 的镜像字段走占位符分支。新 tag 部署流程会构建 GHCR 镜像并以 digest 部署；旧 RC manifest 工具仍未接入这些 digest，镜像扫描仍未接入。
5. **迁移生命周期没有自动验证**：全新库迁移、重复迁移、旧版本升级迁移这三类曾属于 CI，现在只能靠 `make up` / `make alpha-up` 的一次式 `migrate` 顺带覆盖，`test:db-integrity:postgres`（含 `db-migrations.integration.ts`）需要显式在一次性库上跑。
6. **备份调度要手工安装**：`alpha-cron-setup.sh` 与 `alpha-backup-cron.sh` 不在 make/compose 链路上，`rotate.sh` 也没有目标；`make alpha-backup` 是单次动作，不做保留轮换。第一次搭 Alpha 时 `init` 与 `freshness` 两步只能直接调脚本。
7. **环境模板仍需填真实必填项**：`EDGE_TTS_AUTH_TOKEN` 已在 `.env.example` 中显式列出，复制模板后需要填值；数据库密码、角色 URL 和存储密码也不能留空。
8. **`scripts/alpha-env-setup.sh` 的文件头声称 Alpha 包含 "PostgreSQL + API + Worker + Web + MinIO"**：生产 compose 里没有 `web` 服务，也没有任何 Web 容器（`apps/web` 已整包移除）。按这份头去排查会找不到目标。
9. **dev 栈的容器不是非 root**：`docker-compose.dev.yml` 不给 `api`、`worker`、`postgres`、`minio`、`migrate`、`seed-demo` 设 `user:` 或 `security_opt`，而 `api` 容器还挂了 `/var/run/docker.sock`（等价宿主机 root）。这是本机开发换取热重载与面板能力的取舍，**不要把 dev 文件当生产模板**；`no-new-privileges` 只在 `edge-tts` 与叠加层的四个服务上成立。
10. **`docker.sock` 挂载与 `/admin` 的容器操作能力没有单独的审计视图**：面板可以 start/stop/restart 容器，这条能力只由 `ADMIN_PANEL_TOKEN` 一个闸守住。

## 相关分册

- [手册首页与总览](./overview.md)
- [架构](./architecture.md)
- [开发环境](./development.md)
- [桌面客户端](./desktop-client.md)
- [API 与数据](./api-and-data.md)
- [模型与 Worker 链路](./ai-and-companion.md)
- [统一 Agent 运行时（技术）](./agent-runtime.md)
- [伴星体验（产品设计）](./companion-experience.md)
- [测试与质量](./testing-and-quality.md)
- [常见问题与排障](./faq-and-troubleshooting.md)
- 仓库根：[README](../../../README.md)、[AGENTS.md](../../../AGENTS.md)、[第三方声明](../../../THIRD_PARTY_NOTICES.md)
- 方案索引：[docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md)
