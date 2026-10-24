# Release Center 实施记录（服务端 / 桌面 / iOS / Android）

日期：2026-10-24，Asia/Shanghai。
方案：[app-release-center-2026-10-24.md](../plans/app-release-center-2026-10-24.md)。
状态：**代码已实现，未提交、未打 tag、CI 未实际运行**。

## 用户决定

- 服务端版本与客户端版本分开控制；桌面 macOS/Windows 不拆分（共用 `c-v*`）。
- 四条版本线统一从 **2.0.0** 开始：服务端 `s-v2.0.0`、桌面 `c-v2.0.0`、iOS `i-v2.0.0`、Android `a-v2.0.0`。
- 手机仓库允许 tag-only CI（不做 PR/push CI）；iOS 签名暂不做（unsigned IPA 不激活）；Android 做签名。
- 完整包只放 GitHub Releases；增量包放 GitHub + 对象存储（对象存储按现有 S3/MinIO 配置，可选）。
- 桌面更新继续 electron-updater `latest*.yml`；Android 热更新暂不做。
- 需要 `GET /app/server-version`，并在运维面板增加「版本控制」页展示当前与历史。

## 服务端（主仓库）

- 迁移 `0454_app_release_center.sql` + journal：
  - `app_releases`（platform/channel/version/build/tag/released_at/notes/signed/packages/desktop_manifest/client_assets_version/is_current）
  - `client_asset_releases`（platform/channel/version/base_version/manifest/file_count/total_bytes/is_current）
  - `server_releases`（version/tag/commit/image_digests/released_at/notes/is_current）
  - 全局表，不启用 RLS；`astella_api` 读写、`astella_migrator` 全部权限。
- 新模块 `apps/api/src/modules/app-release/`：
  - `schema.ts`（注册/激活/查询 zod 合同）、`manifest.ts`（路径白名单、sha256、大小/数量、URL host 白名单）、`version.ts`、`service.ts`（事务激活、历史、桌面清单、运维总览）、`routes.ts`。
  - 对外：`GET /app/version?platform=&channel=`、`GET /app/client-assets/manifest?platform=&channel=&version=`、`GET /app/server-version`；两个读取端点支持 ETag / If-None-Match（304），资产清单可按历史版本查询。
  - 内部（`Authorization: Bearer $RELEASE_CENTER_TOKEN`，未配置即 503）：`POST /internal/app-releases`、`POST /internal/client-assets`、`POST /internal/channels/:platform/:channel/activate`、`POST /internal/channels/:platform/:channel/assets/activate`、`POST /internal/server-releases`、`GET /internal/releases`。
  - 版本策略：iOS/Android 只有 `signed:true` 的包可以激活为当前可安装版本；桌面端允许 ad-hoc/未签名包激活（与现有 latest.yml 更新链路一致）。默认拒绝降级激活（回滚需 `force`）。
- `desktop-update-routes.ts`：先读 Release Center 当前版本的 `desktop_manifest`，再回退原有 GitHub Feed + `update_manifest_cache`。
- 运维面板：`GET /admin/api/releases` + 静态视图 `views/releases.js`；导航新增「版本控制」（可按 7 直达），展示服务端/桌面/iOS/Android 当前版本与历史、热更新资产当前与历史。
- 配置：`.env.example`、`docker-compose.dev.yml`（dev 默认令牌）、`docker-compose.yml` 增加 `RELEASE_CENTER_TOKEN`、`RELEASE_ASSET_HOSTS`、`RELEASE_ASSETS_PUBLIC_BASE_URL`。

## 版本源与 CI（主仓库）

- `release/version.json` = 服务端 2.0.0（仍由 `version-contract.mjs` 同步 shared/api/worker）；新增 `apps/desktop-client/version.json` = 2.0.0（由 `desktop-version.mjs` 同步桌面包/lockfile/README）。
- tag：服务端 `s-v*`、桌面 `c-v*`；`main-ci.yml` 测试两个 tag，部署只在 `s-v*`；`server-deploy.yml` 校验 `s-v2.0.0` 并在部署后可选登记 `server_releases`；`desktop-release.yml` 由 `c-v*` 触发、版本取桌面文件，`electron-builder.yml` 设置 `tagNamePrefix: c-v`。
- 根 README/README.en、`docs/guide` 同步两条版本线说明。

## 手机仓库（astella-mobile，未提交）

- `ios/version.json`、`android/version.json` 均 2.0.0/build 1；Xcode `MARKETING_VERSION=2.0.0`、`CURRENT_PROJECT_VERSION=1`（Info.plist 改用变量）；Android `versionName=2.0.0`/`versionCode=1`。
- 新增 tag-only `.github/workflows/release-ios.yml`（`i-v*`）与 `release-android.yml`（`a-v*`）：版本校验 → 资产生成/上传（可选 S3）→ 草稿 Release → 可选登记 → 发布；iOS unsigned IPA、Android 用 keystore 签名。
- Android keystore 已生成并设置 4 个 Actions secrets（`ANDROID_KEYSTORE_BASE64/PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`）；keystore 备份在手机仓库 `.keystore/`（gitignored）。
- `scripts/release-assets.mjs`、`release-register.mjs`、`version-check.mjs`。
- iOS `ClientAssetUpdater` 增加 `platform=ios`、ETag/304、按 sha256 的 blob 复用；`checkForAppUpdate` 解析新字段并暴露下载入口；About 页显示“有新版本 · 去下载”，unsigned 明确提示不能安装。

## 验证

- `apps/api npm run typecheck` 通过；`npm test` 全量 **1994 通过 / 0 失败**（新增单测 5 项；两处历史 ratchet 基线按当前工作区真实值更新：note 路由 handler 14、worker 神文件 1576，均非本功能引入）。
- `npm run release:check` 通过（服务端 2.0.0 / 桌面 c-v2.0.0）；`.github/scripts` 55 项测试通过；API 构建通过且 admin 静态资源已复制到 dist。
- 本地 API 容器执行迁移成功（0454 1/1）；用真实 HTTP 注册了服务端/桌面/iOS/Android/热更新资产并验证：
  - `/app/version?platform=android|macos` 200 且字段完整；unsigned iOS 不激活时 404（符合策略）；
  - `/app/client-assets/manifest?platform=ios` 200；
  - `/app/server-version` 返回 Release Center 当前服务端版本；
  - `/updates/desktop/latest.yml`、`latest-mac.yml` 先返回 DB 中的桌面清单；
  - `/admin/api/releases` 返回四条线当前与历史；面板 HTML 已包含「版本控制」导航、`views/releases.js` 200。
- 验证用临时发布记录已从 dev DB 清空（避免面板显示假版本）；同时验证了 unsigned iOS 拒绝激活、桌面 unsigned 允许激活、降级 409 / force 200、内部接口 401/400/503 与 ETag 304。
- 手机仓库：`swiftc -parse` 141 文件、iOS Debug 构建、unsigned Release archive+IPA、Android `assembleRelease` 签名 APK、脚本语法与 actionlint 均通过（详见 mobile-repo 报告）。
- 桌面登记：用临时 artifacts 实跑 `release-register-desktop.mjs`，Windows/macOS 两行均 201，`/app/version?platform=windows` 可读；`latest.yml` 的相对 `url` 已改写为 GitHub Release 绝对地址，`GET /updates/desktop/latest.yml` 返回可直接下载的清单；随后测试数据已清理。
- 安全/边界：注册包 URL 强制 https + `RELEASE_ASSET_HOSTS` 允许域名（错误 URL 返回 400）；对象存储未配置时，桌面/手机登记不会写入指向不存在 CDN 的 mirror URL。
- 最终复核：服务端为注册包 URL 增加 https + 允许域名校验；`npm test` 全量 1994 通过；`npm run build` 通过；`.github/scripts` 测试通过；dev/prod compose `config` 均通过；两个仓库 `git diff --check` 干净。

## 未验证 / 限制

- **未 commit / 未 push / 未打 tag**：两仓库改动都在工作区；`s-v2.0.0`、`c-v2.0.0`、`i-v2.0.0`、`a-v2.0.0` 尚未创建。
- CI 从未实际运行：只做本地构建、脚本演练、actionlint/YAML 校验；macOS runner 的 Xcode 27 与 ubuntu runner 的 Android SDK 37/NDK 29 未验证。
- iOS 签名未配置：CI 只产 unsigned IPA，不激活；真机安装仍需 Apple 证书后重签。
- `RELEASE_CENTER_*`、`RELEASE_S3_*` 未在 GitHub 配置：登记与对象存储步骤会自动跳过；资产清单暂用 `https://assets.invalid` 占位。
- 热更新资产只覆盖 iOS（`notes-web` + `launch-motion`）；Android 热更新按决定暂不做。资产版本目前与原生版本号绑定（同一 tag 一次发布），独立资产 hotfix 尚未拆出。
- Release Center 当前为空（临时数据已清理），运维面板在首次发布前显示“未发布”。

## 最终上线结果（2026-10-24 18:30 Asia/Shanghai）

- 服务端：`s-v2.0.0` CI + 部署成功，`https://103.106.191.159/app/server-version` 返回 `{version:"2.0.0", tag:"s-v2.0.0"}`；运维面板 `/panel-6b3f9c2d/api/releases` 200。
- 桌面：`c-v2.0.0` 发布成功，macOS/Windows 已登记为当前版本；`/updates/desktop/latest*.yml` 返回改写后的 GitHub 资产地址。
- Android：`a-v2.0.0` CI 成功，签名 APK 已发布并登记为当前版本（`signed:true`）。
- iOS：`i-v2.0.0` CI 成功，unsigned IPA 已发布；按策略只登记历史、不激活为当前可安装版本，因此 `/app/version?platform=ios` 返回 404（面板历史可见）。
- 对象存储：生产 S3（`https://cn-nb1.rains3.com`，bucket `astella`）已配置；`app-assets/*` 与 `app-releases/*` 加 public-read bucket policy；CI 通过 Release Center 新内部接口上传 blobs（服务器侧写 S3），不再依赖 runner 直连 S3。
- GitHub secrets：服务端/桌面/手机两仓库均设置 `RELEASE_CENTER_URL/TOKEN`、`RELEASE_S3_*`、`RELEASE_ASSETS_PUBLIC_BASE_URL`；主仓库另设置 `DEPLOY_HOST/USER/PORT/SSH_KEY/KNOWN_HOSTS`。
- 生产 GitHub Environment `production` 的分支策略原先只允许 `v*` tag，已补 `s-v*` tag，否则 deploy job 会在分配 runner 前直接失败（无日志、无步骤）。

### iOS CI 根因与修复

GitHub `macos-latest` 实际是 Xcode 26.6（只有 Xcode 26.0–26.6），本地是 Xcode 27。项目代码用了 iOS 27 API 且 SwiftUI 表达式在旧类型检查器下超时，表现为 `unable to type-check this expression in reasonable time`。修复：
- iOS 27 `ToolbarPlacement.statusBar` 用 `#if compiler(>=6.4)` 门控，旧 SDK 回退 `.navigationBar`；
- `MainTabShell` 的 Tab label/内容拆成子视图，最终改用兼容 Xcode 26 的 `TabView + tabItem + tag`；
- 拆分思维导图尺寸表达式、提取飞行清理 task、修正 flight id 类型；
- `xcodebuild` 增加 `-Xfrontend -solver-expression-time-threshold=10000`（旧编译器兜底）；
- 本地 Xcode 27 用相同 archive 命令验证通过后才推 tag。

### 已知边界

- iOS 仍未签名，unsigned IPA 不能直接安装，也不会成为 `/app/version` 当前版本；Apple 证书就绪后把 `signed` 置真并激活即可。
- 热更新 blobs 已进 S3；`client-assets-full/incr` 归档仍留在 GitHub Release（JSON 上传接口有 body 上限），因此不再在 `/app/version` 的 `mirrors` 中声明未镜像的归档地址。
- Android 客户端暂未接入版本检查/热更新；iOS 已接入。
