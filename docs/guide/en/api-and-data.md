# API and data

[中文](../zh/api-and-data.md) · English

This page covers Fastify startup/shutdown, domain routes, authentication and tenancy, migrations and database roles, job submission, SSE, object transfers and the admin panel. Implementations live in `apps/api/src/`, shared contracts in `packages/shared/src/`, and database privileges in `infra/postgres/`. Endpoint fields follow their contracts/routes.

- [Runtime shape and startup order](#runtime-shape-and-startup-order)
- [Route and module inventory](#route-and-module-inventory)
- [Auth and security contract](#auth-and-security-contract)
- [Multi-tenancy and row-level security](#multi-tenancy-and-row-level-security)
- [Database, schema and migrations](#database-schema-and-migrations)
- [The three database roles](#the-three-database-roles)
- [Companion note writes and object transfers](#companion-note-writes-and-object-transfers)
- [Job handoff and outbox invariants](#job-handoff-and-outbox-invariants)
- [SSE and streaming responses](#sse-and-streaming-responses)
- [Configuration](#configuration)
- [Observability](#observability)
- [Admin panel](#admin-panel)
- [Request body limits](#request-body-limits)
- [Test entry points on the API side](#test-entry-points-on-the-api-side)
- [Related volumes](#related-volumes)

## Runtime shape and startup order

The entrypoint is `apps/api/src/server.ts`: one Fastify instance, **no global path prefix**, and domain route bundles registered flat (one of them, `card-generation-v2`, only when `CARD_GENERATION_V2_ENABLED=true`). The bind address comes from `resolveApiBindHost()` (`apps/api/src/modules/desktop-trust/routes.ts`) — default `127.0.0.1`; `0.0.0.0` is accepted only when `ASTELLA_CONTAINER_MODE` and `ASTELLA_ALLOW_CONTAINER_WILDCARD` are both `true`, otherwise startup throws. The port is `PORT`, default `4000`.

Plugins and hooks:

| Layer | Content |
| --- | --- |
| Plugins | `@fastify/cors` (allowlist from `CORS_ORIGIN`, comma-separated; an empty allowlist means `origin: false`, i.e. no CORS headers at all), `@fastify/sensible` (`httpErrors` plus uniform error serialisation), `@fastify/compress` (`global: true`), `@fastify/multipart` (10MB per file, one file, three non-file fields, 1KB per field value) |
| `onRequest` | Puts `request.id` (`genReqId` uses `crypto.randomUUID()`) into AsyncLocalStorage (`lib/request-context.ts`) so job creation can write `payload.traceId`, which is what makes worker logs traceable back to a request across processes |
| `onSend` | Global security headers `X-Content-Type-Options` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer`; responses that already called `hijack()` never reach this |
| `onResponse` | HTTP counters and latency histogram (route labels use the normalised template, avoiding both high cardinality and parameter leakage), 5xx counter, and one `security event` warn line per 401/403/429 — put here rather than in the error handler because rate limits and explicit rejections never go through the error handler |
| `setErrorHandler` | Anything ≥500 returns the placeholder `{error:"internal_error"}` with details only in logs; Postgres `42501` is counted into `astella_db_rls_denied_total`; 4xx messages pass through only for a controlled error shape (short code + message ≤300 characters), everything else gets the placeholder |
| `setNotFoundHandler` | Fixed `{error:"not_found", message:"资源不存在"}` — Fastify's default text would echo the route template (`Route /v2/notes/:id not found`) |
| Process level | `unhandledRejection` logs and then `process.kill(SIGTERM)`, reusing the same shutdown path |

The startup order is deliberate. `setLearningRunProcessingWaker(...)`, the graceful-shutdown coordinator and the `SIGTERM`/`SIGINT` handlers are all installed **before `app.listen()`** (P0-9: they used to sit after it, so wake-ups during the cold-start window were silent no-ops and users waited up to 10 seconds for the next poll; during that same window a SIGTERM took Node's default path). The DB gauges, series sampling, session cleanup, physical purge of soft-deleted notes, TTL maintenance and the note-round idle sweep **stay after `listen`** — each one touches the database, and putting them ahead of `listen` trades one race for a worse one: "slow database → container never ready → killed by the orchestrator".

Shutdown runs through `createGracefulShutdown()` (`apps/api/src/server/graceful-shutdown.ts`): clear every timer → `closeNoteCollaboration()` and only then `app.close()` (the order cannot flip — Hocuspocus debounces `onStoreDocument`, so closing the server first discards the last edits in the window; `closeNoteCollaboration` flushes pending snapshots, disconnects, then waits for the document count to reach zero with a 5-second ceiling and logs an error if it does not) → `drainInFlight()` waits for a tick that is already running (capped at `drainTimeoutMs` = 15s) → close the NOTIFY listener and the private solution pool → close the DB pool. Each stage collects its own errors and every stage is bounded; shutdown never hangs. Both compose files give the `api` service `stop_grace_period: 20s`, because that budget (10s closeServer + 5s pool `end`) exceeds Docker's default 10s.

## Route and module inventory

Paths are written inside the handlers as a flat set — `/notes`, `/v2/notes/:id`, `/companion/memory/:id/pin`. Version markers (`v2`, `v3`) are part of the resource name, not a global prefix.

| Domain | Module directory (`apps/api/src/modules/`) | Path prefixes | Notes |
| --- | --- | --- | --- |
| Identity and workspace | `identity` | `/auth/*`, `/workspaces*`, `/me/*`, `/invites*`, `/members*`, `/onboarding/*`, `/v1/auth/capabilities`, `/workspace/ai-audit-log` | Login and logout, sessions, workspace create/dissolve/transfer, members and invites, onboarding state, AI consent and egress policy |
| Desktop trust handshake | `desktop-trust` | `/_astella/desktop/trust/v1/challenge` | Exchanges an unauthenticated origin for a signed credential using `ASTELLA_DESKTOP_PAIRING_*` |
| Notes | `note` | `/notes*`, `/v2/notes/:id*`, `/note-doc` (WebSocket) | List and projection, document-state read, incremental upload, versions and trash, collaboration channel |
| Note satellites | `note-annotations` / `note-overviews` / `note-recalls` / `note-expansions` / `note-learning-artifacts` / `note-learning-rounds` | `/v2/notes/:noteId/{annotation,overview,expansion,learning-artifact}-tasks`, `/v2/notes/:noteId/{recalls,expansions,learning-round*}`, `/v2/note-learning-rounds*` | One task-and-artifact chain per note bookmark (速看 / 回想 / 往外学 / 学习记录), plus selection actions 写批注 (annotation) and 原句解读 (line explanation); rounds are read and written here too, and every result is tied back to a note version |
| Sources | `source` | `/sources*` | Capture, reparse, edit, restore, start a note from a source |
| Card generation V2 | `card-generation-v2` | `/v2/card-generation-runs*`, `/v2/cards*`, `/v2/initial-validation-reminders*` | The whole bundle registers only when `CARD_GENERATION_V2_ENABLED=true` |
| Review | `review` | `/v2/reviews/*` | Due queue, deferral, objective holds, source reveal, one-time reminders, subscriptions |
| Learning runs and objectives | `learning-runs`, `learning-objectives`, `learning-dashboard` | `/learning-runs*`, `/v2/learning-runs/:runId/*`, `/learning/assessments/:assessmentId/disputes*`, `/v2/learning-objectives*`, `/v2/learning-dashboard`, `/v2/home/*` | Runs need `LEARNING_RUN_ENABLED=true`, otherwise every endpoint 404s; disputes and corrections are a separate registration chain |
| Understanding and deepening | `note-deepening`, `understanding` | `/v3/understanding/*`, `/understanding/projection*`, `/understanding/routes/plan` | Topology snapshot, deepening, relation decisions, projection and deltas |
| Companion family | `companion-shell`, `companion-conversation` (with `memory/`, `delivery/`, `discovery/`, `turn/`), `companion-bridge`, `companion-journey` | `/me/companion*`, `/public/auth-surface-manifest`, `/companion/*` (conversations, messages, thoughts, proposals, memory, deliveries, inbox, daily, journeys, pet-profile, room-profile, home-projection, history, run diagnostics, export) | Dialogue and memory each fail closed on their own capability flag (`COMPANION_DIALOGUE_V1_ENABLED`, `COMPANION_JOURNEY_V2`, `COMPANION_MEMORY_VECTOR_V1`, `COMPANION_PET_PROFILE_V1`, `COMPANION_BRIDGE_V2`, and others) |
| Agent | `agent` | `/agent/runs*`, `/agent/long-goals`, `/agent/methods*`, `/agent/method-uses/:useId/feedback` | Reads and writes for runs and the method library; what actually runs today versus what is backend-only is in the "connected vs backend-only" table of [Unified agent runtime (technical)](./agent-runtime.md), and the acceptance gaps are recorded in the [plan index](../../plans/learning-companion/README.md) |
| Voice | `learning-sessions` | `/voice/tts`, `/voice/tts/stream`, `/voice/transcribe`, `/voice/preference`, `/voice/guidance-profile`, `/voice/tts/playback-outcome` | TTS/ASR; 404 while the voice capability is off |
| Jobs and retrieval | `job`, `search`, `import`, `export`, `upload` | `/jobs*`, `/search*`, `/import/markdown`, `/export/*`, `/uploads/*` | Jobs expose a read-only projection (payload and `last_error` masked); three upload endpoints plus download |
| Stats and observability | `stats`, `activity`, `observability`, `audit` | `/stats/overview*`, `/activity/today`, `/metrics/learning-events`, `/workspace/audit-log` | Product read models; `/metrics/learning-events` and the Prometheus `/metrics` are two separate routes |
| Admin panel | `admin` | Static shell and `<base>/api/*` under `ADMIN_PANEL_PATH` (default `/admin`) | See the panel section |

The endpoints you actually reach for:

| Purpose | Method and path |
| --- | --- |
| Login / logout / current identity | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /v1/auth/capabilities` |
| Note list / detail / document state / delta | `GET /notes`, `GET /v2/notes/:id`, `GET /v2/notes/:id/doc-state`, `POST /v2/notes/:id/doc-update` |
| Sources | `GET /sources`, `POST /sources`, `GET /sources/:id`, `POST /sources/:id/reparse` |
| Jobs | `GET /jobs`, `GET /jobs/:id` |
| Probes | `GET /health`, `GET /ready`, `GET /metrics` |
| Event streams | `GET /learning-runs/:runId/events`, `GET /v2/card-generation-runs/:runId/events/stream`, `GET /companion/deliveries/inbox/stream`, `GET /companion/conversations/:id/events` |

## Auth and security contract

- Credentials are **dual-channel**: `Authorization: Bearer <token>` first, then the `astella_session` HttpOnly cookie (`modules/identity/session-auth.ts`). Desktop uses Bearer; browser contexts use the cookie.
- A successful login sets both `astella_session` (HttpOnly) and `astella_csrf` (readable) with `Path=/; SameSite=Lax`, plus `Max-Age` when `remember=true`; `Secure` is added when `AUTH_COOKIE_SECURE=true` or `NODE_ENV=production` (an explicit `false` turns it off).
- Cookie-authenticated **mutations** use double-submit CSRF: the `x-csrf-token` header must equal `astella_csrf` under a constant-time comparison. `GET/HEAD/OPTIONS` are exempt; Bearer requests are not checked (browsers do not attach Authorization cross-site). `POST /auth/logout` is exempt too — low risk, and `SameSite=Lax` already blocks cross-site form posts.
- Login rate limiting defaults to a 15-minute window and 5 attempts (`AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX_ATTEMPTS`) with **two buckets**: `auth:login:ip:<req.ip>` and `auth:login:email:<email>`. Over the limit returns 429 with `Retry-After`. Success resets only the email bucket — resetting the IP bucket would let one valid login clear the failure count for the whole machine, which is exactly what distributed cross-account guessing needs.
- The store is selected by `AUTH_RATE_LIMIT_STORE`: `postgres` by default (table `auth_rate_limits`, correct across replicas), `memory` only when set explicitly; any other value throws. The dev stack deliberately sets `memory` and widens the ceiling to 100 — dev-only.
- Passwords use `bcryptjs` at cost 10. A login for an unknown email still runs one comparison against `DUMMY_PASSWORD_HASH`, so response timing does not become an account-existence oracle. Hashing happens on the main thread but always before a transaction opens, so it never holds a pooled connection.
- Session tokens are stored as SHA-256 digests (`sessions.token` holds the hex digest), so a database leak is not a list of usable credentials. Decoding runs inside `withActorTransaction`; a missing membership row or a non-null `left_at` deletes the session on the spot. Sliding renewal comes from `nextSessionExpiry()`: 30-day TTL, renewed only when less than half of it remains, absolute ceiling 180 days. Expired sessions are swept once at startup and then hourly (`cleanupExpiredSessions()`).
- Password length rules differ per flow: login `min 4` (shape validation only, not a strength requirement), registration `min 8`, new password on change `min 8`, Owner initialization of an unset restored-user password `min 12`; the ceiling is 200 everywhere.
- Ownership has a single predicate: `isWorkspaceOwner()` (`membershipRole === "owner"` or `workspaceOwnerId === userId`). `requireOwner`, `/v1/auth/capabilities` and the note projections all use it, which is what prevents "the server allows the write while the UI decides it is read-only".

## Multi-tenancy and row-level security

`db/client.ts` offers three transaction entry points, and all of them **issue the `app.*` transaction-local settings and read them back**: after `set_config('app.workspace_id'|'app.user_id'|'app.session_token', …, true)` the returned values are compared, and a mismatch throws `workspace_transaction_context_error` rather than continuing with a context that never took effect.

- `withWorkspaceTransaction({workspaceId, userId}, fn)`: business requests already inside a workspace. Nesting with the same context reuses the active transaction; changing tenant or isolation level errors out before anything executes; `allowNullUserId: false` — API business work always has an authenticated actor.
- `withActorTransaction({userId, workspaceId?, sessionToken?}, fn)`: the boundary actions — login, token decoding, workspace listing, redeeming an invite — where the workspace is not known yet. `app.workspace_id` may stay empty (that emptiness *is* the "no workspace chosen" state and must not be faked with a nil UUID); nesting may not change the actor or the token, the single exception being the placeholder actor (`SYSTEM_USER_ID`) being replaced by the real token owner through `assumeActor` / `commitAssumedActor`.
- `adoptWorkspaceContext(tx, workspaceId)`: raises the tenant to the newly created workspace mid-transaction without changing the actor.
- The backstop is in the database: the policies are RESTRICTIVE tenant guards, so when `app.*` has not taken effect a query reads **zero rows**, not someone else's rows. If evaluation order ever failed, the outcome is a loud 401 or an empty result — never a silent cross-tenant leak.
- Postgres error code `42501` (RLS rejection) is counted by the global error handler into `astella_db_rls_denied_total`, so false denials are visible.
- The ratchet lives in an integration test: `apps/api/src/integration-tests/schema-isolation-gate-postgres.integration.ts` compares two baselines against a real database and requires **exact equality**. Current baselines: the recorded baseline for tables with `workspace_id` but no foreign key to `workspaces` (new gaps fail, and baseline updates must tighten it), and **0** tables with RLS not enabled (zero tolerance: a new table that forgets `ENABLE`, or another blanket `DISABLE`, fails immediately), plus a check that no table has RLS enabled without any policy.

## Database, schema and migrations

| Item | Fact |
| --- | --- |
| Single source | `apps/api/drizzle.config.ts` points `schema` at `packages/shared/src/db-schema/index.ts` ; `out` is `apps/api/src/db/migrations`. There is no `packages/db`, and no application-side copy or compatibility shim |
| Guard status | `.github/scripts/verify-schema-mirror.mjs` (called by `make verify`) does exactly one thing: it confirms the directory exists and contains `.ts` files, throws if empty, and prints the file count. **It does not diff two schemas**, because there is only one |
| Migration order | `apps/api/src/db/migrations/meta/_journal.json` is authoritative; register new SQL and update role grants. The guide does not maintain a fixed total |
| Runner | `src/db/migrate.ts` is a hand-written runner, not `drizzle-orm/migrator` (that package's exports map puts `types` before `default`, so tsx resolves to the `.d.ts` and the module comes out empty) |
| Idempotency | Each migration is compared by `sha256(SQL file contents)` against `drizzle.__drizzle_migrations.hash`; the runner **does not look at the newest timestamp** — one stray record with a bigger timestamp silently skips every later migration |
| Transaction granularity | One transaction per migration (not one for the whole batch): smaller lock window and recoverable failure, at the cost of overall atomicity, so "create structure + backfill" must be written idempotently and re-entrantly |
| No-transaction directive | If `-- migrate:no-transaction` appears in the **first 20 lines** of a file, its statements are sent one by one outside a transaction (for statements like `CREATE INDEX CONCURRENTLY` that cannot run in a transaction block). Migrations taking this path must be idempotent on their own, and the `__drizzle_migrations` insert happens only after every statement succeeded |
| Folder override | `MIGRATIONS_FOLDER` can point at a truncated journal plus SQL directory (database tests can use it to materialise a baseline before exercising forward migrations); it is never inferred from `NODE_ENV` |
| Who runs them | Both compose files now share one chain of three one-shot services: `role-bootstrap` (create roles) → `migrate` (`npm run db:migrate` with `DATABASE_URL_MIGRATOR`) → `role-grants` (runs `infra/postgres/apply-roles.sh` again, with `REQUIRE_RLS_DISABLED=true`). `api` and `worker` (plus `seed-owner` in production) `depends_on: role-grants` completing successfully. The dev stack used to stop at `role-bootstrap` → `migrate` with `api` gating on `migrate`, so a first boot on a fresh volume had no grants for migration-created objects; it got the same chain on 2026-10-06 |
| Extensions | `uuid-ossp` (cryptographically secure UUIDs), `pg_trgm` (trigram similarity for evidence alignment) and `vector` (pgvector similarity search) must **pre-exist migrations**: `infra/postgres/init.sql` creates them on a fresh database, `infra/postgres/roles.sql` on an existing volume. From 0052 onward a dozen migrations issue `CREATE EXTENSION IF NOT EXISTS vector`, but migrations run as `astella_migrator` and creating an extension is superuser-only, so a missing one fails with `permission denied to create extension "vector"`; that is why the image must be `pgvector/pgvector:pg16` |

## The three database roles

`infra/postgres/roles.sql` is the source of truth for privileges and is safe to re-run. It revokes everything first, grants table by table, and finally asserts the privilege matrix in `DO` blocks, raising an exception when reality does not match.

| Role | Attributes | Privileges |
| --- | --- | --- |
| `astella_migrator` | `LOGIN NOSUPERUSER NOINHERIT BYPASSRLS` | Database-level `CONNECT, CREATE`; DDL and `ALL` on the `public` and `drizzle` schemas; owns the journal table |
| `astella_api` | `NOBYPASSRLS`, no `CREATE` on `public` | `SELECT/INSERT/UPDATE/DELETE` on all business tables (no DDL, no `TRUNCATE/REFERENCES/TRIGGER`); `USAGE` on `drizzle` plus read-only journal (needed by `/ready`); per-table tightening for append-only history and private worker state |
| `astella_worker` | `NOBYPASSRLS`, no `CREATE` on `public`, no `USAGE` on `drizzle` | An explicit read set plus `EXECUTE` on the controlled functions (`astella_claim_jobs`, `astella_renew_job_lease`, `astella_finish_job`, `astella_reap_stale_jobs`, …) |

> **Note:** the per-table `GRANT`s written inside migrations are wiped by `roles.sql`'s `REVOKE ALL`, because that statement runs **after** migrations. Every new grant for `astella_worker` therefore has to be restated in `roles.sql`; when it is not, the failure is silent rather than loud — 0385's `agent_context_compaction_state` left the worker with `permission denied`, so the whole compaction-cooldown chain did nothing on a real database. `assistant_thoughts` and `user_ai_settings` had the same gap earlier (the latter missing `SELECT` marks every companion job dead).

The `REQUIRE_RLS_DISABLED=true` check now means "every table with RLS enabled has at least one policy": it passes only when that count is zero, so `role-grants` fails outright when policies lag behind instead of letting the application start on bare isolation.

## Companion note writes and object transfers

`companion_create_note` calls `packages/agent-host/src/note-creation.ts` from the Worker. Controlled database functions save a private note, initial version and real links, checking workspace write permission, the active request and linked-note visibility/version. Global Agent permissions do not override a Member's read-only role.

API `modules/note/companion-edit-dispatch.ts` claims authorized `companion_edit_note` tools. `companion-edit-document.ts` verifies frozen text/version before changing the existing Hocuspocus Y.Doc. The established save/projection/search path commits it; the Worker reads a real save receipt. Tool identity prevents reapplication, and cancellation/stale text stops replacement. It is not a separate raw-SQL body overwrite endpoint.

`modules/storage/` supplies remote transfers. Clients obtain `/storage/transfers/config` and signed upload URLs, then finalize for API validation and copying to final objects. Downloads/exports check session/visibility before signed GET URLs. Main-process object requests carry no API token/Cookie. local_loopback retains the existing API upload path. See [Deployment](deployment.md) for modes and integration tests.

## Job handoff and outbox invariants

`createJob()` in `modules/job/service.ts` is the general API enqueue path; Agent host ports also enqueue direct capabilities and advancement under the same quota/idempotency contracts. This function **only inserts rows into `jobs`**, and never claims or executes (the claim function's `EXECUTE` is granted to the worker only, and the matrix assertion in `roles.sql` stops the API from ever acquiring it). Inside the same transaction it first takes `pg_advisory_xact_lock(hashtextextended('job-quota:<workspaceId>', 0))`, then:

- **Quota**: when the workspace has ≥ `MAX_PENDING_JOBS_PER_WORKSPACE` pending jobs (`@astella/shared`, value 50), it throws an error carrying `statusCode = 429`. The lock is what prevents two concurrent requests from both passing the check at 49.
- **Idempotency key**: a hit returns the existing job; a key already bound to another type or another `requestedBy` is treated as a caller error.
- **Dedupe**: one probe on `payload->><field>` (`noteVersionId` / `submissionId` / `runId` / `proposalId`) among `pending` + `running`. The field name is chosen explicitly by the caller, because the companion continuation job carries both `runId` and `proposalId` — deduping on `runId` would drop the continuation.
- **Scheduling**: `priority` and `resource_class` are mapped from the job type (`companion_agent` 100 / `interactive_ai`, `note_annotation_explain` 85, `parse_source` 70, companion background types 10 / `maintenance`, default 40).
- The payload carries the session actor (when the worker needs user scope it reads it) and `traceId`. `GET /jobs` and `GET /jobs/:id` never return payloads, and `last_error` comes back as `"error occurred"` plus a privacy-safe `failureReason`.

Each worker round calls `SELECT * FROM public.astella_claim_jobs(p_limit, p_background_limit, p_max_attempts)` (`workers/ai-worker/src/queue.ts`): `FOR UPDATE SKIP LOCKED` claims, one lease stamped for the batch, and a returned `lease_token`; renewals and write-backs are compare-and-set against that token, so if another instance re-claims an expired row this instance's update simply no-ops. `p_background_limit` keeps background lanes from taking the last free slot, so an interactive job has a slot as soon as it is enqueued.

Running jobs renew every 30 seconds. Migration 0394 adds `lease_renewed_at` for crash detection; separate handler/provider budgets govern execution, so the 120-second lease is not total runtime.

Downstream delivery uses outbox tables: inserted inside the transaction, delivered at least once, and idempotent by key on the consumer side.

| Table | Purpose |
| --- | --- |
| `learning_run_processing_outbox` | The only driver of assessment/commit; unique scope key, and the row's current state is checked before processing so a repeated tick never writes results twice |
| `canonical_learning_event_outbox`, `practice_trail_event_outbox` | Canonical events and practice trails published at commit, unique by `commitId` and `(runId, scope)` respectively |
| `card_generation_run_outbox_v2` | Domain events of a card-generation run |
| `learning_outbox_events`, `learning_session_processing_outbox` | Learning events and the session (voice) driving queue |

`learning_run_processing_outbox` **is consumed by the API process itself** (`server.ts` plus `modules/learning-runs/processing/run-processing-tick.ts`): each round calls `astella_claim_run_processing(workerId, 120_000, batchSize, now)` and claims a small batch (in-batch concurrency defaults to 4, ceiling 16, `RUN_PROCESSING_CONCURRENCY`), with a 120-second lease and `Promise.allSettled` inside the batch so one failure cannot block its neighbours; a tick handles at most 50 commands. Cadence is 10 seconds, failures back off exponentially as `10s × 2^streak` capped at 60 seconds and reset on success; after a submission commits, `wakeLearningRunProcessing()` schedules the next round immediately, leaving the 10-second poll as a fallback.

## SSE and streaming responses

Three long-lived event streams share `lib/sse-connection-limiter.ts`: 5 streams per subject and 200 per process by default (`SSE_MAX_STREAMS_PER_USER` / `SSE_MAX_STREAMS_TOTAL`), subject key `userId:workspaceId`, namespaces `run-events`, `card-gen-events` and `inbox`. **The decision happens before `reply.hijack()`** — once hijacked you can only write into the stream, which would turn a clear rejection into a semantically ambiguous one. Over the limit returns 429 `too_many_connections` and increments `astella_sse_rejected_total`. Counts are in-process memory, so with several replicas the real ceiling is replicas × this limit.

Responses after hijack **never reach `onSend`**, so the global security headers do not apply; each route sets `Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive` and `X-Accel-Buffering: no` in its own `writeHead`. Writes go through `safeSseWrite()`, slow clients get events skipped past a backlog threshold instead of accumulating memory, and every close path must call `release()` (idempotent, so calling it twice is safe).

| Endpoint | Shape |
| --- | --- |
| `GET /learning-runs/:runId/events`, `GET /v2/card-generation-runs/:runId/events/stream`, `GET /companion/deliveries/inbox/stream` | SSE through the shared limiter; `Last-Event-ID` supported, with `after` / `lastEventId` query as the fallback |
| `GET /companion/conversations/:id/events` | SSE with its own buckets: ≤3 per conversation and ≤10 per account, 429 over the limit; invalid cursor 400, expired cursor 409 — all decided before any response headers are written |
| `GET /me/companion/events` | Account-level SSE with its own bucket: ≤6 per account, 429 over the limit, 400 on an invalid cursor |
| `GET /companion/export` | NDJSON streaming export; errors can still be returned as JSON before the first line is written |
| `POST /voice/tts/stream` | Audio byte stream (not SSE) |
| `<base>/api/logs/stream` | Panel log tail; consumed with a `fetch` stream so the Bearer token never lands in a query string |

## Configuration

Variable names and purposes only. Values live in [`.env.example`](../../../.env.example) and the two compose files; this page does not restate secrets.

| Group | Variables | Defaults and notes |
| --- | --- | --- |
| Database connections | `DATABASE_URL_MIGRATOR`, `DATABASE_URL_API`, `DATABASE_URL_WORKER`, `DATABASE_URL` | One per role. In production, a missing `DATABASE_URL_API` / `DATABASE_URL_MIGRATOR` throws; `DATABASE_URL` is only the development/test compatibility path |
| Pool and timeouts | `API_STATEMENT_TIMEOUT_MS` (60s), `API_LOCK_TIMEOUT_MS` (5s), `API_IDLE_IN_TRANSACTION_TIMEOUT_MS` (15s), `API_POOL_IDLE_TIMEOUT_SECONDS` (30s), `DB_GAUGE_INTERVAL_MS` (5s) | The pool ceiling of 25 is a code constant, not env-configurable (`DB_POOL_MAX` / `API_DB_POOL_MAX` in the panel are display inputs only); `application_name = 'astella_api'` is what lets pool saturation be measured per process |
| HTTP and edges | `PORT` (4000), `API_BIND_ADDRESS` (`127.0.0.1`), `ASTELLA_CONTAINER_MODE`, `ASTELLA_ALLOW_CONTAINER_WILDCARD`, `CORS_ORIGIN`, `TRUST_PROXY` (false), `AUTH_SURFACE_MANIFEST_SECRET` | An empty `CORS_ORIGIN` sends no CORS headers. `TRUST_PROXY` accepts `true`/`false`/a hop count/a comma list. Leaving it off behind a reverse proxy makes `req.ip` the proxy address for everyone: the login IP bucket degrades into "5 attempts shared by the whole machine", the panel's per-source backoff blames the wrong client, and security logs record a single address |
| Auth and rate limiting | `AUTH_RATE_LIMIT_STORE`, `AUTH_RATE_LIMIT_WINDOW_MS` (15min), `AUTH_RATE_LIMIT_MAX_ATTEMPTS` (5), `AUTH_COOKIE_SECURE`, `NODE_ENV` | The store defaults to `postgres`; `Secure` comes from `AUTH_COOKIE_SECURE` or `NODE_ENV=production` |
| API capability flags | `LEARNING_RUN_ENABLED`, `CARD_GENERATION_V2_ENABLED`, `COMPANION_DIALOGUE_V1_ENABLED`, `COMPANION_VOICE_DIALOGUE_V1_ENABLED`, `COMPANION_STREAMING_VOICE_V1_ENABLED`, `COMPANION_JOURNEY_V2`, `COMPANION_BRIDGE_V2`, `COMPANION_MEMORY_VECTOR_V1`, `COMPANION_MEMORY_STAR_MAP_V1`, `COMPANION_PET_PROFILE_V1`, `COMPANION_PROACTIVE_PERSONALIZED_V1`, `COMPANION_SUMMARIZER_V1`, `COMPANION_DAILY_SUMMARY_V1` | All strictly `=== "true"`, i.e. **fail closed**: unset means off, endpoints 404 or the whole bundle is not registered. Most predicates live in `config/learning-companion-flags.ts`; a few are read in their own routes (star map, daily summary, bridge, proactive delivery). `verify-companion-capability-config.mjs`, run by `make verify`, pins both directions — each service declares exactly the flags it actually reads — plus defaults: the companion basics are on in dev and prod, while `LEARNING_RUN_ENABLED`, `CARD_GENERATION_V2_ENABLED` and voice are on in dev and off in prod. Worker-side siblings are covered in [Models and the worker pipeline](./ai-and-companion.md) |
| SSE and processing concurrency | `SSE_MAX_STREAMS_PER_USER` (5), `SSE_MAX_STREAMS_TOTAL` (200), `RUN_PROCESSING_CONCURRENCY` (4, ceiling 16) | Counters are per-process memory |
| Object storage | `STORAGE_MODE`, `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `S3_REGION` (`us-east-1`), `S3_BUCKET` (`astella-workspaces`), `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` (falling back to `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`), `STORAGE_REQUEST_TIMEOUT_MS` (120s) | A credential pair must be complete **within one set**; when nothing is configured the upload endpoints return 503. The decision logic lives in `@astella/shared/storage-config`, shared with the worker |
| Voice | `EDGE_TTS_BASE_URL`, `EDGE_TTS_PORT`, `EDGE_TTS_AUTH_TOKEN`, `EDGE_TTS_MAX_CONCURRENCY`, `QWEN_TTS_MAX_CONCURRENCY`, `DASHSCOPE_TTS_WORKSPACE_ID`, `SILICONFLOW_API_KEY`, `VOICE_ASR_MODEL` | Local edge-tts container plus external ASR |
| Run secrets | `LEARNING_DRAFT_ENC_KEY`, `PROJECTION_CHECKPOINT_SECRET`, `ASTELLA_DESKTOP_PAIRING_KEY_ID`, `ASTELLA_DESKTOP_PAIRING_SECRET`, `ASTELLA_DOMAIN_SCHEMA_REVISION` | Draft encryption, projection checkpoint signing, desktop trust handshake |
| Readiness and observability | `MIN_READY_MIGRATION_CREATED_AT`, `LOG_LEVEL`, `GIT_COMMIT`, `MIGRATION_COUNT`, `npm_package_version` | See the next section |
| Admin panel | `ADMIN_PANEL_TOKEN`, `ADMIN_PANEL_PATH` (`/admin`), `ADMIN_LOG_BUFFER_SIZE` (500, capped at 5000), `ADMIN_DOCKER_SOCKET`, `AI_PLATFORMS_CONFIG` | See the admin panel section |
| Seeding | `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_WORKSPACE`, `SEED_DEMO_DATA` | `db:seed` fails closed when the owner email or password is missing; demo data is only enabled in the dev profile |

## Observability

| Endpoint | Semantics |
| --- | --- |
| `GET /health` | Liveness only: proves the process and event loop can answer HTTP. It never touches the database, so a transient dependency outage does not make the orchestrator kill an otherwise healthy API |
| `GET /ready` | `SELECT 1`, plus a query against `information_schema.tables` compared with a set of core table names (`users`, `workspaces`, `notes`, `jobs`, `sessions`, `learning_runs`, `learning_run_private_contracts`, `learning_tasks`, `learning_task_variants`), plus `max(created_at)` from `drizzle.__drizzle_migrations` compared against `MIN_READY_MIGRATION_CREATED_AT`; any failure returns 503 with the gap reported |
| `GET /metrics` | Prometheus text, **deliberately unauthenticated** — the boundary is network policy (only the scraper can reach it), not a token check in the application layer |

The readiness check's migration clause is really a **timestamp floor**: it proves the largest applied `created_at` (the journal's `when`) is at least the threshold, not that every migration ran. The default floor is `1786683800000` and needs to be raised as versions move forward; leave it alone and a database holding only the early core tables still reports ready. It is documented here precisely because it reads like a schema validation.

`astella_*` families worth knowing (the full list is in `lib/metrics.ts`):

| Family | Use |
| --- | --- |
| `astella_http_requests_total`, `astella_http_request_duration_seconds`, `astella_http_errors_5xx_total` | By method / normalised route template / status class |
| `astella_db_pool_active_connections`, `astella_db_pool_max_connections`, `astella_db_server_connections`, `astella_db_transaction_failures_total`, `astella_db_rls_denied_total`, `astella_db_migration_version` | Dividing the first two gives pool saturation — postgres.js does not publish a queue count, so saturation is the only reliable "the pool is queueing" signal |
| `astella_learning_run_processing_outbox_depth`, `_oldest_pending_age_seconds`, `_tick_duration_seconds`, `astella_learning_run_processing_commands_total`, `astella_learning_run_critic_*` | Depth, staleness and critic calls/fail-closed for the outbox chain the API runs itself |
| `astella_sse_active_streams`, `astella_sse_rejected_total` | Labelled by namespace; labels are removed at zero so the endpoint does not carry a set of permanent zeros |
| `astella_readiness_status`, `astella_release_info`, `astella_funnel_events_total`, `astella_surface_*`, `astella_dashboard_*`, `astella_companion_*`, `astella_maintenance_rows_purged_total` | Readiness flip, version and migration label, funnel and surface latency, companion-side signals |

Logging uses pino (`lib/logger.ts`, `LOG_LEVEL`, JSON when not a TTY) and projects application logs and completed requests into two separate **bounded rings** (`lib/log-buffer.ts`: 500 / 300 entries by default, in-process, never persisted) that serve the panel's `/api/logs`, `/api/logs/requests` and `/api/logs/stream`. Metric series are sampled on their own two timers (`lib/metrics-series.ts`, 15s and 30s) — those windows feed panel trends and have a different contract from the instantaneous gauges Prometheus scrapes, so they keep their own cadence.

## Admin panel

| Item | Fact |
| --- | --- |
| Registration | `ADMIN_PANEL_TOKEN`, trimmed, must be ≥16 characters **and contain no placeholder fragment** (`change-me`, `placeholder`, `example`, `todo`, …); otherwise `adminRoutes()` returns and registers nothing. "Exists but always 401" is a permanent probing target; unregistered, it does not exist in the route table or in a scan |
| A different identity | The panel uses a deployment-level ops token (`x-admin-token` or `Bearer`) and never reuses `sessions`. Reason: authentication in this repository is per-tenant, and owner is a role **inside a workspace**. Wiring it to the panel would produce a global back office that can only see one workspace, while "is any run stuck in assessing" is exactly a cross-workspace question |
| Mount prefix | `ADMIN_PANEL_PATH` moves the static shell and every data endpoint under an unguessable prefix (for example `/panel-6b3f9c2d`); an illegal shape or no setting falls back to `/admin` with a log line. This reduces scanning noise — it is not authentication |
| Boundary | The static shell (`index.html` plus a few `.js` / `.css`, each file listed explicitly, no inline scripts or styles) is **public** — otherwise someone opening the panel for the first time would get a JSON error and never see the field where the token is typed. Everything under `<base>/api/*` carries `onRequest: requireAdmin`, enforced with a child scope so the boundary is structural rather than a path check that a future file could slip past |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, plus `Cache-Control: no-store` |
| Views | Six: overview, metrics (with series), logs (application / requests / live tail), queues (with job actions and grouped failures), infrastructure, config. `/api/audit` and `/api/todo` are data endpoints surfaced on the overview and queues pages. They map to `<base>/api/{overview,metrics,metrics/series,logs,logs/requests,logs/stream,queues,todo,audit,infra,config}`, plus `POST <base>/api/jobs/actions`, `GET <base>/api/infra/containers/:service/{logs,stats}` and `POST …/action` |
| Config page | Reads and writes `config/ai-platforms.json` (path from `AI_PLATFORMS_CONFIG`). Writes are **patches** that the server merges into what is on disk, so a whole-file replacement cannot erase plaintext secrets the panel never shows; platform and capability shapes are validated server-side, and a read-only production mount returns 409 `config_read_only` |
| Container actions | Require `ADMIN_DOCKER_SOCKET`; when it is unset the infrastructure page returns `available: false` and the panel shows "not connected" |
| Audit and backoff | Tokens are compared in constant time; failures are tracked per source IP and 8 failures block for 5 minutes (an in-process table that only raises guessing cost — it is not a security boundary); every entry into the panel is audited |

> **Note:** the dev stack sets two of these for local convenience — `ADMIN_PANEL_TOKEN` is a fixed development token and `ADMIN_DOCKER_SOCKET` mounts `/var/run/docker.sock`. That socket is equivalent to root on the host, so it is enabled only in `docker-compose.dev.yml`; the production compose leaves both empty (panel off, container actions unavailable). Carrying the dev values elsewhere as if they were defaults is the sharp edge this page flags deliberately.

## Request body limits

The limits are deliberately uneven; change one and look at all of them:

| Entry point | Limit | Source |
| --- | --- | --- |
| multipart (global) | 10MB per file, 1 file, 3 fields, 1KB per field value; oversize is cut during streaming, and `req.file()` throws `FST_REQ_FILE_TOO_LARGE`, mapped to 413 | `server.ts` |
| `POST /uploads/avatars` | 2MB (override via `req.file({limits})`; `MAX_IMAGE_SIZE` is 10MB and `MAX_AVATAR_SIZE` 2MB in `upload-service.ts`) | `modules/upload/` |
| `POST /v2/notes/:id/doc-update` | `bodyLimit` 8MB is only a coarse filter; the real rule is **decoded bytes** ≤ 2MB (`NOTE_DOC_UPDATE_MAX_BYTES`), otherwise `update_too_large` | `modules/note/` |
| `POST /import/markdown` | `bodyLimit` 50MB, aligned with the schema ceiling (100 items × 500KB) | `modules/import/` |
| Every other JSON route | Fastify's default 1MiB | — |

## Test entry points on the API side

- Unit and guard tests: `cd apps/api && npm test` = `node --import tsx --test --test-concurrency=8 $(find src -name '*.test.ts')` . Besides service unit tests, `src/__tests__/` contains a family of `*-source-guard.test.ts` and `*-contract.test.ts` files that read source text and migration SQL, pinning conventions runtime checks cannot catch: layering boundaries, the error envelope, capability-flag naming, the no-transaction migration directive.
- Integration: `*.integration.ts` files under `src/integration-tests/` are **not part of `npm test`**; they run only through the explicit `test:*:postgres` scripts in `apps/api/package.json` and need a real database plus `DATABASE_URL_*`.
- Everything at once: `make test-postgres` walks every `test:*:postgres` script in `apps/api` and `workers/ai-worker` and injects restricted-role connection strings (a superuser bypasses RLS and turns isolation assertions into false passes). They must run on a **clean disposable database**: `bash scripts/dev-disposable-db.sh astella_it` — several cases assert that the database holds only their own fixtures, and a shared dev database fails them.
- Contracts and route coverage: `npm run test:route-contract:postgres`, `test:users-rls:postgres` (includes the schema ratchet), `test:db-integrity:postgres` (migrations and rate limiting).
- Type checking: `cd apps/api && npm run typecheck`. The local baseline is `make verify` (the same set as CI, pinned by `ci-workflow-contract.test.mjs`); the wider verification matrix is in [Testing and quality](./testing-and-quality.md).

## Related volumes

- [Handbook index](../README.md)
- [Product overview](./overview.md)
- [Architecture](./architecture.md)
- [Development and running](./development.md)
- [Desktop client](./desktop-client.md)
- [Models and the worker pipeline](./ai-and-companion.md)
- [Unified agent runtime (technical)](./agent-runtime.md)
- [Companion experience (product design)](./companion-experience.md)
- [Testing and quality](./testing-and-quality.md)
- [Operations](./operations.md)
- [FAQ and troubleshooting](./faq-and-troubleshooting.md)
- [README.md](../../../README.md), [PRODUCT.md](../../../PRODUCT.md), [plan index](../../plans/learning-companion/README.md)
