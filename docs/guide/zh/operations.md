# 运行与发布

中文 · [English](../en/operations.md)

本机开发、服务器部署和 Alpha 验证使用不同的配置。首次开发见 [开发环境](development.md)，服务器步骤、HTTPS、SSH 与远程对象存储见 [部署说明](deployment.md)。本页整理版本、运维、备份与监控的职责。

## Compose 的分工

| 配置 | 用途与数据 |
| --- | --- |
| `docker-compose.dev.yml` | 本机开发，项目 `astella-dev`；源码热重载、本地 MinIO、开发账号和回环端口；`make up` 默认启用 storage |
| `docker-compose.yml` | 生产基础：API、Worker、PostgreSQL、迁移与 edge-tts；远程存储配置，不含本地 MinIO |
| `docker-compose.deploy.yml` | 正式部署叠加：GHCR digest 镜像、Nginx HTTPS、远程 S3、运维 socket 与部署配置 |
| `docker-compose.alpha.yml` | Alpha 叠加：项目 `astella-alpha`，本地 MinIO、监控与备份；不能单独运行 |

开发文件不叠加生产基础。Alpha 通过 `scripts/alpha-env-setup.sh` 使用生产基础和 Alpha 文件；正式服务器不加载 Alpha。对象存储切换与备份必须同时考虑数据库引用和对象本体。

初始化顺序为 **role-bootstrap → migrate → role-grants → API／Worker**，应用依赖授权成功退出。`seed-owner` 是显式的一次性操作，缺生产邮箱／密码或密码少于 12 字符即失败；生产禁用演示播种。迁移和授权每次部署重新执行，空闲时幂等。

## 配置与边界

| 组 | 变量与行为 |
| --- | --- |
| 数据库 | `POSTGRES_PASSWORD`、三角色密码、`DATABASE_URL_MIGRATOR`／`_API`／`_WORKER`；生产必填，角色原始密码与 URL 中编码后的值一致 |
| 客户端连接 | `DESKTOP_API_ORIGIN`、`ASTELLA_DOMAIN_SCHEMA_REVISION`、配置修订；local_loopback 还需配对 Key ID／密钥，remote_https 使用 HTTPS 信任 |
| 模型 | `config/ai-platforms.json` 引用供应商环境变量；密钥只在服务端，新增变量需显式透传 Compose |
| AI 治理 | 用户账号的同意与外发政策，联网搜索另有默认关闭的账号开关；生产未配置真实 provider 时不应以 mock 保存假内容 |
| 对象存储 | `STORAGE_MODE`、两个 endpoint、桶、区域、访问密钥；remote 不回退 MinIO 凭据；本机开发固定 local |
| 语音 | `EDGE_TTS_AUTH_TOKEN` 为 API 与 edge-tts 共享必填令牌；Qwen 及语音开关按配置启用 |
| 运维 | `ADMIN_PANEL_TOKEN`、面板路径与日志缓冲；未配置有效令牌不注册面板，部署叠加可提供 Docker socket |
| 执行预算 | handler／provider 超时、并发和制卡预算；运行中续租，见 [模型链路](ai-and-companion.md#超时阶梯) |

`.env.example` 是变量模板，不是可直接用于生产的配置。真实密码、Key、SSH 密钥与生产环境文件不提交仓库。安装包的 HTTPS 地址和协议修订是公开连接配置；本机配对密钥不应打入远程安装包。

能力默认值会影响端点是否可用：生产的学习运行、制卡和语音增强默认与开发不同。以 Compose 的可执行 environment 与 `.github/scripts/verify-companion-capability-config.mjs` 为准，不从旧方案或 `.env` 中未被透传的值推断已开启。

## 统一版本与发布

`release/version.json` 维护 `version` 与非空 `notes` 数组。仓库根首次 `npm ci` 后：

```bash
npm run release:prepare
npm run release:check
```

prepare 同步 API、Worker、shared、desktop 的 package.json／lockfile 和中文 README 版本标记，预览 GitHub 发布说明；英文 README 的版本显示同步维护。内部包可以保留内部版本。

提交准备好的改动，用带注释的 `v<版本>` tag 触发发布。服务端 CI 全部通过后复用 `server-deploy.yml`，构建 GHCR 镜像并以 digest 部署；桌面由独立 release 工作流完成质量、打包与更新清单验证。

| 桌面平台 | 本地打包 | 自动安装包发布 |
| --- | --- | --- |
| macOS | `package:mac:arm64`／`package:mac:x64`，dmg + zip | 当前工作流覆盖 |
| Windows | `package:win:x64`，NSIS | 当前工作流覆盖 |
| Linux | `package:linux:x64`，AppImage | 可单独打包，当前统一发布工作流未覆盖 |

打包配置使用 `electron-builder.config.cjs` 加 YAML。产物前缀为 ASCII `astella-`，更新器直连 GitHub Releases，与 API 是否可用分开。无 Apple 证书使用 ad-hoc 签名，首次启动仍可能需系统允许；签名通过不等于真实跨版本替换已验收。

`make release-check` 运行发布输入、verify、覆盖率与清单检查；skip/todo 需单独执行。现有 RC manifest 工具未自动取得 Tag 部署的镜像 digest，不能用占位字段作为验收证据。门禁边界见 [测试与质量](testing-and-quality.md)。

## Alpha 与备份

`make alpha-up`／`alpha-down`／`alpha-status`／`alpha-metrics`／`alpha-backup`／`alpha-restore-verify` 转调 Alpha 脚本。首次基础设施初始化和备份新鲜度检查直接执行：

```bash
./scripts/alpha-env-setup.sh init
./scripts/alpha-env-setup.sh freshness
```

应用会连接的操作需完整角色 URL 和密码；查看／停止可采用脚本的惰性占位解析，不能据此认为凭据有效。

| 工具 | 结果 |
| --- | --- |
| `infra/backup/backup.sh` | 数据库 dump、SHA-256、age 加密、对象上传与 manifest |
| `restore.sh` | 校验目标 allowlist 后解密并恢复到指定隔离库 |
| `rc-restore-verify.sh` | 备份、恢复、迁移与核心数据／角色核对，生成恢复验证报告 |
| `rotate.sh` | 按保留规则清理已验证的超期备份；未验证的保留 |
| `freshness-check.sh` | 检查最近已验证备份的时间 |
| `alpha-cron-setup.sh`／`alpha-backup-cron.sh` | 需手动安装的调度，不由 Compose 或 `make alpha-up` 自动配置 |

`alpha-backup` 只证明产生了备份，`alpha-restore-verify` 才验证恢复；纯脚本自测也不执行真实备份。数据库 dump 不包含全部长期 S3 对象，须另行备份对象和恢复所需私有配置。同机迁移前 dump 不能代替异机备份。

SOURCE_MIGRATION 描述被验证备份的迁移版本；未覆盖时脚本取当前 journal 末端。模板中的旧值是示例，不应据此修改现有备份身份。

## 数据卷与角色

开发 PostgreSQL 卷 `astella-dev_dev_postgres_data` 为 external，Compose down／down -v 不自动删除它。项目的显式重置入口是：

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB
```

该命令永久删除开发数据库并重启。MinIO 和生产／Alpha 普通命名卷没有同一保护，不能将开发库的保留规则推广到所有数据。集测使用一次性库，先确认目标名称。

数据库角色由 `infra/postgres/roles.sql` 补授：migrator 拥有结构且可绕过 RLS，API／Worker 无 DDL、NOBYPASSRLS，业务事务设置用户／空间上下文。迁移中的 GRANT 不能代替部署后 roles.sql 的授权。

## 监控与运维面板

Alpha Prometheus 抓取 API、Worker、备份 sidecar 和自身指标，Alertmanager 当前只发 webhook 到 sidecar 日志，没有寻呼／邮件接收器。告警必须核对指标生产者：provider error 和 search drift 的部分规则缺生产指标，不能从没有告警推断正常。

API／Worker 的 metrics 无应用鉴权，应限制网络可达性；正式 Nginx 不公开 `/metrics`。Worker 开发 healthcheck 读取 `/metrics`，而真实依赖探测在 `/ready`，容器 healthy 不等于库可用。

面板令牌独立于用户会话，日志缓冲是进程内有界状态，重启清空，不等于持久审计。基础生产配置不挂 socket；开发及正式部署叠加会给 API socket 能力，权限等同宿主机管理，详见 [部署说明](deployment.md)。面板的项目范围检查不能把原始 socket 变成受限凭据。

运维限制还包括：无密钥管理器、无自动扩缩容、无邮件自助密码恢复；备份调度和告警出口需部署者配置，镜像／密钥扫描与迁移生命周期测试按用途显式执行。服务器部署失败可尝试恢复旧应用镜像，但数据库迁移不自动撤销。

[手册索引](../README.md) · [服务器部署](deployment.md) · [API 与数据](api-and-data.md) · [常见问题](faq-and-troubleshooting.md)
