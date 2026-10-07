# FAQ and Troubleshooting

[中文](../zh/faq-and-troubleshooting.md) · English

What this covers: the failures you actually hit when running Astella locally, written as symptom → cause → fix. Every answer here was checked against the compose files, the Makefile and the source in this repo, so it names the step that matters rather than general advice.

- [Login and accounts](#login-and-accounts)
- [Ports and local services](#ports-and-local-services)
- [Database and readiness](#database-and-readiness)
- [Companion voice](#companion-voice)
- [Model calls](#model-calls)
- [The companion does not reply](#the-companion-does-not-reply)
- [Desktop client and type checking](#desktop-client-and-type-checking)
- [Where the data lives](#where-the-data-lives)
- [Tests that will not run](#tests-that-will-not-run)
- [Known limitations still open](#known-limitations-still-open)

## Login and accounts

### Cannot log in → the demo account was never created → `make seed-demo`

**Symptom:** `owner@astella.local` / `<set-a-private-owner-password>` is rejected in the desktop app, or the API answers 401 `invalid credentials`.

**Cause:** The dev stack creates no accounts on startup. The `seed-demo` service sits behind the `seed` profile and only runs when invoked: `make seed-demo` maps to `docker compose -p astella-dev -f docker-compose.dev.yml --profile seed run --rm seed-demo`, and that container sets `SEED_DEMO_DATA=true`, which is what lets `apps/api/src/db/seed.ts` fall back to the built-in demo credentials.

**Fix:** Run `make seed-demo` after the stack is up. If the account already exists the script just prints `Owner already exists` and exits, so it is safe to repeat. These credentials are **development only**; production never seeds a demo account.

The production stack uses a different one-shot service, `seed-owner` in `docker-compose.yml`:

```bash
docker compose -f docker-compose.yml --profile seed run --rm seed-owner
```

It does not set `SEED_DEMO_DATA` and runs with `NODE_ENV=production`, where `seed.ts` fails closed: a missing `OWNER_EMAIL` or `OWNER_PASSWORD` throws ("Production seeding never uses a default owner account"), an `OWNER_PASSWORD` shorter than 12 characters throws, and combining `SEED_DEMO_DATA=true` with production is refused outright.

### Login returns 429 → the rate limiter is counting → wait out the window; a successful login will not clear it

**Symptom:** The password is right, but you get 429 `rate_limited` with a `Retry-After` header.

**Cause:** `POST /auth/login` keeps two independent counters: `auth:login:ip:<ip>` and `auth:login:email:<email>`. Defaults are a 15-minute window and 5 attempts, set by `AUTH_RATE_LIMIT_WINDOW_MS` (milliseconds) and `AUTH_RATE_LIMIT_MAX_ATTEMPTS`. The dev stack widens attempts to 100 by default because several E2E specs log in back to back; the production compose keeps 5. `AUTH_RATE_LIMIT_STORE` decides where counts live: unset means `postgres` (correct across replicas), and the in-process store is used only when you explicitly write `memory`. The dev compose defaults to `memory`, production to `postgres`. Any other value throws `AUTH_RATE_LIMIT_STORE must be memory or postgres`.

**Fix:** Honour `Retry-After`; raise `AUTH_RATE_LIMIT_MAX_ATTEMPTS` if you need permanent headroom locally. Note that **a successful login resets only the email counter, never the IP counter** (tightened 2026-08-11: otherwise one valid credential would clear the attacker's own IP failure count and enable cross-account spraying). So after enough failed attempts, the same IP can stay blocked for the rest of the window even once you authenticate correctly.

## Ports and local services

### Startup fails on a bound port → the dev stack publishes several fixed host ports → change the matching `*_PORT`

**Symptom:** `make up` dies with `port is already allocated` or `address already in use`.

**Cause:** These are published to the host, loopback-only by default:

| Service | Host default | Override | Notes |
| --- | --- | --- | --- |
| API | `127.0.0.1:4000` | `API_PORT`, plus `API_BIND_ADDRESS` | The in-container listener is `API_INTERNAL_BIND_ADDRESS`, default `0.0.0.0` |
| PostgreSQL | `127.0.0.1:5432` | `POSTGRES_PORT`, `POSTGRES_BIND_ADDRESS` | Collides most often with a locally installed Postgres |
| MinIO | `127.0.0.1:9000` / `:9001` | `MINIO_PORT`, `MINIO_CONSOLE_PORT` | Behind the `storage` profile |
| edge-tts | `127.0.0.1:8088` | `EDGE_TTS_PORT` | Container listens on 8080; mapping is `127.0.0.1:${EDGE_TTS_PORT:-8088}:8080` |
| Worker metrics | `127.0.0.1:9100` | `WORKER_METRICS_PORT`, `WORKER_METRICS_BIND_ADDRESS` | Its health check hits `/metrics` |

**Fix:** Change the variable in `.env`, then `make up`. If you move the API port, **change `DESKTOP_API_ORIGIN` as well** (default `http://127.0.0.1:4000`) — otherwise the desktop app keeps dialling the old one. `make config` validates the dev configuration.

## Database and readiness

### `/ready` is 503 or migrations never ran → the API process is not the thing that migrates → read the one-shot containers' logs

**Symptom:** Postgres is healthy, the API starts, but `http://localhost:4000/ready` stays 503 with `business schema is incomplete — run migrations` and the fields `missingTables`, `appliedMigration`, `requiredMigration`.

**Cause:** Migrations run in a one-shot service, `migrate` (`restart: "no"`, command `npm run db:migrate`). The API does not migrate on boot. `/ready` checks two things: that the core business tables exist (`users`, `notes`, `jobs`, `learning_runs` and friends), and that the newest `created_at` in `drizzle.__drizzle_migrations` is at or above a floor. That floor comes from `MIN_READY_MIGRATION_CREATED_AT` and is a **timestamp**, not a migration count — the code default is `1786683800000` — so an early-partially-migrated database cannot masquerade as ready. A value that is not a positive safe integer produces its own 503. A database it cannot reach produces a different body, `database connection failed`.

**Fix:**

```bash
docker compose -f docker-compose.dev.yml logs migrate role-bootstrap role-grants
docker compose -f docker-compose.dev.yml ps            # one-shot services should sit at Exited(0)
```

`make up` removes last round's one-shot containers, recreates them and then `docker wait`s on `role-bootstrap`, `migrate` and `role-grants` (plus `minio-init` in storage mode), so normally you never trigger migrations by hand. Both compose files now run the same chain: `role-bootstrap` (creates the roles — it must come first because migrations `GRANT EXECUTE` to them) → `migrate` → `role-grants` (re-runs `apply-roles.sh` so grants land on objects the migrations created), and `api` / `worker` gate on `role-grants` exiting successfully. Without that last step a first boot on a fresh volume leaves the api with no SELECT on any business table: `/ready` answers `business schema is incomplete` and the container stays unhealthy — which is exactly what used to happen, repaired only by running `make up` a second time. `.github/scripts/compose-init-order.test.mjs` now holds that line. Leftover exited containers can be cleared with `make clean-init`.

## Companion voice

### No audio → engine selection, address or token mismatch → work out which path is supposed to sound

**Symptom:** Companion replies show text but stay silent; logs contain `qwen tts failed; falling back to edge-tts`.

**Cause:** The default engine is Qwen, and a synthesis failure degrades automatically to Edge TTS. Engine and voices are read from `config/ai-platforms.json`: `tts.engine` (`"qwen"` or `"edge"`; anything else falls back to the code default, `qwen`), `tts.qwen.{model,voice,workspaceId,instruction}` and `tts.edge.{voice,rate}` (Edge defaults to `zh-CN-XiaoxiaoNeural`). Degradation happens only on a real synthesis failure: a missing Qwen `workspaceId` switches to Edge instead of returning 502, while **a governance denial or a user cancellation does not degrade** — in those cases nothing should go out at all.

Addresses live in two worlds, and mixing them is the common mistake here:

| Caller | Address it needs | Provided by |
| --- | --- | --- |
| API inside Compose | `http://edge-tts:8080` | `EDGE_TTS_BASE_URL`, already injected by compose |
| API run directly on the host | `http://127.0.0.1:8088` (port from `EDGE_TTS_PORT`) | The host loopback default in code; Docker service names do not resolve from the host |

The shared token is `EDGE_TTS_AUTH_TOKEN` and **must be identical on both sides**. Compose declares it as `${EDGE_TTS_AUTH_TOKEN:?...}`, so the stack will not start without it. Container-side, `docker/edge-tts/server.py` fails closed when the variable is empty: everything except `/health` returns 401, and you get no audio. Concurrency has its own knob, `EDGE_TTS_MAX_CONCURRENCY` (default 4).

**Fix:** Decide which world your API runs in (a host-run API pointing at `edge-tts:8080` is the classic symptom), confirm the token matches on both sides, then read `docker compose -f docker-compose.dev.yml logs edge-tts`. If Qwen is unusable for you, set `tts.engine` to `edge` so Edge becomes the primary path instead of being reached only after a failed Qwen attempt each time.

## Model calls

### A call fails with 400 → protocol, model profile or baseUrl does not match the provider → check the declarations, slot by slot

**Symptom:** An AI call returns 400, or a job retries repeatedly and still fails. There is no "test this model" screen in the product — models and providers come only from `config/ai-platforms.json` and environment variables, so a 400 always arrives through a real call. (The old root README's "model test returns 400" and "re-enter your API key" items described a per-user provider configuration screen, which this repo does not have.)

**Cause:** This repo runs on **declaration as truth** and does no runtime capability probing. Capability-to-model mapping sits in `config/ai-platforms.json` under `capabilities` (`agent_turn`, `text_generation`, `companion_fallback`, `vision`, `embedding`), and each model's abilities are declared **per model**: `platforms.<id>.models.<model>` with `contextWindowTokens`, `maxOutputTokens`, `vision`, and `reasoning.levels` / `reasoning.default`. An undeclared model gets the provider's built-in defaults plus a one-time warning, so context budgets and thinking tiers are usually wrong in that case. Vision routing follows the declarations in three steps: use the conversation model if it declares `vision: true`; otherwise use `capabilities.vision` provided that model is not explicitly declared `vision: false`; if neither holds, fail plainly rather than hand the image to a model that cannot see.

Protocol type is part of the declaration too. `opencode_go` speaks the OpenAI **Responses** API (`/responses`), whose messages/choices contract differs from `chat/completions` and cannot be reused by rewriting the endpoint. So within one provider, models available only on `/responses` go through `opencode_go`, while models still on `chat/completions` need a separate `openai_compatible` platform on the same base URL — that is exactly how `siliconflow` and `siliconflow-chat` are split in the config. `dashscope` is its own provider type with default base path `https://dashscope.aliyuncs.com/compatible-mode/v1`, and its embedding resolution requires the baseUrl to end in `/compatible-mode/v1`, throwing otherwise.

**Fix:** Verify the base URL matches the provider's protocol, the model ID is correct, the account is entitled to that model, and the balance is not exhausted; for newer DashScope models prefer the compatible-mode address. Then add the missing profile for that model instead of letting the code guess.

### A call fails with 401 or 403 → treated as non-retryable → fix the credential, do not wait for retries

**Symptom:** The job goes to failed quickly instead of retrying, with 401/403 from the provider in the log.

**Cause:** `workers/ai-worker/src/lib/non-retryable-errors.ts` classifies authentication, authorization and billing errors as non-retryable and marks the job dead immediately so it stops burning lease time. The list uses exact phrases — `invalid api key`, `unauthorized`, `authentication failed`, `api key is required`, `access denied`, `permission denied`, `insufficient balance`, `account suspended` — plus 401/403 detection that requires HTTP-status context, so a bare number in a message ("card 403 not found") no longer kills a retryable job. The real DashScope overdue payload, `please make sure your account is in good standing`, is deliberately in the list.

Keys are not entered through the UI: both local and production inject them from environment variables, and the config file holds only `${VAR}` placeholders. So a 401/403 is fixed by supplying the variable and restarting the affected service, not by pasting a key into some page.

**Fix:** Check that the key belongs to the right project and region and is entitled to the target model, then check the account side — overdue balance or exhausted quota produces the same class of failure. For the current config the keys come from `${VAR}` placeholders in `config/ai-platforms.json`, backed by `DASHSCOPE_API_KEY`, `OPENAI_COMPAT_API_KEY`, `BIGMODEL_API_KEY`, `SILICONFLOW_API_KEY`, `TOKENRHYTHM_API_KEY` and `OPENCODE_GO_API_KEY`.

> **Note:** When the environment variable behind a placeholder is unset, `${VAR}` stays literally in place, the platform counts as not configured, and resolution **falls back to the mock provider** (fixed fake text, plus a warning) rather than throwing. The production compose sets `AI_REQUIRE_CONFIGURED_PROVIDER=true`, where an unconfigured platform instead throws the non-retryable `ai_provider_not_configured`, so the user sees "AI not configured" and invented text never reaches study records.

## The companion does not reply

### Silent reply or a spinner that never ends → consent gate, platform resolution, or genuine thinking latency → check them in this order

**Symptom:** A message goes out with no answer, the state stays "generating" for a long time, or the reply is one or two characters.

**Cause and fix, in order:**

1. **The consent gate.** The single gate for anything leaving the machine is account-level AI consent: `PUT /me/ai-consent`, stored in `user_ai_settings`, satisfied only when both `consentAt` and `consentVersion` are set. Without it, the voice endpoints and the note-learning generation routes respond 403 `ai_consent_required`, and the interface should say "agree in settings first", not "the service is broken". Consent is account-wide and unrelated to workspaces, so switching space never re-asks.
2. **What the platform actually resolved to.** The provider health probe must run **inside the worker container**:

   ```bash
   docker exec -i -w /app astella-dev-worker-1 \
     node --import tsx --eval "$(cat scripts/companion-provider-health.mjs)"
   ```

   On the host, `AI_PLATFORMS_CONFIG` points at a path the container cannot see, so the probe reports `provider=mock` with a "platform not configured" line and measures nothing. The probe reuses the production truncation test, and exits 1 if any `agent_turn` response degenerates — that is the tier users are actually on.
3. **It is slow, not stuck.** Since thinking mode was enabled across the chain on 2026-10-06, a single retrieval went from a measured 7.6s to 36s; the summariser's single call measures 36s. Handler timeouts are therefore derived from the lease budget instead of written as literals: `LEASE_TIMEOUT_MS = 120s`, minus a 10s safety margin gives the ceiling, and `companion_agent`, `agent_run_advance`, `companion_memory_extract` and others take that ceiling. A single provider call defaults to 75s, still bounded by handler budget minus 15s; diary-style jobs go to the ceiling because one job can sample twice. Per-deployment overrides are `WORKER_MODEL_TIMEOUT_MS`, `WORKER_TIMEOUT_<TYPE>_MS`, `WORKER_PROVIDER_TIMEOUT_MS` and `WORKER_PROVIDER_TIMEOUT_<TYPE>_MS`. The lease must stay strictly larger than every handler timeout so the abort fires before the reaper reclaims the job — if a task sits at `running` and then gets taken over, someone has desynchronised those two numbers.

## Desktop client and type checking

### Type checking "passes" but inspects nothing → the desktop root tsconfig only has references → run each package's own `npm run typecheck`

**Symptom:** `tsc --noEmit` under `apps/desktop-client` finishes instantly and stays green even after you break a type.

**Cause:** `apps/desktop-client/tsconfig.json` is `{"files": [], "references": [tsconfig.node.json, tsconfig.web.json]}`. With no `files` and no `include`, a plain `tsc --noEmit` against that project checks nothing at all. The package's own script runs the two real projects: `tsc --noEmit -p tsconfig.node.json --composite false && tsc --noEmit -p tsconfig.web.json --composite false`.

**Fix:** Use `npm run typecheck`, or `make verify` from the repo root, which runs typecheck plus unit tests across seven packages: `packages/shared`, `packages/agent-core`, `packages/agent-host`, `packages/ai-quality`, `apps/api`, `apps/desktop-client` and `workers/ai-worker`. The other packages' `typecheck` is a plain `tsc --noEmit` and works directly. When a change touches shared types, look at shared, api, desktop-client and ai-worker together.

### Content is cut off or the companion overlaps the page → minimum window size and zoom rules → use the zoom shortcuts

**Symptom:** In a small window the controls do not fit, or zoom appears to do nothing.

**Cause:** The native minimum is `1280×720`, from `HOME_WINDOW_MINIMUM_SIZE` in `apps/desktop-client/src/shared/window-geometry.ts` (the same file gives the initial content size, `1440×810`). The room's coordinate space is `1672×941` (`room-1672x941` in `scene-geometry.ts`, `WORLD` in `home-v2/home-scene-profile.ts`), and the backdrop is always cropped to that world ratio — no filler bands, no stretching. Zoom is handled in the main process (`src/main/window-zoom.ts`): ⌘ on macOS, Ctrl elsewhere, with `+` / `-` / `0`, stepping 0.25, capped at 3×, and `0` returning to 1. `keyUp` events and active IME composition are ignored, so composing Chinese text cannot trigger an accidental zoom.

**Fix:** The acceptance sizes are `1440×810` plus 125% / 150% / 200% (200% yields a `720×405` effective CSS viewport). Home V2 switches to the compact semantic room once the effective CSS viewport is no wider than `720px` or no taller than `480px`, and every operation remains reachable. Motion modes are `full` / `lite` / `off`, chosen in Settings; the system `prefers-reduced-motion` always wins and jumps animations straight to their end state.

## Where the data lives

### Is my data still there after a restart → the database volume is external and outlives the compose lifecycle → only the confirmed reset deletes it

**Symptom:** Worry that `make down` or `docker compose down -v` wipes study records — or the reverse, wanting a clean slate and not being able to get one.

**Cause:** The dev database uses a fixed volume, `astella-dev_dev_postgres_data`, declared `external: true` in compose and created by `make up` (the `ensure-db-volume` step) with protective labels. `make down`, removing containers, and `docker compose down -v` all leave it untouched. The only deletion path is the confirmed reset:

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB
```

If `CONFIRM_RESET_DB` is not exactly `DELETE_DEV_DB`, the command prints a cancellation note and exits with code 2 without changing anything; if the volume is already gone it says so. MinIO keeps its data in a separate volume, `dev_minio_data`, with the bucket name from `S3_BUCKET` (dev default `astella-workspaces`).

| What | Where | Notes |
| --- | --- | --- |
| Business data | Docker volume `astella-dev_dev_postgres_data` | External; back it up before any reset |
| Uploaded images and attachments | Volume `dev_minio_data`, bucket `astella-workspaces` | `make storage` starts MinIO and `minio-init` |
| On-device speech recognition model | `<userData>/voice-models/` (relocatable via `ASTELLA_VOICE_ASR_DIR`) | Roughly 228 MB, **not in the installer**; the user downloads it in Settings |
| Desktop session credentials | Encrypted on disk by the main process via Electron `safeStorage` | Keychain on macOS, DPAPI on Windows, libsecret on Linux; when the platform offers no encryption backend it fails closed, writes nothing, and the login stays session-only |

## Tests that will not run

### Everything is green but no integration test ran → `*.integration.ts` is outside `npm test` → use the postgres-scoped targets

**Symptom:** `npm test` passes, yet a broken database contract goes undetected.

**Cause:** In `apps/api` and `workers/ai-worker`, the `test` script collects files matching `*.test.ts`. Integration suites are named `*.integration.ts` and are **not matched**. They sit behind a family of `test:*:postgres` scripts. The desktop package is different again: `vitest run --passWithNoTests`.

**Fix:**

```bash
make test-postgres          # iterates every test:*:postgres in apps/api and workers/ai-worker
make disposable-db DISPOSABLE_DB=astella_scratch
```

`test-postgres` needs a real but throwaway Postgres. `make disposable-db` builds a fresh database, runs all migrations and re-applies role grants against it, then discards it — because suites such as `rls-policies`, the worker queue and projection pagination assert "the only rows here are my fixtures". On the shared dev database they fail spuriously because of leftover rows, and they also write and delete data, so they never belonged there. The dev compose Postgres container must be running first. The script accepts only database names matching `astella_*` that are neither `astella` nor `postgres`, which is what makes it safe to keep in the repo.

A second trap: beyond the `DATABASE_URL_*` group these suites each read a dedicated variable (`RLS_TEST_*`, `QUEUE_TEST_*`, `RATE_LIMIT_TEST_DATABASE_URL`, `CONTENT_HASH_TEST_DATABASE_URL`, `SEC02_TEST_DATABASE_URL`, `NOTE_VERSION_RESTORE_TEST_DATABASE_URL`). Missing one is an **explicit throw**, not a silent skip, so the whole file goes red while reading environment variables and not a single case runs. `make test-postgres` injects all of them; when running a suite by hand, pass them yourself — the disposable-db script prints a copyable assignment list at the end.

## Known limitations still open

These are not misconfigurations on your side. They are the current state as recorded in code and documents; the files are the authority.

- **Server and desktop share `v1.0.0`**, maintained in `release/version.json`; check the GitHub Release and workflow results for installer availability.
- **The licence is MIT** ([LICENSE](../../../LICENSE)), but third-party and asset permissions must be read separately in [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md) — the companion model's redistribution limits are not granted by the code licence.
- **Since 2026-10-06 CI no longer builds or scans production images.** The production image and a real HTTPS deployment are only verified manually and locally.
- **Companion guidance is implemented** (the island button, seven topics, and a local demo that creates no business facts), but the brand-new-account walk and post-consent speech have never been run in a real window; **system-wide context governance and compaction** has its code path connected, with not one acceptance criterion evidenced by a real model, a real database or a real window.
- **The old "insertion sort stability" test card still exposes its answer summary** in the list and detail views before answering, and the detail view offers no recoverable delete or archive action. The records were not rewritten behind the product ([full QA, 2026-10-05](../../testing/full-qa-2026-10-05-final.md)).
- **The real macOS update replacement is still unverified** with a Developer ID signature (such a package cannot be produced locally), and the Windows NSIS path is likewise untested.
- **No human listening test, and no cross-day, concurrent or production performance validation.** What exists is a local memory snapshot, which does not substitute for a soak test.
- **`test:users-rls:postgres` had 3 failures in the same recheck**, all attributed to environment and baseline rather than the change (`RLS_TEST_MIGRATOR_DATABASE_URL` not injected for 2, the `schema-isolation-gate` table baseline for 1); it has not been closed out on a clean baseline.
- **Current study room artwork is still marked `reviewOnly / IN_REVIEW`** and must not be used as production assets before licensing and release acceptance are done.
- **There is no self-service password reset**: no email channel and no reset token, only the admin-side endpoint where an Owner initialises a password. Ask your workspace Owner.

## Related pages

- [Manual index](../README.md)
- [Overview](./overview.md)
- [Architecture](./architecture.md)
- [Development](./development.md)
- [Desktop client](./desktop-client.md)
- [API and data](./api-and-data.md)
- [Models and the worker pipeline](./ai-and-companion.md)
- [Unified agent runtime (technical)](./agent-runtime.md)
- [Companion experience (product design)](./companion-experience.md)
- [Testing and quality](./testing-and-quality.md)
- [Operations](./operations.md)
