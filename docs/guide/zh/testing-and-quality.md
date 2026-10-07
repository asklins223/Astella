# 测试与质量

中文 · [English](../en/testing-and-quality.md)

这篇讲什么：把拾星笔记现在的验证链路如实摊开——每个包用什么跑测试、`make verify` 到底执行了哪些命令、真库集成测试与单元测试的分界在哪里、源码守卫这套机制各守哪条不变量、CI 实际跑什么与不跑什么，以及文档与代码之间已知的不一致。所有命令、路径、任务名、阈值和数量都是当场从 `Makefile`、`.github/**`、各包 `package.json` 与 compose 文件里读出来的。

- [测试拓扑：每个包怎么跑](#测试拓扑每个包怎么跑)
- [一条命令：`make verify`](#一条命令make-verify)
- [干净检出时的单包命令](#干净检出时的单包命令)
- [单元与真库集测的分界](#单元与真库集测的分界)
- [源码守卫与合同测试](#源码守卫与合同测试)
- [两个只在发版时跑的门禁](#两个只在发版时跑的门禁)
- [CI 实际跑什么](#ci-实际跑什么)
- [文档与代码里已知的不一致](#文档与代码里已知的不一致)
- [真实窗口核对](#真实窗口核对)
- [在这个仓库里加一条测试](#在这个仓库里加一条测试)
- [这一页没有覆盖的部分](#这一页没有覆盖的部分)

## 测试拓扑：每个包怎么跑

后端与共享包统一用 Node 自带的 `node:test`，经 `tsx` 直接吃 TypeScript；桌面端用 vitest。各包独立 lockfile，`npm ci` 分别安装。

| 包 | runner | 用例发现方式 | 并发 | 单元文件数 |
| --- | --- | --- | --- | --- |
| `apps/api` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=8` | 281 |
| `workers/ai-worker` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=8` | 127 |
| `packages/shared` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=1` | 103 |
| `packages/agent-host` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=1` | 4 |
| `packages/agent-core` | `node --import tsx --test` | `src/**/__tests__/*.test.ts`（shell glob） | 默认 | 14 |
| `packages/ai-quality` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | 默认 | 9 |
| `packages/card-generation` | 无 test 脚本 | — | — | 0 |
| `apps/desktop-client` | `vitest run --passWithNoTests` | vitest 默认 include | vitest 并行 | 356 |

三处值得单独说明：

- `packages/agent-core` 是唯一没用 `find` 的包。它的 glob 展开成 `src/<一层目录>/__tests__/*.test.ts`，当前 14 个文件恰好都在这个深度，所以能全跑到；把测试放进更深一层目录会被**静默漏掉**。
- `packages/card-generation` 只有 `typecheck` 一条脚本，**没有 `test` 脚本，也没有任何测试文件**。它的类型正确性靠宿主包间接保证（`apps/api`、`packages/agent-host`、`workers/ai-worker` 共 15 个源码文件 import 它，typecheck 会跟随源码），但它自己不在 `make verify` 的包清单里，也不在 CI 的被测目录里。
- 桌面端 356 个文件里 350 个在 `src/`（172 个 `.test.ts` + 178 个 `.test.tsx`），另外 6 个在 `src/` 之外：`scripts/split-chat-routing-probe.test.ts`、`scripts/runtime-asset-containment.test.mjs`、`scripts/validate-room-layers.test.mjs` 与 `demos/__tests__/` 下 3 个。vitest 的默认 include 连 `.test.mjs` 一起收，所以这 6 个也在 `npm test` 的分母里——其中 `runtime-asset-containment.test.mjs` 量的是 `out/` 里的构建产物，**没有先构建就没有可量的东西**（CI 的 desktop job 因此先 build 再 test，见下文）。

桌面端没有在全局配置里设 `environment`，运行环境由**每个测试文件顶部的 docblock** 声明：`src/` 下 197 个文件写 `// @vitest-environment jsdom`，2 个写 `node`，其余走 vitest 默认的 node。`apps/desktop-client/vitest.config.ts` 只做两件事——把 `testTimeout` 与 `hookTimeout` 放宽到 15 000 ms、挂上 `./vitest.setup.ts`；`vitest.setup.ts` 把 Testing Library 的 `asyncUtilTimeout` 从默认 1000 ms 放宽到 5000 ms（`testTimeout` 管不到它），并补上 jsdom 缺失的 `HTMLMediaElement.play()/load()` 与 `Range.getClientRects()` 浏览器语义。放宽的动机写在配置注释里：全量并行时机器负载高，会造成**单跑通过、全量超时**的假红。

## 一条命令：`make verify`

`make verify` 是本地基线，也是 CI 的口径。它依赖 `version-check`，实际执行顺序如下（逐行取自 `Makefile` 的 `verify:` 目标；写目标名不写行号，免得下次插一行就对不上）：

```bash
node .github/scripts/version-contract.mjs --check           # 前置：版本契约
node --test \
  .github/scripts/version-contract.test.mjs \
  .github/scripts/release-manifest-contract.test.mjs \
  .github/scripts/coverage-gate-lib.test.mjs \
  .github/scripts/ci-workflow-contract.test.mjs \
  .github/scripts/postgres-integration-lifecycle.test.mjs \
  .github/scripts/compose-init-order.test.mjs              # 6 份仓库级合同测试
node .github/scripts/verify-schema-mirror.mjs               # 2 道 verify 闸门
node .github/scripts/verify-companion-capability-config.mjs
bash infra/backup/backup-scripts.test.sh                  # 备份/恢复 shell 组自测
cd packages/shared     && npm run typecheck && npm test
cd packages/agent-core && npm run typecheck && npm test
cd packages/agent-host && npm run typecheck && npm test
cd packages/ai-quality && npm run typecheck && npm test && npm run pr-gate
cd apps/api            && npm run typecheck && npm test
cd apps/desktop-client && npm run typecheck && npm test
cd workers/ai-worker   && npm run typecheck && npm test
```

要点：

- `verify` **不装依赖**，它假定 `npm ci` 已经在每个包跑过。
- `packages/ai-quality` 额外跑一条 `pr-gate`：AI 质量层的 PR 固定桩闸，用固定数据集与桩评测试逻辑，不发任何付费网络请求。
- `packages/card-generation` 不在这串里。
- 版本契约脚本覆盖三个包根（`apps/api`、`workers/ai-worker`、`packages/shared`），唯一来源是 `release/version.json`。

## 干净检出时的单包命令

`../../../README.md` 给的冷启动顺序是逐包先装再测，顺序上先共享包：

```bash
(cd packages/shared && npm ci && npm run typecheck && npm test)
(cd apps/api && npm ci && npm run typecheck && npm test)
(cd workers/ai-worker && npm ci && npm run typecheck && npm test)
(cd apps/desktop-client && npm ci && npm run typecheck && npm test)
```

跨包依赖是 `file:` 链接，而 `tsc` 解析被引包时会读**那个包自己的** `node_modules`，所以 npm workspace 提升在这里不顶用：CI 的每个 job 都显式列了自己 program 真正包含的包并逐个 `npm ci`。`apps/api` 与 `workers/ai-worker` 的 typecheck program 是互相咬合的——worker 的集测文件直接相对 import `apps/api/src/...`，少装对方就报 TS2307。

桌面端 `npm run typecheck` 是两条 `tsc --noEmit -p` 的组合（`tsconfig.node.json` 与 `tsconfig.web.json`，都带 `--composite false`）。仓库根的 `tsconfig.json` 只有 `references`，直接 `tsc --noEmit` 可能什么都没检查。

## 单元与真库集测的分界

> **说明：** `*.integration.ts` 不会被 `npm test` 收到——后端的发现规则是 `find src -name '*.test.ts'`，两种命名不重叠（实测 `src/integration-tests/` 下 0 个 `.test.ts`）。也就是说 `make verify` 与 CI 跑的全部是**不需要数据库**的用例；真库集测要另起一条命令、要一个干净的一次性库。

盘上的集测文件：`apps/api/src/integration-tests/` 119 个、`workers/ai-worker/src/integration-tests/` 37 个，共 **156** 个。它们被 **55** 条 `test:*:postgres` 脚本引用（`apps/api` 40 条、`workers/ai-worker` 15 条），去重后覆盖 **154** 个文件；剩下 2 个没有被任何脚本引用：`apps/api/src/integration-tests/note-collaboration-postgres.integration.ts` 与 `workers/ai-worker/src/integration-tests/queue-postgres.integration.ts`。反向没有死引用：脚本点名的 154 个文件全部存在（这条由 `ci-test-file-references.test.ts` 盯着）。

`make test-postgres` 是统一的入口。它进 `apps/api` 和 `workers/ai-worker`，用一行 `node -e` 从 `package.json` 里**自动发现**所有以 `test:` 开头、以 `:postgres` 结尾的脚本名，逐条 `npm run --silent`，任何一条非零退出即整体失败。执行时注入这组变量（值由 Makefile 里的 `IT_*` 变量拼出，默认沿用 `COMPANION_HOME_TEST_*`，即 host `127.0.0.1`、port `5432`、db `astella`）：

| 变量 | 指向的角色 |
| --- | --- |
| `DATABASE_URL` | `astella`（超级用户，仅用于建/清夹具） |
| `DATABASE_URL_MIGRATOR` | `astella_migrator` |
| `DATABASE_URL_API` / `DATABASE_URL_API_RLS` / `RATE_LIMIT_TEST_DATABASE_URL` | `astella_api`（`NOBYPASSRLS`） |
| `DATABASE_URL_WORKER` / `QUEUE_TEST_WORKER_A_DATABASE_URL` / `QUEUE_TEST_WORKER_B_DATABASE_URL` | `astella_worker` |
| `DATABASE_URL_TEST_ADMIN` / `CONTENT_HASH_TEST_DATABASE_URL` / `SEC02_TEST_DATABASE_URL` / `NOTE_VERSION_RESTORE_TEST_DATABASE_URL` | `astella` |
| `RLS_TEST_MIGRATOR_DATABASE_URL` / `RLS_TEST_API_DATABASE_URL` / `RLS_TEST_WORKER_DATABASE_URL` | 与上面三档同名角色 |
| `QUEUE_TEST_MIGRATOR_DATABASE_URL` | `astella_migrator` |

必须**显式给受限角色**：超级用户会 `BYPASSRLS`，隔离类断言在超户下会变成假通过。这些专用变量各读各的（RLS、队列、内容哈希、SEC-02 邀请、版本恢复、限流），缺一个就是**整份文件红在读环境变量上**——文件里写的是 `throw new Error('… is required')`，那是显式拒绝，不是静默 skip。

共享开发库上不能跑集测：这一族用例的断言含"库里只有自己的夹具"（RLS 策略目录、worker 队列 claim、投影分页），残留行会造成假失败。配套工具：

| 命令 / 脚本 | 作用 |
| --- | --- |
| `make disposable-db DISPOSABLE_DB=<name>` | 在跑着的 dev postgres 里重建一个一次性库 |
| `bash scripts/dev-disposable-db.sh <name>` | 同上，Makefile 就是转调它 |
| `scripts/psql-lite.mjs` | 极小 `psql` 替身，供没有 docker CLI 的机器上跑一次性库脚本 |
| `scripts/with-restricted-db-urls.py <包目录> <命令…>` | 把 `DATABASE_URL_API`/`_WORKER` 换成受限角色再执行命令 |

一次性库的名字护栏：目标库必须匹配 `astella_*` 且**不等于** `astella`，否则脚本直接拒绝执行。`dev-disposable-db.sh` 会打印可直接复制的集测环境变量。

两个更窄的目标各自只跑一份脚本，便于定点复现：

- `make test-companion-home-profile-postgres` → `apps/api` 的 `test:companion-home-profile:postgres`。
- `make test-companion-integration-postgres` → `apps/api` 的 `test:companion-integration:postgres`（31 个文件的伴星集成矩阵）。

典型用法：

```bash
bash scripts/dev-disposable-db.sh astella_it
make test-postgres COMPANION_HOME_TEST_DB=astella_it
```

## 源码守卫与合同测试

这个项目的特色机制是**读自己源码的测试**：判据的对象是文件、目录、导入关系与字符串形状，而不是运行时行为。它们跟着 `npm test` 一起跑，所以进 `make verify`、也进 CI。下面列的是各条实际守的不变量（名字即文件名，都在 `__tests__/` 下）。

### 桌面端（`apps/desktop-client/src/main/__tests__/`）

这些文件放在 main 侧是为了能用 `node:fs` 读仓库；`tsconfig.web.json` 的编译图里没有 Node 类型。

| 守卫 | 守住的不变量 |
| --- | --- |
| `component-size-guard.test.ts` | 把 `AGENTS.md` 的"单函数超过 400 行、hook 超过 25 个是信号"变成硬判据：文件 > 2000 行 / 函数 > 1200 行 / hook > 50 直接判死不给豁免；软线（1200 / 600 / 25）之上必须登记进 `SIZE_DEBT` 并写明下次拆哪块；台账**只允许变短**。 |
| `renderer-style-closure-guard.test.ts` | "类发出去没人接"：renderer 里每个 tsx 发出的类名，必须在样式表里有对应规则，否则整页没有纸、没有边。 |
| `renderer-style-dead-guard.test.ts` | 反面："接了没人发"的死 CSS。实际死集必须与 `KNOWN_DEAD` 完全相等，每条带一句它还留在磁盘上的理由；新长出来的死样式立刻变红。 |
| `renderer-style-order-guard.test.ts` | 样式表只从 `styles.ts` 一处进来：磁盘上每份 CSS 都要在清单里、组件模块不得再 `import` CSS、跨层顺序符合清单顶部写下的分层理由。 |
| `css-var-resolution-guard.test.ts` | 每个 `var(--x)` 要么有声明、要么带 fallback、要么由 JS 注入；三者都不满足即这条声明在计算值时失效（会静默丢阴影、丢边框）。 |
| `hud-substrate-guard.test.ts` | HUD 衬底不许退回字面量与第二真理源：结构性去重删掉的那种裸单类不得再抄回来，`var(--hud-*)` 引用不得改回 hex。两条判据各配一份故意违规的合成 CSS 作正对照。 |
| `desktop-ipc-channel-coverage.test.ts` | IPC 通道**集合相等**：契约声明的每个通道，要么主进程有 `ipcMain.handle`，要么出现在写明理由的出站/事件名单里，而名单本身也被断言"确实以那种方式绑定了"。 |
| `ipc-channel-single-source-guard.test.ts` | 通道名不得在 main 与 preload 各写一份字面量；除 `shared/window-state.ts` 那两条之外，全部走 `DESKTOP_IPC_CHANNELS`。 |
| `page-readable-registration.test.ts` | 每一屏的 `useHudPage(…)` 调用点与它发出的 `pageId` 对账（字面量与变量两种形状都认），差集分进 `NOT_REGISTERED_WITH_REASON`（看了代码才下的判断）与 `PENDING_W2_7`（还没做，只许变短）。 |
| `graph-surface-shape-guard.test.ts` | 关系图组件的控制流形状：`edge.decidable ?` 不得换成恒真，乐观更新必须在 `await` 之前。改为在目录树里搜文件名，组件搬家不再波及它。 |
| `startup-failure-guard.test.ts` | 启动失败必须是看得见的失败：回调抛错要有人接、退出码非 0、错误信息落到 userData 一份。 |
| `home-feature-wiring-guard.test.ts` | 首页功能"接线状态"与真处理器双向对账：标成 native 的必须真有分支，有分支的不许还标着 pending。 |

同目录还有一批没进上面清单的守卫（`doc-reference-guard`、`renderer-copy-guard`、`renderer-html-sink-guard`、`output-stream-guard`、`task-scene-background-guard`、`universe-canvas-sizing-guard`、`objective-flow-copy/css-guard`、`objective-progress-band-guard`、`settings-surface-css-guard`、`surface-state-paper-css-guard`、`formal-assessment-guard`、`companion-center-copy-guard`、`notebook-round-lost-shape-guard`），判据同属"读源码"这一族。

### API（`apps/api/src/__tests__/`）

| 守卫 | 守住的不变量 |
| --- | --- |
| `error-envelope-source-guard.test.ts` | 错误响应信封：`DomainError` 到 HTTP body 的映射稳定，服务错误与简单错误的字段形状一致。 |
| `cursor-column-db-clock-source-guard.test.ts` | 被当作翻页游标的时间列，写入必须用 DB 时钟——多副本时钟偏差会让元组比较漏项或重复。 |
| `feature-flags-naming-source-guard.test.ts` | 文件名字对得上装的东西：通用 flag 收口处是 `apps/api/src/config/learning-companion-flags.ts`，`packages/shared` 那份已在 2026-09-29 正名为 `provider-prompt-cache.ts`，不得再长回同名不同物。 |
| `companion-layer-boundaries-source-guard.test.ts` | 方案 40b §6.2 的层边界：从 `packages/shared/src/ai-task-kernel.ts` 出发做**解析后路径**的可达闭包，闭包里不得 import 人格、领域写入口、`db-schema/*` 或 `apps/api/src/modules/*`。注释里提到"人格"不算违规。 |
| `doc-pointer-reachability-source-guard.test.ts` | 源码注释里的 `docs/**.md` 指针必须还能打开。扫描根为 `apps/api/src`、`workers/ai-worker/src`、`packages/shared/src`、`apps/desktop-client/src`，并自带一条"故意造一个坏指针必须判成悬空"的自证。 |
| `ci-test-file-references.test.ts` | 脚本点名的集测文件必须真的存在。判据按各自的 `working-directory` 解析，避免把包内路径误报成死引用。 |
| `integration-db-url-guard.test.ts` | 测试代码里不许再出现写死的开发库串（扫 `src/integration-tests`、`src/__tests__`、`*.test.ts` 与 `src/scripts`）；产品代码**有意不在范围内**，因为那几处回落指向 compose 内服务名且带 `NODE_ENV=production` 必填守卫。 |
| `source-text-guard-naming.test.ts` | 守卫文件自己也要按命名规则可分类。 |

`route-contract` 与 `schema-isolation-gate` **不属于上面这批单元测试**。它们是 `apps/api/src/integration-tests/` 下的真库集测：

- `route-contract-postgres.integration.ts`（由 `test:route-contract:postgres` 跑）核对认证路由的真实 HTTP 合同。
- `schema-isolation-gate-postgres.integration.ts` 是空间隔离的 **schema 棘轮**，由 `test:users-rls:postgres` 跑。它把"有 `workspace_id` 列但缺指向 `workspaces` 外键"的表登记成基线，要求实际集合与基线**完全相等**：新增一张漏外键的表变红，修好一张却忘了从基线里删也变红。基线当前 **89** 条（全部是表名，不重复）；"缺 RLS 启用"的基线**是空数组并且必须一直是空的**。RLS 那条判据的口径是"有 `workspace_id` **或** `user_id`"，因此 `users` 这类按人分区的表也在分母里。

### 仓库级（`.github/scripts/`）

| 合同测试 | 守住的不变量 |
| --- | --- |
| `ci-workflow-contract.test.mjs` | 两个方向都钉死：`make verify` 里逐个包跑的 7 个目录必须**逐个**出现在 `main-ci.yml` 的被测路径里（只有矩阵的 `path:` 和字面量 `working-directory:` 算数，`${{ matrix.path }}` 那种引用不算），少接一个包就红；反过来 CI 里不许再出现本地不跑的门禁名 `coverage-gate`、`skip-todo-gate`、`gitleaks`、`npm audit`、`trivy`、`pgvector`，也不许再起 postgres service；`push` 触发里必须仍有 `main` 分支。 |
| `version-contract.test.mjs` | 版本唯一来源 `release/version.json` 与三个包根（`apps/api`、`workers/ai-worker`、`packages/shared`）的副本一致，`--write` 能同步、`--check` 能发现漂移。包根清单是测试里**显式列出**的，不是从实现常量推导，否则删掉一个包根会让测试静默通过。 |
| `release-manifest-contract.test.mjs` | Release manifest 的必填门（`unit` / `integration` / `coverage` / `dependencyScan` / `secretScan` / `containerScan`）、journal 与镜像 digest 的形状、以及"在精确 release tag 上必须存在完整工件"这条 fail-closed。 |
| `postgres-integration-lifecycle.test.mjs` | 两个 `src/integration-tests/` 目录里每个 `const x = postgres(` 建出来的客户端都必须被显式 `end()`；不留悬挂连接。 |
| `coverage-gate-lib.test.mjs` | 覆盖率阈值库的解析与聚合语义，含"缺 changed-lines 输入时 fail closed"。 |

## 两个只在发版时跑的门禁

> **说明：** `make coverage-gate` 与 `make skip-todo-gate` 都**不在** `make verify` 里，也**不在** CI 里。它们只在 `make release-check` 这条链上被调用（`release-check` = `verify-release-inputs.mjs` → `make verify` → `coverage-gate.mjs` → `release-manifest-generate.mjs` → `release-manifest-contract.mjs`）。因此"本地 `make verify` 全绿"不等于覆盖率达标，也不等于没有未登记的 skip。`ci-workflow-contract.test.mjs` 正是为了让这两条不再悄悄挂回 CI。

### `make coverage-gate`

`node .github/scripts/coverage-gate.mjs`：对 4 个包（`packages/shared`、`packages/ai-quality`、`apps/api`、`workers/ai-worker`）分别跑 `c8`，把该包全部生产源码纳入分母，聚合后按阈值判。桌面端、`agent-core`、`agent-host` **不在**覆盖率统计的包清单里。阈值来自 `.github/scripts/coverage-gate-lib.mjs`：

| 门禁 | 行 | 分支 |
| --- | --- | --- |
| 全仓生产源码 | 50 | 60 |
| 关键模块的默认阈值（无显式覆盖时） | 85 | 75 |
| 变更行（changed lines） | 50 | 不设分支线 |
| `identity`（`apps/api/src/modules/identity/`） | 50 | 85 |
| `tenant isolation`（`apps/api/src/db/client.ts`、`apps/api/src/modules/identity/middleware.ts`、`workers/ai-worker/src/db.ts`） | 75 | 65 |
| `job + lease`（worker 的 `handlers/index.ts`、`index.ts`、`lib/job-lease.ts`、`queue.ts` 与 `apps/api/src/modules/job/`） | 33 | 55 |
| `import + export`（`apps/api/src/modules/import/`、`export/`） | **0** | **0** |

关键模块的阈值是 2026-09-29 重定基到当时实测值的产物（脚本注释里写明是**棘轮**：只能往上走）。`import-export` 那组是 0/0，注释本身把它记成"一笔明账"——这四个文件一条单元测试都没有，这条线现在只能挡住"从 0 变负数"这种不可能的事。changed-lines 在没有 base/head 感知的行图时**fail closed**（记为未通过），本地无 base/head 时记为 skipped。

`--report-only` 这个模式仍然存在且退出码恒为 0；`make coverage-gate` 与 `release-check` 都**不带**它。

### `make skip-todo-gate`

`node .github/scripts/skip-todo-gate.mjs`：对同样那 4 个包跑测试，从 TAP 输出里统计 skipped/todo，未在 allowlist 中即失败。`--package <path>` 可只跑一个包。allowlist 是 `.github/scripts/skip-todo-allowlist.json`，**当前 1 条**：

| 字段 | 值 |
| --- | --- |
| 测试名 | 真 LLM 生成（`.env` 配置后真实调用 DashScope） |
| 包 | `apps/api` |
| 类型 | `skip` |
| 到期日 | `2026-10-19` |

脚本自己校验 allowlist 的形状：必填字段齐全、`type` 只能是 `skip` 或 `todo`，且 `expiresAt` **不得超过当前时间 + 14 天**——那条是闸的上限，过期前要么补凭据、要么把这条改造成可用的本地替身，不能无限顺延。

## CI 实际跑什么

四个工作流，`node-version` 全部由仓库级 `env.NODE_VERSION: "22"` 传给 `actions/setup-node@v4`（各包 lockfile 显式列进 `cache-dependency-path`）。

| 工作流 | 文件 | 触发 | jobs |
| --- | --- | --- | --- |
| CI | `.github/workflows/main-ci.yml` | `push` 到 `main`、`push` tags `v*`、`pull_request`、`workflow_dispatch` | `packages`（矩阵）、`api`、`worker`、`desktop` |
| Desktop client | `.github/workflows/desktop-client.yml` | `workflow_dispatch`、`push` tags `desktop-v*` 与 `v*` | `shared-contracts`、`variant-quality`（矩阵 v1/v2）、`package-smoke`（矩阵） |
| Desktop package | `.github/workflows/desktop-package.yml` | `workflow_dispatch`、被 `workflow_call` 调用 | `windows`、`macos`、`summary` |
| Desktop release | `.github/workflows/desktop-release.yml` | `push` tags `desktop-v*`、`workflow_dispatch` | `resolve`、`build`（复用 desktop-package）、`release` |

`main-ci.yml` 的口径写在文件头：**CI = 本地跑得通的那套测试**，逐个包一一对应。`packages` 矩阵的四个 label 是 Shared contracts、Agent core、Agent host、AI quality (PR mock)；每个条目按 `deps` 列出的包逐个 `npm ci`，再 `npm run typecheck` 与 `npm test`，AI quality 那条多跑一步 `npm run pr-gate`。`api` 与 `worker` 两个 job 给 `DATABASE_URL_API`/`DATABASE_URL_WORKER` 填了一个**明确不可达**的 `postgres://ci:ci@127.0.0.1:1/ci`：单测在模块加载时会 import `db.ts` 建连接池，池是懒的，但 compose 主机名 `postgres` 在 runner 上不解析，DNS 查不到会把 job 挂到超时。`desktop` job **先 `npm run build` 再 `npm test`**——`scripts/runtime-asset-containment.test.mjs` 量的是 `out/renderer/assets` 下的最终打包内容，没有 `out/` 就没有可量的东西（2026-10-06 实测少了这一步会在干净 runner 上红 3 条，而本地一直不红是因为工作树里躺着上次构建的 `out/`）。

`desktop-client.yml` 的 `variant-quality` 按 v1/v2 两个 `VITE_HOME_SCENE_VARIANT` 各跑一遍 typecheck → `validate:room-layers` → build → `validate:room-layers:output` → test 并上传 `out`。`package-smoke` 依赖它，在 linux-x64 / windows-x64 / macos-native 三个 runner 上 `electron-builder --dir` 出未打包应用，先**从 `electron-builder.yml` 读 `productName`**（不写死可执行文件名）再跑 `npm run package:smoke`；Linux 那条走 `xvfb-run`，并带 `ASTELLA_PACKAGED_OFFLINE_ONLY=1`。

`desktop-package.yml` **只打包不设质量闸**：装依赖 → 构建 → 出安装包 → 上传产物，`windows` 与 `macos` 互不依赖，`summary` 带 `if: always()`。它存在的理由是"质量闸挂了也该能先拿到一个能装能双击的包看看"，与"这个包能不能发"分开。

## 文档与代码里已知的不一致

以下是当场核对得到的差异。列在这里是为了让下一步要么改文档、要么把门禁接回去；每行给出**权威文件**。

| 说法 / 现象 | 权威文件 | 现状 |
| --- | --- | --- |
| "CI still builds production images from docker-compose.yml directly (see .github/workflows/main-ci.yml)" | `Makefile` 的 `ensure-db-volume` 上方注释 | `main-ci.yml` 里没有任何 `docker build` / compose 构建步骤。 |
| "`verify` 会**真的**卡覆盖率阈值" / "Skip/todo allowlist gate (blocks verify and release-check)" | `Makefile` 的 `verify` 与 `skip-todo-gate` 两段注释 | `verify` 里既没有 `coverage-gate.mjs` 也没有 `skip-todo-gate.mjs`；只有 `release-check` 跑 coverage 门禁，skip/todo 两道链都不跑。这两条注释是 2026-10-06 之前留下的。 |
| `Secret scan (Gitleaks) and container scan (Trivy) are integrated in CI` | `Makefile` `verify` 上方的注释 + `main-ci.yml` | 两个工作流里都没有 gitleaks / trivy 步骤；`ci-workflow-contract.test.mjs` 还把它们列进"不许再回 CI"的名字里。`.gitleaks.toml` 仍在仓库里。 |
| `scripts/with-restricted-db-urls.py` 自称对照 `.github/workflows/main-ci.yml:386-387` | `main-ci.yml` 只有 257 行 | 引用的行号不存在；`DATABASE_URL_API`/`_WORKER` 实际在 126–127 与 170–171 行。 |
| `desktop-client.yml` / `desktop-release.yml` / `desktop-version.mjs` / `ci-test-file-references.test.ts` 的注释里写 `ci.yml` | `.github/workflows/` 目录 | 这份工作流现在叫 `main-ci.yml`，`ci.yml` 不存在。影响一处判据：`ci-test-file-references.test.ts` 的 `ciReferences()` 读 `.github/workflows/ci.yml`，文件不在就 `return []`——**工作流那一半判据目前是空转**，只有 `package.json` 那一半在真拦（154 条引用，非空判据仍然满足）。 |
| `verify-alerts-syntax.mjs`、`verify-shared-exports.mjs`、`coverage-baseline-save.mjs`、`capture-image-digests.mjs`、`.github/ci/ai-platforms.mock.json` | 全仓 grep（排除 `node_modules` 与归档目录） | 这五个文件**没有任何 make 目标、工作流或包脚本调用它们**。`capture-image-digests.mjs` 的产物只被 `release-manifest-generate.mjs --images` 消费，而 `make release-manifest` / `release-check` 都没传 `--images`，所以 RC manifest 的镜像字段走占位符分支。 |
| `test-companion-integration-postgres` | `Makefile` 的两处 `.PHONY` | 目标定义在第 276 行，但**不在任何 `.PHONY` 清单**里。仓库里存在同名目录时会被当成目录依赖而跳过执行。 |
| `test-postgres` 的前置说明要求"已迁移（`make migrate` 或容器内 migrate）" | `Makefile` 的目标清单 | 没有 `migrate` 目标；迁移由 dev compose 的 `migrate` 一次性容器执行。 |

## 真实窗口核对

单元测试和守卫覆盖不了"真窗口里到底顺不顺"。项目的做法是把每一轮窗口核对写成文档留在 `docs/testing/`，写清跑了什么、看到什么、哪些项**没验证**：

| 文件 | 内容 |
| --- | --- |
| `docs/testing/full-qa-2026-10-05.md` | 全量页面与主流程首轮记录 |
| `docs/testing/full-qa-2026-10-05-final.md` | 同一轮的收口记录，含 2026-10-06 复测更新：逐项写出问题、解决方案与"修复后的证据"，并保留未闭合项（1 项需处理、2 组受版本或观察时长限制未验证） |
| `docs/testing/companion-record-reading-2026-10-05.md` | 伴星记录阅读核对，含按范围拆分的测试数表 |
| `docs/testing/discovery-bookmarks-2026-10-05.md` | 发现簿与收藏链路核对 |

安装包层面的证据由 `apps/desktop-client/scripts/` 里的脚本产出，`apps/desktop-client/package.json` 暴露成三条脚本：

| 脚本 | 做什么 |
| --- | --- |
| `npm run package:smoke` | `node scripts/smoke-packaged.mjs`：用 Playwright 的 `_electron` 启动已打包应用；可从 `electron-builder.yml` 读 `productName` 找包，带 `ASTELLA_PACKAGED_PREFLIGHT_ONLY` / `ASTELLA_PACKAGED_OFFLINE_ONLY` 两种离线口径 |
| `npm run package:evidence` | 先跑 `package:smoke`，再 `node scripts/package-evidence.mjs` 汇总冒烟结果与产物 sha256 |
| `npm run evidence:manifest` | `node --experimental-strip-types scripts/evidence-manifest.ts`，按 `scripts/fixtures/evidence-manifest.input.json` 生成质量证据清单（合同类型来自 `packages/shared/src/quality-evidence-contracts.ts`） |
| `npm run capture:evidence` | `npm run build` 后 `node scripts/capture-evidence.mjs` |

产物落在仓库根的 `.impeccable/evidence/`（`package-smoke.json`、`packaged-manifest.json` 等）。`desktop-client.yml` 的 `package-smoke` job 会把 `.impeccable/evidence/package-smoke-offline.json` 和 `release/` 一起上传成工件。

## 在这个仓库里加一条测试

下面这些约定来自 `../../../AGENTS.md` 与现有测试文件的写法，按它们做能少踩一轮返工：

1. **测试与被测放一起**：组件、样式、文案和状态逻辑放在同一个功能域目录里，测试进该域的 `__tests__/`；不要新建顶层测试目录。
2. **命名决定它跑不跑**：后端要进 `npm test` 就必须叫 `*.test.ts`；需要真库就叫 `*.integration.ts`，并同时把它加进某个 `test:*:postgres` 脚本——否则它会变成盘上没人引用的第 3 个文件。
3. **需要数据库就自己声明**：读环境变量用 `@astella/shared/integration-test-db-env` 的 `testDatabaseUrl()`，缺了当场喊，**不要写 `?? "postgres://…localhost…"` 的回落**（`integration-db-url-guard` 会扫到并判红，那条回落曾把夹具写进真实 dev 库）。用例若断言"库里只有自己的夹具"，就在注释里写清要用 `scripts/dev-disposable-db.sh` 起一次性库。
4. **隔离类断言用受限角色**：`astella_api` / `astella_worker` 是 `NOBYPASSRLS` 的，超级用户下这类断言必红或假通过；Makefile 的 `test-postgres` 已经把这组变量补齐，本地定点复现可用 `scripts/with-restricted-db-urls.py`。
5. **静态守卫必须自带正对照**：读源码的判据天生是绿的，所以要加一条"喂一份故意违规的样本，必须报出违例"的自证（`hud-substrate-guard`、`doc-pointer-reachability-source-guard`、`ci-test-file-references` 都这么写）。同时保证分母非空——解析器坏了不能让守卫静默通过。
6. **判据不要钉死文件路径**：`graph-surface-shape-guard` 之所以改成在目录树里搜文件名，是因为同级兄弟路径会让"拆分组件"这件事被一条测试无限推迟。断言对象是控制流形状，不是它住在哪。
7. **台账只许变短**：豁免、基线、待办清单（`SIZE_DEBT`、`KNOWN_DEAD`、`PENDING_W2_7`、schema 棘轮的两份基线）都要写成"实际集合与清单必须相等"，并把修好却没删的情况也判红；每条豁免写清理由，删条目连理由一起删。
8. **动效与交互改动要跑真窗口**：重复点击、快速反向切换、动效 Off、系统减少动态、键盘焦点路径，以及真实长内容、缩放和伴星位置——这几类截图与单测都不能替代，按 `docs/testing/` 的写法留一份记录，并把没验证的项单独列出。

## 这一页没有覆盖的部分

- AI 平台的真实凭据调用与线上质量评估：`pr-gate` 只跑固定桩，`test:platform-live:postgres` 需要真实 provider，两者都不在 `make verify` 与 CI 里。
- 生产镜像构建、compose 冒烟、备份与恢复演练、Alpha 基础设施巡检、Gitleaks / npm audit / Trivy 扫描：脚本与配置都在仓库里，但当前没有任何自动链路调用它们。怎么手动跑见 [运行与发布](./operations.md)。
- 覆盖率数字的现状：这一页只写阈值和判据，不写当前实测值（要实测值得跑一次 `make coverage-gate`，它自己会出报告）。
- 桌面端渲染层的具体测试写法与 jsdom 边界：见 [桌面客户端](./desktop-client.md)。
- `packages/card-generation` 的行为测试：目前不存在，这一页不替它声明覆盖。

## 相关分册

- [手册首页与总览](./overview.md)
- [架构](./architecture.md)
- [开发环境](./development.md)
- [桌面客户端](./desktop-client.md)
- [API 与数据](./api-and-data.md)
- [模型与 Worker 链路](./ai-and-companion.md)
- [统一 Agent 运行时（技术）](./agent-runtime.md)
- [伴星体验（产品设计）](./companion-experience.md)
- [运行与发布](./operations.md)
- [常见问题与排障](./faq-and-troubleshooting.md)
- 仓库根：[README](../../../README.md)、[AGENTS.md](../../../AGENTS.md)、[第三方声明](../../../THIRD_PARTY_NOTICES.md)
- 方案索引：[docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md)
