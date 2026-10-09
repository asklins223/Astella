# FAQ and troubleshooting

[中文](../zh/faq-and-troubleshooting.md) · English

Identify whether you are using local development, Alpha or remote HTTPS before checking configuration and logs. Historical incidents are not a list of current limitations. See [Development](development.md) for the complete startup path.

## Startup and login

### What must I configure first?

Copy `.env.example`, then fill `EDGE_TTS_AUTH_TOKEN`, `ASTELLA_DESKTOP_PAIRING_KEY_ID`, `ASTELLA_DESKTOP_PAIRING_SECRET` and `ASTELLA_DOMAIN_SCHEMA_REVISION`. Compose requires the first; local desktop pairing needs the other three. Missing values produce `desktop_trust_unavailable` or client `configuration_error`.

The pairing secret must contain at least 32 random bytes encoded as base64url. Generate one and put it in `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Remote HTTPS clients use a public API address and domain revision, without local pairing keys. Certificates must still be valid. See [Deployment](deployment.md).

### Why does the demo account fail to log in?

The development stack creates no account automatically. Run `make seed-demo` after startup. Defaults are **`owner@astella.local` / `astella_owner`**, for local development only. This Make target does not forward `.env` values for `OWNER_EMAIL` / `OWNER_PASSWORD`; an existing email is skipped without a password reset.

For custom credentials, export both variables in your shell, then run:

```bash
docker compose -p astella-dev -f docker-compose.dev.yml --profile seed   run --rm -e OWNER_EMAIL -e OWNER_PASSWORD seed-demo
```

Seed passwords require at least 12 characters. Production uses explicit `seed-owner` with its private environment file, and rejects demo seeding. See Deployment.

For 429, wait according to `Retry-After`. Email and IP counters are separate; successful login clears only the email counter. `AUTH_RATE_LIMIT_*` controls windows, limits and storage, with different development and production defaults.

### Can I recover a forgotten password?

There is no email self-service recovery. `/auth/change-password` requires the current password. The Owner endpoint `/auth/recovered-users/:userId/reset-password` only initializes an unset password for an imported/restored user; it cannot reset arbitrary existing accounts. It is not a general recovery endpoint.

### Is a port occupied, or is the client using the wrong address?

| Service | Development host default | Overrides |
| --- | --- | --- |
| API | `127.0.0.1:4000` | `API_PORT`, `API_BIND_ADDRESS` |
| PostgreSQL | `127.0.0.1:5432` | `POSTGRES_PORT`, `POSTGRES_BIND_ADDRESS` |
| MinIO | `127.0.0.1:9000/9001` | `MINIO_PORT`, `MINIO_CONSOLE_PORT` |
| edge-tts | `127.0.0.1:8088` | `EDGE_TTS_PORT` |
| Worker metrics | `127.0.0.1:9100` | `WORKER_METRICS_PORT`, `WORKER_METRICS_BIND_ADDRESS` |

When changing the API port, update `DESKTOP_API_ORIGIN` too. Check development configuration with `make config`, then apply it with `make up`.

## The API is alive, but `/ready` fails

`/health` checks process liveness. `/ready` also checks database connectivity, business tables and the migration threshold. One-shot containers run initialization: `role-bootstrap` → `migrate` → `role-grants`, followed by API and Worker startup after successful grants.

```bash
curl -fsS http://127.0.0.1:4000/ready
docker compose -p astella-dev -f docker-compose.dev.yml logs role-bootstrap migrate role-grants
docker compose -p astella-dev -f docker-compose.dev.yml ps -a
```

One-shot containers should show `Exited (0)`. `make up` waits for exit but does not check exit codes printed by `docker wait`, so command completion cannot replace readiness and log inspection. Creating tables alone or skipping grants is insufficient. See [API and data](api-and-data.md).

## The companion does not reply or keeps generating

Check in this order:

1. **AI consent:** sign account-level consent and allow egress in your own settings. `ai_consent_required` is a permission result; an Owner cannot sign for others, and changing workspace does not require signing again.
2. **Capabilities and configuration:** check feature flags, capability mappings in `config/ai-platforms.json`, and whether the matching keys reach API/Worker. New `.env` variables do not automatically enter containers.
3. **Execution progress:** inspect run, job and tool receipts. `/companion/runs/:id/doctor` diagnoses runs visible to the current user. Distinguish awaiting confirmation, not executed, unavailable, failed and running.
4. **Time budgets:** ordinary AI handlers default to 30 minutes and provider calls to 15 minutes, constrained by remaining time and overrides. A two-minute lease renews every 30 seconds for crash recovery; it is not the task runtime limit.

See [Model pipeline](ai-and-companion.md#timeout-ladder) and [Agent runtime](agent-runtime.md) for overrides, card outbox and recovery boundaries. Reasoning can take time, but elapsed time alone cannot establish health: inspect heartbeats and durable events. Cancelled executions or those with obsolete leases cannot commit.

[companion-provider-health.mjs](../../../scripts/companion-provider-health.mjs) runs in the Worker's configuration and identity context. It makes real, potentially billable model calls; ordinary unit tests do not run it.

## Model calls return 400, 401 or 403

For 400, check protocol, Base URL, model ID, profile and reasoning levels. `opencode_go` uses `/responses`, including the current DeepSeek dialogue slot. Models available only through chat/completions need an `openai_compatible` platform. Do not infer protocol from model names. Vision and reasoning follow the specific model's declarations.

401/403, insufficient balance and missing configuration are usually non-retryable. Fix keys, project/region authorization or quota, then restart the relevant service. The desktop has no personal provider-key settings page. Development may use mock; production with `AI_REQUIRE_CONFIGURED_PROVIDER=true` explicitly fails instead of substituting fake output.

See [Model pipeline](ai-and-companion.md) for configuration and protocols.

## Search or note writing does not execute

Web search defaults to off. It requires account opt-in, AI consent, permitted egress and usable BigModel credentials. Quota exhaustion starts a 30-minute credential cooldown in the current Worker, without global enforcement across replicas. The turn may continue but must disclose that online verification did not finish. Citations open sources without adding titles or URLs to spoken text.

Ordinary chat and sentence explanations do not automatically create or edit notes. Ask explicitly and check permission level: read-only blocks writes; guided permits qualifying reversible actions; the six learning actions still need proposal confirmation at full permission.

Editing synchronizes the draft, freezes cursor/selection and verifies version and original text. Affected paragraphs lock temporarily while others remain editable. Conflict, failure or cancellation clears the state. After a conflict, confirm the current version and selection before requesting another edit. The selection action “让伴星改这段” prepares an instruction; you still need to send it.

See [Companion experience](companion-experience.md) and [Desktop client](desktop-client.md).

## Speech is silent or recognition fails

Recognition and synthesis are separate. On-device SenseVoice recognizes input; API Qwen/Edge TTS synthesizes output. Check microphone permission, local model download and companion mute settings, then inspect the relevant service logs.

API in Compose uses `http://edge-tts:8080`; API running directly on the host uses `http://127.0.0.1:8088`. Both sides need the same `EDGE_TTS_AUTH_TOKEN`. Failed Qwen synthesis can fall back to Edge; governance denial or cancellation cannot trigger another external call. Engine, voice and model configuration are covered in Model pipeline.

Recognition models live under `<userData>/voice-models/`, overridden by `ASTELLA_VOICE_ASR_DIR`, and are not bundled in installers. Real microphones, speakers and listening quality need separate validation; source guards cannot establish audio quality.

## Fullscreen, zoom and motion

Fullscreen notes keep the same editor and working draft. Tool layers cover the body without shrinking paper width. Esc closes the top floating layer, then tools, then fullscreen. The companion's temporary fullscreen position does not overwrite persistent preferences.

Use ⌘/Ctrl with `+`, `-` and `0` to adjust/reset zoom. `src/shared/window-geometry.ts` defines the native size floor; a default-size screenshot cannot establish high-zoom acceptance. Motion modes are Full/Lite/Off, with system reduced motion taking precedence. Lite retains teaching interactions; Off/reduced motion retain manual controls and all information.

## Where is data stored? Does stopping containers delete it?

| Data | Location and boundary |
| --- | --- |
| Development database | external volume `astella-dev_dev_postgres_data`, retained by `make down` and Compose `down -v` |
| Local images, attachments and originals | MinIO object volume, without the PostgreSQL external-volume protection |
| Production objects | private remote S3-compatible bucket, backed up separately from the database |
| Local recognition models and artifact cache | corresponding directories in Electron `userData` |
| Session credentials | Written by the main process to a 0600 file under Electron `userData`; when the write fails nothing is stored and the sign-in lasts only for that session |

`make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB` permanently deletes the development database volume and restarts the stack. Explicit Docker administration can still delete volumes; this is not absolute deletion prevention. Database backups do not automatically include remote/MinIO objects. Check long-lived resources before migration.

## Why did type checking or tests miss a problem?

The desktop root tsconfig has only references; use the package's `npm run typecheck`. Install dependencies for all required packages and build desktop outputs before `make verify`.

Backend ordinary `npm test` discovers `*.test.ts`, excluding `*.integration.ts`. Real database tests use:

```bash
make disposable-db DISPOSABLE_DB=astella_it
make test-postgres COMPANION_HOME_TEST_DB=astella_it
```

The first command deletes an existing database with that name. Never target production. Remote S3, real models and real windows have separate entry points. `make verify` also excludes coverage and skip/todo gates. See [Testing and quality](testing-and-quality.md).

## How do I know a feature has passed acceptance?

Connected code, passing unit tests, database checks, real-model completion and smooth window interactions are distinct evidence. Context governance has database, model-comparison and selected-window records; “never verified” is outdated. Long-term effects, concurrent recovery, audio quality and cross-version updates remain subject to their specific records.

See the [current plans](../../plans/learning-companion/README.md), [Testing and quality](testing-and-quality.md), [Operations](operations.md) and [Deployment](deployment.md). MIT code licensing does not replace third-party model or asset authorization; see [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
