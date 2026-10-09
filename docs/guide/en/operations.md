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

## Unified versions and publication

`release/version.json` maintains `version` and a nonempty `notes` array. After a one-time root `npm ci`:

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

Packaging uses `electron-builder.config.cjs` plus YAML. Assets use ASCII `astella-`; updates go directly to GitHub Releases and do not depend on API health. Without an Apple certificate, ad-hoc signing may require first-launch authorization. Valid signatures do not accept actual cross-version replacement.

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

## Monitoring and admin

Alpha Prometheus scrapes API, Worker, backup sidecar and itself. Alertmanager currently sends webhooks only to sidecar logs, without paging/email receivers. Check rule metric producers: some provider-error/search-drift rules lack production metrics. Silence is not proof of health.

Metrics have no application authentication, so restrict reachability. Production Nginx does not expose `/metrics`. Development Worker healthchecks read `/metrics`; dependency checks live at `/ready`, so healthy containers do not prove database availability.

Admin tokens are separate from user sessions. Bounded in-process log buffers disappear on restart and are not durable audit records. The production base does not mount a socket; development and deployment overlays give API socket access equivalent to host management. Project-scope checks do not turn raw Docker socket access into a restricted credential. See [Deployment](deployment.md).

Other limits: no secret manager, automatic scaling or email password recovery. Operators configure backup schedules and alert receivers; image/secret scans and migration-lifecycle tests require explicit execution/wiring. Failed deployment may restart previous application images, but database migrations do not automatically roll back.

[Guide index](../README.md) · [Deployment](deployment.md) · [API and data](api-and-data.md) · [Troubleshooting](faq-and-troubleshooting.md)
