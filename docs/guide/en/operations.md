# Operations and releases

[中文](../zh/operations.md) · English

What this page covers: how Astella is actually run and shipped today — the responsibility of each of the three compose files, which environment variables are required versus optional in production, the two version lines and the desktop packaging and release chain, the Alpha environment's checks and backup/restore flow, what monitoring and alerting really deliver, and the security boundary an operator can rely on plus the gaps that remain. Every port, variable name, make target, volume name and alert name was read out of `docker-compose*.yml`, the `Makefile`, `scripts/alpha-env-setup.sh`, `infra/**`, `.github/workflows/**` and `apps/desktop-client/electron-builder.yml`; the merged project name and volume names were verified with `docker compose config`. This page lists names and purposes only — never credential values.

- [The three compose files](#the-three-compose-files)
- [Environment variable groups](#environment-variable-groups)
- [Unified version and release chain](#unified-version-and-release-chain)
- [The Alpha environment](#the-alpha-environment)
- [Observability](#observability)
- [Backup and restore](#backup-and-restore)
- [Database: volume protection and role posture](#database-volume-protection-and-role-posture)
- [Security posture for operators](#security-posture-for-operators)
- [Known operational gaps](#known-operational-gaps)
- [Related guides](#related-guides)

## The three compose files

| File | Top-level `name:` | Role | Driven by |
| --- | --- | --- | --- |
| `docker-compose.dev.yml` | `astella-dev` | Local development: `target: dev` images, source bind mounts with hot reload, hard-coded local-only credentials, `seed-demo` behind the `seed` profile, every published port loopback-only, `docker.sock` mounted for `/admin`, companion capability flags on by default | `COMPOSE := docker compose -p astella-dev -f docker-compose.dev.yml` in the `Makefile`, i.e. `make up` / `storage` / `seed-demo` / `rebuild` / `config` / `logs` / `down` / `reset-db` / `shell-*` / `desktop-client-up` |
| `docker-compose.yml` | `astella` | Production shape: `target: prod` images plus `user: node`, no source mounts, three `:?`-required database URLs, one-shot role bootstrap and migration services, capability flags fail-closed, `AUTH_RATE_LIMIT_STORE` defaults to `postgres`, edge-tts **publishes no port** | No make target is wired to it (deliberately, as the README states). Used manually or by the Alpha flow |
| `docker-compose.alpha.yml` | `astella-alpha` | An **overlay — it cannot be used alone**: adds a `restore-postgres` network alias to `postgres` and four services (`prometheus`, `alertmanager`, `alpha-ops-sidecar`, `backup-runner`) plus the `prometheus_data`, `alertmanager_data`, `backup_keys` and `backup_manifests` volumes | `scripts/alpha-env-setup.sh`, as `docker compose -f docker-compose.yml -f docker-compose.alpha.yml --profile storage` |

> **Note:** When files are layered, the last top-level `name:` wins, so the whole Alpha chain runs under project `astella-alpha` and its volumes become `astella-alpha_postgres_data`, `astella-alpha_minio_data`, `astella-alpha_prometheus_data`, and so on (verified with `docker compose -f docker-compose.yml -f docker-compose.alpha.yml --profile storage config`). Running `docker-compose.yml` alone gives the `astella_` prefix. The header of `docker-compose.dev.yml` explicitly says **not** to layer it onto `docker-compose.yml`.

The one-shot service chain in `docker-compose.yml` (`restart: "no"`, idempotent, must run on every deployment path):

| Service | Order | What it does |
| --- | --- | --- |
| `role-bootstrap` | before migrations | Runs `infra/postgres/apply-roles.sh`: creates/rotates `astella_migrator`, `astella_api`, `astella_worker`, and transfers ownership of legacy objects to the migrator |
| `migrate` | after role-bootstrap | `npm run db:migrate`, reading only `DATABASE_URL_MIGRATOR` |
| `role-grants` | after migrate | Runs `apply-roles.sh` again with `REQUIRE_RLS_DISABLED=true` to grant privileges on objects the migration just created |
| `seed-owner` | `seed` profile, explicit `run --rm` | `npm run db:seed`. Fail-closed on the production path: missing `OWNER_EMAIL` or `OWNER_PASSWORD` throws, `OWNER_PASSWORD` shorter than 12 characters throws, and `SEED_DEMO_DATA=true` under `NODE_ENV=production` refuses outright |

`api` and `worker` wait for `role-grants` to exit **successfully**. The two `stop_grace_period` values are derived from the code, not chosen for taste: `api` gets 20s (the 10s `closeServer` race in `graceful-shutdown.ts` + `end({timeout:5})` in `db/client.ts` + headroom), `worker` gets 60s (45s drain + 2s notify + 5s database + headroom). **Change either budget in code and you must change compose with it**, otherwise the orchestrator SIGKILLs before the budget elapses and lease hand-back and graceful shutdown simply do not happen.

Published ports (all default to loopback, each overridable through the bind-address variable):

| Port | Variables | Present in |
| --- | --- | --- |
| `5432` PostgreSQL | `POSTGRES_BIND_ADDRESS` / `POSTGRES_PORT` | dev only |
| `4000` API (including `/metrics`) | `API_BIND_ADDRESS` / `API_PORT` | dev, prod |
| `9100` worker metrics (`/metrics`, `/ready`) | `WORKER_METRICS_BIND_ADDRESS` / `WORKER_METRICS_PORT` | dev, prod |
| `9000` / `9001` MinIO API / console | `MINIO_BIND_ADDRESS` / `MINIO_PORT` / `MINIO_CONSOLE_PORT` | dev, prod (`storage` profile) |
| `8088` edge-tts | `EDGE_TTS_PORT` | dev only; the prod `edge-tts` service has **no `ports:`** and is reachable only on the internal network as `http://edge-tts:8080` |
| `9090` Prometheus, `9093` Alertmanager | `PROMETHEUS_*` / `ALERTMANAGER_*` | Alpha overlay only |

The container's internal listener and the host publish are kept apart deliberately: compose uses `API_BIND_ADDRESS` for the host mapping and `API_INTERNAL_BIND_ADDRESS` (default `0.0.0.0`) for what the process binds inside the container.

## Environment variable groups

`.env.example` is the production template (70 uncommented assignments plus a set of commented-out optional ones); `.env.alpha.example` is the slimmer Alpha template. **Names and purposes only, never values.**

Required means compose interpolated it as `${VAR:?…}`: a missing value aborts `docker compose up` at the interpolation step. Passing `--env-file .env.example` against the production + Alpha pair reports exactly these missing: `POSTGRES_PASSWORD`, `DATABASE_URL_MIGRATOR`, `DATABASE_URL_API`, `DATABASE_URL_WORKER`, `EDGE_TTS_AUTH_TOKEN` (and, via the anchor, `MIGRATOR_PASSWORD` / `API_PASSWORD` / `WORKER_PASSWORD`).

| Group | Variables | Production | Development |
| --- | --- | --- | --- |
| Database role passwords | `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `API_PASSWORD`, `WORKER_PASSWORD` | `:?` required | hard-coded local values in the dev file; `.env` is not consulted |
| Application connection strings | `DATABASE_URL_MIGRATOR`, `DATABASE_URL_API`, `DATABASE_URL_WORKER` | `:?` required (consumed by `migrate`, `api`, `worker` respectively) | hard-coded in the dev file, and `_API`/`_WORKER` also point at restricted roles |
| Shared voice token | `EDGE_TTS_AUTH_TOKEN` | `:?` required, and must match the edge-tts container | `:?` required — **the one variable dev actually needs** |
| Object storage | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET`, `S3_REGION`, `STORAGE_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `STORAGE_REQUEST_TIMEOUT_MS` | optional; `minio` sits under the `storage` profile and the service exits on its own if either root credential is empty rather than falling back to MinIO defaults | hard-coded local values |
| First account | `OWNER_EMAIL`, `OWNER_PASSWORD` (≥12 characters), `OWNER_WORKSPACE` | read only by an explicit `seed-owner` run | use `make seed-demo`; these three are not read |
| Network and origins | `CORS_ORIGIN`, `TRUST_PROXY`, `API_PORT`, `API_BIND_ADDRESS`, `POSTGRES_BIND_ADDRESS` | optional, defaults in compose | same |
| Session and secrets | `AUTH_COOKIE_SECURE`, `AUTH_SURFACE_MANIFEST_SECRET`, `AUTH_RATE_LIMIT_STORE`, `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX_ATTEMPTS`, `LEARNING_DRAFT_ENC_KEY`, `PROJECTION_CHECKPOINT_SECRET` | optional, but each has a fail-closed consequence (table below) | same |
| Desktop pairing and contracts | `ASTELLA_DESKTOP_PAIRING_KEY_ID`, `ASTELLA_DESKTOP_PAIRING_SECRET`, `ASTELLA_DOMAIN_SCHEMA_REVISION`, `DESKTOP_API_ORIGIN`, `DESKTOP_DEPLOYMENT_CONFIG_REVISION` | optional | dev falls back to a fixed dev key id and revision |
| Operations panel | `ADMIN_PANEL_TOKEN`, `ADMIN_PANEL_PATH`, `ADMIN_LOG_BUFFER_SIZE`, `ADMIN_DOCKER_SOCKET` | optional: empty means `/admin` is never registered | dev ships a default token and mounts the socket |
| Model credentials | `DASHSCOPE_API_KEY`, `OPENAI_COMPAT_API_KEY`, `SILICONFLOW_API_KEY`, `BIGMODEL_API_KEY`, `TOKENRHYTHM_API_KEY`, `OPENCODE_GO_API_KEY`, `ASSESSMENT_CRITIC_URL` / `_KEY` / `_MODEL`, `AI_PLATFORMS_CONFIG` | optional; unset providers follow the fail-closed branch | same |
| Runtime tuning | `LOG_LEVEL`, `WORKER_DRAIN_TIMEOUT_MS`, `WORKER_MODEL_TIMEOUT_MS`, `WORKER_PROVIDER_TIMEOUT_MS`, `WORKER_TIMEOUT_PARSE_SOURCE_MS`, `V3_ALLOW_DETERMINISTIC_PROVIDERS`, `AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS`, `AI_REQUIRE_CONFIGURED_PROVIDER`, `EDGE_TTS_BASE_URL`, `EDGE_TTS_PORT`, `EDGE_TTS_MAX_CONCURRENCY`, `QWEN_TTS_MAX_CONCURRENCY`, `TOPOLOGY_SNAPSHOT_CACHE_MS`, `V2_EVIDENCE_*` / `V2_LEASE_RENEWAL_INTERVAL_MS` / `V2_PIPELINE_BUDGET_MS` / `V2_SOURCE_CONTENT_MAX_CHARS`, `V2_E2E_DEBUG_ERRORS` | optional; most only affect the worker | `V2_E2E_DEBUG_ERRORS` defaults to 1 in dev |
| Alpha overlay | `PROMETHEUS_BIND_ADDRESS` / `PROMETHEUS_PORT`, `ALERTMANAGER_BIND_ADDRESS` / `ALERTMANAGER_PORT`, `BACKUP_BUCKET`, `SOURCE_RELEASE`, `SOURCE_MIGRATION` | appear only in the overlay | — |

> **Watch the URL encoding:** role passwords and connection strings are two separate sets of variables. `apply-roles.sh` receives the **raw** password, while the three `DATABASE_URL_*` embed the **encoded** same value. If a password contains `@`, `:`, `/`, `#` or another reserved character it must be percent-encoded before being embedded, otherwise the username, host and database parsed out of the URL are all wrong. `.env` is git-ignored; never commit a real password or key.

Fail-closed shapes worth memorising:

| Variable | Behaviour when unset |
| --- | --- |
| `AUTH_COOKIE_SECURE` | Compose defaults to `true` in production; the code default is "Secure when `NODE_ENV=production`". Testing the production stack over plain HTTP requires setting `false` explicitly in `.env`; a real HTTPS deployment must keep `true`. The cookie also carries `SameSite=Lax`. |
| `TRUST_PROXY` | `false` in both dev and prod. Set it true only when an external proxy **overwrites** `X-Forwarded-For`, otherwise the IP dimension of login rate limiting can be spoofed. |
| `AUTH_SURFACE_MANIFEST_SECRET` | Companion grant issuance returns 503 (`turn-service.ts`). |
| `AUTH_RATE_LIMIT_STORE` | Production defaults to `postgres` (correct across replicas), dev defaults to `memory`; any other value throws. |
| `ADMIN_PANEL_TOKEN` | See [Security posture for operators](#security-posture-for-operators). |
| `LEARNING_DRAFT_ENC_KEY` | Draft reads/writes return 409 `draft_encryption_unavailable`. |
| `PROJECTION_CHECKPOINT_SECRET` | No checkpoint is issued, so envelopes stay pending and the star-map projection never advances. |
| `AI_REQUIRE_CONFIGURED_PROVIDER` | Production compose defaults to `true`: an unconfigured provider throws the non-retryable `ai_provider_not_configured` instead of falling back to mock output. Dev and the desktop client leave it unset and keep the fallback. |
| `CARD_GENERATION_V3_PROVIDER` | Both compose files set `deterministic`. With `NODE_ENV=production` and no explicit `V3_ALLOW_DETERMINISTIC_PROVIDERS=1`, `resolveCardGenerationV3Providers()` throws a non-retryable error — i.e. until this chain is wired to a real model, **a production deployment cannot produce cards**. |

Capability flags are checked by `.github/scripts/verify-companion-capability-config.mjs` with a **bidirectional** assertion (it runs inside `make verify`): each service must declare exactly the flags it actually reads — one extra is dead configuration, one missing means operators cannot enable a capability without editing compose — and each expression must equal `${NAME:-<expected default>}`. The table shows the current defaults in the two files.

| Flag | prod | dev | Read by |
| --- | --- | --- | --- |
| `LEARNING_RUN_ENABLED` | `false` | `true` | api |
| `CARD_GENERATION_V2_ENABLED` | `false` | `true` | api |
| `COMPANION_DIALOGUE_V1_ENABLED` | `true` | `true` | api + worker |
| `COMPANION_VOICE_DIALOGUE_V1_ENABLED` | `false` | `true` | api + worker |
| `COMPANION_STREAMING_VOICE_V1_ENABLED` | `false` | `false` | api |
| `COMPANION_JOURNEY_V2` | `true` | `true` | api |
| `COMPANION_BRIDGE_V2` | `true` | `true` | api |
| `COMPANION_MEMORY_VECTOR_V1` | `true` | `true` | api + worker |
| `COMPANION_MEMORY_STAR_MAP_V1` | `true` | `true` | api |
| `COMPANION_PET_PROFILE_V1` | `true` | `true` | api |
| `COMPANION_PROACTIVE_PERSONALIZED_V1` | `true` | `true` | api |
| `COMPANION_SUMMARIZER_V1` | `true` | `true` | api + worker |
| `COMPANION_DAILY_SUMMARY_V1` | `true` | `true` | api + worker |
| `COMPANION_MEMORY_EXTRACTOR_V1` | `true` | `true` | worker only |
| `COMPANION_THOUGHTS_V1` | `true` | `true` | worker only |
| `CARD_GENERATION_V3_PROVIDER` | `deterministic` | `deterministic` | worker only |

## Unified version and release chain

The server and desktop share `release/version.json` (currently `1.0.0`) and the same `v<version>` tag. After editing that file, run `node .github/scripts/version-contract.mjs --write` to synchronize API, Worker, Shared and Desktop package metadata and lockfiles; `--check` verifies consistency. Desktop packaging uses `desktop-version.mjs` to invoke that same contract. Pushing `v1.0.0` triggers server CI and deployment alongside desktop quality checks and installer publishing. A version mismatch stops the release.

Make targets: `make version-check` checks both server and desktop versions; `make release-manifest` produces the machine-readable manifest from `release-manifest-generate.mjs`; `make release-check` runs `verify-release-inputs.mjs` → `make verify` → `coverage-gate.mjs` → `release-manifest-generate.mjs` → `release-manifest-contract.mjs`. On an exact release tag the last step fails closed unless `RELEASE_MANIFEST_PATH` points at a complete CI/release JSON artifact.

The electron-builder configuration is `apps/desktop-client/electron-builder.yml`, with these targets:

| Platform | Target | Architecture | Commands |
| --- | --- | --- | --- |
| macOS | `dmg` + `zip` | decided on the command line (the yml **deliberately omits `arch`** so it cannot fight with the scripts) | `npm run package:mac:arm64` / `package:mac:x64`, i.e. `make desktop-client-dist-arm64` (Apple Silicon) and `desktop-client-dist-mac` |
| Windows | `nsis` | `x64` (hard-coded in the yml) | `npm run package:win:x64`, `make desktop-client-dist-win` |
| Linux | `AppImage` | `--x64` passed on the CLI | `npm run package:linux:x64`, `make desktop-client-dist-linux` |

Several choices here are intentional:

- **`nsis.oneClick: true`** (changed from `false` on 2026-10-04). A wizard-style installer has a `PageEx custom` directory-picking page; in `/S` silent mode NSIS skips drawing it while MultiUser still needs an explicit decision, so the installer waits forever — on CI that shows up as the install step timing out, indistinguishable from "the installer is broken". The price is that users can no longer choose the directory; it now installs to `%LOCALAPPDATA%\Programs\Astella` (since 2026-10-06 the package name is the ASCII `Astella`; the Chinese display name 拾星笔记 is only used for the Start Menu entry and "Apps & features"). `requestedExecutionLevel: asInvoker` is also explicit, so no elevation.
- **`artifactName: astella-${version}-${os}-${arch}.${ext}` hardcodes the prefix.** `productName` is now the ASCII `Astella` too, but the artifact name deliberately does not read `${productName}`: release asset names land in `latest.yml` / `latest-mac.yml` and get parsed by the client, so however the display name changes later, the file names already published in update metadata must not drift. GitHub asset URLs, NSIS differential downloads and Squirrel.Mac also all have edge cases with non-ASCII file names. `desktop-release.yml` checks precisely those four names: `astella-<version>-win-x64.exe`, its `.blockmap`, `-mac-<arch>.zip` and `.dmg`.
- **The update source is GitHub Releases, not this project's API.** `publish: provider github / owner asklins223 / repo Astella`; `apps/desktop-client/src/main/desktop-update.ts` repeats the same owner/repo constants so the "open the download page" link can be computed without loading the packaging config — **change the repository address and you must change both places**. Checks go to `api.github.com` and downloads to GitHub's CDN, so `apps/api` is not on the update path at all: update bandwidth does not land on your own server, and an outage of the API cannot block updates.
- **No code signing is configured.** The repository holds no Windows certificate and no Apple certificate / notarization credentials, so artifacts are unsigned: macOS requires right-click → Open on first launch, Windows shows SmartScreen, and **the macOS auto-update install is refused by Squirrel.Mac** (it verifies that both `.app` versions are signed by the same developer, so an unsigned build downloads and then fails to install). The yml deliberately does not set `identity: null` / `notarize: false` — those would actively disable signing and notarization — and adds `hardenedRuntime: true`, a hard prerequisite for notarization. Once the secrets exist, signing and notarization happen automatically with no config change. `desktop-package.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY=false` only to skip searching the keychain.

The release pipeline `.github/workflows/desktop-release.yml` publishes a Release only on `push` of a `v*` tag. The `resolve` job first compares the tag version with `release/version.json` and stops on mismatch (otherwise you get a Release titled one thing containing another). `build` reuses `desktop-package.yml` via `workflow_call` to build both platforms in parallel. Then `release` (gated by `if: from_tag == 'true'`): download the `desktop-*` artifacts → assert both platforms produced the same version and that all four files are non-empty → **require `latest.yml`** (hard failure if missing: Windows would never learn about a new version) and **require `latest-mac.yml`** (hard failure if missing) → create the Release with `softprops/action-gh-release@v2` and `draft: true`, uploading every asset → flip it public with `gh api --method PATCH … -F draft=false`. Draft-then-publish exists for the updater's sake: publishing while uploading can let it read a half-written `latest.yml` or a half-uploaded installer. A manual `workflow_dispatch` run never publishes.

## The Alpha environment

Alpha is a single-host compose environment that adds monitoring and backup infrastructure. The make targets wrap `./scripts/alpha-env-setup.sh`:

| Make target | Calls | What it does |
| --- | --- | --- |
| `make alpha-up` | `alpha-env-setup.sh up` | Start `postgres minio alpha-ops-sidecar` → wait for `pg_isready` → run the one-shots `minio-init`, `role-bootstrap`, `migrate`, `role-grants` in order (each is removed, re-created and `docker wait`-ed every time) → start `api worker prometheus alertmanager` → `wait_http` on the API `/ready`, worker `/metrics`, Prometheus `/-/healthy`, Alertmanager `/-/healthy` → print status |
| `make alpha-backup` | `… backup` | Runs `infra/backup/backup.sh` inside the `backup-runner` container |
| `make alpha-restore-verify` | `… restore-verify` | First `DROP DATABASE IF EXISTS astella_restore_verify WITH (FORCE)` + `CREATE DATABASE` on `postgres`, then runs `infra/backup/rc-restore-verify.sh` |
| `make alpha-status` | `… status` | `docker compose ps`, the endpoint list, and `curl :9090/api/v1/alerts` plus `/api/v1/targets` (needs `jq`) |
| `make alpha-metrics` | `… metrics` | The first 20 `^astella_` lines from `curl :4000/metrics`, plus one PromQL query for `astella_job_queue_depth` |
| `make alpha-down` | `… down` | `docker compose down --remove-orphans` |

The script accepts 8 subcommands, and **`init` and `freshness` have no make targets** (nor does any other step outside the wrapped six), so those must be called directly:

```bash
./scripts/alpha-env-setup.sh init        # generate the age keypair + create the backup bucket
./scripts/alpha-env-setup.sh freshness   # check how recent the last verified backup is (24h threshold)
```

Before the first run, `.env` must provide these 8 values (`check_env` names each one that is missing): `MINIO_ROOT_PASSWORD`, `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `API_PASSWORD`, `WORKER_PASSWORD`, `DATABASE_URL_MIGRATOR`, `DATABASE_URL_API`, `DATABASE_URL_WORKER`. `down` and `status` take a different path: `prepare_compose_control_env` fills inert placeholders so an operator can still inspect or stop a broken stack when the secret file is unavailable; the commands that actually connect or mutate (`up`, `backup`, `restore-verify`, `init`, `freshness`) still go through `check_env` and hard-fail.

Where the backup infrastructure keeps its state (names only):

| Thing | Location |
| --- | --- |
| age public key (encrypt backups) and private key (decrypt restores) | Named volume `astella-alpha_backup_keys`, mounted at `backup-runner:/etc/astella` |
| Manifests and RC reports | Named volume `astella-alpha_backup_manifests`, mounted at `backup-runner:/var/lib/astella/manifests`; `alpha-ops-sidecar` mounts the same volume read-only |
| The backup objects themselves | The S3-compatible bucket `BACKUP_BUCKET` (default `astella-backups`) on MinIO, whose data lives in `astella-alpha_minio_data` |

The migration number is read **dynamically**: both `backup` and `restore-verify` take the `tag` of the last `entries[]` element in `apps/api/src/db/migrations/meta/_journal.json` with a one-line `node -e` (currently 388 entries, last one `0391_summary_verified_revision_backfill`). This used to be hard-coded to `0039` and went stale.

**`SOURCE_MIGRATION` in `.env.alpha.example` is not "the current migration number".** It is the `--migration` argument passed to `rc-restore-verify.sh`, meaning "which migration the backup under verification came from", and the `0039` in the template is only an example value — changing it to track the latest migration would be wrong. Override it explicitly in `.env` if you need to; the script uses `${SOURCE_MIGRATION:-<journal tail>}`. `SOURCE_RELEASE` works the same way (default `0.5.0-alpha`), while `SOURCE_COMMIT` is taken from git by the script.

## Observability

Per `infra/prometheus/prometheus.yml`: `scrape_interval` and `evaluation_interval` are both 15s, external labels are `monitor: astella-alpha` / `environment: alpha`, rules load from `alerts.yml`, and the Alertmanager static target is `alertmanager:9093`. Prometheus starts with `--storage.tsdb.retention.time=30d` and `--web.enable-lifecycle`.

| Job | Scrape target | Path | Port |
| --- | --- | --- | --- |
| `prometheus` | `localhost:9090` | default | 9090 |
| `astella-api` | `api:4000` | `/metrics` | 4000 |
| `astella-worker` | `worker:9100` | `/metrics` | 9100 (relabel pins `instance` to `worker`) |
| `astella-backup` | `alpha-ops-sidecar:8080` | `/metrics` | 8080, reachable only inside the overlay network — no host port |
| `alertmanager` | `alertmanager:9093` | default | 9093 |
| `postgres` (commented out) | `postgres-exporter:9187` | — | not enabled |

The rule file `infra/prometheus/alerts.yml` holds **7 groups and 21 alerts** (13 warning, 7 critical, 1 info). The script that was supposed to add a second layer — `.github/scripts/verify-alerts-syntax.mjs`, which parses the YAML, validates each group and rule shape, flags duplicate alert names and checks whether 15 required metrics are referenced in `alerts.yml` — **is not wired into any chain**, so only Prometheus' own load-time validation applies today. Verify the file yourself after editing it.

| Group | Alerts |
| --- | --- |
| `astella_http_health` | `AstellaAPIDown`, `AstellaWorkerDown`, `AstellaHighHTTP5xxRate`, `AstellaHighHTTPLatency` |
| `astella_job_health` | `AstellaJobQueueBacklog`, `AstellaStalePendingJob`, `AstellaHighJobDeadRate`, `AstellaJobLeaseLost` |
| `astella_provider_health` | `AstellaHighProviderErrorRate`, `AstellaProviderHighLatency`, `AstellaProviderSchemaFailure`, `AstellaProviderQuotaExceeded` |
| `astella_database_health` | `AstellaHighTransactionFailureRate`, `AstellaHighRLSDenialRate`, `AstellaBackupStale` |
| `astella_funnel_monitoring` | `AstellaLowInviteConsumptionRate`, `AstellaLowCardGenerationSuccessRate` |
| `astella_release_info` | `AstellaReleaseDeployed`, `AstellaReleaseRolledBack` |
| `astella_search_consistency` | `AstellaSearchIndexDrift`, `AstellaHighSearchDriftRatio` |

There is exactly one notification path: `infra/prometheus/alertmanager.yml` defines a single receiver, `log-receiver`, whose `webhook_configs.url` is `http://alpha-ops-sidecar:8080/alerts`, and the sidecar's only action is `print("[alpha-ops] alertmanager webhook " + <json>)` to its own stdout. **In other words, no paging, Slack or PagerDuty is configured; seeing an alert means reading container logs or the Prometheus UI.** Routing parameters: `group_by: [alertname, service]`, `group_wait` 30s (10s for critical), `group_interval` 5m, `repeat_interval` 4h (1h for critical), `resolve_timeout` 5m, plus one inhibit rule that suppresses a warning when the critical of the same alert is firing. The `slack_configs` block in that file is a commented-out example.

Metric families worth graphing (by declaration site): `apps/api/src/lib/metrics.ts` declares 28 families, `workers/ai-worker/src/lib/metrics.ts` declares 15, the sidecar 3. The useful groups:

| Question | Metrics |
| --- | --- |
| Is the API alive, and what is the traffic | `astella_readiness_status`, `astella_http_requests_total`, `astella_http_errors_5xx_total`, `astella_http_request_duration_seconds`, `astella_sse_active_streams` |
| Is the queue stuck | `astella_job_queue_depth{status="pending"}`, `astella_job_oldest_pending_age_seconds`, `astella_job_terminal_total`, `astella_job_lease_lost_total`, `astella_job_non_retryable_dead_total` |
| Model calls and quota | `astella_provider_calls_total`, `astella_provider_call_duration_seconds`, `astella_provider_call_tokens_total`, `astella_ai_circuit_open_total`, `astella_ai_circuit_observer_healthy` |
| Tenant isolation and database health | `astella_db_rls_denied_total`, `astella_db_transaction_failures_total`, `astella_db_pool_active_connections`, `astella_db_migration_version` |
| Is the learning loop advancing | `astella_learning_run_processing_outbox_depth`, `astella_learning_run_processing_outbox_oldest_pending_age_seconds`, `astella_learning_run_critic_fail_closed_total`, `astella_funnel_events_total` |
| Is a backup actually usable | `astella_backup_verified_manifests_total`, `astella_backup_manifest_scan_errors`, `astella_db_last_successful_backup_timestamp` (the last one is **absent** until a deep RC verification succeeds) |

Logging: pino reads its level from `LOG_LEVEL`, default `info` (`trace`/`debug`/`info`/`warn`/`error`/`fatal`), and attaches `pino-pretty` outside production when not in a test context. The real sink is still stdout, collected by the container runtime. **A separate bounded in-process ring feeds the `/admin` log page**: `apps/api/src/lib/log-buffer.ts` hooks pino's `hooks.logMethod` and captures **before** serialisation, so `scope` / `runId` / `workspaceId` survive. It is two independent rings — application logs default to 500 entries (`ADMIN_LOG_BUFFER_SIZE`, capped at 5000) and request/access logs are fixed at 300. This buffer is **not an audit log**: it is cleared on restart, never written to disk, not searchable, not exported. Cross-restart tracing still goes through stdout and the audit tables.

## Backup and restore

The scripts live in `infra/backup/` and run inside the `backup-runner` container (`infra/backup/Dockerfile.backup`, alpine-based).

| Script | Responsibility |
| --- | --- |
| `setup-backup-infrastructure.sh` | Generate the age keypair, create the separate backup bucket, verify access and encryption; prints where the public and private keys landed |
| `backup.sh` | `pg_dump` (custom format, consistent snapshot) → SHA-256 → age envelope encryption with the public key → S3 upload → write a manifest JSON recording release / commit / migration / checksums. There are local-directory fallback branches when `age` or S3 is missing, and **artifacts from those branches must not be presented as release evidence** |
| `rotate.sh` | Keep the 14 most recent daily and 4 weekly backups; **only deletes backups with `verificationStatus=verified`**, everything unverified is retained |
| `restore.sh` | Download → decrypt with the age private key → restore into the target database. The target must pass the safety allowlist; pointing at a production host or database name is refused |
| `rc-restore-verify.sh` | End-to-end proof: create a backup → restore into the isolated database (in the Alpha flow the target host is the network alias `restore-postgres`) → compare the migration tail and core-table row counts → re-check the role posture with `infra/postgres/roles.sql` → write the RC report |
| `freshness-check.sh` | Scan the manifest directory for the most recent `verificationStatus=verified` backup and exit non-zero past the threshold (default 24 hours), which is what fires `AstellaBackupStale` |
| `alpha-backup-cron.sh` + `alpha-cron-setup.sh` | The 12-hour schedule: `backup.sh` → `rotate.sh` → `freshness-check.sh`, logging to `/var/log/astella/backup-cron.log`. **Neither script is wired to a make target or compose**; the crontab has to be installed on the host explicitly |
| `backup-scripts.test.sh` | Tests for this shell group itself (manifest shape, rotation policy, restore allowlist refusal, `manifest.schema.json` validation). It used to be manual-only (`bash infra/backup/backup-scripts.test.sh`) with no automated chain calling it; since 2026-10-07 it runs in `make verify` **and** in the `main-ci.yml` `Backup scripts` job, and `ci-workflow-contract` fails if either side drops it |

Two operations must not be conflated: `make alpha-backup` only produces an encrypted backup plus a manifest; `make alpha-restore-verify` is the evidence that the backup can actually be restored, and `AstellaBackupStale` reads the timestamp of the most recent **deep-verified** backup. Backing up without ever verifying leaves the metric absent, so that alert **can never fire** — it will not tell you "everything is fine".

## Database: volume protection and role posture

The development data volume is kept outside the Compose lifecycle on purpose: `docker-compose.dev.yml` declares `dev_postgres_data` as `external: true` with the fixed name `astella-dev_dev_postgres_data`, and `make up` depends on `ensure-db-volume`, which creates it with the labels `com.astella.protected=true` and `com.astella.purpose=postgres-data` when absent. Consequently `make down`, deleting containers and even `docker compose down -v` **cannot remove it**. Wiping it has exactly one confirmed path:

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB   # any other value prints a cancellation and exits 2, changing nothing
```

Take a backup first. For integration tests that need isolation, use a disposable database (`make disposable-db` / `bash scripts/dev-disposable-db.sh`); that script only drops and creates names matching `astella_*` and never `astella` itself. Production and Alpha use **ordinary named volumes** (`astella_postgres_data` / `astella-alpha_postgres_data`) with no external protection, and no Makefile target manages them.

Role and isolation posture (full treatment in [API and data](./api-and-data.md)): the three application roles are created by `infra/postgres/apply-roles.sh` with `roles.sql`, all `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`. `astella_migrator` has `BYPASSRLS` and owns tables, sequences, views and types (migrations need DDL); `astella_api` and `astella_worker` are `NOBYPASSRLS` with no DDL privileges. Business requests set `app.workspace_id` / `app.user_id` transaction-locally and FORCE RLS narrows visibility; boundary actions that do not yet know the workspace (login, token resolution, workspace listing, redeeming an invite) go through the actor transaction. The current holes in this contract are registered as a ratchet by `schema-isolation-gate-postgres.integration.ts`: **89** tables have a `workspace_id` column but no foreign key to `workspaces` (that list may only shrink), and the "RLS not enabled" baseline **is empty and must stay empty** since migration 0257. Dev, CI and production now all use the restricted-role shape — a superuser bypasses RLS and turns isolation assertions into false passes.

## Security posture for operators

What you can defend on the basis of the current code:

- **Non-root containers (production)**: `api`, `worker`, `migrate` and `seed-owner` set `user: node`, and the `prod` image stages end with `chown -R node:node /app` plus `USER node`; `edge-tts` uses `user: nobody`; every service in `docker-compose.yml` and in the overlay carries `security_opt: [no-new-privileges:true]`.
- **Ports default to loopback only**: every host mapping in the table above defaults its bind address to `127.0.0.1`, and dev's edge-tts even hard-codes it. Publishing outward requires changing `*_BIND_ADDRESS` explicitly.
- **`/metrics` is unauthenticated**: `app.get("/metrics")` in `apps/api/src/server.ts` has no preHandler, and the code comment says plainly that it needs no authentication but should be restricted by network policy in production (only the Prometheus scraper should reach it). The boundary is the **network layer**, not the application layer — that responsibility sits with the deployment's firewall or security group and the repository does not do it for you. The same applies to worker's 9100 and the sidecar's 8080 (which publishes no host port).
- **`/admin` does not exist unless configured**: `MIN_ADMIN_TOKEN_LENGTH = 16` in `apps/api/src/modules/admin/auth.ts`. A token shorter than 16 characters, or containing any of `change-me`, `changeme`, `placeholder`, `example`, `your-token`, `your_token`, `todo`, counts as **not configured**, and in that state `adminRoutes()` **registers no routes at all** (rather than registering and rejecting), so the panel is absent from port scans and from the Fastify route table. The token is supplied via the `x-admin-token` header or `Authorization: Bearer`, compared in constant time. The mount prefix comes from `ADMIN_PANEL_PATH`, defaulting to `/admin`, with an invalid shape falling back and logging a warning — the prefix is obfuscation, **not** authentication. The dev compose ships a long-enough fixed default and mounts `docker.sock`, so locally the panel works and can show container state and start/stop/restart them.
- **HTTP baseline**: `onSend` globally adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`; session cookies are HttpOnly with `SameSite=Lax`, and `Secure` follows `AUTH_COOKIE_SECURE`.
- **Desktop client**: the main process applies a three-way CSP split (main document / artifact origin / everything else `rejectAll`), deleting any upstream header of the same name first; windows run with `contextIsolation: true` and `sandbox: true`; the renderer policy uses `connect-src 'self' blob:` (dev only appends the dev-server origin and its WebSocket). The package additionally excludes `out/renderer/assets/3d**` and `out/renderer/models**`, so speech-recognition models are not shipped — users download them in Settings.

What is **not** done yet, as the repository stands:

- `docker-compose.deploy.yml` now provides Nginx TLS termination and IP certificate renewal. The base production Compose file still needs a TLS proxy; see the [deployment guide](../zh/deployment.md).
- No secret manager: PostgreSQL and MinIO credentials are injected as environment variables and are visible via `docker inspect` (the SEC-18 note at the end of `docker-compose.yml` says so explicitly, and warns that adding a `secrets:` block without changing the application code does nothing).
- No code signing or notarization (see above), which is why macOS auto-update is unusable today.
- No email-based self-service password reset: `apps/api/src/modules/identity/routes.ts` only offers `POST /auth/change-password` (verifies the current password and revokes all sessions) and `POST /auth/recovered-users/:userId/reset-password` (requires `requireSession` + `requireOwner`, for initialising a recovered user's password). Forgetting a password means asking a workspace Owner.
- No autoscaling story: all three compose files are single-host orchestration (`restart: unless-stopped`). `AUTH_RATE_LIMIT_STORE=postgres` only keeps rate limiting honest across replicas; it is not a scaling path.

## Known operational gaps

Each of these was confirmed during the checks above rather than inferred:

1. **Five alerts in `infra/prometheus/alerts.yml` can never fire.** `AstellaHighProviderErrorRate`, `AstellaProviderSchemaFailure` and `AstellaProviderQuotaExceeded` depend on `astella_provider_errors_total`; `AstellaSearchIndexDrift` and `AstellaHighSearchDriftRatio` depend on `astella_search_drift_total` / `astella_search_documents_total`. None of these families has a **producer** anywhere in `apps/api`, `workers/ai-worker` or `packages` (a repository-wide grep finds them only in `alerts.yml`, a comment in `prometheus.yml` and an archived audit document). Nothing validates the rule file beyond Prometheus itself loading it.
2. **There is no alert sink.** `log-receiver` only POSTs to the sidecar, which prints to stdout. With no Slack / PagerDuty / email receiver configured, "an alert fired" requires someone to actively read logs or open the Prometheus UI.
3. **`verify-alerts-syntax.mjs` is unwired**: it would validate rule shapes and duplicate alert names and report which of 15 required metrics are not referenced, but it appears in no `verify`, `release-check`, workflow or package script. Similarly unwired are `verify-shared-exports.mjs` (which exists specifically for the "file present but not listed in `exports`, so typecheck is green and the runtime throws `ERR_PACKAGE_PATH_NOT_EXPORTED`" case), `coverage-baseline-save.mjs`, `capture-image-digests.mjs` and `.github/ci/ai-platforms.mock.json`. None is called by any make target, workflow or package script.
4. **The image digest chain is broken.** `release-manifest-generate.mjs` supports `--images` to read the output of `capture-image-digests.mjs`, but neither `make release-manifest` nor `make release-check` passes it, so RC manifest image fields take the placeholder branch. The tag deployment workflow now builds GHCR images and deploys by digest. The older RC manifest tools still do not consume those digests; image scanning remains unwired.
5. **Migration lifecycle has no automated verification.** Fresh-database, repeated and upgrade-from-old-version migrations used to be CI jobs; today they are only touched incidentally by the one-shot `migrate` container in `make up` / `make alpha-up`, while `test:db-integrity:postgres` (which includes `db-migrations.integration.ts`) must be run explicitly against a disposable database.
6. **Backup scheduling must be installed by hand.** `alpha-cron-setup.sh` and `alpha-backup-cron.sh` are not in any make or compose path, and `rotate.sh` has no target either: `make alpha-backup` is a single action with no retention rotation. The `init` and `freshness` steps of a first Alpha setup must be called directly on the script.
7. **Environment templates require real values.** `EDGE_TTS_AUTH_TOKEN` is now explicitly listed in `.env.example`; database credentials, role URLs and storage passwords also require values before starting production.
8. **The header of `scripts/alpha-env-setup.sh` claims Alpha includes "PostgreSQL + API + Worker + Web + MinIO"**: the production compose has no `web` service and no web container at all (`apps/web` was removed wholesale). Debugging against that header sends you looking for something that is not there.
9. **Dev containers are not non-root.** `docker-compose.dev.yml` sets no `user:` or `security_opt` for `api`, `worker`, `postgres`, `minio`, `migrate` or `seed-demo`, and the `api` container additionally mounts `/var/run/docker.sock` (equivalent to host root). That is the trade for hot reload and the panel's infrastructure view — **do not use the dev file as a production template**. `no-new-privileges` holds only on `edge-tts` and on the overlay's four services.
10. **Mounting `docker.sock` and the panel's container-control capability have no separate audit view.** The ability to start/stop/restart containers is guarded by `ADMIN_PANEL_TOKEN` alone.

## Related guides

- [Handbook overview](./overview.md)
- [Architecture](./architecture.md)
- [Development](./development.md)
- [Desktop client](./desktop-client.md)
- [API and data](./api-and-data.md)
- [Models and the worker pipeline](./ai-and-companion.md)
- [Unified agent runtime (technical)](./agent-runtime.md)
- [Companion experience (product design)](./companion-experience.md)
- [Testing and quality](./testing-and-quality.md)
- [FAQ and troubleshooting](./faq-and-troubleshooting.md)
- Repository root: [README](../../../README.md), [AGENTS.md](../../../AGENTS.md), [third-party notices](../../../THIRD_PARTY_NOTICES.md)
- Plan index: [docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md)
