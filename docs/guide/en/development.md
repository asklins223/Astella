# Astella Development Environment

[中文](../zh/development.md) · English

What this covers: from a clean checkout to a window you can actually operate — what each step really runs, which commands only look like they do something, and which variables you have to fill in yourself. Every line below was checked against `Makefile`, `docker-compose.dev.yml`, each package's `package.json` and the Dockerfiles. This page is the local development stack; production image builds and the Alpha environment live in [operations.md](operations.md).

- [Prerequisites](#prerequisites)
- [From a clean checkout to a working window](#from-a-clean-checkout-to-a-working-window)
- [/health and /ready assert different things](#health-and-ready-assert-different-things)
- [Port table](#port-table)
- [How hot reload actually works](#how-hot-reload-actually-works)
- [The one-shot container convention](#the-one-shot-container-convention)
- [Database volume safety](#database-volume-safety)
- [Day-to-day commands](#day-to-day-commands)
- [Where the dev window differs from a packaged build](#where-the-dev-window-differs-from-a-packaged-build)
- [What to read once it runs](#what-to-read-once-it-runs)
- [Common first-run failures](#common-first-run-failures)

## Prerequisites

| Needed | Why | How to check |
| --- | --- | --- |
| Docker + Compose v2 | Everything the stack depends on (postgres, minio, edge-tts, api, worker) is in `docker-compose.dev.yml`; PostgreSQL does **not** need to be installed locally | `docker compose version` |
| `make` | Every entry point is a Make target; bare `make` means `make up` (`.DEFAULT_GOAL := up`) | `make -v` |
| Node 22 | Both service images are `node:22.11.0-alpine3.20` (`apps/api/Dockerfile:4`, `workers/ai-worker/Dockerfile:3`); CI pins `NODE_VERSION: "22"` (`.github/workflows/main-ci.yml`) | `node -v` |
| `npm ci` once per package | Nine packages each carry their own `package-lock.json`; `@astella/*` are `file:` symlinks, but `tsc` resolves `zod` / `drizzle-orm` from the **imported package's own** `node_modules` | `ls package-lock.json packages/*/package-lock.json apps/*/package-lock.json workers/*/package-lock.json` |
| `python3` | Several live probes (`scripts/companion-inbox-sse-probe.py` and friends) and the edge-tts service script are Python | `python3 -V` |

Two things worth stating honestly rather than papering over. First: **there is no `.nvmrc`, and no `engines` field** anywhere in the root, `apps/*`, `packages/*` or `workers/*` `package.json`. "Node 22" exists only as an image tag and a CI variable — switching Node versions won't be blocked, and won't warn you either. Second: the repo carries **six stray `pnpm-lock.yaml` files** (root, api, desktop-client, shared, ai-quality, ai-worker) that **no command reads**. `Makefile`, both Dockerfiles and CI all use `npm ci`. Treat those lockfiles as historical material; don't infer a dependency graph from them.

## From a clean checkout to a working window

### 1. Prepare `.env`

```bash
cp .env.example .env
```

The header of `.env.example` calls it a production template, but **the dev stack genuinely needs the file**: PostgreSQL credentials, role passwords and MinIO credentials are hard-coded local defaults inside `docker-compose.dev.yml` (the `x-dev-database` anchor plus each service's `environment`), and compose only reads the `${VAR:-default}` items from `.env`.

Exactly one variable is **hard-required** by the dev stack — compose uses the `:?` form, so `make up` fails outright when it is unset or empty:

| Variable | Purpose | What happens if you skip it |
| --- | --- | --- |
| `EDGE_TTS_AUTH_TOKEN` | shared auth token between the `edge-tts` container and api; both sides must match | compose fails during interpolation with `Set EDGE_TTS_AUTH_TOKEN in .env` |

Then, **for the desktop window to log in**, three more are required (`.env.example` leaves them blank, and blank means fail closed):

| Variable | Purpose | Observed behaviour when blank |
| --- | --- | --- |
| `ASTELLA_DESKTOP_PAIRING_KEY_ID` | pairing key id, echoed in the challenge request | api answers 503 `desktop_trust_unavailable` |
| `ASTELLA_DESKTOP_PAIRING_SECRET` | base64url, at least 32 decoded bytes; the HMAC-SHA256 key | same as above, and the main process cannot build a `local_loopback` config at all, so connection state is `configuration_error: pairing_secret_missing` |
| `ASTELLA_DOMAIN_SCHEMA_REVISION` | domain contract revision, part of the signed challenge message | same; either side missing it is refused |

`openssl rand -base64 32` yields standard base64 (with `+` and `/`), while `readDesktopTrustConfig` requires `^[A-Za-z0-9_-]+$` and that `Buffer.from(v,'base64url').toString('base64url') === v` — convert to base64url before pasting.

Generate a correctly encoded pairing key directly:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

For local development use a key id such as `local-dev` and revision such as `local-dev-v1`, matching both sides. Remote HTTPS does not use the local pairing secret but still needs a valid certificate and contract revision; see [Deployment](deployment.md).

Real model calls need keys: `DASHSCOPE_API_KEY`, `OPENAI_COMPAT_API_KEY`, `OPENCODE_GO_API_KEY`, `SILICONFLOW_API_KEY`, `BIGMODEL_API_KEY`, `TOKENRHYTHM_API_KEY`. Which platform serves which capability is decided by `config/ai-platforms.json`, and `docker-compose.dev.yml` only passes through the variables **explicitly listed** there. When adding a provider, update the model JSON and environment forwarding in the Compose files you use, checking both API and Worker. `ASSESSMENT_CRITIC_URL` / `_KEY` / `_MODEL` are a separate group: unconfigured, open-ended answer assessment takes the deterministic path instead of guessing.

The remaining variables (`COMPANION_*`, `LEARNING_RUN_ENABLED`, `CARD_GENERATION_*`, …) already have local defaults in dev. `.github/scripts/verify-companion-capability-config.mjs`, run by `make verify`, checks that the flags declared by api and worker stay paired, so the API never accepts a turn the worker immediately rejects as disabled.

### 2. `make up`

```bash
make up
```

The Makefile `up` target performs four steps:

1. `ensure-db-volume`: if `docker volume inspect` fails, create `astella-dev_dev_postgres_data` labelled `com.astella.protected=true`.
2. `compose rm -f role-bootstrap migrate role-grants minio-init`: clear last round's exited init containers.
3. `compose --profile storage up -d --build --remove-orphans`: build the `target: dev` images and start postgres / minio / api / worker / edge-tts. The dev stack **includes the storage profile by default** (`DEV_PROFILES`), so avatar and note-image upload work without a separate `make storage`.
4. `docker wait` on each of `role-bootstrap`, `migrate`, `role-grants` and `minio-init`.

Get step 4's semantics right, because it is where a green command lies. `docker wait` **blocks until the container exits and prints its exit code**, but the CLI itself exits 0 (measured on this machine 2026-10-06: a container exiting with code 3 made `docker wait` print `3` while `$?` stayed `0`), and the Makefile redirects that output to `/dev/null`. So "waits for init to finish" is true; **"a failed migration aborts `make up`" is not**. `make up` will complete successfully, and you find out another way: `GET /ready`, or `docker compose -p astella-dev -f docker-compose.dev.yml logs migrate`.

`migrate`, `role-bootstrap` and `role-grants` run on every start (idempotent no-ops when nothing changed) — they are not first-time-only. `minio-init` and `seed-*` are the genuinely one-time ones.

### 3. `make seed-demo`

```bash
make seed-demo
```

Runs `compose --profile seed run --rm seed-demo`, which executes `npm run db:seed` in the container with `SEED_DEMO_DATA=true`. `apps/api/src/db/seed.ts` defines the demo credentials:

```text
email:    owner@astella.local
password: astella_owner
```

`make seed-demo` does not forward `.env` values for `OWNER_EMAIL`/`OWNER_PASSWORD`. It creates the defaults above and skips an existing email without resetting its password. For custom seeding, export both values in the shell and use `docker compose -p astella-dev -f docker-compose.dev.yml --profile seed run --rm -e OWNER_EMAIL -e OWNER_PASSWORD seed-demo`; passwords must have at least 12 characters.

**These default credentials are only for local development.** `seed.ts` throws when `NODE_ENV=production` and `SEED_DEMO_DATA=true` are combined; a production stack seeds its Owner from explicit `OWNER_EMAIL` / `OWNER_PASSWORD`.

### 4. Install dependencies and open the window

```bash
make desktop-client-install   # cd apps/desktop-client && npm ci
make desktop-client-dev       # cd apps/desktop-client && npm run dev
```

`npm run dev` expands to `electron-vite dev --remoteDebuggingPort 9222`. It requires the Docker stack to be **already running**: the main process targets `http://127.0.0.1:4000` by default (`DEFAULT_API_ORIGIN` in `desktop-gateway.ts`, overridable with `DESKTOP_API_ORIGIN`). `electron.vite.config.ts` loads the repository-root `.env`, and its comment is explicit that these values go to the **privileged main process only** — they are not injected into the renderer's `import.meta.env` and not exposed through preload.

## /health and /ready assert different things

| Endpoint | What it checks | What a failure means |
| --- | --- | --- |
| `GET /health` | the process is alive and the event loop can answer HTTP. `server.ts` returns only `{status:"ok",service:"api",timestamp}` | the process itself is broken |
| `GET /ready` | `SELECT 1`; the nine core tables present in `information_schema.tables` (`users`, `workspaces`, `notes`, `jobs`, `sessions`, `learning_runs`, `learning_run_private_contracts`, `learning_tasks`, `learning_task_variants`); and `max(created_at)` from `drizzle.__drizzle_migrations` ≥ `MIN_READY_MIGRATION_CREATED_AT` (default `1786683800000`) | the database is reachable but its schema is incomplete — migrations never ran, or ran half way |
| `GET /metrics` | Prometheus text exposition | says nothing about liveness or readiness |

`/ready` is what the compose healthcheck for api targets. **Worker is asymmetric**: `/ready` exists in code (`workers/ai-worker/src/lib/metrics.ts`, probing `db.execute(sql`SELECT 1`)`), but the healthcheck in `docker-compose.dev.yml` still polls `/metrics` — so a dead database will not mark the worker container unhealthy. Read "compose says worker is healthy" as "worker can serve metrics", nothing more.

## Port table

| Service | Container | Host | Binding comes from |
| --- | --- | --- | --- |
| api | 4000 | `${API_PORT:-4000}` | `${API_BIND_ADDRESS:-127.0.0.1}`; the in-container listener is set by `API_INTERNAL_BIND_ADDRESS:-0.0.0.0` |
| postgres | 5432 | `${POSTGRES_PORT:-5432}` | `${POSTGRES_BIND_ADDRESS:-127.0.0.1}` |
| minio | 9000 | `${MINIO_PORT:-9000}` | `${MINIO_BIND_ADDRESS:-127.0.0.1}` |
| minio console | 9001 | `${MINIO_CONSOLE_PORT:-9001}` | same |
| worker metrics | 9100 | `${WORKER_METRICS_PORT:-9100}` | `${WORKER_METRICS_BIND_ADDRESS:-127.0.0.1}`; the process itself calls `listen(port, "0.0.0.0")` |
| edge-tts | 8080 | `127.0.0.1:${EDGE_TTS_PORT:-8088}` | hard-coded loopback |
| Electron main | — | `127.0.0.1:9222` (CDP) | for capture and probe scripts only |

`API_BIND_ADDRESS` is not "set it to `0.0.0.0` if you feel like it": `resolveApiBindHost()` (`apps/api/src/modules/desktop-trust/routes.ts`) accepts the literal `127.0.0.1`, or `0.0.0.0` only when **both** `ASTELLA_CONTAINER_MODE=true` **and** `ASTELLA_ALLOW_CONTAINER_WILDCARD=true`. dev compose sets both for the container; on the host you get `API_BIND_ADDRESS must be literal 127.0.0.1…`.

edge-tts has two addresses on purpose: the api inside compose uses `http://edge-tts:8080`, an api running directly on the host uses `http://127.0.0.1:8088`. Both must carry the same `EDGE_TTS_AUTH_TOKEN`, and **do not point a host-run API at the Docker service name**.

## How hot reload actually works

Image layer: both `apps/api/Dockerfile` and `workers/ai-worker/Dockerfile` have a `FROM base AS dev` stage with `NODE_ENV=development` and `CMD ["npm", "run", "dev"]`, where `dev` is `tsx watch src/server.ts` / `tsx watch src/index.ts`. The `prod` stage runs `node dist/server.cjs` / `node dist/index.cjs` and has no watch at all.

Runtime mounts (`docker-compose.dev.yml`; api and worker each carry the same package set):

| Mount | Covers |
| --- | --- |
| `./apps/api/src` → `/app/src` (api) / `./workers/ai-worker/src` → `/app/src` (worker) | that service's source |
| `./packages/shared` → `/app/packages/shared` | the **whole package directory**, not just `src` |
| `./packages/agent-core/src` + `package.json` | agent-core source and its `exports` manifest |
| `./packages/agent-host/src` + `package.json` | same |
| `./packages/card-generation/src` + `package.json` | same |
| `./config` → `/app/config:ro` | `ai-platforms.json` |
| `/var/run/docker.sock` → `/var/run/docker.sock` | api only, and **dev stack only**: it powers the operations panel's container view, and is equivalent to host root |

Inside the container `@astella/*` are symlinks to `/app/packages/*`, and `NODE_OPTIONS=--preserve-symlinks` keeps them resolving through one `node_modules`, so drizzle and zod exist as single instances.

`CHOKIDAR_USEPOLLING: "true"` with `CHOKIDAR_INTERVAL: "1000"` is set on both api and worker: Docker Desktop on macOS does not reliably deliver inotify events across bind mounts, so without polling `tsx watch` receives the change and never restarts. The price is a per-second scan of the source tree.

**Dependency changes do not hot reload.** The image's `node_modules` is a build-stage `npm ci` product and no mount covers it. Edit any `package.json` and you need `make rebuild` (`--no-cache`, and it **must include the seed profile** — the Makefile comment records a 2026-09-16 measurement where omitting it silently left the `seed-demo` image two weeks stale, so `make seed-demo` ran old code against old dependencies).

## The one-shot container convention

`role-bootstrap`, `migrate`, `role-grants` and `minio-init` are `restart: "no"` and are **left in place as `Exited` containers**. That is deliberate, not untidy (`Makefile:6-18`): Docker Desktop's group **Start** is effectively `docker compose start`, which restarts containers without recreating them, so if the init containers had been deleted, pressing Start in the GUI would skip migrations. Leaving them means Start re-runs migrations and role grants (idempotent, no-op when nothing changed). Real cleanup happens at the **beginning of the next** `make up` / `make storage`, or manually:

```bash
make clean-init   # removes role-bootstrap, migrate and role-grants; minio-init is not in that list
```

`make seed-demo` uses `run --rm` and removes itself, so never seeing it in `ps -a` is normal.

## Database volume safety

```yaml
dev_postgres_data:
  name: astella-dev_dev_postgres_data
  external: true
```

`external: true` means compose does not own the volume: `make down` (`down --remove-orphans`), deleting containers, or even `docker compose down -v` **cannot remove it**. The single deletion path is an explicit confirmation:

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB
```

`Makefile:86-99`: any value other than exactly `DELETE_DEV_DB` prints a cancellation notice and `exit 2` without touching anything; the correct value triggers `down`, `docker volume rm`, then a fresh `make up`. Back up first, then do it.

When you need a clean database whose contents are only your own fixtures, don't reset the dev volume — create a throwaway one:

```bash
make disposable-db DISPOSABLE_DB=astella_it   # scripts/dev-disposable-db.sh, guarded to astella_* and never the base astella db
```

`make test-postgres` is built for exactly that: it enumerates every `test:*:postgres` script from `apps/api` and `workers/ai-worker` `package.json` and injects the suite-specific connection variables (`RLS_TEST_*`, `QUEUE_TEST_*`, `RATE_LIMIT_TEST_DATABASE_URL`, `CONTENT_HASH_TEST_DATABASE_URL`, `SEC02_TEST_DATABASE_URL`, `NOTE_VERSION_RESTORE_TEST_DATABASE_URL`). These suites left CI on 2026-10-06; **the files and fixtures all remain**, nobody runs them by default.

## Day-to-day commands

| Command | What it actually does |
| --- | --- |
| `make up` | the four steps above; bare `make` is this |
| `make storage` | same shape as `up` but names the storage profile explicitly (since `up` now includes it, the two are effectively equivalent) |
| `make logs` | `compose logs -f`, all services |
| `make down` | `down --remove-orphans`, data preserved |
| `make config` | `compose config --quiet`: validates YAML and variable interpolation only, **never touches Docker** — a missing required `.env` value shows up here |
| `make rebuild` | `compose --profile seed build --no-cache`; follow with `make up` |
| `make clean-init` | clears `role-bootstrap`, `migrate` and `role-grants` (taken from `INIT_SERVICES`) |
| `make shell-api` / `make shell-worker` | `compose exec api sh` / `exec worker sh` |
| `make verify` | `version-check` first, then five contract test files, the schema-mirror check, the companion flag parity check, and `typecheck` + `test` across seven packages (`packages/ai-quality` additionally runs `pr-gate`). **This is the CI baseline locally**, and `.github/scripts/ci-workflow-contract.test.mjs` pins the two together |
| `make test-postgres` | real-database suites; needs a clean throwaway database (previous section) |
| `make disposable-db` | create / drop a throwaway dev database |
| `make release-check` | `verify` + release-input validation + `coverage-gate` (thresholds genuinely enforced) + manifest generation and validation |
| `make coverage-gate` / `make skip-todo-gate` | two standalone gates that are **no longer part of `verify`**; call them explicitly |
| `make alpha-up` / `alpha-down` / `alpha-status` / `alpha-metrics` / `alpha-backup` / `alpha-restore-verify` | via `scripts/alpha-env-setup.sh` + `docker-compose.alpha.yml` (prometheus / alertmanager / backups) |
| `make desktop-client-dev` / `-build` / `-dist` | `npm run dev` / `build` / `dist` (`dist` = typecheck + test + build + electron-builder) |
| `make desktop-client-dist-arm64` / `-mac` | `package:mac:arm64`: build and package only, without those two gates |
| `make desktop-client-dist-linux` / `-win` | `package:linux:x64` / `package:win:x64` |

## Where the dev window differs from a packaged build

| Dimension | `make desktop-client-dev` | Packaged app |
| --- | --- | --- |
| Page source | Vite dev server; main reads the origin from `ELECTRON_RENDERER_URL` | `astella-app://bundle/index.html`, served by `protocol.handle` from inside the package |
| CSP | dev origin added to `connect-src` (plus its `ws:` variant) and `'unsafe-inline'` in `script-src` for the React refresh preamble | strict policy; the artifact origin gets its own `default-src 'none'` |
| Navigation gate | dev server origin allowed | only `astella-app://bundle`, with no username, no password and no port |
| DevTools | available (`webPreferences.devTools: !app.isPackaged`, `src/main/index.ts`) | disabled |
| CDP | `--remoteDebuggingPort 9222`, which is what capture and probe scripts attach to | not exposed |
| Voice models | the dev server serves the two model files on its own origin (the custom scheme does not do CORS; a cross-origin fetch measured `TypeError: Failed to fetch`) | `astella-app://bundle/device/asr/`, same-origin read |
| Main-process restart | `npm run dev` does not watch main/preload — restart the command after editing them; `npm run dev:watch-main` (`electron-vite dev -w`) keeps rebuilding them | not applicable |

`out/` is the `electron-vite build` output directory (ignored by `apps/desktop-client/.gitignore`). `npm run dev` serves the renderer from the Vite dev server, but `preview` and the capture scripts run `electron .`, which loads `package.json`'s `main: ./out/main/index.js` — **a stale `out/` produces no error, it just shows you an old window**. Whenever a screenshot conclusion "doesn't look like what I changed", check whether a `npm run build` happened.

> **Note:** `VITE_HOME_SCENE_VARIANT` is **not** a usable runtime flag. Its only occurrence in the repo is the assignment inside the `capture:home-v2` script in `package.json`; nothing in the source reads it (`HomeV2Provider` mounts unconditionally at `renderer/src/App.tsx`, and there are no `.env*` files under `apps/desktop-client`). The guard `src/main/__tests__/docs-vite-vars-have-readers.test.ts` exists for exactly this: documentation may name a flag that does not exist, but must say so on that same line. To change the home composition, change the component — don't go looking for that variable.

## What to read once it runs

1. **Learn to look at the real window, not just the interface.** `npm run capture` (`scripts/capture-scene.mjs`) and `npm run capture:evidence` take screenshots; the second one runs `npm run build` first and the first does not — it calls `electron.launch` directly and reads whatever is currently in `out/`. Credentials come from `OWNER_EMAIL` / `OWNER_PASSWORD` in the root `.env` via `scripts/load-capture-env.mjs`, falling back to anonymous capture when absent. To drive **the window you are actually looking at**, use attach mode:

   ```bash
   ASTELLA_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/capture-pages-v3.mjs
   ```

   Without that variable the script launches a second Electron instance (`electron.launch`, reading `out/`) whose profile, workspace and reload state all differ from the window under review. `compare-mockup-geometry.mjs` in the same folder sets no default at all and throws if `ASTELLA_CAPTURE_CDP` is missing — attaching to the live window is the point. `ASTELLA_CAPTURE_NO_SANDBOX=1` is an escape hatch for restricted environments (CI containers, sandboxed agent shells); leave it off locally.
2. **Run relevant validation.** Install dependencies in referenced packages and build desktop output before `make verify` on a clean checkout. It excludes coverage and skip/todo; use `make coverage-gate` and `make skip-todo-gate` separately. See [Testing and quality](testing-and-quality.md) for guard scope.
3. **Then read the structure.** [architecture.md](architecture.md) for processes and chains, [api-and-data.md](api-and-data.md) for roles and migrations, [desktop-client.md](desktop-client.md) for IPC and the window, [testing-and-quality.md](testing-and-quality.md) for the gates. Product boundaries are in [PRODUCT.md](../../../PRODUCT.md), visual and interaction direction in [DESIGN.md](../../../DESIGN.md), collaboration rules in [AGENTS.md](../../../AGENTS.md).

## Common first-run failures

Only the three that self-resolve at the command-and-configuration layer; the rest belong to the troubleshooting chapter:

- `make up` fails during compose interpolation with `Set EDGE_TTS_AUTH_TOKEN in .env`: that line is still commented out. Fill in any local token and re-validate cheaply with `make config`.
- The window opens but login reports a connection-configuration problem: `ASTELLA_DESKTOP_PAIRING_*` / `ASTELLA_DOMAIN_SCHEMA_REVISION` are unset, or you edited `.env` without restarting the main process (`electron.vite.config.ts` calls `loadDotenv` once at startup).
- Migrations or role grants clearly did not apply, yet `make up` was green: see the `docker wait` paragraph in [The one-shot container convention](#the-one-shot-container-convention) — `docker compose -p astella-dev -f docker-compose.dev.yml logs migrate` and `GET /ready` are the evidence.

The full symptom → cause → fix list lives in [faq-and-troubleshooting.md](faq-and-troubleshooting.md); this page deliberately does not duplicate it.

## Related chapters

- [Manual index](../README.md)
- [Product overview](overview.md)
- [System architecture](architecture.md)
- [Desktop client](desktop-client.md)
- [API and data](api-and-data.md)
- [Models and the worker pipeline](ai-and-companion.md)
- [Unified agent runtime (technical)](agent-runtime.md)
- [Companion experience (product design)](companion-experience.md)
- [Testing and quality](testing-and-quality.md)
- [Operations](operations.md)
- [FAQ and troubleshooting](faq-and-troubleshooting.md)
- Repository root: [README.md](../../../README.md), [PRODUCT.md](../../../PRODUCT.md), [DESIGN.md](../../../DESIGN.md), [AGENTS.md](../../../AGENTS.md)
- Current plan index: [docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md)
