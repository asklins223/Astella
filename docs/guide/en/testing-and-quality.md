# Testing and quality

[中文](../zh/testing-and-quality.md) · English

Choose typechecks, unit tests, database integration, real models and window checks for the change. They establish different things: contracts, database permissions, model behavior and continuous interaction. This guide follows executable Makefile/package/workflow content; older comments can describe obsolete gates.

## Test entries

| Package | Typecheck | Ordinary tests |
| --- | --- | --- |
| shared, agent-core, agent-host, ai-quality | Package `npm run typecheck` | Node test runner through tsx |
| apps/api, workers/ai-worker | Package `npm run typecheck` | Discover `*.test.ts` under src |
| desktop-client | Node and renderer tsconfigs separately | Vitest, jsdom declared per DOM test |
| card-generation | Package `npm run typecheck` | No independent test script; host-path tests cover its use |

Each package has a lockfile. Referenced `file:` packages still need their own dependencies. API/Worker typechecks include some source from the other package, so installing only one is insufficient. From the repository root:

```bash
npm ci
for dir in packages/shared packages/card-generation packages/agent-core packages/agent-host packages/ai-quality apps/api workers/ai-worker apps/desktop-client; do
  (cd "$dir" && npm ci) || exit 1
done
make desktop-client-build
make verify
```

Build first because desktop asset-containment tests read `out/`. `make verify` neither installs dependencies nor builds desktop output first. The references-only root tsconfig does not replace the package typecheck. agent-core's shell glob differs from the find rules in other packages; verify discovery when adding deeper tests.

## What `make verify` covers

The local baseline includes:

1. Product-version consistency.
2. Repository contracts for version, release manifest, coverage-tool logic, CI wiring, integration-connection lifecycle and init ordering.
3. Schema-directory and companion configuration validation.
4. Pure backup-script tests in `infra/backup/backup-scripts.test.sh`.
5. Typechecks/tests for shared, agent-core, agent-host, ai-quality, API, desktop and Worker; ai-quality adds a fixed-Mock `pr-gate`.

It excludes coverage, skip/todo, real PostgreSQL, real models, external S3, image scanning and complete window walkthroughs. card-generation is not independently included; check it explicitly when needed. Passing source guards does not establish good design or interaction.

## Real PostgreSQL and S3

`*.integration.ts` does not match ordinary backend tests. Explicit `test:*:postgres` scripts run them. `make test-postgres` discovers scripts dynamically from API/Worker package.json, supplies dedicated connection variables and stops on failure.

Use a disposable database to avoid changing real content or inheriting fixture debris:

```bash
make disposable-db DISPOSABLE_DB=astella_it
make test-postgres COMPANION_HOME_TEST_DB=astella_it
```

The helper accepts `astella_*` names except `astella`, but deletes an existing database with the same name. Migrator/admin connections manage structure/fixtures; business assertions use NOBYPASSRLS `astella_api`/`astella_worker`. Superuser tests do not prove tenant isolation. Passwords and dedicated variables follow the Makefile and suite requirements.

Narrower entries include `make test-companion-home-profile-postgres` and `make test-companion-integration-postgres`. Register new integration files in package scripts; file existence does not imply automatic execution.

`npm --prefix apps/api run test:object-storage:s3` is separate from `make test-postgres` and needs an isolated database, remote credentials and cleanup scope. See [Server deployment](deployment.md).

## What guards check

| Guard or area | Contract |
| --- | --- |
| IPC coverage and single-source guards | Channel definitions, handlers/events and common names |
| Renderer style closure/dead/order and CSS variables | Class wiring, dead-style ledger, single CSS entry and resolvable variables |
| `component-size-guard` | Source HARD/SOFT thresholds and SIZE_DEBT; not a universal extraction rule from AGENTS |
| Page registration, HTML sinks, answering and output | Page identities, content injection and business boundaries |
| API layer/error/cursor/doc-pointer guards | Dependencies, error envelopes, cursor clocks and reachable documentation |
| `ci-workflow-contract.test.mjs` | Package and backup-script baseline wiring between local checks and CI |
| `schema-isolation-gate-postgres.integration.ts` | Real database foreign-key debt and RLS ratchets; requires database execution |

Desktop filesystem guards live in `src/main/__tests__/`; functional renderer tests stay near their domain. Test source owns thresholds and debt sets. The guide does not duplicate changing file/test totals.

## Coverage, skips and release checks

| Command | Scope |
| --- | --- |
| `make coverage-gate` | c8 for shared, ai-quality, API and Worker, enforcing script thresholds; not every package |
| `make skip-todo-gate` | Separate skip/todo checks with an expiring allowlist for those packages |
| `make release-check` | Inputs → verify → coverage → manifest generation/contract; excludes the skip/todo gate |
| `make release-manifest` | Generate a machine-readable manifest; missing evidence or placeholder digests are not acceptance |

`--report-only` does not block and is not the enforcing coverage gate. On an exact release tag, manifest validation requires a valid `RELEASE_MANIFEST_PATH` artifact. Producing a manifest does not fill in missing evidence.

## CI and releases

| Workflow | Purpose |
| --- | --- |
| `main-ci.yml` | main, PR, v* tags and manual runs; package matrix, API, Worker, desktop (build first), backup-script tests |
| `server-deploy.yml` | Reused after tag CI passes; deployment-script checks, GHCR production images, digests and SSH deployment |
| `desktop-client.yml` | Desktop quality and packaged smoke, called by release/manual runs |
| `desktop-package.yml` | Windows/macOS installers; can supply test packages separately |
| `desktop-release.yml` | Publish after version, packaging, quality and updater-metadata checks |

Ordinary CI does not start PostgreSQL or make paid model requests. Tag deployment does build real production images, so “CI never builds images” is outdated. Coverage, skip/todo, secret/image scans and restore drills are not automatically part of these baselines.

Old scripts/matrices still mention `VITE_HOME_SCENE_VARIANT`, but current source does not read it. Matrix labels do not prove different home scenes were exercised. Follow executable wiring rather than comments or file existence.

## Real models and windows

Enable real-model probes explicitly and configure the test actor, permissions and budget. Current entries are in `workers/ai-worker/src/live-tests/README.md`; old probes and fixed Mocks do not accept the current model. Calls may incur cost. Separate business completion, factual correctness, naturalness and latency in reports.

Use the actual build and long content. Check read/edit/source, full-screen/booklet, fast reversal, cancel/failure, focus/Esc, zoom, companion placement and Full/Lite/Off/system reduced motion. From the desktop package, attach to a running development window with:

```bash
ASTELLA_CAPTURE_CDP=http://127.0.0.1:9222 node scripts/capture-pages-v3.mjs
```

Some capture scripts launch another instance without CDP; distinguish it from the user's window. Packaged builds use `package:smoke`/`package:evidence`. Fixture manifests validate format rather than actual operation.

Keep implementation/debug records near tests, `docs/testing/` or live-tests. Establish existing failures before broad regression, fix newly introduced failures and report executed scope and unverified items. Accumulated test counts do not substitute for conclusions.

[Guide index](../README.md) · [Development](development.md) · [Operations](operations.md) · [Server deployment](deployment.md)
