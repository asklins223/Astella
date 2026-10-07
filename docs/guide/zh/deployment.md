# Tag 发布与服务器部署

推送统一的 `v<版本>` tag 同时触发两端发布，版本唯一来源为 `release/version.json`。

桌面端：Windows x64 与 macOS 构建安装包，同时验证桌面质量与打包启动；全部成功并检查更新清单后才公开 GitHub Release。单独手动运行 Desktop package 仍可取得测试安装包。没有 Apple 证书时使用完整 ad-hoc 签名和稳定的跨版本更新要求，macOS 首次打开仍可能需要在隐私与安全中允许；Windows 覆盖安装分支仍未在无头 runner 上验证。

服务端：现有 CI 的测试全部成功后调用 Server deploy，构建 Linux amd64 的 API、Worker 和 TTS 镜像推送 GHCR，以 digest 记录镜像，再通过 SSH 部署该 tag 的确切提交。版本必须与 `release/version.json` 一致，使用 `.github/scripts/version-contract.mjs --write` 同步版本副本。部署串行执行，不打断正在迁移的任务。重新部署可在 GitHub 重跑该 tag 的 CI。

## 私有配置

GitHub 的 `production` Environment 只允许 `v*` tag，存放 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。SSH 必须验证预先登记的服务器主机密钥；授权密钥限制为 `deploy <40位提交SHA>` 强制命令，禁止交互式 shell、端口转发和 SCP。部署接收器及部署程序安装在 `/usr/local/lib/astella`，由服务器管理员更新。

应用 `.env` 只保存在服务器 `/etc/astella/production.env`，权限 `600`；真实 API Key 不进入 GitHub、镜像、artifact 或安装包。GitHub Token 仅在部署 job 内用于拉取 GHCR 镜像，临时 Docker 登录目录在退出时删除。公开仓库中的脚本只有变量名和通用逻辑；不要开启 `set -x` 或输出 Compose 展开后的配置。

仓库 Secrets 的 `DESKTOP_API_ORIGIN` 与 `ASTELLA_DOMAIN_SCHEMA_REVISION` 提供正式安装包的公开连接配置。安装包只包含 HTTPS 地址、协议修订和配置版本。**客户端必须知道服务器地址，因此地址最终能从安装包和网络连接中读取；API Key、数据库密码、SSH 私钥才是需要保密的凭据。** HTTPS IP 地址受支持，不需要关闭证书验证。

## 单机部署生命周期

生产 Compose 使用 `docker-compose.yml` 加 `docker-compose.deploy.yml`，以固定项目名 `astella` 保留 PostgreSQL volume；线上资源存放在私有 S3 兼容对象存储，本地 MinIO volume 独立保留。数据库、Worker 指标只在内部网络或回环地址；Nginx 对外提供 443，80 仅提供 ACME challenge；外部 `/metrics` 返回 404。SSE 与 WebSocket 通过代理，认证 Cookie 保持 Secure。

每次部署先拉取镜像、检查配置和基础服务，再在 `/opt/astella/backups` 保存迁移前的数据库 dump。API 与 Worker 优雅停机后执行角色引导、数据库迁移及权限补授，随后验证 API、Worker、Nginx 与公网 HTTPS readiness，最后更新 `/opt/astella/current`。失败时尝试重新启动上一版应用镜像；**数据库迁移不会自动撤销**，需要依据迁移兼容性决定是否从备份恢复。备份位于同机，不能代替异机备份，删除服务器或磁盘会同时失去数据和这些 dump。

首次部署后显式运行 `seed-owner`，使用服务器环境里的 Owner 账号，不自动创建演示账号。运行部署命令和排障日志时不要打印密码或完整环境文件。

IP 证书通过 Certbot 的 shortlived profile 签发，约六天有效。服务器安装 `infra/deploy/renew-certificate.sh`，每八小时运行一次并重载 Nginx。通过 `certbot renew --dry-run` 验证续期；80 与 443 必须在云安全组中开放。

正式长期运营应使用仍受支持的 Linux 和 Docker Engine。CentOS 7、Ubuntu 16.04 等旧系统只用于迁移验证；迁移应用不等于更新宿主系统。

更换服务器时，先准备运行环境和新地址的 HTTPS，再优雅停止旧 API、Worker 与 MinIO 的写入，保存最终数据库 dump、MinIO 文件和受限环境文件。数据库恢复后核对各表行数，文件迁移后核对校验值；新端登录和空间访问通过后，才切换 GitHub `production` 的主机、端口、部署密钥与主机密钥。固定版本的 MinIO 镜像可从旧端迁移并核对镜像 ID，后续部署只在本地缺少该版本时拉取；应用镜像仍按 CI 指定的 digest 拉取。

客户端安装包携带公开的 API 地址。服务器切换后更新 `DESKTOP_API_ORIGIN` 并重新打包；过渡期可以让旧地址通过验证证书的 HTTPS 代理转发到新端，旧 Worker 保持停止，避免两端分别处理任务。确认用户换用新包之后，再停用旧主机。

## 线上对象存储与本地隔离

`docker-compose.deploy.yml` 明确选择 `STORAGE_MODE=remote`，API 与 Worker 使用同一套远程配置，不启动 MinIO，也不回退本地凭据。以下配置只写入服务器 `/etc/astella/production.env`，不要写入仓库或客户端：

```dotenv
STORAGE_MODE=remote
STORAGE_ENDPOINT=https://cn-nb1.rains3.com
STORAGE_PUBLIC_ENDPOINT=https://cn-nb1.rains3.com
S3_REGION=us-east-1
S3_BUCKET=astella
STORAGE_ACCESS_KEY_ID=<服务端访问密钥>
STORAGE_SECRET_ACCESS_KEY=<服务端私有密钥>
```

桶保持私有；为 `temporary/` 前缀设置一天后过期的生命周期规则。长期资源位于空间／用户前缀，导出与未完成上传位于 `temporary/`。更换提供商时同步修改两个 endpoint 和客户端可用的 HTTPS 源；密钥可限制在目标桶及读、写、复制、删除、列举权限。生命周期管理可用单独的管理员凭据。

新版桌面端通过 `/storage/transfers/config` 取得模式与允许的源，向 API 申请限时签名 PUT，上传后调用完成接口。API 校验原文与图片，再复制到不可被旧 PUT 覆盖的最终对象。下载与导出先校验会话和资源权限，再发短期签名 GET；对象请求不携带 API token 或 Cookie。旧客户端仍可通过 API 转发上传与下载，但这部分流量仍占服务器带宽；重新打包并更新客户端后才能获得直传节省。

Worker 解析文本来源时读取远程原文并验证 SHA-256。工作区 JSON 导出会带回来源原文；导出对象最多 256 MiB，上传遵循原有各类资源上限。数据库、对象存储与下载到本机的副本承担不同职责，备份必须同时覆盖数据库和长期对象。

本地 `docker-compose.dev.yml` 固定 `STORAGE_MODE=local`、`http://minio:9000`，继续使用本地 `.env` 的 MinIO 配置；本地客户端 `local_loopback` 直接沿原容器上传链路。不要把生产远程配置覆盖到本地 `.env`。线上切换前先停止写入、核对旧桶对象并迁移，再保存数据库与环境文件备份；切换失败时一并恢复旧环境及应用镜像，旧 MinIO volume 暂不删除。

真实存储集测独立运行 `npm --prefix apps/api run test:object-storage:s3`，不混入不需要外部存储的 `make test-postgres`。先准备迁移完成且授权已补齐的可丢弃 `astella_storage_it_*` 数据库，分别设置受限角色的 `DATABASE_URL_API`、`DATABASE_URL_WORKER` 与管理员的 `DATABASE_URL_TEST_ADMIN`，再在受限环境文件中提供远程存储配置。集测只创建模拟内容并清理对应对象前缀；结束后删除该临时数据库。不要使用生产数据库或提交环境文件。

## macOS 无证书构建

打包使用 `electron-builder.config.cjs`，在 ZIP 和 DMG 创建之前完成签名。有 Developer ID 时保留证书签名；没有时先由 electron-builder 签完整嵌套包体，再把主应用指定要求固定为 `identifier "com.asklins.astella"`。这是 [word-tts-desktop 构建流程](https://github.com/asklins223/word-tts-desktop/blob/main/build_electron.sh) 使用的更新方式。`scripts/check-macos-update-signature.cjs` 用两份内容不同的真实二进制验证跨版本要求，并确认篡改签名后的资源会失败；最终 ZIP 与 DMG 中的应用都必须通过签名检查。

签名完整性、跨版本要求和系统首次启动许可是不同的检查。ad-hoc 不提供 Apple 开发者认证，也不会消除首次打开的用户确认。`v1.0.0` 原始安装包发布时跳过了重签名；这次流程修复不会自动改变已发布资产。从旧损坏包升级到修复包需要手动安装一次；真实更新替换的结果单独记录，不能用 `codesign` 通过代替。
