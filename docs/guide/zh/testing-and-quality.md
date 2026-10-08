# 测试与质量

中文 · [English](../en/testing-and-quality.md)

按改动选择类型检查、单测、实库、真实模型和窗口检查。它们回答不同问题：合同正确、数据库权限正确、模型能够完成任务、页面能够连续操作，不能互相替代。本页以 Makefile、包脚本与工作流的可执行内容为依据；旧注释中的门禁声明可能过时。

## 测试入口

| 包 | 类型检查 | 普通测试 |
| --- | --- | --- |
| shared、agent-core、agent-host、ai-quality | 包内 `npm run typecheck` | Node test runner，经 tsx 执行 |
| apps/api、workers/ai-worker | 包内 `npm run typecheck` | 发现 `src` 下的 `*.test.ts` |
| desktop-client | 分别检查 `tsconfig.node.json` 与 `tsconfig.web.json` | Vitest，DOM 测试按文件声明 jsdom |
| card-generation | 包内 `npm run typecheck` | 当前没有独立 test 脚本，由宿主链路测试覆盖 |

各包有独立 lockfile，跨包 `file:` 依赖仍需安装被引用包的依赖。API 与 Worker 的类型检查会纳入对方部分源码，不能只装其中一个包。首次在仓库根执行：

```bash
npm ci
for dir in packages/shared packages/card-generation packages/agent-core packages/agent-host packages/ai-quality apps/api workers/ai-worker apps/desktop-client; do
  (cd "$dir" && npm ci) || exit 1
done
make desktop-client-build
make verify
```

先构建桌面端是因为素材包含测试读取 `out/`。`make verify` 本身不安装依赖，也不先构建桌面产物。桌面根 tsconfig 只有 references，直接 `tsc --noEmit` 不能代替包内 typecheck。agent-core 的 shell glob 与其他包的 find 规则不同，新增更深目录测试时检查实际发现范围。

## `make verify` 的范围

本地基线包含：

1. 产品版本一致性检查。
2. 仓库合同测试：版本、发布清单、覆盖率工具逻辑、CI 对账、集成连接生命周期、初始化顺序。
3. schema 目录和伴星能力配置校验。
4. `infra/backup/backup-scripts.test.sh` 的纯脚本自测。
5. shared、agent-core、agent-host、ai-quality、API、desktop、Worker 七个包的类型检查与测试；ai-quality 额外运行固定 Mock 的 `pr-gate`。

它不包含覆盖率、skip/todo、真实 PostgreSQL、真实模型、外部 S3、镜像扫描或完整窗口走查。card-generation 未作为独立包接入此目标；需要时显式检查它。源码守卫通过也不能证明设计和交互体验良好。

## 真实 PostgreSQL 与 S3

`*.integration.ts` 不匹配后端普通测试规则，需显式运行 `test:*:postgres` 脚本。`make test-postgres` 从 API 和 Worker 的 package.json 动态枚举这些脚本，注入各自要求的连接变量；任一脚本失败即停止。

使用可丢弃数据库，避免夹具修改真实数据或残留数据干扰断言：

```bash
make disposable-db DISPOSABLE_DB=astella_it
make test-postgres COMPANION_HOME_TEST_DB=astella_it
```

一次性库脚本只处理匹配 `astella_*` 且不等于 `astella` 的名称，但会删除已存在的同名库。迁移／管理员连接负责结构和夹具；业务断言使用 `astella_api`／`astella_worker` 的 NOBYPASSRLS 角色。超级用户测试不能证明租户隔离。角色密码与专用变量以 Makefile 和脚本要求为准。

定点入口包括 `make test-companion-home-profile-postgres` 与 `make test-companion-integration-postgres`。新增集成文件应登记 package.json 脚本；盘上文件存在不等于自动被运行。

远程对象存储集测是 `npm --prefix apps/api run test:object-storage:s3`，不属于 `make test-postgres`。它需要独立测试库、远程配置与清理范围，详见 [服务器部署](deployment.md)。

## 守卫检查什么

| 守卫或目录 | 主要判据 |
| --- | --- |
| `desktop-ipc-channel-coverage`、`ipc-channel-single-source-guard` | IPC 合同、注册与事件出口对账；通道名同源 |
| renderer 样式 closure／dead／order、`css-var-resolution-guard` | 类名与样式接线、死样式台账、唯一 CSS 入口与变量可解析 |
| `component-size-guard` | 按源码的 HARD／SOFT 和 SIZE_DEBT 登记结构债；不是 AGENTS 文档中的统一拆分红线 |
| 页面可读登记、HTML sink、正式作答与输出守卫 | 页面身份、内容注入与业务边界 |
| API 的 layer／error／cursor／doc-pointer 守卫 | 层级依赖、错误信封、游标时钟与文档指针 |
| `ci-workflow-contract.test.mjs` | 本地基线与 CI 被测包、备份脚本自测的接线 |
| `schema-isolation-gate-postgres.integration.ts` | 真实库的外键债与 RLS 棘轮；必须实库执行 |

桌面守卫位于 `src/main/__tests__/` 以便读取文件；功能行为测试靠近对应 renderer 域。结构阈值、允许项与债务集合以测试源码为准，文档不复制每轮会变的文件数或总用例数。

## 覆盖率、skip 与发布检查

| 命令 | 范围 |
| --- | --- |
| `make coverage-gate` | c8 采集 shared、ai-quality、API、Worker，按脚本阈值阻断；不覆盖所有包 |
| `make skip-todo-gate` | 检查上述包的 skip/todo 与有期限 allowlist，独立运行 |
| `make release-check` | 发布输入 → `verify` → 覆盖率 → 发布清单生成／合同；不运行 skip/todo 门禁 |
| `make release-manifest` | 生成机器可读清单；缺证据字段或占位 digest 不能当作发布验收 |

`--report-only` 不阻断，不能与正式覆盖率门禁混称。在精确 release tag 上，清单合同要求有效的 `RELEASE_MANIFEST_PATH` 工件；生成一份清单不等于所有证据已经齐全。

## CI 与发布工作流

| 工作流 | 用途 |
| --- | --- |
| `main-ci.yml` | main、PR、v* 标签与手动触发；包矩阵、API、Worker、desktop（先构建）和备份脚本自测 |
| `server-deploy.yml` | v* 标签的 CI 通过后复用；部署脚本测试、GHCR 生产镜像构建、digest 与 SSH 部署 |
| `desktop-client.yml` | 桌面质量与打包冒烟，由发布或手动调用 |
| `desktop-package.yml` | Windows／macOS 安装包构建，可单独取得测试包 |
| `desktop-release.yml` | 版本检查、打包、质量检查与更新清单通过后公开 Release |

普通 CI 不起真实 PostgreSQL，也不执行付费模型请求；Tag 部署另有真实镜像构建，不能再概括为「CI 从不构建生产镜像」。覆盖率、skip/todo、密钥／镜像扫描和恢复演练不自动属于这些基线，需要按用途显式执行或接线。

`VITE_HOME_SCENE_VARIANT` 在旧脚本／矩阵中仍出现，但当前源码不读取它；矩阵标签本身不证明两种首页都被测试。已有脚本和过时注释不能代替可执行接线核对。

## 真实模型与窗口

真实模型探针需明确启用并配置测试账号、权限与预算。近期入口在 `workers/ai-worker/src/live-tests/README.md`，旧脚本和固定 Mock 不代表当前模型已验收。探针可能收费，报告要区分业务链路、生成内容正确性、自然度与等待时间。

窗口检查使用实际运行构建与长内容，覆盖阅读／编辑／源码、全屏／册页、快速反向、停止／失败、焦点／Esc、缩放、伴星位置和 Full／Lite／Off／系统减少动态。附着已有开发窗口可在桌面包目录运行：

```bash
ASTELLA_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/capture-pages-v3.mjs
```

未提供 CDP 时部分 capture 脚本另启实例；必须区分该副本与用户正在看的窗口。安装包验证另用 `npm run package:smoke`／`package:evidence`；fixture manifest 只证明格式，不证明真实运行。

实现与排障记录留在对应 `__tests__/`、`docs/testing/` 或 live-tests。既有失败记基线，新引入问题修复；交付写明实际执行、通过范围和未验证项，不用累计测试数量代替结论。

[手册索引](../README.md) · [开发环境](development.md) · [运行与发布](operations.md) · [服务器部署](deployment.md)
