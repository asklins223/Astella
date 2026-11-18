# Operations and releases

[中文](../zh/operations.md) · English

Local development, server deployment and Alpha validation have different configuration. See [Development](development.md) for local setup and [Deployment](deployment.md) for HTTPS, SSH, server steps and remote objects. This page maps versions, backups and monitoring.

## Compose responsibilities

| Configuration | Purpose and data |
| --- | --- |
| `docker-compose.dev.yml` | Local `astella-dev`, hot reload, MinIO, development account and loopback ports; `make up` includes storage |
| `docker-compose.yml` | Production base: API, Worker, PostgreSQL, migrations and edge-tts; remote storage configuration, no local MinIO |
| `docker-compose.deploy.yml` | Production overlay: GHCR digest images, Nginx HTTPS, remote S3, admin socket and deployment configuration |
| `docker-compose.alpha.yml` | Alpha overlay: `astella-alpha`, local MinIO, monitoring and backup tools; not standalone |

Do not layer development over production. Alpha scripts combine the base and Alpha files; production does not load Alpha. Storage changes/backups must account for database references and object bytes.

Initialization runs **role-bootstrap → migrate → role-grants → API/Worker**. Applications depend on successful grants. `seed-owner` is explicit, rejects missing credentials/passwords under 12 characters, and production disallows demo seeding. Migrations/grants rerun idempotently at deployment.

## Configuration and boundaries

| Group | Variables and behavior |
| --- | --- |
| Database | `POSTGRES_PASSWORD`, role passwords, `DATABASE_URL_MIGRATOR`/`_API`/`_WORKER`; required in production, raw passwords must match URL-encoded values |
| Client | `DESKTOP_API_ORIGIN`, `ASTELLA_DOMAIN_SCHEMA_REVISION`, config revision; local_loopback also needs pairing id/secret, remote_https uses HTTPS trust |
| Models | Provider environment variables referenced by `config/ai-platforms.json`; keys stay server-side and new variables need explicit Compose forwarding |
| Governance | Account consent/egress policy plus separate, default-off web-search setting; production should not save mock text when providers are missing |
| Objects | `STORAGE_MODE`, endpoints, bucket, region and credentials; remote does not fall back to MinIO credentials, development stays local |
| Voice | Required shared `EDGE_TTS_AUTH_TOKEN`; Qwen and voice enhancements use configured flags |
| Admin | Separate panel token/path/log buffers; invalid or missing token leaves routes unregistered; deployment overlay can supply Docker socket |
| Execution | Handler/provider deadlines, concurrency and card budget, with renewable leases; see [Model pipeline](ai-and-companion.md#timeout-ladder) |

`.env.example` is a variable template, not production-ready configuration. Never commit real credentials or server environment files. An installer's HTTPS origin/revision are public connection settings; local pairing secrets do not belong in remote installers.

Production learning, card and voice defaults differ from development. Follow executable Compose environment and `verify-companion-capability-config.mjs`; an unforwarded `.env` value does not establish availability.

Deploy one API replica per database. Collaboration documents live in that process. A PostgreSQL leader lock rejects a second API process on the same database, and in-flight edits hold a shared lock through broadcasting during handover. Concurrent active replicas would require a shared document protocol and validation across database failovers.

## Retire legacy password hashes

New and explicitly changed or email-reset passwords use scrypt. Existing bcrypt
hashes cannot establish the full original password beyond 72 bytes. A matching
short candidate is not reliable proof of the original either, because bcrypt
can also match a longer NUL-containing input. The server therefore never
silently rewrites a legacy hash on password login.

The default `AUTH_LEGACY_PASSWORD_POLICY=allow` preserves existing access but
continues to accept bcrypt's legacy equivalences. To remove that exposure:

1. Use the deployment's Compose files and environment to count the affected
   accounts and their session rows. The command requires a migrator role with
   `BYPASSRLS` and reports aggregate counts.

   ```bash
   docker compose run --rm --no-deps migrate npm run db:legacy-password-sessions
   ```

2. Configure an outbound email provider and check its TLS and authentication
   with the deployed API environment. The command reports each provider and
   succeeds when at least one authenticates.

   ```bash
   docker compose run --rm --no-deps api npm run email:verify-smtp
   ```

   Complete an email password reset with a controlled test account to verify
   delivery and mailbox access separately. Arrange a support
   recovery process for users who cannot access their registered mailbox.
   Notify users that the existing “Forgot password” flow sets a new password.
3. Set `AUTH_LEGACY_PASSWORD_POLICY=require_reset` and restart the API. Startup
   rejects this mode when no email channel is configured. In this mode all
   bcrypt password logins fail with the normal generic login error; scrypt
   logins and email-code logins continue working. An already authenticated user
   may instead change the password in account settings. Password changes and
   email resets revoke that user's sessions.
4. After every API instance enforces the new policy and requests from the
   previous version have finished, revoke sessions that belong to accounts still
   using bcrypt. This also signs those users out of sessions created through
   email codes. They can sign in again through email recovery.

   ```bash
   docker compose run --rm --no-deps migrate npm run db:legacy-password-sessions -- --revoke
   ```

   Recount to track how many accounts still need a new password. Existing
   collaboration sockets observe database revocation on their next message or
   periodic session check.

Do not enable forced reset until a workable recovery route exists. Setting the
policy back to `allow` restores access for legacy accounts, but also restores
the legacy bcrypt risk; document and monitor any rollback.

## Unified versions and publication

`release/version.json` (server) and `apps/desktop-client/version.json` (desktop) each maintain `version` and `notes`. After a one-time root `npm ci`:

```bash
npm run release:prepare
npm run release:check
```

Prepare synchronizes API, Worker, shared and desktop package metadata/lockfiles and the Chinese README marker, and previews release notes. Maintain the English README version alongside it. Internal packages may keep internal versions.

Commit prepared changes and use an annotated `v<version>` tag. Passing server CI calls `server-deploy.yml` to build GHCR images and deploy by digest. The independent desktop release completes quality, packaging and updater-metadata checks.

| Platform | Local packaging | Automated installer publication |
| --- | --- | --- |
| macOS | `package:mac:arm64` / `package:mac:x64`, dmg + zip | Covered |
| Windows | `package:win:x64`, independent .NET / WPF installer | Covered |
| Linux | `package:linux:x64`, AppImage | Separate packaging; not in current unified release workflow |

Packaging uses `electron-builder.config.cjs` plus YAML. Assets use ASCII `astella-`; updates go directly to GitHub Releases and do not depend on API health. Public desktop tags require the repository Actions secrets `WIN_CSC_LINK`, `MAC_CSC_LINK`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_SPECIFIC_PASSWORD`. Set `WIN_CSC_KEY_PASSWORD` and `MAC_CSC_KEY_PASSWORD` when the certificate files are password protected. The workflow checks the built installers and macOS notarization before publishing. Verify cross-version installation on both platforms in a release rehearsal.

`make release-check` covers release inputs, verify, coverage and manifest checks; run skip/todo separately. Existing RC manifest tools do not automatically receive tag-deployment image digests. Placeholder fields are not evidence. See [Testing and quality](testing-and-quality.md).

## Alpha and backups

The Alpha Make targets invoke `scripts/alpha-env-setup.sh`. Initialization and freshness are direct commands:

```bash
./scripts/alpha-env-setup.sh init
./scripts/alpha-env-setup.sh freshness
```

Connecting/mutating operations require complete role URLs/passwords. Status/down can parse with inert placeholders; that does not establish valid credentials.

| Tool | Result |
| --- | --- |
| `backup.sh` | Database dump, SHA-256, age encryption, object upload and manifest |
| `restore.sh` | Target allowlist checks, decrypt and restore to isolation |
| `rc-restore-verify.sh` | Backup/restore, migration/data/role checks and a validation report |
| `rotate.sh` | Remove verified expired backups under retention rules; keep unverified ones |
| `freshness-check.sh` | Inspect the latest verified backup time |
| Alpha cron scripts | Manual scheduling installation; not configured by Compose or alpha-up |

Creating a backup differs from verifying a restore. Pure script tests do not perform either operation. A database dump does not include all long-lived S3 objects: back up objects and private recovery configuration too. Same-host pre-migration dumps do not replace off-host backups.

SOURCE_MIGRATION identifies the backup under validation. Without an override, scripts use the journal tail; an old template value is an example, not a reason to change a backup's identity.

## Volumes and database roles

The development PostgreSQL volume `astella-dev_dev_postgres_data` is external and survives Compose down/down -v. The explicit project reset is:

```bash
make reset-db CONFIRM_RESET_DB=DELETE_DEV_DB
```

It permanently deletes the development database and restarts. MinIO and ordinary production/Alpha named volumes do not share that protection. Use disposable databases for integration and verify names before execution.

`infra/postgres/roles.sql` grants ownership/DDL and BYPASSRLS to migrator. API/Worker have no DDL and use NOBYPASSRLS plus verified actor/workspace transactions. Migration GRANT statements do not replace post-migration grants.

### Workspace foreign keys after migration 0472

Migration 0472 enforces its five workspace foreign keys for new writes. If existing rows refer to missing workspaces, it preserves them and leaves the affected constraints `NOT VALID`. Check the actual deployment after migration, using the same Compose files and environment as the deployment:

```bash
docker compose run --rm --no-deps migrate npm run db:check-workspace-fks
```

The check requires the configured `DATABASE_URL_MIGRATOR` role to have `BYPASSRLS` (or be a superuser), so row-level security cannot hide orphans. It reports counts and validation state, without printing row contents. It exits nonzero when any constraint is missing, incorrectly defined, unvalidated, or has orphans. It never deletes rows. For each reported table, the data owner must inspect and reconcile its rows against a verified backup; for example, the following query identifies the affected workspace IDs for `companion_reflections`:

```sql
SELECT t.workspace_id, count(*) FROM public.companion_reflections t
LEFT JOIN public.workspaces w ON w.id = t.workspace_id
WHERE t.workspace_id IS NOT NULL AND w.id IS NULL
GROUP BY t.workspace_id;
```

Treat those IDs as sensitive and choose recovery for each table based on its data; do not delete them merely to make a check pass. After **all** reported orphans are reconciled, explicitly validate all remaining constraints in one transaction and repeat the read-only check:

```bash
docker compose run --rm --no-deps migrate npm run db:check-workspace-fks -- --validate
docker compose run --rm --no-deps migrate npm run db:check-workspace-fks
```

Validation scans existing tables and can wait on locks; schedule it according to table size and operational requirements. A concurrent database error rolls back the validation transaction. The tool cannot determine whether a business-specific recovery was correct, so verify restored records separately.

## Monitoring and admin

The deployment Nginx writes privacy-limited JSON access records to its container log for the API and standby object-store proxy. To summarize completed requests by bounded route group over the past hour, run with the same Compose files and environment used by the deployment, and the script from this checkout:

```bash
docker compose logs --no-log-prefix --since 1h nginx | python3 infra/deploy/traffic-summary.py
```

Pass the correct `-f` files or Compose project options for the installation. Records contain no raw path, query, user identifier, or token. `request_bytes` includes the request line, headers, and bytes received; `response_body_bytes` is the transmitted response body after compression; `response_bytes` also includes HTTP response headers, but neither includes TLS overhead. Streams and WebSockets appear only when their request closes, so this is not a live rate or complete account of open connections. Direct transfers to the external primary object store bypass this proxy; the `storage_backup` group covers the local standby proxy. Use host network counters for total ingress and egress, including model-provider and other traffic.

Nginx emits one record per completed request. Check the host's Docker logging driver and rotation settings with `docker inspect`; this Compose file does not set its own limits. `--since` cannot recover rotated logs. Ship the records to a collector if the retained window is too short for capacity analysis, and reserve disk space for the chosen retention.

The worker already exposes `astella_job_oldest_pending_age_seconds` and queue depth; API and worker default process metrics include resident memory. Alpha's Prometheus setup does not establish that production scrapes or retains these metrics. Restrict `/metrics` to trusted networks and configure collection and alert delivery before relying on them. For a peak over a test, take repeated RSS and network-counter samples throughout the run, not just before and after.

Alpha Prometheus scrapes API, Worker, backup sidecar and itself. Alertmanager currently sends webhooks only to sidecar logs, without paging/email receivers. Check rule metric producers: some provider-error/search-drift rules lack production metrics. Silence is not proof of health.

Metrics have no application authentication, so restrict reachability. Production Nginx does not expose `/metrics`. Development Worker healthchecks read `/metrics`; dependency checks live at `/ready`, so healthy containers do not prove database availability.

Admin tokens are separate from user sessions. Bounded in-process log buffers disappear on restart and are not durable audit records. The production base does not mount a socket; development and deployment overlays give API socket access equivalent to host management. Project-scope checks do not turn raw Docker socket access into a restricted credential. See [Deployment](deployment.md).

Other limits: no secret manager and no automatic scaling. Outbound verification mail goes through external personal mailbox accounts (QQ Mail, falling back to 2925) with credentials in `.env`/compose environment variables, so its quota is decided by the provider and registration and password recovery depend on it being reachable. Operators configure backup schedules and alert receivers; image/secret scans and migration-lifecycle tests require explicit execution/wiring. Failed deployment may restart previous application images, but database migrations do not automatically roll back.

[Guide index](../README.md) · [Deployment](deployment.md) · [API and data](api-and-data.md) · [Troubleshooting](faq-and-troubleshooting.md)
