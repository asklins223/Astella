# Tag releases and server deployment

[中文](../zh/deployment.md) · English

A unified `v<version>` tag triggers desktop release and server deployment. `release/version.json` is the version authority. Before tagging, run `npm run release:prepare` to synchronize copies and preview release notes, then `npm run version:check`.

Desktop release builds Windows x64 and macOS installers, checks desktop quality and packaged startup, and publishes the GitHub Release only after successful jobs and update-manifest validation. A manual Desktop package run also produces test installers. Without an Apple certificate, macOS uses complete ad-hoc signing and a stable cross-version designated requirement; first launch may still require approval in Privacy & Security. Windows overwrite installation is not established by a headless-runner build.

After its test jobs pass, CI calls Server deploy to build Linux amd64 API, Worker and TTS images, push them to GHCR and record immutable digests. SSH deploys the exact tagged commit. Deployment is serialized to avoid interrupting migrations. Re-running that tag's CI can redeploy it.

## Private configuration

The GitHub `production` Environment admits `v*` tags and holds `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`. SSH verifies the pre-registered host key. Its authorized key is restricted to the forced command `deploy <40-character commit SHA>`, without interactive shell, port forwarding or SCP. The deployment receiver and scripts are installed under `/usr/local/lib/astella` and updated by the server administrator.

Application environment values stay in `/etc/astella/production.env` with mode `600`. Real API keys belong outside GitHub, images, artifacts and installers. A deployment-job GitHub Token pulls GHCR images through a temporary Docker login directory removed on exit. Repository scripts contain variable names and generic logic; avoid `set -x` and printing expanded Compose configuration.

Repository Secrets `DESKTOP_API_ORIGIN` and `ASTELLA_DOMAIN_SCHEMA_REVISION` supply installers' public connection configuration: an HTTPS address, domain revision and configuration version. The client must know its server address, which is observable in the installer and network traffic. API keys, database passwords and SSH private keys remain private. HTTPS IP addresses are supported without disabling certificate verification.

## Single-server deployment lifecycle

Production combines `docker-compose.yml` and `docker-compose.deploy.yml` under the fixed Compose project `astella`, retaining its PostgreSQL volume. Objects use private remote S3-compatible storage; production has no MinIO service or volume. Local development and Alpha use their own MinIO. Database and Worker metrics stay on internal networking or loopback. Nginx exposes 443; port 80 serves ACME challenges. External `/metrics` returns 404. SSE and WebSocket proxying retain Secure authentication cookies.

Each deployment pulls images, validates configuration and base services, and saves a pre-migration database dump under `/opt/astella/backups`. API and Worker stop gracefully before role bootstrap, migrations and grants. The deployment then checks API, Worker, Nginx and public HTTPS readiness before updating `/opt/astella/current`. Failure attempts to restart the previous application images. Database migrations are not automatically reversed: migration compatibility determines whether a restore is needed. Same-server dumps are not off-server backups; losing the server or disk can lose both data and dumps.

After the first deployment, explicitly run `seed-owner` with the private server environment. Do not create a demo account or print passwords/environment files during deployment or troubleshooting.

The production admin panel accesses Docker through `/var/run/docker.sock`, mounted into API by `docker-compose.deploy.yml` with `ADMIN_DOCKER_SOCKET`. Store the socket's group ID from `stat -c '%g' /var/run/docker.sock` as `ADMIN_DOCKER_GID` in the server environment (default `0`). API continues as user `node` through the supplemental group. Recreate API to apply it, then reload Nginx to refresh the API container address.

The panel reads this Compose project's container state, logs, CPU and memory, and can start, stop or restart services. All endpoints require an admin token and targets must belong to API's Compose project. Raw Docker socket access grants host administration powers: mount it only into API, avoid a Docker TCP endpoint and keep panel tokens private. The panel's project checks do not turn the raw socket into a restricted Docker credential.

IP certificates use Certbot's shortlived profile, with roughly six-day validity. Install `infra/deploy/renew-certificate.sh` on the server and run it every eight hours with Nginx reload. Verify renewal using `certbot renew --dry-run`; cloud firewall rules must admit ports 80 and 443.

Use a supported Linux distribution and Docker Engine for long-term operation. Old hosts used during migration validation do not become supported merely because the application migrated successfully.

When changing servers, prepare the runtime and HTTPS first. Gracefully stop writes from the old API/Worker, save a final dump and restricted environment file, and verify access to the remote object bucket. After restore, compare table counts and test login, workspace access and object upload/download. Then change GitHub `production` host, port, deployment key and host key. Remote objects need no MinIO/container-volume migration; application images follow the CI-selected digests.

Installers contain the public API address. Update `DESKTOP_API_ORIGIN` and rebuild for the new server. During transition, a certificate-validating HTTPS proxy at the old address can forward to the new server. Keep the old Worker stopped to avoid two independent task processors. Retire the old host after clients move to new packages.

## Remote object storage and local isolation

`docker-compose.deploy.yml` explicitly selects `STORAGE_MODE=remote`. API and Worker share the remote configuration, without starting MinIO or falling back to local credentials. Put values only in `/etc/astella/production.env`, never in the repository or client:

```dotenv
STORAGE_MODE=remote
STORAGE_ENDPOINT=https://s3.example.com
STORAGE_PUBLIC_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=astella
STORAGE_ACCESS_KEY_ID=<server-access-key>
STORAGE_SECRET_ACCESS_KEY=<server-secret-key>
```

Replace the example endpoints and region with the provider's actual values. Keep the bucket private and expire the `temporary/` prefix after one day. Long-lived resources use workspace/user prefixes; exports and unfinished uploads use `temporary/`. Provider changes require updating both endpoints and the client-accessible HTTPS origin. Credentials can be scoped to the bucket's read, write, copy, delete and list operations; lifecycle administration may use separate credentials.

New desktop clients obtain the mode and allowed origins from `/storage/transfers/config`, request short-lived signed PUT URLs and finalize after upload. API validates text/images and copies them into final objects that an old PUT cannot overwrite. Downloads and exports check session/resource access before issuing short-lived signed GET URLs. Object requests carry no API token or Cookie. API-proxied uploads/downloads remain available but consume server bandwidth; direct transfers require an updated client.

Worker reads remote source originals and verifies SHA-256 before text parsing. Workspace JSON exports include source originals. Export objects are capped at 256 MiB; uploads retain per-resource limits. Database, object storage and downloaded local copies have separate duties. Backups must cover both database and long-lived objects.

Local `docker-compose.dev.yml` fixes `STORAGE_MODE=local` and `http://minio:9000`. local_loopback clients retain the existing local upload path. Alpha's MinIO service and local application storage configuration belong to `docker-compose.alpha.yml`, which production does not load. Do not overwrite local `.env` with production remote settings.

For a MinIO-to-remote migration, move long-lived objects and compare counts/content plus upload/download behavior before checking old-bucket resources. Only clean up old services, volumes, images and variables after validating backups, switching and rollback. The repository's remote deployment configuration cannot establish that a particular server has completed migration or cleanup.

The remote storage integration test runs independently:

```bash
npm --prefix apps/api run test:object-storage:s3
```

It is outside `make test-postgres`. Prepare a migrated, fully granted disposable `astella_storage_it_*` database. Supply restricted-role `DATABASE_URL_API` and `DATABASE_URL_WORKER`, administrator `DATABASE_URL_TEST_ADMIN`, and remote storage configuration through a private environment. The test creates synthetic content and cleans its object prefixes; delete the temporary database afterward. Never use production databases or commit the environment file.

## macOS builds without a certificate

Packaging uses `electron-builder.config.cjs` and signs before ZIP/DMG creation. With Developer ID, retain certificate signing. Otherwise electron-builder signs the complete nested bundle, then fixes the main application's designated requirement to `identifier "com.asklins.astella"`.

`scripts/check-macos-update-signature.cjs` checks cross-version requirements with two different real binaries and rejects a tampered signed resource. The applications inside final ZIP and DMG assets must both pass signature checks.

Signature integrity, cross-version requirements and first-launch permission are separate checks. Ad-hoc signing provides no Apple developer authentication and cannot eliminate first-launch confirmation. Workflow fixes do not alter already published assets. A damaged older package may require manual installation of a repaired package. Record real update replacement independently; passing `codesign` alone does not prove it.

## Related documents

- [Operations](operations.md): Compose choices, version preparation, backups and monitoring.
- [Testing and quality](testing-and-quality.md): release gates, database and window evidence.
- [Development](development.md): local pairing and the MinIO development stack.
