# docker compose 自己会读 .env，make 不会——于是同一个口令有两个真相源：
# 用 `make up` 起的库按 .env 走，而 `make test-postgres` 拼 IT_* 连接串时
# POSTGRES_PASSWORD 是空的，集测直接报 `password authentication failed`
# （2026-10-06 实测）。这里把 .env 读进来；下面那些 `?=` 默认值退成兜底，
# 命令行 `make VAR=x` 仍然优先。
-include .env

COMPOSE := docker compose -p astella-dev -f docker-compose.dev.yml
DEV_DB_VOLUME := astella-dev_dev_postgres_data
.DEFAULT_GOAL := up

# One-shot init containers (restart: "no") that exit after their task.
# Stale containers are removed at the START of each `up`/`storage` run
# so that `docker compose up` always recreates them with the latest image.
# After they exit they are LEFT IN PLACE (as exited containers) so that
# Docker Desktop's "Start" button (`docker compose start`) can restart the
# entire stack — including re-running migrations — without error.
#
# migrate / role-bootstrap run on every startup to apply pending schema
# migrations and re-apply role grants.  They are idempotent no-ops when
# nothing changed, but must run every time — they are NOT
# first-time-only.  minio-init and seed-* are genuinely one-time and are
# already gated behind profiles.
INIT_SERVICES := role-bootstrap migrate role-grants
STORAGE_INIT_SERVICES := minio-init

# Include the storage profile in every dev `up` so that avatar/note image
# uploads work out of the box without a separate `make storage` step.
DEV_PROFILES := --profile storage

.PHONY: up storage seed-demo down logs reset-db \
	rebuild config clean-init \
	ensure-db-volume disposable-db \
	shell-api shell-worker version-check verify release-check \
	coverage-gate skip-todo-gate release-manifest \
	test-postgres test-companion-home-profile-postgres \
	alpha-up alpha-down alpha-backup alpha-restore-verify alpha-status alpha-metrics \
	desktop-client-install desktop-client-dev desktop-client-build desktop-client-dist \
	desktop-client-dist-arm64 desktop-client-dist-linux desktop-client-dist-win \
	desktop-client-up desktop-client-down desktop-client-logs

# Local development stack: dev image targets, source bind mounts and hot
# reload.  This is the default `make up` target — there is no separate
# production stack for local use anymore.  CI still builds production images
# from docker-compose.yml directly (see .github/workflows/main-ci.yml), but that
# file is no longer wired to any local Makefile target.
ensure-db-volume:
	@set -e; if ! docker volume inspect "$(DEV_DB_VOLUME)" >/dev/null 2>&1; then \
		docker volume create \
			--label com.astella.protected=true \
			--label com.astella.purpose=postgres-data \
			"$(DEV_DB_VOLUME)" >/dev/null; \
		echo "Created protected database volume $(DEV_DB_VOLUME)"; \
	fi

up: ensure-db-volume
	-$(COMPOSE) rm -f $(INIT_SERVICES) $(STORAGE_INIT_SERVICES) 2>/dev/null
	$(COMPOSE) $(DEV_PROFILES) up -d --build --remove-orphans
	@set -e; for svc in $(INIT_SERVICES) $(STORAGE_INIT_SERVICES); do \
		cid="$$( $(COMPOSE) ps -aq $$svc )"; \
		if [ -z "$$cid" ]; then echo "Missing required init service: $$svc" >&2; exit 1; fi; \
		docker wait $$cid >/dev/null; \
	done

storage: ensure-db-volume
	-$(COMPOSE) rm -f $(INIT_SERVICES) $(STORAGE_INIT_SERVICES) 2>/dev/null
	$(COMPOSE) --profile storage up -d --build --remove-orphans
	@set -e; for svc in $(INIT_SERVICES) $(STORAGE_INIT_SERVICES); do \
		cid="$$( $(COMPOSE) ps -aq $$svc )"; \
		if [ -z "$$cid" ]; then echo "Missing required init service: $$svc" >&2; exit 1; fi; \
		docker wait $$cid >/dev/null; \
	done

# Manually remove stale one-shot init containers.  This is NOT called
# automatically by `up` — init containers are left in place after they
# exit so that Docker Desktop's "Start" button can restart the stack.
# Stale containers are instead removed at the beginning of the next
# `up`/`storage` run.
clean-init:
	@$(COMPOSE) rm -f $(INIT_SERVICES) 2>/dev/null || true

# Explicitly creates owner@astella.local / astella_owner in development only.
# Uses --rm so the container is removed immediately after seeding.
seed-demo: ensure-db-volume
	$(COMPOSE) --profile seed run --rm seed-demo

down:
	$(COMPOSE) down --remove-orphans

logs:
	$(COMPOSE) logs -f

reset-db:
	@if [ "$(CONFIRM_RESET_DB)" != "DELETE_DEV_DB" ]; then \
		echo "Database reset cancelled; no data was changed."; \
		echo "To permanently delete $(DEV_DB_VOLUME), run:"; \
		echo "  make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB"; \
		exit 2; \
	fi
	$(COMPOSE) down --remove-orphans
	@if docker volume inspect "$(DEV_DB_VOLUME)" >/dev/null 2>&1; then \
		docker volume rm "$(DEV_DB_VOLUME)"; \
	else \
		echo "Database volume $(DEV_DB_VOLUME) is already absent."; \
	fi
	$(MAKE) --no-print-directory up

# 一次性（可丢弃）数据库：见 scripts/dev-disposable-db.sh 顶部说明。
# 用途是给"断言依赖空库"的集成测试（RLS 策略目录、worker 队列、投影分页…）
# 一个隔离库——在共享开发库上跑这些用例会因残留行假失败。
# 脚本带名字护栏：只删/建 astella_* 且不等于 astella 的库。
disposable-db:
	bash scripts/dev-disposable-db.sh "$(DISPOSABLE_DB)"

# --no-cache 全量重建；**必须带上 seed profile**——seed-demo 在 profile 下，
# 漏掉它会让 `make rebuild` 静默跳过该镜像（实测 2026-09-16：其它 4 个镜像已重建，
# seed-demo 仍是两周前的，于是 `make seed-demo` 跑的是旧代码 + 旧依赖）。
rebuild:
	$(COMPOSE) --profile seed build --no-cache

config:
	$(COMPOSE) config --quiet

# release/version.json is the only manually edited version source. To update
# generated copies, run: node .github/scripts/version-contract.mjs --write
version-check:
	node .github/scripts/version-contract.mjs --check

# Honest local/CI baseline using only gates that exist today. Coverage gate is
# 覆盖率门禁：verify 与 release-check 都真卡（2026-09-29 P3-12 统一）。
# Secret scan (Gitleaks) and container scan (Trivy) are integrated in CI.
# AIQ RC requires the
# release provider credentials and is therefore executed by the RC workflow.
# `verify` 会**真的**卡覆盖率阈值。2026-09-29（P3-12）之前这里挂的是
# `coverage-gate.mjs --report-only`——那个模式只出报告不失败，于是
# `make verify` 名义上"验证"覆盖率，实际上一条线低都过得去。
# 与 CI 里 P0-3 已经改成的形态保持一致：要么两条路都卡，要么都不卡，
# 不能一条卡一条不卡。
# ─── 本地基线 ────────────────────────────────────────────────────────────
#
# **这里跑什么，CI 就跑什么，反过来也一样。** 两者由
# `.github/scripts/ci-workflow-contract.test.mjs` 钉住：少接一个包就红。
#
# 2026-10-06 之前这个目标末尾还挂着 `skip-todo-gate.mjs` 与
# `coverage-gate.mjs`，而 CI 里另有十条本地根本不跑的链（真库集测、Gitleaks、
# npm audit、镜像扫描、compose 冒烟、Alpha 巡检）。于是"本地全绿"与
# "CI 一片红"可以同时成立，而且红的全是没人跑过的东西——那是噪声，不是信号。
#
# 两个门禁脚本都还在，需要时按下面两个独立目标显式调用；它们不再是这条基线
# 的一部分，所以 CI 也不再要求它们过。
verify: version-check
	node --test .github/scripts/version-contract.test.mjs .github/scripts/release-manifest-contract.test.mjs .github/scripts/coverage-gate-lib.test.mjs .github/scripts/ci-workflow-contract.test.mjs .github/scripts/postgres-integration-lifecycle.test.mjs .github/scripts/compose-init-order.test.mjs
	node .github/scripts/verify-schema-mirror.mjs
	node .github/scripts/verify-companion-capability-config.mjs
	# 备份/恢复那组 shell 脚本的自测（53 条断言：卷名、mc 别名、禁用库名清单、
	# 校验值命令）。它以前**只有文档提到、没有任何验证目标跑它**——和当初
	# agent-core / agent-host "有测试但不在目标里" 是同一类。只依赖 bash + mktemp。
	bash infra/backup/backup-scripts.test.sh
	cd packages/shared && npm run typecheck && npm test
	# 2026-10-05（方案 44）：agent-core 与 agent-host 此前**不在**验证目标里——
	# 而上下文预算解析、完整请求计量、压缩冷却与失败学习全在 agent-core，
	# 方法的版本/来源/采用记录全在 agent-host。它们各自有测试，只是没人跑。
	cd packages/agent-core && npm run typecheck && npm test
	cd packages/agent-host && npm run typecheck && npm test
	# pr-gate 是 AI 质量层的 **PR Mock** 闸：固定数据集、固定桩，不访问付费网络。
	cd packages/ai-quality && npm run typecheck && npm test && npm run pr-gate
	cd apps/api && npm run typecheck && npm test
	cd apps/desktop-client && npm run typecheck && npm test
	cd workers/ai-worker && npm run typecheck && npm test

# Coverage gate with threshold enforcement (blocks release-check, not PRs).
coverage-gate:
	node .github/scripts/coverage-gate.mjs

# Skip/todo allowlist gate (blocks verify and release-check).
skip-todo-gate:
	node .github/scripts/skip-todo-gate.mjs

# Generate release manifest (collects test summaries, coverage, digests).
release-manifest:
	node .github/scripts/release-manifest-generate.mjs

# Source inputs are checked first. The actual manifest is generated after the
# tag and stays untracked because embedding HEAD in a tracked file would be
# self-referential. On an exact release tag, the final command fails closed
# unless RELEASE_MANIFEST_PATH names a complete CI/release JSON artifact.
release-check:
	node .github/scripts/verify-release-inputs.mjs
	$(MAKE) --no-print-directory verify
	node .github/scripts/coverage-gate.mjs
	node .github/scripts/release-manifest-generate.mjs
	node .github/scripts/release-manifest-contract.mjs

# ─── 真实 PostgreSQL 集成测试（不进 CI） ─────────────────────────────────
#
# 2026-10-06：这些套件整体退出 CI。理由是 CI 不该跑本地基线之外的东西——
# 退出前它们在 CI 上是 12 条真红（`note-learning-round-access-revoked` 撞上
# 0284 的 append-only 触发器那一族），而本地没人跑，于是"CI 坏了"这个结论
# 既对又没用。**退出 CI 不等于放弃它们**：文件、脚本、夹具全部原样保留，
# 需要时用这个目标跑。
#
# 前置：本地库已就绪（`make up`），且已迁移（`make migrate` 或容器内 migrate）。
# **必须在干净的一次性库上跑**——用例含"库里只有自己的夹具"类断言，共享开发库
# 会假失败：
#   bash scripts/dev-disposable-db.sh astella_it
#   make test-postgres COMPANION_HOME_TEST_DB=astella_it
#
# 显式给**受限角色**：超级用户会绕过 RLS，隔离断言会变成假通过。
# 连接参数沿用 COMPANION_HOME_TEST_* 那组变量。
IT_HOST ?= $(COMPANION_HOME_TEST_HOST)
IT_PORT ?= $(COMPANION_HOME_TEST_PORT)
IT_DB ?= $(COMPANION_HOME_TEST_DB)
IT_MIGRATOR_PASSWORD ?= $(COMPANION_HOME_TEST_MIGRATOR_PASSWORD)
IT_API_PASSWORD ?= $(COMPANION_HOME_TEST_API_PASSWORD)
IT_WORKER_PASSWORD ?= $(COMPANION_HOME_TEST_API_PASSWORD)
IT_SUPERUSER_URL = postgres://astella:$(POSTGRES_PASSWORD)@$(IT_HOST):$(IT_PORT)/$(IT_DB)
IT_MIGRATOR_URL = postgres://astella_migrator:$(IT_MIGRATOR_PASSWORD)@$(IT_HOST):$(IT_PORT)/$(IT_DB)
IT_API_URL = postgres://astella_api:$(IT_API_PASSWORD)@$(IT_HOST):$(IT_PORT)/$(IT_DB)
IT_WORKER_URL = postgres://astella_worker:$(IT_WORKER_PASSWORD)@$(IT_HOST):$(IT_PORT)/$(IT_DB)

# 每个用例读的名字**不只** DATABASE_URL_* 那一组：RLS、队列、内容哈希、
# SEC-02 邀请、版本恢复、限流各自读一个专用变量，缺了就直接
# `throw new Error('… is required')`——那条是**显式拒绝**，不是静默 skip，
# 所以少给一个就是"整份文件红在读环境变量上"，用例一条都没跑。
# 下面这一组是 2026-10-06 实测补齐的（漏了 RLS_TEST_* 那两个别名时，
# users-rls 与 rls-policies 两份直接抛错）。
test-postgres:
	@for pkg in apps/api workers/ai-worker; do \
		echo "════════ $$pkg ════════"; \
		scripts=$$(cd $$pkg && node -e 'const p=require("./package.json");console.log(Object.keys(p.scripts).filter(k=>k.startsWith("test:")&&k.endsWith(":postgres")).sort().join("\n"))'); \
		for s in $$scripts; do \
			echo "── $$s"; \
			(cd $$pkg && NODE_ENV=test \
				DATABASE_URL="$(IT_SUPERUSER_URL)" \
				DATABASE_URL_MIGRATOR="$(IT_MIGRATOR_URL)" \
				DATABASE_URL_API="$(IT_API_URL)" \
				DATABASE_URL_WORKER="$(IT_WORKER_URL)" \
				DATABASE_URL_API_RLS="$(IT_API_URL)" \
				DATABASE_URL_TEST_ADMIN="$(IT_SUPERUSER_URL)" \
				RLS_TEST_MIGRATOR_DATABASE_URL="$(IT_MIGRATOR_URL)" \
				RLS_TEST_API_DATABASE_URL="$(IT_API_URL)" \
				RLS_TEST_WORKER_DATABASE_URL="$(IT_WORKER_URL)" \
				QUEUE_TEST_MIGRATOR_DATABASE_URL="$(IT_MIGRATOR_URL)" \
				QUEUE_TEST_WORKER_A_DATABASE_URL="$(IT_WORKER_URL)" \
				QUEUE_TEST_WORKER_B_DATABASE_URL="$(IT_WORKER_URL)" \
				RATE_LIMIT_TEST_DATABASE_URL="$(IT_API_URL)" \
				CONTENT_HASH_TEST_DATABASE_URL="$(IT_SUPERUSER_URL)" \
				SEC02_TEST_DATABASE_URL="$(IT_SUPERUSER_URL)" \
				NOTE_VERSION_RESTORE_TEST_DATABASE_URL="$(IT_SUPERUSER_URL)" \
				npm run --silent $$s) || exit 1; \
		done; \
	done

shell-api:
	$(COMPOSE) exec api sh

shell-worker:
	$(COMPOSE) exec worker sh

# ─── Companion 首页房间档案：真实 PostgreSQL 集成测试 ────────────────
# 覆盖 0185 RLS 隔离、真实 SQL revision CAS（含并发写入者竞争）以及
# PATCH /companion/room-profile 的 400/409/200 认证契约。
# 需要本地开发栈已启动（make up）。这里显式使用受限角色而不是 compose 注入给
# API 容器的超级用户 URL：超级用户会绕过 RLS，让隔离断言变成假通过。
# 连接参数可用同名变量覆盖，例如
#   make test-companion-home-profile-postgres COMPANION_HOME_TEST_DB=other_db
COMPANION_HOME_TEST_HOST ?= 127.0.0.1
COMPANION_HOME_TEST_PORT ?= 5432
COMPANION_HOME_TEST_DB ?= astella
COMPANION_HOME_TEST_MIGRATOR_PASSWORD ?= astella_dev
COMPANION_HOME_TEST_API_PASSWORD ?= astella_dev

test-companion-home-profile-postgres:
	cd apps/api && \
		NODE_ENV=test \
		DATABASE_URL_MIGRATOR="postgres://astella_migrator:$(COMPANION_HOME_TEST_MIGRATOR_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		DATABASE_URL_API="postgres://astella_api:$(COMPANION_HOME_TEST_API_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		npm run test:companion-home-profile:postgres

# ─── Companion 集成矩阵：对话/记忆/交付/旅程/工具网关（16 个套件） ──────
# 这些套件此前没有任何 CI job 或 make 目标，只能在记得文件名时手工运行。
# 必须在**干净库**上跑：用例含「库里只有自己的夹具」类断言，共享开发库会假失败。
# 推荐配合一次性隔离库：
#   bash scripts/dev-disposable-db.sh astella_companion_it
#   make test-companion-integration-postgres COMPANION_HOME_TEST_DB=astella_companion_it
# 与 home-profile 目标同理，显式使用受限角色（超级用户会绕过 RLS，让隔离断言假通过）。
test-companion-integration-postgres:
	cd apps/api && \
		NODE_ENV=test \
		DATABASE_URL_MIGRATOR="postgres://astella_migrator:$(COMPANION_HOME_TEST_MIGRATOR_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		DATABASE_URL_API="postgres://astella_api:$(COMPANION_HOME_TEST_API_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		DATABASE_URL_WORKER="postgres://astella_worker:$(COMPANION_HOME_TEST_API_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		npm run test:companion-integration:postgres

# ─── Alpha environment (OPS-01) ──────────────────────────────────────
# Docker-based Alpha environment with Prometheus, Alertmanager, and
# backup infrastructure. Requires .env with POSTGRES_PASSWORD,
# MIGRATOR_PASSWORD, API_PASSWORD, WORKER_PASSWORD, MINIO_ROOT_PASSWORD.
ALPHA_SCRIPT := ./scripts/alpha-env-setup.sh

alpha-up:
	$(ALPHA_SCRIPT) up

alpha-down:
	$(ALPHA_SCRIPT) down

alpha-backup:
	$(ALPHA_SCRIPT) backup

alpha-restore-verify:
	$(ALPHA_SCRIPT) restore-verify

alpha-status:
	$(ALPHA_SCRIPT) status

alpha-metrics:
	$(ALPHA_SCRIPT) metrics

# ─── Desktop client ─────────────────────────────────────────────────
# The desktop client is the only supported application shell.

DESKTOP_CLIENT_DIR := apps/desktop-client
DESKTOP_COMPOSE := docker-compose.dev.yml
DESKTOP_PROJECT := astella-dev

.PHONY: desktop-client-install desktop-client-dev desktop-client-build desktop-client-dist \
	desktop-client-dist-arm64 desktop-client-dist-linux desktop-client-dist-win \
	desktop-client-dist-mac \
	desktop-client-up desktop-client-down desktop-client-logs

# Install desktop Electron dependencies.
# 2026-08-11：npm ci（依赖与 lock 严格一致，锁文件已提交）
desktop-client-install:
	cd $(DESKTOP_CLIENT_DIR) && npm ci

# Run the desktop app in development mode (requires Docker stack running).
desktop-client-dev:
	cd $(DESKTOP_CLIENT_DIR) && npm run dev

# Build the Electron main/preload bundles.
desktop-client-build:
	cd $(DESKTOP_CLIENT_DIR) && npm run build

# Package the desktop app for the host platform (or the target passed through
# the npm script).  Cross-platform CI invokes electron-builder explicitly.
desktop-client-dist:
	cd $(DESKTOP_CLIENT_DIR) && npm run dist

# 下面四个 target 只构建 + 打包，不跑 typecheck / vitest（`dist` 会跑那两道门禁）。
# 双平台的 CI 打包流程见 .github/workflows/desktop-package.yml。

# Package for Apple Silicon only (smaller, faster build).
desktop-client-dist-arm64:
	cd $(DESKTOP_CLIENT_DIR) && npm run package:mac:arm64

# Linux x64 AppImage build (CI/Ubuntu runner).
desktop-client-dist-linux:
	cd $(DESKTOP_CLIENT_DIR) && npm run package:linux:x64

# Windows x64 NSIS installer (CI/Windows runner or a configured Wine host).
desktop-client-dist-win:
	cd $(DESKTOP_CLIENT_DIR) && npm run package:win:x64

# macOS dmg+zip (Apple Silicon; package:mac:x64 for the Intel build).
desktop-client-dist-mac:
	cd $(DESKTOP_CLIENT_DIR) && npm run package:mac:arm64

# Manually start the shared development Docker stack (without the Electron app).
desktop-client-up:
	docker compose -f $(DESKTOP_COMPOSE) -p $(DESKTOP_PROJECT) up -d --build

# Stop the desktop Docker stack.
desktop-client-down:
	docker compose -f $(DESKTOP_COMPOSE) -p $(DESKTOP_PROJECT) down

# Tail desktop stack logs.
desktop-client-logs:
	docker compose -f $(DESKTOP_COMPOSE) -p $(DESKTOP_PROJECT) logs -f
