# Tag 发布与服务器部署

推送统一的 `v<版本>` tag 同时触发两端发布，版本唯一来源为 `release/version.json`。

桌面端：Windows x64 与 macOS 构建安装包，同时验证桌面质量与打包启动；全部成功并检查更新清单后才公开 GitHub Release。单独手动运行 Desktop package 仍可取得测试安装包。没有 Apple 证书时使用完整 ad-hoc 签名和稳定的跨版本更新要求，macOS 首次打开仍可能需要在隐私与安全中允许；Windows 覆盖安装分支仍未在无头 runner 上验证。

服务端：现有 CI 的测试全部成功后调用 Server deploy，构建 Linux amd64 的 API、Worker 和 TTS 镜像推送 GHCR，以 digest 记录镜像，再通过 SSH 部署该 tag 的确切提交。版本必须与 `release/version.json` 一致，使用 `.github/scripts/version-contract.mjs --write` 同步版本副本。部署串行执行，不打断正在迁移的任务。重新部署可在 GitHub 重跑该 tag 的 CI。

## 私有配置

GitHub 的 `production` Environment 只允许 `v*` tag，存放 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。SSH 必须验证预先登记的服务器主机密钥；授权密钥限制为 `deploy <40位提交SHA>` 强制命令，禁止交互式 shell、端口转发和 SCP。部署接收器及部署程序安装在 `/usr/local/lib/astella`，由服务器管理员更新。

应用 `.env` 只保存在服务器 `/etc/astella/production.env`，权限 `600`；真实 API Key 不进入 GitHub、镜像、artifact 或安装包。GitHub Token 仅在部署 job 内用于拉取 GHCR 镜像，临时 Docker 登录目录在退出时删除。公开仓库中的脚本只有变量名和通用逻辑；不要开启 `set -x` 或输出 Compose 展开后的配置。

仓库 Secrets 的 `DESKTOP_API_ORIGIN` 与 `ASTELLA_DOMAIN_SCHEMA_REVISION` 提供正式安装包的公开连接配置。安装包只包含 HTTPS 地址、协议修订和配置版本。**客户端必须知道服务器地址，因此地址最终能从安装包和网络连接中读取；API Key、数据库密码、SSH 私钥才是需要保密的凭据。** HTTPS IP 地址受支持，不需要关闭证书验证。

## 单机部署生命周期

生产 Compose 使用 `docker-compose.yml` 加 `docker-compose.deploy.yml`，以固定项目名 `astella` 保留 PostgreSQL 与 MinIO volumes。数据库、对象存储、Worker 指标只在内部网络或回环地址；Nginx 对外提供 443，80 仅提供 ACME challenge；外部 `/metrics` 返回 404。SSE 与 WebSocket 通过代理，认证 Cookie 保持 Secure。

每次部署先拉取镜像、检查配置和基础服务，再在 `/opt/astella/backups` 保存迁移前的数据库 dump。API 与 Worker 优雅停机后执行角色引导、桶初始化、数据库迁移及权限补授，随后验证 API、Worker、Nginx 与公网 HTTPS readiness，最后更新 `/opt/astella/current`。失败时尝试重新启动上一版应用镜像；**数据库迁移不会自动撤销**，需要依据迁移兼容性决定是否从备份恢复。备份位于同机，不能代替异机备份，删除服务器或磁盘会同时失去数据和这些 dump。

首次部署后显式运行 `seed-owner`，使用服务器环境里的 Owner 账号，不自动创建演示账号。运行部署命令和排障日志时不要打印密码或完整环境文件。

IP 证书通过 Certbot 的 shortlived profile 签发，约六天有效。服务器安装 `infra/deploy/renew-certificate.sh`，每八小时运行一次并重载 Nginx。通过 `certbot renew --dry-run` 验证续期；80 与 443 必须在云安全组中开放。

当前旧 CentOS 7 主机可以用于这一轮部署验证，但该系统已经停止维护。正式长期运营应迁移到仍受支持的 Linux，并使用当前 Docker Engine；迁移前备份数据库、MinIO、环境文件和证书，不能只拷贝应用代码。

## macOS 无证书构建

打包使用 `electron-builder.config.cjs`，在 ZIP 和 DMG 创建之前完成签名。有 Developer ID 时保留证书签名；没有时先由 electron-builder 签完整嵌套包体，再把主应用指定要求固定为 `identifier "com.asklins.astella"`。这是 [word-tts-desktop 构建流程](https://github.com/asklins223/word-tts-desktop/blob/main/build_electron.sh) 使用的更新方式。`scripts/check-macos-update-signature.cjs` 用两份内容不同的真实二进制验证跨版本要求，并确认篡改签名后的资源会失败；最终 ZIP 与 DMG 中的应用都必须通过签名检查。

签名完整性、跨版本要求和系统首次启动许可是不同的检查。ad-hoc 不提供 Apple 开发者认证，也不会消除首次打开的用户确认。`v1.0.0` 原始安装包发布时跳过了重签名；这次流程修复不会自动改变已发布资产。从旧损坏包升级到修复包需要手动安装一次；真实更新替换的结果单独记录，不能用 `codesign` 通过代替。
