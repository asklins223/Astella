COMPOSE := docker compose -p ailearn-dev -f docker-compose.dev.yml
DEV_DB_VOLUME := ailearn-dev_dev_postgres_data
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
INIT_SERVICES := role-bootstrap migrate
STORAGE_INIT_SERVICES := minio-init

# Include the storage profile in every dev `up` so that avatar/note image
# uploads work out of the box without a separate `make storage` step.
DEV_PROFILES := --profile storage

.PHONY: up storage seed-demo down logs reset-db \
	rebuild config clean-init \
	ensure-db-volume disposable-db \
	shell-api shell-worker version-check verify release-check \
	coverage-gate skip-todo-gate release-manifest \
	test-companion-home-profile-postgres \
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
			--label com.ailearn.protected=true \
			--label com.ailearn.purpose=postgres-data \
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

# Explicitly creates owner@ailearn.local / ailearn_owner in development only.
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
# 脚本带名字护栏：只删/建 ailearn_* 且不等于 ailearn 的库。
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
verify: version-check
	node --test .github/scripts/version-contract.test.mjs .github/scripts/release-manifest-contract.test.mjs .github/scripts/coverage-gate-lib.test.mjs .github/scripts/ci-workflow-contract.test.mjs .github/scripts/postgres-integration-lifecycle.test.mjs
	node .github/scripts/verify-schema-mirror.mjs
	node .github/scripts/verify-companion-capability-config.mjs
	cd packages/shared && npm run typecheck && npm test
	cd packages/ai-quality && npm run typecheck && npm test && npm run pr-gate
	cd apps/api && npm run typecheck && npm test
	cd apps/desktop-client && npm run typecheck && npm test
	cd workers/ai-worker && npm run typecheck && npm test
	node .github/scripts/skip-todo-gate.mjs
	node .github/scripts/coverage-gate.mjs

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
COMPANION_HOME_TEST_DB ?= ailearn
COMPANION_HOME_TEST_MIGRATOR_PASSWORD ?= ailearn_dev
COMPANION_HOME_TEST_API_PASSWORD ?= ailearn_dev

test-companion-home-profile-postgres:
	cd apps/api && \
		NODE_ENV=test \
		DATABASE_URL_MIGRATOR="postgres://ailearn_migrator:$(COMPANION_HOME_TEST_MIGRATOR_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		DATABASE_URL_API="postgres://ailearn_api:$(COMPANION_HOME_TEST_API_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		npm run test:companion-home-profile:postgres

# ─── Companion 集成矩阵：对话/记忆/交付/旅程/工具网关（16 个套件） ──────
# 这些套件此前没有任何 CI job 或 make 目标，只能在记得文件名时手工运行。
# 必须在**干净库**上跑：用例含「库里只有自己的夹具」类断言，共享开发库会假失败。
# 推荐配合一次性隔离库：
#   bash scripts/dev-disposable-db.sh ailearn_companion_it
#   make test-companion-integration-postgres COMPANION_HOME_TEST_DB=ailearn_companion_it
# 与 home-profile 目标同理，显式使用受限角色（超级用户会绕过 RLS，让隔离断言假通过）。
test-companion-integration-postgres:
	cd apps/api && \
		NODE_ENV=test \
		DATABASE_URL_MIGRATOR="postgres://ailearn_migrator:$(COMPANION_HOME_TEST_MIGRATOR_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		DATABASE_URL_API="postgres://ailearn_api:$(COMPANION_HOME_TEST_API_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
		DATABASE_URL_WORKER="postgres://ailearn_worker:$(COMPANION_HOME_TEST_API_PASSWORD)@$(COMPANION_HOME_TEST_HOST):$(COMPANION_HOME_TEST_PORT)/$(COMPANION_HOME_TEST_DB)" \
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
DESKTOP_PROJECT := ailearn-dev

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
