# 理解引擎 (ailearn) System Architecture

[中文](../zh/architecture.md) · English

What this covers: which processes make up this codebase today, every hop a request takes from the desktop window to the database and back to the screen, how the 138 tables group up, and where each boundary's enforcement actually lives. After reading it you should be able to name processes, hops and table groups — not just remember "front end and back end". Ports and commands follow `Makefile` and `docker-compose.dev.yml`; this page maps structure and points at files. Every name, port, default and line reference below was read out of the source.

- [Runtime topology](#runtime-topology)
- [One AI turn, end to end](#one-ai-turn-end-to-end)
- [Process inventory](#process-inventory)
- [Packages and dependency direction](#packages-and-dependency-direction)
- [Table groups](#table-groups)
- [Data-flow contracts](#data-flow-contracts)
- [Where the AI work actually runs](#where-the-ai-work-actually-runs)
- [The desktop client boundary](#the-desktop-client-boundary)
- [Authentication and authorization topology](#authentication-and-authorization-topology)
- [Two version lines](#two-version-lines)
- [Decisions and what they cost](#decisions-and-what-they-cost)
- [Changing X, look at Y](#changing-x-look-at-y)

## Runtime topology

The development stack is `docker-compose.dev.yml` (Compose project `ailearn-dev`), production image builds use `docker-compose.yml`, and the Alpha environment uses `docker-compose.alpha.yml`. The diagram below is the dev stack plus the desktop client. `prometheus` / `alertmanager` **exist only in the alpha file** — there is none in the dev stack.

```mermaid
flowchart TB
  subgraph client["desktop-client: one Electron instance, one window"]
    REN["Sandboxed renderer<br/>ailearn-app://bundle/index.html<br/>contextIsolation · sandbox: true · nodeIntegration: false"]
    PRE["preload bridge<br/>window.ailearn · window.ailearnDesktop"]
    MAIN["Electron main process<br/>src/main/index.ts + desktop-gateway*"]
    REN <-->|"typed IPC channel + zod input"| PRE
    PRE <-->|"ipcRenderer.invoke"| MAIN
  end

  API["api: Fastify 5<br/>apps/api/src/server.ts<br/>container :4000, loopback-published to host"]
  WK["worker: ai-worker<br/>workers/ai-worker/src/index.ts<br/>metrics :9100"]
  PG[("postgres 16 (pgvector/pgvector:pg16)<br/>:5432, three roles + RLS")]
  MINIO[("minio: :9000 API<br/>:9001 console, bucket ailearn-workspaces")]
  TTS["edge-tts container<br/>container :8080 → host 127.0.0.1:8088"]
  LLM["External model platforms<br/>declared in config/ai-platforms.json"]

  MAIN -->|"HTTP: Bearer + CSRF + local pairing trust"| API
  API --> PG
  WK --> PG
  API -->|"assessment / transcription / voice: in-process"| LLM
  WK -->|"provider calls for queued jobs"| LLM
  API --> MINIO
  WK --> MINIO
  API -->|"TTS synthesis"| TTS
```

Three edges people tend to drop, each of which changes the conclusion:

- The renderer **issues no business HTTP**. Everything it wants from the API goes `window.ailearn` → IPC → main-process gateway → HTTP. There are `fetch` calls in the renderer, but they only load same-origin bundled assets (Live2D manifests, fonts, audio) — see `components/companion/WindowLive2DDriver.ts` and `media/learning-room-manifest.ts`.
- api and worker **never call each other**. Postgres is their only shared channel: api writes `jobs`, worker claims and settles it through `SECURITY DEFINER` functions, and events propagate over `pg_notify` channels.
- Auto-update **does not go through apps/api**. The client talks to GitHub Releases directly (`publish` in `apps/desktop-client/electron-builder.yml`, implemented in `src/main/desktop-update.ts`), so a dead local API does not block updates.

## One AI turn, end to end

The diagram traces a companion dialogue turn (`companion_agent`), because that is the only path with SSE. The other two return paths are described in words right after it.

```mermaid
sequenceDiagram
    autonumber
    participant R as Renderer (note page / companion)
    participant M as Electron main
    participant A as api route
    participant J as jobs table
    participant W as ai-worker
    participant P as model platform

    R->>M: window.ailearn.<domain>.<action> (channel name + zod input)
    M->>A: POST /companion/conversations/... (Bearer token stays in main)
    A->>A: withWorkspaceTransaction: set_config, then read it back
    A->>J: createJob: pg_advisory_xact_lock(job-quota:workspaceId) → idempotency lookup → payload dedupe → pending count below 50 → INSERT
    A-->>M: 202 accepted (runId / operationId)
    M-->>R: receipt; page parks the task
    J-->>W: AFTER INSERT trigger pg_notify('ailearn_job_events')
    W->>J: public.ailearn_claim_jobs(interactive, background, 3): SKIP LOCKED, writes lease_token
    W->>W: read material in a short transaction (inside RLS) → call model outside it
    W->>P: runAiTask (budget / timeout / AbortSignal / consent + data-policy gate)
    P-->>W: candidate output
    W->>J: verify lease_token → write domain tables + pg_notify('ailearn_companion_events_v1') → ailearn_finish_job
    A-->>M: SSE frames from GET /companion/conversations/:id/events (NOTIFY wakes it, cursor is the fallback)
    M-->>R: projected minimal event shape over the subscription channel
```

The three paths differ; don't collapse them into one in your head:

| Trigger | Enqueue implementation | How the result reaches the screen |
| --- | --- | --- |
| Companion dialogue, note annotation explanation, source parsing, memory and thought jobs | `createJob()` in `apps/api/src/modules/job/service.ts` | Dialogue uses SSE; annotations and sources poll task/operation status |
| Note-page 速看 (overview), expansion, dynamic artifact, plus card generation | direct `INSERT INTO jobs` in `packages/agent-host/src/note-operation.ts` and `store.ts:enqueueAdvance` | Renderer polls operation/job status, e.g. `renderer/src/components/surfaces/notebook/use-notebook-overview.ts:142` |
| LearningRun answer assessment and Commit | not in `jobs` at all: the api process polls `learning_run_processing_outbox` | events written, then pushed on `/learning-runs/:runId/events` |

Both enqueue paths take **the same lock with the same limit**: `note-operation.ts:37-39` and `job/service.ts:151-155` both run `pg_advisory_xact_lock(hashtextextended('job-quota:<workspaceId>', 0))` and then count pending rows. The only difference is that agent-host hard-codes `50` while `createJob` reads `MAX_PENDING_JOBS_PER_WORKSPACE` (`packages/shared/src/job-queue-limits.ts:17`).

## Process inventory

| Process | Who starts it | Entry point | Port | Health endpoint |
| --- | --- | --- | --- | --- |
| api | `make up` → compose service `api`, `target: dev` | `apps/api/src/server.ts` (`npm run dev` = `tsx watch src/server.ts`) | 4000 in-container; host `${API_PORT:-4000}` bound to `${API_BIND_ADDRESS:-127.0.0.1}` | `/health`, `/ready`, `/metrics` |
| worker | `make up` → compose service `worker` | `workers/ai-worker/src/index.ts` (`tsx watch src/index.ts`) | metrics `${WORKER_METRICS_PORT:-9100}`, published on 127.0.0.1 | `/metrics` (what the compose healthcheck hits), `/ready` (exists in code, `lib/metrics.ts:364`) |
| postgres | compose service `postgres`, image `pgvector/pgvector:pg16` | stock image + `infra/postgres/init.sql` | `${POSTGRES_PORT:-5432}` on 127.0.0.1 | `pg_isready -U ailearn -d ailearn` |
| minio | compose service `minio`, profile `storage`; dev `make up` includes that profile by default | `minio/minio:RELEASE.2024-12-18T13-15-44Z` | `${MINIO_PORT:-9000}`, `${MINIO_CONSOLE_PORT:-9001}` | `/minio/health/live` |
| edge-tts | compose service `edge-tts` | `docker/edge-tts/server.py` (`python:3.12-slim`, `user: nobody`) | container 8080 → host `127.0.0.1:${EDGE_TTS_PORT:-8088}` | `/health` |
| Electron main | `make desktop-client-dev` → `npm run dev` = `electron-vite dev --remoteDebuggingPort 9222` | `apps/desktop-client/src/main/index.ts` | listens on nothing; acts only as an HTTP client | no HTTP surface; the window shows connection state via the `runtime.getHealth` IPC channel |
| Electron renderer | the single `BrowserWindow` created by main | dev: Vite dev server; packaged: `ailearn-app://bundle/index.html` | served by the dev server, whose origin arrives as `ELECTRON_RENDERER_URL` | as above |
| preload bridge | same lifetime as the renderer | `apps/desktop-client/src/preload/index.ts` | — | — |
| prometheus / alertmanager | `make alpha-up` (`scripts/alpha-env-setup.sh` + `docker-compose.alpha.yml`) | `prom/prometheus:v3.0.1`, `prom/alertmanager:v0.28.1` | 9090 / 9093 | `/-/healthy` on both |

The one-shot containers (`role-bootstrap`, `migrate`, `minio-init`, `seed-demo`) are not in this table: they run to completion and stop. Their convention is documented in [development.md](development.md#the-one-shot-container-convention).

## Packages and dependency direction

`packages/` contains **exactly five packages**: `shared`, `agent-core`, `agent-host`, `ai-quality`, `card-generation`. **There is no `packages/db`** — the project-structure block in the root README still lists it, and that is stale. Database access lives in `apps/api/src/db/` and `workers/ai-worker/src/db.ts`; table definitions have one home, `packages/shared/src/db-schema/`, and `.github/scripts/verify-schema-mirror.mjs` (run by `make verify`) is the guard that says so: no application-side mirror, no compatibility shim.

| Package | Responsibility | Imported by | What it must not pull in |
| --- | --- | --- | --- |
| `@ailearn/shared` (`packages/shared`) | zod contracts, enums, the drizzle schema for all 138 tables, cross-process safety utilities (`safe-error`, `job-queue-limits`) | api, worker, desktop-client, and the other four packages | `src/index.ts` must stay free of `node:` imports — the renderer loads it. Server-only modules (`workspace-transaction.ts`, `content-hash`, `task-router`, `card-generation-v2-hashing`) are reachable only by subpath; `verify-shared-exports.mjs` plus the per-line comments in `index.ts` hold that line |
| `@ailearn/agent-core` (`packages/agent-core`) | context measurement and budgets, compaction cooldown, run state, capability descriptions | api, worker, agent-host | src contains **no** `node:` or `drizzle-orm` import; it stays pure TypeScript, so don't add persistence to it |
| `@ailearn/agent-host` (`packages/agent-host`) | reads/writes for `agent_runs` / `agent_operations`, governance policy, method and receipt registration | api, worker | issues no HTTP and never touches model transport; because it depends on drizzle it can neither be re-exported from `packages/shared/src/index.ts` nor imported by the renderer |
| `@ailearn/ai-quality` (`packages/ai-quality`) | offline scoring, datasets, `pr-gate` (fixed fixtures, never paid network) | worker (and its own scripts); it is the only package `make verify` runs `pr-gate` on | does not reach the renderer, and api does not import it |
| `@ailearn/card-generation` (`packages/card-generation`) | card creation, evidence sealing, transaction and event shapes | api, worker, agent-host | it ships only a `typecheck` script and has **no tests**; `make verify` does not include it either (verify covers shared / agent-core / agent-host / ai-quality / api / desktop-client / ai-worker) |

`shared` declares 143 `exports` entries with zero wildcards. That is not a style choice: host `tsc --noEmit` resolves through the workspace symlink and finds the file on disk, while the Node runtime reads `exports`. A deep import for a file that exists but was never registered type-checks green and fails at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Table groups

31 modules under `packages/shared/src/db-schema/` declare **138 `pgTable`s** (the other two files, `enums.ts` and `index.ts`, declare none). On the migration side there are 388 `.sql` files, and the newest journal entry is `0391_summary_verified_revision_backfill`. Grouped by module:

| Group | Schema modules | Tables | What lives here |
| --- | --- | --- | --- |
| Identity, session, AI consent | `identity.ts`, `session.ts`, `ai.ts` | 11 | users, workspaces, membership and invites, `sessions`, sign-in rate-limit counters, `user_ai_settings`, `ai_artifacts` |
| Sources and notes | `note.ts`, `evidence.ts`, `note-annotations.ts`, `note-expansions.ts`, `note-learning-artifacts.ts`, `note-learning-reflections.ts`, `note-learning-rounds.ts`, `note-overviews.ts`, `note-recalls.ts` | 24 | sources and parsed output, notes with immutable versions and evidence alignment, then one task-plus-artifact table set per on-demand capability: overview, annotation, expansion, dynamic artifact, rounds, reflection |
| Background queue | `job.ts` | 1 | the single `jobs` table: `type` / `status` / `attempts` / `payload` / `lease_token` / `priority` / `resource_class` / `idempotency_key` |
| Learning runs and review | `learning-runs.ts`, `learning-metrics.ts`, `assessment-disputes.ts`, `validation-v2.ts`, `personal-objective-bindings.ts`, `personal-relation-decisions.ts` | 25 | LearningRun with its private contracts, tasks and variants, events and outboxes, review scheduling, assessment disputes and corrections, objective binding |
| Card generation | `card-generation-v2.ts` | 33 | the largest set: generation runs, candidates, review and exposure ledger, quality and evidence sealing, activation receipts |
| Companion | `companion.ts`, `companion-conversations.ts`, `companion-memory.ts`, `assistant-memory.ts`, `assistant-deliveries.ts`, `companion-bridge.ts`, `companion-journey.ts`, `companion-home.ts`, `companion-sandbox.ts` | 40 | the companion and its account state, conversations and turn events, memory items and revisions, deliveries and reminders, the page-context bridge, journey, room projection, isolated artifacts |
| Search and understanding projection | `search.ts`, `understanding-projection.ts` | 4 | the full-text search write projection and the read-side projection behind the understanding graph |

Three things about this table that lead to wrong conclusions if you read it too quickly:

- Table count is not the permission surface. **Who may read a table is decided by `infra/postgres/roles.sql`, not by the drizzle declaration** — the per-table `GRANT` inside a migration is undone by the later `REVOKE ALL`, and a grant not repeated in `roles.sql` fails silently rather than loudly.
- Most of those 33 card table names end in `_v2` (a few do not, e.g. `card_content_capability_state`), yet **V3 uses exactly this set** (`card_generation_runs_v2`, `card_generation_plans_v2`, `card_generation_candidates_v2`). The V3 implementation is in `workers/ai-worker/src/card-generation-v3/` and declares no schema — searching for "V3 tables" by name finds nothing.
- **Tables do not only exist in the drizzle declarations.** `companion_memory_organization_state` is created by migration `0350_companion_memory_organization_lease.sql` and is absent from `packages/shared/src/db-schema/`; the `companion_memory_organize` job that consumes it also has **a worker handler but no `JobType` enum member**. Its other input, `assistant_memory_items`, sits in `assistant-memory.ts` — same "Companion" group above, different table-name prefix. When looking for a table, check both the schema directory and the migrations.

## Data-flow contracts

**Request id and cross-process trace.** `server.ts:116` generates `genReqId` with `crypto.randomUUID()`; `server.ts:143` puts it into `AsyncLocalStorage` in the `onRequest` hook (`apps/api/src/lib/request-context.ts`). `createJob` writes it as `payload.traceId` via `withTraceId()`, and worker reads it back at `index.ts:167` into its own logs. ALS was chosen over an extra parameter because `createJob` has seven-plus call sites and threading an argument through all of them guarantees a miss.

**Error envelope.** `apps/api/src/lib/error-envelope.ts` unifies the **decision** (status code, whether to mask 5xx, whether to spread `recoveryData`), not the wire shape. Its header documents the three shapes that still exist; the companion one carries `version: 1` / `recoverable` / `requestId`, which is part of the desktop contract and must not be "unified" away.

**Cursor pagination.** `apps/api/src/lib/pagination-utils.ts`: `encodeCursor` is `base64(ISO timestamp + ":" + id)` (lines 88-91); `decodeCursor` returns `null` on a malformed cursor instead of throwing; `clampLimit` / `clampOffset` / `clampPagination` do the clamping. `pagination.ts` adds only the Fastify-dependent `parseQuery`, which raises 400 on validation failure — the dependency-free half is reusable by worker.

**Workspace transaction.** `packages/shared/src/workspace-transaction.ts` is the single implementation after the API and worker halves were merged: UUID normalisation, `pg_catalog.set_config` for `app.workspace_id` and `app.user_id` with `is_local = true`, **then a read-back comparison** against what Postgres actually accepted (lines 147-172), throwing `database rejected … transaction context` on any mismatch. Two traps are baked in: a `null` userId must be passed as NULL, not an empty string (empty hits `user_id = ''::uuid` as a plan-time constant cast and throws), and nested work may reuse the transaction but may never change tenant or actor.

**Outside-transaction gate.** `assertOutsideWorkspaceTransaction` / `assertOutsideRegisteredTransactions` in the same file (lines 199, 249) test "is there an active transaction in the current async scope", not "does the text of this code mention `transaction`" — so implicit nesting is rejected too. The registry exists because `public-json-http` is shared by both processes and `shared` cannot import either side's ALS module.

**RLS.** 112 tables carry `FORCE ROW LEVEL SECURITY` across the migrations. `ailearn_api` and `ailearn_worker` are both `NOBYPASSRLS`; only `ailearn_migrator` has `BYPASSRLS` (`infra/postgres/roles.sql:52/60/68`). The dev stack's `DATABASE_URL_API` is already the restricted role (`docker-compose.dev.yml:17`) and that was deliberate: with a superuser, a read point missing `app.workspace_id` does not error, it silently returns zero rows.

**Outbox tables.** Four tables are named as outboxes: `learning_run_processing_outbox` (consumed in the api process), `canonical_learning_event_outbox` and `practice_trail_event_outbox` (all three in `learning-runs.ts`), plus `card_generation_run_outbox_v2` (in `card-generation-v2.ts`).

**SSE limiter.** `apps/api/src/lib/sse-connection-limiter.ts`: default 5 streams per user and 200 per process (lines 28, 37), overridable with `SSE_MAX_STREAMS_PER_USER` / `SSE_MAX_STREAMS_TOTAL`, bucketed by namespace — live namespaces include `run-events`, `card-gen-events`, `inbox`. Counters are **in-process memory**: with N replicas the real ceiling is N × this limit. All writes go through `safeSseWrite` in `safe-sse-write.ts`, which returns `false` on failure instead of letting a broken pipe surface as HTTP 500.

**LISTEN / NOTIFY wake-up.** Channels in use: `ailearn_job_events` (wakes the worker loop, `workers/ai-worker/src/lib/job-notify.ts:9`), `ailearn_companion_events_v1` (dialogue events, drives SSE), `ailearn_companion_inbox_v1` (delivery inbox), `ailearn_companion_account_v1`. Every sender is on the SQL side (`0115_job_insert_notify.sql`, `0271_job_ready_notify_on_retry.sql`, `0226_card_generation_outbox_notify.sql`, …); application code only consumes. Worker's idle poll backs off 500ms → 5000ms (`index.ts:103-104`); an arriving NOTIFY interrupts the current sleep and returns to the fast interval, and if establishing LISTEN fails it logs a warning and falls back to plain polling.

## Where the AI work actually runs

Not "all of it in worker". The split follows one question: does this chain need to be retried, queued and recoverable across processes.

In worker: all 13 handlers behind `jobs` (`HANDLERS` in `workers/ai-worker/src/index.ts:70-89`) — source parsing, companion agent turns and tool execution, memory extraction / summarisation / daily summary / embedding rebuild / semantic organisation, proactive thoughts, note overview / annotation explanation / expansion / dynamic artifact, and card generation V3 (`workers/ai-worker/src/card-generation-v3/handler.ts`).

In the api process: consumption of `learning_run_processing_outbox` together with the Assessment Critic call (`apps/api/src/modules/learning-runs/processing/run-processing-tick.ts`, wired at `server.ts:523-551`, one tick per 10s, 50 commands per tick, exponential backoff to 60s on failure); `learning-runs/planning/run-critic.ts` and `disputes/dispute-recheck.ts`; `note-learning-rounds/teaching/teaching-explain.ts`; speech transcription `learning-sessions/voice-providers/siliconflow-asr.ts`; the TTS engine and edge-tts client (`tts-engine.ts`, `edge-tts.ts` in the same folder); proactive delivery generation `companion-conversation/delivery/proactive-generator.ts`.

> **Note:** The criterion is "does the side effect need a lease". Callers behind `jobs` get a 120-second lease, a `lease_token` fence and a reaper. The in-process api batch relies on the outbox row's unique scope key plus a status check before handling the command (stated at the top of `run-processing-tick.ts`) and has no lease machinery. Moving that batch into worker would not buy a stronger guarantee — it would add a cross-process round trip.

The `JobType` enum has 12 members (`packages/shared/src/enums.ts:60-80`) while worker registers 13 keys in `HANDLERS`: `companion_memory_organize` has a handler but no enum entry. Adding a job type means touching both, plus the priority table in `jobScheduling()`.

## The desktop client boundary

- `webPreferences`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `devTools: !app.isPackaged` (`src/main/index.ts:588-595`). Session tokens and the encrypted credential file are main-process only (`session-credential-store.ts`); the renderer receives a snapshot.
- Custom protocol: `ailearn-app` is registered with `protocol.registerSchemesAsPrivileged` (line 69) and served by `protocol.handle` (line 171). Two hosts: `bundle` (the app itself) and the artifact host (AI-generated HTML/SVG in an isolated origin, `artifact-surface.ts`). Packaged serving supports streaming GET, HEAD and one Range per request — that is why local video and audio playback works.
- Navigation gates: `setWindowOpenHandler` always `deny`; `will-navigate`, `will-redirect` and sub-frame navigation all pass `isAllowedNavigation` (lines 430-449) — in development the dev server origin is allowed, otherwise only `ailearn-app://bundle` with no username, no password and no port. Blocks increment `isolationGateCounters`.
- CSP: `onHeadersReceived` routes three ways (lines 399-424) — renderer policy, artifact policy (`default-src 'none'`), and everything else gets `rejectAllContentSecurityPolicy`. The dev origin's `connect-src` and `'unsafe-inline'` are added only in development.
- IPC contract: channel names live in `DESKTOP_IPC_CHANNELS` (`packages/shared/src/contracts/desktop-ipc-contracts.ts`); main registers them with `installHandler(channel, inputSchema, options, handler)` (`desktop-ipc.ts:627`) split by domain across `desktop-ipc-{rest,source,learning,auth,workspace,companion,agent,voice-asr}.ts`; the renderer calls nested methods on `window.ailearn`; both sides share `DESKTOP_IPC_CONTRACT_VERSION` and `AILEARN_DOMAIN_SCHEMA_REVISION`.
- One instance, one window: `requestSingleInstanceLock` (line 645) — a second launch just focuses the existing window, and `new BrowserWindow` appears exactly once in the repo. The old "transparent always-on-top pet window" no longer exists in code.

> **Note:** `nativeCapabilities` is a projection that can mislead you. `transportNativeCapabilities()` (`desktop-gateway-transport.ts:216`) maps `filePicker`, `notifications` and `live2d` to `null`, and `null` always resolves to `unavailable`; the settings page renders that as 未接入 ("not wired up") via `capabilityChipLabel` (`settings-companion-status.tsx:45-56`). The other half of the problem is that its `registered` set is built from `Object.values(DESKTOP_IPC_CHANNELS)` — a **static channel-name list**, not "which handlers actually got installed this run". So the projection cannot express "name in the list but nobody registered it", and cannot express the reverse either: `desktop-ipc-workspace.ts:611/651` really do call `showSaveDialog` / `showOpenDialog`, yet `filePicker` never reports available, and Live2D is visibly on screen while the settings Live2D chip reads a separate runtime `Live2dStatus`, not this field. Check which source a capability chip actually reads before changing it.

## Authentication and authorization topology

Three identities that never mix.

**User session (HTTP).** `apps/api/src/modules/identity/session-auth.ts`: cookie `ailearn_session` (HttpOnly) plus a readable cookie `ailearn_csrf` paired with the `x-csrf-token` header (double submit); `SameSite=Lax`, and `Secure` from `AUTH_COOKIE_SECURE`, defaulting to on when `NODE_ENV === "production"`. `extractAuthCredential` (lines 36-44) **prefers Bearer** and only then reads the session cookie — the desktop gateway uses Bearer, a direct browser session uses the cookie. Desktop pairing is a fourth gate: `POST /_ailearn/desktop/trust/v1/challenge` (`modules/desktop-trust/routes.ts:106`) HMAC-SHA256-signs the nonce, `serviceId`, IPC contract version and `AILEARN_DOMAIN_SCHEMA_REVISION` with `AILEARN_DESKTOP_PAIRING_SECRET` (base64url, at least 32 decoded bytes). A mismatched key id is 401; unconfigured trust is 503 `desktop_trust_unavailable`. The client is symmetric: `local_loopback` requires both key id and secret, and if either is missing the constructed connection state is `configuration_error: pairing_secret_missing` (`desktop-gateway.ts:444-476, 669-681`).

**Operations panel (separate identity).** `modules/admin/auth.ts` uses a deployment-level token, `ADMIN_PANEL_TOKEN`, and deliberately **does not reuse the `sessions` table**: authentication in this repo is per-tenant, and owner is a role **inside a workspace**, so wiring `requireOwner` into the panel would yield a global back office that can see exactly one workspace. The strength floor is `MIN_ADMIN_TOKEN_LENGTH = 16` plus a placeholder blacklist; below that the token counts as unconfigured and `adminRoutes()` **registers no routes at all** rather than registering and rejecting. `ADMIN_PANEL_PATH` is a mount prefix that obscures scan noise — the boundary is the token.

**AI external-send consent (account level).** `modules/identity/ai-consent-gate.ts`: the test is `consentAt && consentVersion` on `user_ai_settings`. `requireAiConsent` runs as a preHandler before synthesis or transcription, returning 403 + `ai_consent_required`; text outbound is governed by `lib/governance.ts` in worker. Consent belongs to the account, not the workspace — signed once means signed everywhere, unsigned blocks everywhere. On job failure `classifyJobFailureReason` (`modules/job/service.ts:88`) maps the persisted privacy-safe code to `ai_consent_required` so the UI can say "go sign the consent" instead of "it failed".

## Two version lines

| Line | Single hand-edited source | Synced into | Enforced by |
| --- | --- | --- | --- |
| Server stack `0.5.0` | `release/version.json` | `apps/api`, `workers/ai-worker`, `packages/shared`: `package.json` and `package-lock.json` (top level and `packages[""]`), plus **exactly one** version marker in README | `make version-check` → `node .github/scripts/version-contract.mjs --check` (`--write` to sync); it is a prerequisite of `make verify` |
| Desktop `0.1.0` | `release/desktop-version.json` | `apps/desktop-client/package.json` and its lockfile | `.github/scripts/desktop-version.mjs --check / --set`, run by `desktop-package.yml` before packaging |

Keeping them apart is intentional: the tag namespaces are disjoint (server `v0.5.0`, desktop `desktop-v1.0.0`), the regex in `version-contract.mjs` returns `null` for the prefixed tag, so a desktop release never drags the backend CI along and vice versa. The cost is that you version twice, and that `packages/agent-core`, `agent-host`, `card-generation` (each 0.1.0) and `ai-quality` (0.5.0) are **outside** either contract's coverage.

## Decisions and what they cost

| Decision | Why | Recorded in | What it costs |
| --- | --- | --- | --- |
| Local-first, everything in one Compose file | The product is a personal study room: material, notes and memory should not pass through someone else's cloud first. `PRODUCT.md` lists PostgreSQL 16 as the only persistence store | [PRODUCT.md](../../../PRODUCT.md) | No cloud multi-tenant scaling path; in-process counters such as the SSE ceiling are per replica; the alpha stack is shaped like "a robot means alerts", not a platform |
| A queue plus a separate worker, instead of api calling models directly | Model calls are slow, time out, need retrying, and must not write once the user cancels or the lease expires. [Plan 41a §3](../../plans/learning-companion/41a-unified-agent-foundation-2026-09-28.md) states the run boundary as: short transaction to prepare → execute outside the transaction → short transaction to verify and save | 41a §3; implemented as `jobs` + `ailearn_claim_jobs` + `assertOutsideRegisteredTransactions` | One turn spans two processes, so tracing needs `traceId`; you acquire leases, a reaper, backoff and idempotency to maintain; `Exited` containers and a `LISTEN` connection are things someone has to keep alive |
| AI consent as an account-level gate, with no per-user model configuration UI in the desktop client | The decision to let content leave the machine belongs to the person who wrote it, not to each workspace's admin. `PRODUCT.md` states "account-level AI consent and outbound-data policy (no model/provider configuration)" | 41a §2/§3; code `ai-consent-gate.ts` + `lib/governance.ts` | The voice path once bypassed it (the file header records that doc 34 L13 closed it); the two tests must stay the same shape or one side loosens while the other tightens; an unconsented user gets a 403 with guidance rather than a field to paste an API key into |

## Changing X, look at Y

| Changing | Start here |
| --- | --- |
| Adding a background job type | `packages/shared/src/enums.ts` (`JobType`), `packages/shared/src/contracts/job-payload-contracts.ts`, `apps/api/src/modules/job/service.ts` (`jobScheduling`), `workers/ai-worker/src/index.ts` (`HANDLERS` and `DEAD_FINALIZERS`), `workers/ai-worker/src/lib/handler-timeout-config.ts` |
| Claim / retry semantics | `apps/api/src/db/migrations/0228_claim_jobs_interactive_reserve.sql`, `0018_sec01_jobs_expand.sql`, `0022_sec01_job_functions_expand.sql`, `workers/ai-worker/src/queue.ts`, `workers/ai-worker/src/lib/worker-concurrency.ts` |
| Adding a table | the matching module in `packages/shared/src/db-schema/`, a new migration in `apps/api/src/db/migrations/` (plus journal), and `infra/postgres/roles.sql` — **grants must be repeated there**, because the per-table GRANT in a migration is undone by the later `REVOKE ALL` |
| A new desktop action | `packages/shared/src/contracts/desktop-ipc-contracts.ts` (channel name + input/output schemas), the matching `apps/desktop-client/src/main/desktop-ipc-*.ts`, `apps/desktop-client/src/preload/index.ts`, the call site in `renderer/src/app/` |
| What a capability chip reports | `apps/desktop-client/src/main/desktop-gateway-transport.ts` (`NATIVE_CAPABILITY_CHANNELS`, `transportNativeCapabilities`), `renderer/src/components/surfaces/settings/settings-companion-status.tsx` |
| Companion turn events and presentation | `apps/api/src/modules/companion-conversation/turn/`, `workers/ai-worker/src/handlers/companion-dialogue*.ts` and `companion-agent-events.ts`, `renderer/src/app/companion-chat-session.tsx` |
| Answer assessment and review scheduling | `apps/api/src/modules/learning-runs/processing/run-processing-tick.ts` and `run-processing-assessment.ts`, `apps/api/src/server.ts:523-551` (wiring and cadence) |
| Switching a model platform or capability mapping | `config/ai-platforms.json`, and the same key list must be passed through **both** api and worker in `docker-compose.dev.yml` (2026-09-17: `OPENCODE_GO_API_KEY` was missing there and card generation failed closed), `workers/ai-worker/src/lib/providers/` |
| Health-check semantics | `apps/api/src/server.ts:125` (`/health`) and `:244` (`/ready`), `workers/ai-worker/src/lib/metrics.ts:348`, the two `healthcheck` blocks in `docker-compose.dev.yml` |
| Bumping a version | `release/version.json` or `release/desktop-version.json`, then `node .github/scripts/version-contract.mjs --write` / `node .github/scripts/desktop-version.mjs --set <ver>` |

## Related chapters

- [Manual index](../README.md)
- [Product overview](overview.md)
- [Development environment](development.md)
- [Desktop client](desktop-client.md)
- [API and data](api-and-data.md)
- [AI and the companion](ai-and-companion.md)
- [Testing and quality](testing-and-quality.md)
- [Operations](operations.md)
- [FAQ and troubleshooting](faq-and-troubleshooting.md)
- Repository root: [README.md](../../../README.md), [PRODUCT.md](../../../PRODUCT.md), [DESIGN.md](../../../DESIGN.md), [AGENTS.md](../../../AGENTS.md)
- Current plan index: [docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md)
