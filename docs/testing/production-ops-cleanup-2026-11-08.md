# Production deployment and build-identity cleanup — 2026-11-08

The production audit found three outstanding operations issues: the installed deployment helper lacked the current pruning protections, the host environment still contained two retired companion settings, and API/Worker had no build identity. The administrator-approved cleanup completed at **16:51:50 Asia/Shanghai**. Public and authenticated checks passed at **16:53:24**.

## Applied changes

- Installed the release's current `infra/deploy/deploy.sh` as root-owned `/usr/local/lib/astella/deploy.sh`, mode `0755`. Both SHA-256 values are `0a4981cfecd307004356e73e45547859dfd97601e36d0ec1d35e5b1e840538fc`. The installed receiver and extractor already matched and needed no replacement.
- Removed only `COMPANION_RELEASE_ROUTER` and `COMPANION_TOOL_INTENT_HEDGE_MS` from `/etc/astella/production.env`, retaining its root ownership and `0600` mode.
- Added `APP_VERSION=2.0.25` and `GIT_COMMIT=7d9454b5a29aa745dcf1a4cdf5d1936daf43bba8` to the release's public deployment environment. The production overlay injects both into API and Worker. The authenticated overview now reports `2.0.25` and the actual source commit rather than `dev`.
- Updated the repository deployment workflow to generate this identity alongside immutable image digests for future releases. A regression executes the actual CI writer and resolves the full production Compose configuration to verify that both containers receive the corresponding version, commit and image. Both deployment Node tests now run in the release workflow alongside extraction tests and shellcheck.

The running application remains `s-v2.0.25`. No published tag was moved and no application image was rebuilt. The original running image IDs were compared with their replacements and are identical; complete API/Worker container environments differ only by the two added identity fields. The model configuration still hashes to `0b39c2cb30a46aebcc434aca6f72c6ef403751e12b3b56f616846718417876af` on the host and in both processes. The 60-second silence policy, Tavily selection, provider credentials and companion flags are preserved.

## Application and rollback

The previous release directory was preserved. A separate release directory uses the same commit and the hash of its new deployment environment:

```text
/opt/astella/releases/7d9454b5a29aa745dcf1a4cdf5d1936daf43bba8-4b608c341117
```

Before applying, full old/new Compose resolutions were compared after removing the two identity additions and normalizing release paths. They were otherwise identical. The operation held the existing deployment lock, backed up the host environment and installed helper, recreated Worker and then API/Nginx with the existing images, and switched `current` only after readiness checks. The operation had an automatic rollback branch for failures; it was not exercised because application succeeded. No database migration or data cleanup ran. The baseline job table contained no pending or running jobs.

Root-only rollback materials remain at `/opt/astella/ops-backups/20261108T084924Z-release-metadata`; the containing directory is `0700`, and the saved environment is `0600`. Credentials were not copied to the repository or evidence.

## Verification

| Check | Result |
| --- | --- |
| Existing deployment-test baseline | 2 bundle tests and 2 retention tests passed |
| Updated deployment checks | 3 Node tests and 2 bundle tests passed |
| Shell checks | `shellcheck infra/deploy/*.sh` and `bash -n` passed |
| Repository contracts | Server version and companion capability configuration checks passed |
| Production configuration | Compose validation and Nginx configuration test passed |
| Actual process identity | API and Worker `/proc/1/environ` contain `2.0.25` and `7d9454b5a29aa745dcf1a4cdf5d1936daf43bba8` |
| Host cleanup | Installed helper matches the release; both retired settings are absent |
| Public endpoints | `/health`, `/ready` and `/app/server-version` return 200 |
| Authenticated overview | Version and commit match the running release |
| Provider configuration | All seven routes resolve; no validation issue or unresolved environment reference |
| Container health | All seven long-running services healthy, zero restarts |

This was an operations and deployment-configuration change. No application TypeScript changed, so package type checks and complete application suites were not repeated. No new conversation or voice acceptance run was generated. Sanitized receipts are in [verification.json](evidence/production-ops-cleanup-2026-11-08/verification.json).
