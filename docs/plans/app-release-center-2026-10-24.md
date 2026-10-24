# App Release Center：iOS / Android / 桌面统一发布、版本与热更新（设计方案）

日期：2026-10-24，Asia/Shanghai。
状态：**已按用户 2026-10-24 决定进入实施**。最终版在本文 §16；实施记录见 `docs/testing/ios-release-center-2026-10-24.md`（待生成）。

## 1. 用户诉求

1. 服务端实现 `GET /app/version` 与 `GET /app/client-assets/manifest`。
2. 热更新内容推送到对象存储，服务端做版本控制；**客户端查询最新版本不依赖 GitHub**（国内用户可能访问不了 Git）。
3. 每次 git 打新 tag 自动触发打包：完整包 + 增量包。
4. 完整包地址仍放在 Git（GitHub Releases）；增量包同时放 Git 和对象存储。
5. 桌面端（macOS / Windows）一起纳入同一套管理，放在一个地方同时管理。

## 2. 现状与可复用资产

| 已有 | 位置 | 复用方式 |
| --- | --- | --- |
| 桌面更新清单（服务端下发，GitHub Feed → DB 缓存 → 客户端） | `apps/api/src/modules/updates/desktop-update-routes.ts`、迁移 `0406_update_manifest_cache.sql` | 保留路由，改为 **DB 优先**，GitHub 仅作过渡/兜底 |
| S3/MinIO 封装、签名下载、对象持久化 | `apps/api/src/lib/object-storage.ts`、`packages/shared/src/storage-config.ts` | 复用同一 bucket/凭证；新增版本化前缀与公开读策略 |
| iOS 热更新客户端契约 | `astella-mobile/ios/Astella/App/ClientAssetUpdater.swift` | 契约不变（manifest：version + files[path,url,byteLength,sha256]），客户端增加内容寻址缓存 |
| 桌面发版流水线（tag 触发、Windows + macOS、Draft → 公开） | `.github/workflows/desktop-release.yml`、`desktop-package.yml` | 在现有 job 之后追加 S3 镜像与 Release Center 注册 |
| 版本单一来源与 tag 约定 | `release/version.json`、`v<version>`；mobile 为 `MARKETING_VERSION`/`versionName` + `v1.0.x` | 保留；mobile 增加 `version.json` 并校验 tag 一致 |
| 客户端更新检查 | iOS `AccountMethods.checkForAppUpdate` 调 `/app/version`（当前只读 `version`） | 服务端返回结构向后兼容，客户端扩展下载入口 |

当前缺口：`/app/version`、`/app/client-assets/manifest` 没有服务端实现；热更新无上传/版本登记链路；桌面更新清单仍依赖 GitHub；手机端仓库无 tag 打包流程（此前用户要求不加 CI，本次需求实际要求 tag 自动打包，见 §12 问题 1）。

## 3. 目标与非目标

**目标**

- 一个 Release Center（服务端 DB + 对象存储 + 内部注册 API + 对外查询 API）统一管理：iOS、Android、macOS、Windows 的版本、安装包地址、热更新资产版本。
- 客户端只问自家 API 就能拿到“最新版本 + 下载地址 + 热更新清单”，运行时**不访问 GitHub**。
- tag 触发流水线自动产出完整包、增量包、更新清单，上传 GitHub Releases 与对象存储，并登记到 Release Center。
- 支持热更新资产独立发版（不要求同时发原生包）。
- 支持回滚当前版本指针，不改客户端。

**非目标（本期）**

- 不做原生代码热更新（iOS/Android 原生包只能整包升级）。
- 不把桌面 Electron 渲染层做成 Web 资产热更新（桌面继续使用 electron-updater 整包/差分更新）。
- 不做灰度发布、A/B、按用户百分比放量；先做单 `stable` 通道，预留 `channel` 字段。
- 不做在线签名；签名仍由 CI secrets/外部签名机完成。
- 不改动桌面客户端的更新 UI 结构，只切换清单来源。

## 4. 总体架构

```
                 ┌──────────────────────────── 客户端 ────────────────────────────┐
                 │ iOS / Android: GET /app/version, /app/client-assets/manifest     │
                 │ macOS / Windows: electron-updater → GET /updates/desktop/*.yml  │
                 └───────────────────────────────┬────────────────────────────────┘
                                                 │ 只问自家 API（不查 Git）
                                                 ▼
        ┌───────────────────────── Release Center (Fastify API) ─────────────────────────┐
        │ 只读路由：/app/version、/app/client-assets/manifest、/updates/desktop/:file     │
        │ 内部路由：/internal/app-releases、/internal/client-assets、/internal/channels   │
        │ 版本读取：PostgreSQL（版本、清单、当前指针、回滚历史）                          │
        └───────────────┬───────────────────────────────────────────┬───────────────────┘
                        │ 读取清单/指针                              │ 校验/登记
                        ▼                                           │
   ┌─────────────────────────────┐                     ┌──────────────▼────────────────┐
   │ 对象存储（S3/OSS/COS/R2）    │                     │ CI（两仓库，tag 触发）          │
   │ app-assets/blobs/<sha256>    │◀──── 上传资产 ─────│ mobile: ios/android + assets   │
   │ app-releases/<platform>/...  │                     │ main: macos/windows 安装包      │
   │ public-read + CDN/HTTPS      │                     │ 产物同时上传 GitHub Release    │
   └─────────────────────────────┘                     └───────────────────────────────┘
                        ▲
                        │ 完整包/增量包仍保留 GitHub 地址（canonical、归档、Artifact attestation）
                        └──────────────────────── GitHub Releases ────────────────────────
```

同步与边界：

- **PostgreSQL 是“最新版本”的唯一事实源**；GitHub 只是产物归档与来源记录，客户端不查询。
- 对象存储是热更新资产与镜像下载的主通道；GitHub Releases 保留完整包与增量包（用户明确要求），服务端 DB 同时记录 GitHub 与对象存储两种地址。
- 桌面 `latest.yml` / `latest-mac.yml` 由 Release Center 托管；electron-updater 的下载 URL 指向对象存储镜像，GitHub 地址作为清单里的兜底/人工下载。

## 5. 数据模型

新增迁移 `apps/api/src/db/migrations/0454_app_release_center.sql`，Drizzle schema 放 `packages/shared/src/db-schema/app-release.ts`（全局表，不按 workspace 隔离，不启用 RLS，授权 `astella_api`；与 `update_manifest_cache` 同级的全局数据）。

```sql
CREATE TYPE public.app_release_platform AS ENUM ('ios', 'android', 'macos', 'windows');

CREATE TABLE public.app_releases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         public.app_release_platform NOT NULL,
  channel          text NOT NULL DEFAULT 'stable' CHECK (channel ~ '^[a-z][a-z0-9-]{0,31}$'),
  version          text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'),
  build            integer NOT NULL DEFAULT 0,
  tag              text NOT NULL,
  released_at      timestamptz NOT NULL,
  notes            text,
  signed           boolean NOT NULL DEFAULT false,
  packages         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{kind:'full'|'incremental'|'blockmap'|'manifest', name, url, mirrorUrl, sha256, byteLength}]
  desktop_manifest jsonb,              -- {"latest.yml":"…", "latest-mac.yml":"…"}（仅 macos/windows）
  client_assets_version text,          -- 与本次原生包一起发布的资产版本（可空）
  is_current       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, channel, version)
);
CREATE UNIQUE INDEX app_releases_one_current
  ON public.app_releases (platform, channel) WHERE is_current;

CREATE TABLE public.client_asset_releases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform     public.app_release_platform NOT NULL CHECK (platform IN ('ios','android')),
  channel      text NOT NULL DEFAULT 'stable',
  version      text NOT NULL,
  base_version text,                   -- 增量包基线；完整清单时为空
  manifest     jsonb NOT NULL,         -- {version, baseVersion?, createdAt, files:[{path,url,byteLength,sha256}]}
  file_count   integer NOT NULL,
  total_bytes  bigint NOT NULL,
  released_at  timestamptz NOT NULL,
  is_current   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, channel, version)
);
CREATE UNIQUE INDEX client_asset_releases_one_current
  ON public.client_asset_releases (platform, channel) WHERE is_current;

GRANT SELECT, INSERT, UPDATE ON public.app_releases, public.client_asset_releases TO astella_api;
```

设计说明：

- **一张 app_releases** 覆盖四个平台；桌面两个平台各一行（macOS 存 `latest-mac.yml`，Windows 存 `latest.yml`），避免一张表里塞多平台清单。
- `packages` 用 JSONB 保存不同平台的产物列表，服务端对外只返回白名单字段；后续需要统计/审计再拆 `release_artifacts` 表。
- `is_current` 用**部分唯一索引**保证每个 (platform, channel) 只有一个当前版本；激活在一个事务里“旧 current=false → 新 current=true”。
- `client_asset_releases` 独立于原生版本：允许只发热更新资产（web hotfix），`version` 可用 `ios-2026.10.24-1` 这类单调标识；`base_version` 记录增量基线。
- 回滚 = 内部接口切换 `is_current`，不删除历史行、不删除对象存储文件。
- 服务端版本可选建 `server_releases`（version、tag、git sha、image digests、deployed_at、notes）仅供 `/app/server-version` 展示；不参与客户端更新。
- 迁移编号接在 `0453` 之后；若同时有其它迁移，按仓库现有顺序规则顺延。

## 5.1 版本线拆分（2026-10-24 用户补充决定）

服务端版本与客户端版本**分开控制**；iOS、Android 也**各自独立**。所有客户端版本都进 Release Center，服务端版本不参与客户端更新检查。

| 发布线 | 版本来源 | tag 约定 | 谁能独立发版 | Release Center 记录 |
| --- | --- | --- | --- | --- |
| 服务端（api / worker / shared） | `release/version.json`（从共享版本改为服务端专用） | **`s-v<version>`** | 服务端 | `server_releases` |
| 桌面客户端（macOS + Windows 同一产品线） | 新增 `apps/desktop-client/version.json` | **`c-v<version>`** | 桌面 | `app_releases` 的 `macos` / `windows` 两行，同一 version/tag |
| iOS | `ios/version.json`（手机仓库） | **`i-v<version>`** | iOS | `app_releases.platform = ios` |
| Android | `android/version.json`（手机仓库） | **`a-v<version>`** | Android | `app_releases.platform = android` |

要点：

- **不再共用 `release/version.json`**：它现在同时被服务端部署、桌面打包、README 版本徽章、release notes 和 version-contract 使用；拆分时：
  - `release/version.json` 只承载服务端版本（可改名 `release/server.json`，保留旧文件作为过渡别名一个版本）；
  - `apps/desktop-client/version.json` 承载桌面版本；`desktop-version.mjs` 改读它；`version-contract.mjs` 拆成 server 版（shared/api/worker/lockfile）与 desktop 版（desktop-client/lockfile）；
  - README 拆成“服务端版本 / 桌面客户端版本”两处展示；
  - `release-notes.mjs` 支持按版本线生成笔记。
- 桌面 tag 改为 `c-v<version>`；服务端部署改为 `s-v<version>`（`main-ci.yml` 的 deploy 条件、`server-deploy.yml` 的 `if` 与 version-contract 一起改）。electron-builder 的 GitHub 兜底需要 `tagNamePrefix: c-v`（若该版本不支持，则只依赖服务端 DB 清单，GitHub 兜底降级并在验收记录中说明）。
- 手机仓库两个版本文件互相独立；iOS/Android 的 tag 前缀各自独立，CI 也拆成 `release-ios.yml` / `release-android.yml`（或一个 workflow 按 tag 前缀走不同 job），一个端发版不要求另一个端同步。
- **首次拆分基线：四条版本线全部为 2.0.0**（用户 2026-10-24 决定），之后各自递增。
- 服务端版本若要展示/审计，新增 `GET /app/server-version`（只读 `server_releases` 或部署元数据）；客户端更新接口不读取服务端版本，避免再耦合。

## 6. 对象存储布局与公开访问

```
s3://<bucket>/app-assets/blobs/<sha256>                                  # 热更新文件（内容寻址，不可变）
s3://<bucket>/app-releases/<platform>/<version>/<filename>               # 完整包 / 增量 zip / 桌面安装包与 blockmap
s3://<bucket>/app-releases/<platform>/<version>/latest[-mac].yml         # 桌面更新清单快照（审计用）
s3://<bucket>/app-releases/<platform>/<version>/SHA256SUMS
```

- **热更新文件按 sha256 存储**：不同版本相同内容只存一份；清单里的 `url` 指向 `blobs/<sha256>`，客户端按 hash 复用本地缓存——这是移动端“增量下载”的核心（见 §9），也避免每个版本复制一份 10MB 的 LaunchMotion。
- 公开读取：对象存储/CDN 域名需 HTTPS 且国内可达（`RELEASE_ASSETS_PUBLIC_BASE_URL`，如 `https://assets.example.com`）。blobs 设置 `Cache-Control: public, max-age=31536000, immutable`；releases 目录同理按版本不可变。
- 清单由 API 实时返回，设较短缓存（60–300s）与 ETag；不把清单长期缓存在 CDN，保证发版后能快速切到新版本。
- 完整包建议同时镜像到对象存储（见 §12 问题 3）：GitHub 对国内用户下载不友好；即使“完整包地址放 Git”，服务端 DB 仍记录 `mirrorUrl`，客户端优先镜像、GitHub 兜底。
- 桌面 blockmap 必须和安装包放在同一可推导路径：electron-updater 会根据 `files[0].url` 推导 `<url>.blockmap`；镜像时两个文件都要上，且 yml 内 URL 指向镜像首地址。

## 7. 对外 API 契约

### 7.1 `GET /app/version`

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `platform` | 否 | `ios` / `android` / `macos` / `windows`；缺省 `ios`（兼容现有客户端） |
| `channel` | 否 | 默认 `stable` |

响应 `Cache-Control: public, max-age=60, stale-while-revalidate=300`，`ETag` 取 `platform:channel:version`，支持 `If-None-Match → 304`。

```json
{
  "platform": "ios",
  "channel": "stable",
  "version": "1.0.1",
  "build": 2,
  "tag": "v1.0.1",
  "releasedAt": "2026-10-25T06:00:00Z",
  "signed": true,
  "notes": "…",
  "downloadUrl": "https://assets.example.com/app-releases/ios/1.0.1/Astella-1.0.1.ipa",
  "mirrors": [
    { "kind": "github", "url": "https://github.com/asklins223/astella-mobile/releases/download/v1.0.1/Astella-1.0.1.ipa" }
  ],
  "sha256": "…",
  "byteLength": 31096288,
  "clientAssetsVersion": "ios-2026.10.25-1"
}
```

- 现有 iOS 只读 `version`，新字段向前兼容；客户端升级后再使用 `downloadUrl`/`notes`/`signed`。
- 没有当前版本时返回 `404 {"error":"release_not_found"}`，客户端显示“服务尚未提供可用的版本信息”（现有文案）。
- `signed=false` 的版本仍可返回（用于内测/开发），客户端不得提示安装；后端默认只把已签名版本设为 current（见 §8）。

### 7.2 `GET /app/client-assets/manifest`

查询参数：`platform=ios|android`（必填）、`channel`（默认 stable）、`version`（可查历史资产版本；缺省为当前版本）。

响应 `Cache-Control: public, max-age=300, stale-while-revalidate=600`，`ETag` 取资产版本号，支持 304。

```json
{
  "version": "ios-2026.10.25-1",
  "baseVersion": "ios-2026.10.20-2",
  "createdAt": "2026-10-25T06:00:00Z",
  "files": [
    { "path": "notes-web/reader.html", "url": "https://assets.example.com/app-assets/blobs/ab/…", "byteLength": 1234, "sha256": "ab…" },
    { "path": "launch-motion/index.html", "url": "https://assets.example.com/app-assets/blobs/cd/…", "byteLength": 5678, "sha256": "cd…" }
  ]
}
```

- 契约与 iOS `ClientAssetUpdater` 现有解码完全一致（只多 `baseVersion`/`createdAt`，`Codable` 会忽略未知字段）。
- 路径白名单：iOS `notes-web/`、`launch-motion/`；Android `launch-motion/`（当前 Android 只有开屏动效是 Web 资产）。
- 没有资产发布时返回 404；客户端继续用内置/缓存（现有行为）。

### 7.3 桌面更新清单

保留 `GET /updates/desktop/latest.yml` 与 `GET /updates/desktop/latest-mac.yml`：

1. 先读 `app_releases`（platform=windows/macos、channel、is_current、desktop_manifest）；
2. 没有则退回现有 GitHub Feed + `update_manifest_cache` 逻辑（过渡期兜底）；
3. `Content-Type: text/yaml`，`Cache-Control: public, max-age=300`。

CI 在公开 Release 后把 blockmap / `latest*.yml` 镜像到对象存储（可选），并把与平台对应的清单 body 登记到 `app_releases.desktop_manifest`；服务端优先返回 DB 清单，GitHub Feed 只作过渡兜底。

### 7.4 可选：`GET /app/releases?platform=&limit=20`

返回版本历史（不含内部字段），给官网/排障用；本期可后置。

## 8. 内部注册 API

所有内部接口：`Authorization: Bearer <RELEASE_CENTER_TOKEN>`；令牌来自环境变量，常量时间比较；未配置时路由返回 503（fail closed）；只允许 POST，body 上限 1MB；写审计日志。

### 8.1 `POST /internal/app-releases`

幂等键：`platform + channel + version`（也可用 `Idempotency-Key`）。重复提交相同内容返回 200，不同内容返回 409。

```json
{
  "platform": "ios",
  "channel": "stable",
  "version": "1.0.1",
  "build": 2,
  "tag": "v1.0.1",
  "releasedAt": "2026-10-25T06:00:00Z",
  "notes": "…",
  "signed": true,
  "packages": [
    { "kind": "full", "name": "Astella-1.0.1.ipa", "url": "https://assets…/…ipa",
      "mirrorUrl": null, "sha256": "…", "byteLength": 31096288 },
    { "kind": "incremental", "name": "client-assets-1.0.1-incr.zip", "url": "https://github…/…zip",
      "mirrorUrl": "https://assets…/…zip", "sha256": "…", "byteLength": 12345 }
  ],
  "activate": true
}
```

- `signed=false` 时忽略 `activate`（或 400），保证未签名包不会成为“最新可安装版本”。
- 注册时服务端校验：semver、平台枚举、至少一个 `kind=full` 包、URL 为 https 且 host 在允许列表（`RELEASE_ASSET_HOSTS`）、sha256/长度合法。
- 激活默认要求新版本 semver 大于当前；回滚走 8.3。

### 8.2 `POST /internal/client-assets`

```json
{
  "platform": "ios",
  "channel": "stable",
  "version": "ios-2026.10.25-1",
  "baseVersion": "ios-2026.10.20-2",
  "releasedAt": "2026-10-25T06:00:00Z",
  "manifest": { "version": "ios-2026.10.25-1", "files": [ … ] },
  "files": [
    { "path": "notes-web/reader.js", "sha256": "…", "byteLength": 123 },
    { "path": "launch-motion/index.html", "sha256": "…", "byteLength": 456 }
  ],
  "activate": true
}
```

服务端校验 `manifest.files` 与 `files` 一致、路径白名单、总大小/文件数上限（默认 ≤ 500 文件、≤ 200MB）、sha256 格式；对对象存储中的 blob 做 `HEAD` 校验存在与长度（失败拒绝登记，避免清单指向不存在的文件）。

### 8.3 激活 / 回滚

- `POST /internal/channels/{platform}/{channel}/activate` `{ "version": "1.0.0" }`：事务内切 `is_current`；支持回滚到历史版本。
- `POST /internal/channels/{platform}/{channel}/rollback`：切到上一个已发布版本（按 released_at 倒序）。
- 可选 `GET /internal/app-releases?platform=` 给管理面板/CLI 列表。

## 9. 完整包 / 增量包 / 热更新

| 平台 | 完整包 | 增量包 | 热更新（不改原生包） |
| --- | --- | --- | --- |
| iOS | `.ipa`（签名后） | 无（原生代码不能热更） | `notes-web/` + `launch-motion/` 资产 |
| Android | `.apk`（可选 `.aab` 上架） | 无 | 当前仅 `launch-motion/`；若做 reader 热更需先改资产加载 |
| macOS | `.dmg` / `.zip` | electron-updater `.blockmap` 差分 | 不做 |
| Windows | `.exe`（NSIS） | electron-updater `.blockmap` 差分 | 不做 |

移动端资产“增量”有两层含义，建议分开处理：

1. **上传/存储增量**：按 sha256 内容寻址，新版本只上传变化的 blob；完整包与增量 zip 仍产出，满足归档、GitHub Release 和对象存储同步要求。
2. **客户端下载增量**：清单始终是完整文件列表；客户端按 sha256 命中本地 blob 缓存，只下载缺失文件。**不引入 server 端 delta 协议**——跳过多个版本、跨 CDN、失败重试都更简单可验证，且客户端改动小。
3. 增量 zip（`client-assets-<version>-incr.zip`）内容 = `baseVersion → version` 变化的文件 + `baseVersion` 元数据，用于发布归档/人工排查/第三方分发；客户端不依赖它。

桌面增量：electron-builder 已生成 `.blockmap` 与 `latest*.yml`，CI 将安装包、`.blockmap`、清单一起上传 GitHub 与对象存储；服务端清单 URL 指向对象存储镜像，electron-updater 自动走差分下载。

## 10. CI 流水线设计

### 10.1 手机端仓库 `astella-mobile`（新增 tag-only 工作流）

`.github/workflows/release-ios.yml` 与 `release-android.yml`（或单个 `release.yml` 内按 `ios-v*` / `android-v*` 分 job）：

- 触发：`push: tags: ['ios-v*']` / `['android-v*']` + 各自的 `workflow_dispatch`（dry-run，用 `0.0.0-test.N`，不激活）。
- `verify`：校验 tag 与 `version.json`/iOS `MARKETING_VERSION`/Android `versionName` 一致；不一致直接失败（避免产物版本与 tag 不符）。
- `assets`：Node 脚本 `scripts/release-assets.mjs`
  - 收集 `ios/Astella/NotesWeb/**` → `notes-web/…`，`ios/Astella/LaunchMotion/**` → `launch-motion/…`；Android 只收 `android/app/src/main/assets/launch-motion/**`；
  - 计算 sha256/长度，生成完整清单与 `baseVersion`（默认上一个 tag 的资产清单；baseline 不存在时为空）；
  - 生成 `client-assets-full-<version>.zip`、`client-assets-incr-<version>.zip`、`manifest-<platform>.json`、`SHA256SUMS`；
  - 用 `aws s3 cp/sync` 上传 blobs 与 zip 到对象存储；
  - 调用 `POST /internal/client-assets` 登记（`activate=true`）。
- `ios`（macos runner）：`xcodebuild archive` + `-exportArchive`（有 `IOS_*` secrets 时签名并导出 IPA；否则产出 unsigned IPA 并在注册时 `signed:false`，不激活）。
- `android`（ubuntu runner）：`./gradlew assembleRelease`（有 `ANDROID_KEYSTORE_*` 时签名；否则 unsigned，`signed:false`）。
- `publish`：创建 GitHub Release（先 draft，资产齐全后公开），资产 = IPA/APK + 完整/增量 zip + manifest + SHA256SUMS；随后 `POST /internal/app-releases` 注册并激活（`signed:true` 才 activate）。
- 失败策略：任何上传/HEAD 校验失败则不激活；GitHub Release 可保留 draft 供人工处理。

> 与“手机端仓库不加 CI”的旧决定的冲突见 §12 问题 1。推荐只保留这一个 tag-only 发布工作流，不做 PR/push CI。

### 10.2 桌面端（主仓库现有工作流扩展）

`.github/workflows/desktop-release.yml` 在现有 `softprops/action-gh-release`（Draft/公开）之后增加 `publish-release-center` job：

1. 下载本次 workflow 的 artifacts（Windows `*.exe`、`*.exe.blockmap`、`latest.yml`；macOS `*.dmg`、`*.zip`、`*.zip.blockmap`、`latest-mac.yml`）；
2. `aws s3 cp` 上传到 `app-releases/macos/<version>/` 与 `app-releases/windows/<version>/`；
3. 生成镜像版 yml（把 `url`/`files[].url` 改写为对象存储地址，保留 GitHub 兜底信息到 `packages[].url`）；
4. 调用 `POST /internal/app-releases` 注册 macOS 与 Windows 两行（`desktop_manifest` 对应各自 yml），`activate=true`。
5. 失败时工作流报错，人工用 CLI 重放注册（幂等）。

现有签名/公证 secrets 不变：`MAC_CSC_LINK`、`APPLE_ID` 等；对象存储新增 `RELEASE_S3_*`（或用现有 `STORAGE_*`，建议独立只写前缀的凭证）。

### 10.3 版本与 tag 约定（按 2026-10-24 拆分决定）

| 仓库 | tag | 版本来源 | 首次基线 | CI 触发 |
| --- | --- | --- | --- | --- |
| 主仓库 Astella（服务端） | `s-v2.0.x` | `release/version.json` | 2.0.0 | `s-v*` |
| 主仓库 Astella（桌面） | `c-v2.0.x` | `apps/desktop-client/version.json` | 2.0.0 | `c-v*` |
| 手机仓库（iOS） | `i-v2.0.x` | `ios/version.json` | 2.0.0 | `i-v*` |
| 手机仓库（Android） | `a-v2.0.x` | `android/version.json` | 2.0.0 | `a-v*` |

- 四条线独立递增；`/app/version?platform=` 按平台返回各自的当前版本。
- CI 在打包前校验 tag ↔ 对应版本文件一致；不一致直接失败。
- 手机端发布资产时，资产版本仍按平台各自递增（`ios-…`、`android-…`），与原生包 tag 解耦：资产 hotfix 不需要重新发 IPA/APK。
- 拆分迁移注意：现有 `v1.8.28` / `v1.8.29` 历史 release 仍属于旧的共用版本线；新线从 `s-v2.0.0` / `c-v2.0.0` / `i-v2.0.0` / `a-v2.0.0` 开始。

### 10.4 CI 密钥清单（需要用户提供/配置）

- Release Center：`RELEASE_CENTER_URL`、`RELEASE_CENTER_TOKEN`
- 对象存储：`RELEASE_S3_ENDPOINT`、`RELEASE_S3_REGION`、`RELEASE_S3_BUCKET`、`RELEASE_S3_ACCESS_KEY_ID`、`RELEASE_S3_SECRET_ACCESS_KEY`、`RELEASE_ASSETS_PUBLIC_BASE_URL`
- iOS 签名：`IOS_CERT_P12_BASE64`、`IOS_CERT_PASSWORD`、`IOS_PROVISION_PROFILE_BASE64`、`IOS_TEAM_ID`（有证书才出可安装 IPA）
- Android 签名：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`
- 桌面签名/公证：沿用现有 `MAC_CSC_LINK`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`、`WIN_CSC_LINK` 等

## 11. 服务端与客户端改造清单

### 11.1 服务端（主仓库）

- 迁移：`0454_app_release_center.sql`（§5）；`packages/shared/src/db-schema/app-release.ts`；按需 `db-schema/index.ts` 导出。
- 新模块 `apps/api/src/modules/app-release/`
  - `routes.ts`：§7 公开路由 + §8 内部路由；
  - `service.ts`：查询当前版本、事务激活/回滚、JSONB 读写；
  - `schema.ts`：zod 严格校验（内部注册 body、公开 query）；
  - `manifest.ts`：资产清单校验（路径白名单、hash、大小、URL host 白名单）；
  - `__tests__/app-release-center.test.ts`：纯函数/服务单测；
  - `integration-tests/app-release-center.integration.ts`：一次性 Postgres + MinIO。
- `apps/api/src/server.ts` 注册模块；`apps/api/src/modules/updates/desktop-update-routes.ts` 改为 DB 优先、GitHub 兜底。
- 配置：`RELEASE_CENTER_TOKEN`、`RELEASE_ASSET_HOSTS`（逗号分隔，含对象存储域名与 `github.com` release 域名）、`RELEASE_ASSETS_PUBLIC_BASE_URL`；`.env.example` 增加说明。
- 版本源拆分：新增 `release/server.json`（服务端）、`apps/desktop-client/version.json`（桌面）；改造 `version-contract.mjs` / `desktop-version.mjs` / `release-notes.mjs` 与 `main-ci.yml`、`server-deploy.yml` 的 tag 触发条件（`server-v*` vs `v*`）。
- 回填（可选，未实现脚本）：旧桌面 `v*` 发布继续由 GitHub 兜底，无需迁移；新版本线 `s-v/c-v/i-v/a-v` 在第一次 tag 流水线时自动登记。若要在发布前手工造数，直接调用内部注册接口即可。
- 文档：`apps/mobile-client/API_SURFACE.md`（在手机仓库）与主仓库 `AGENTS`/README 的入口更新。

### 11.2 手机端客户端

- iOS `AccountMethods.checkForAppUpdate`：解析 `version/build/notes/downloadUrl/mirrors/signed`；About 页增加“去下载”入口（`openURL`）；`signed=false` 不提示安装。
- iOS `ClientAssetUpdater`：
  - 增加 `blobs/<sha256>` 内容寻址缓存：下载前先命中本地 blob；命中则复制到 staging，不重复下载；
  - 请求 `/app/client-assets/manifest?platform=ios`，带 `If-None-Match`（需要给 `MobileAPI` 增加可带 header 的请求或在本类内用 URLSession）；
  - 保留现有原子切换、`.manifest.json` 回执与失败回退内置资源。
- Android：新增 `AssetUpdater`（launch-motion）与 `checkForAppUpdate`（`/app/version?platform=android`）；若本期只做版本检查，则资产热更列入后续（见 §12 问题 6）。
- 桌面：无需改更新客户端；清单来源由服务端切换后自动生效。可选把“关于”页的版本检查改走 `/app/version?platform=macos|windows`（非必须）。

### 11.3 手机端仓库（astella-mobile）

- 新增 `ios/version.json`、`android/version.json`、`.github/workflows/release-ios.yml`、`release-android.yml`、`scripts/release-assets.mjs`（按 `--platform ios|android`）、`scripts/verify-versions.mjs`、`scripts/release-register.mjs`（或 curl 步骤）。
- 版本字段同步：iOS 的 `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` 与 Android 的 `versionName`/`versionCode` 由各自 version.json 在 CI 构建时注入（`xcodebuild MARKETING_VERSION=…` / gradle property），仓库里的默认值仅作开发基线。
- 扩展 `scripts/ios-dev.py`/文档说明按端发版命令（`ios-v*` / `android-v*`）。

## 12. 用户已确认的决定（2026-10-24）

| 问题 | 决定 |
| --- | --- |
| CI | 手机仓库允许 **tag-only** `release-ios.yml` / `release-android.yml`，不做 PR/push CI |
| iOS 签名 | **先不做**；CI 只产 unsigned IPA，登记 `signed=false`、不激活 |
| Android 签名 | **要做**；CI 用 keystore secrets 签 release APK |
| 完整包镜像 | **只放 GitHub Releases**，不镜像完整包到对象存储 |
| 对象存储 | 由实施方配置；沿用现有 S3/MinIO 配置与新增 `RELEASE_S3_*` 可选 secrets；未配置时资产只进 GitHub |
| 桌面管理 | 继续 electron-updater `latest*.yml`（服务端 DB 托管 + GitHub 兜底） |
| Android 热更新 | 先不做；只做 `/app/version` 检查 |
| 版本线 | 服务端 `s-v2.0.0`、桌面 `c-v2.0.0`、iOS `i-v2.0.0`、Android `a-v2.0.0`；桌面 macOS/Windows 不拆分 |
| 服务端版本 | 需要 `GET /app/server-version`；运维面板增加「版本控制」页，展示四条线与热更新资产的当前版本和历史 |

## 13. 实施阶段（待确认后执行）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P1 | 迁移 + Release Center 公开/内部路由 + 桌面路由 DB 优先 | API 单测、一次性 Postgres/MinIO 集成、curl 真机验证 |
| P2 | 手机端 `release-assets` 脚本 + S3 上传 + 客户端 blob/版本检查改造 + 手动 CLI 发一版测试资产 | Swift 测试、Android 单测、模拟器热更新（只下载变化文件） |
| P3 | 手机仓库 tag 工作流 + 桌面工作流扩展 + 签名 secrets + GitHub Release/对象存储双写 + 自动激活 | workflow_dispatch dry-run + 正式 patch tag 端到端 |
| P4 | 回滚 CLI/管理列表、监控、保留策略、文档与 API_SURFACE 更新 | 灰度/回滚演练 |

预计工作量：P1 约 1–2 天，P2 约 1–2 天，P3 约 1–2 天，P4 约 0.5–1 天（不含等待签名材料/对象存储配置）。

## 14. 失败处理与安全

- **DB 不可用**：`/app/version`、`/app/client-assets/manifest` 返回 503；客户端保持内置/缓存资源并显示稍后重试；桌面回退 GitHub 清单。
- **对象存储不可用**：版本接口仍可返回，下载失败回退 GitHub 地址（若配置了）；桌面 electron-updater 同样可回退。
- **部分上传**：只有全部 blob/zips `HEAD` 校验通过才登记并激活；失败保留旧 current。
- **回滚**：内部激活接口切换指针，历史与文件不删；客户端下次检查即回退。
- **安全**：公开接口只读白名单字段；内部接口 token（常量时间）、请求体上限、URL host 白名单、路径白名单、sha256/长度校验；防路径穿越；不代理任意 S3 key；审计日志落 observability。

## 15. 附：与现有客户端契约的兼容性

- iOS `ClientAssetUpdater` 的 manifest 解码只要求 `version` + `files[path,url,byteLength,sha256]`；新增 `baseVersion`/`createdAt` 会被忽略，安全。
- iOS `checkForAppUpdate` 只读 `version`；新增字段不影响旧版本。
- 桌面 `/updates/desktop/*` 返回体仍是 electron-updater 可解析的 YAML；客户端无需改动。
- 现有 `update_manifest_cache` 在过渡期保留；DB 有当前桌面版本后优先使用，GitHub 仅兜底。
