# Testing and quality

[中文](../zh/testing-and-quality.md) · English

What this page covers: the verification chain as it actually stands — which runner each package uses, exactly what `make verify` executes, where unit tests stop and real-database integration tests begin, which invariant each source guard protects, what CI does and does not run, and the known mismatches between the documentation and the code. Every command, path, job name, threshold and count below was read out of the `Makefile`, `.github/**`, each package's `package.json` and the compose files while writing this page.

- [Test topology: how each package runs](#test-topology-how-each-package-runs)
- [One command: `make verify`](#one-command-make-verify)
- [Per-package commands from a clean checkout](#per-package-commands-from-a-clean-checkout)
- [Where unit tests end and real-database tests begin](#where-unit-tests-end-and-real-database-tests-begin)
- [Source guards and contract tests](#source-guards-and-contract-tests)
- [The two gates that only run for releases](#the-two-gates-that-only-run-for-releases)
- [What CI actually runs](#what-ci-actually-runs)
- [Known mismatches between docs and code](#known-mismatches-between-docs-and-code)
- [Real-window QA](#real-window-qa)
- [Adding a test in this repository](#adding-a-test-in-this-repository)
- [What this page does not cover](#what-this-page-does-not-cover)

## Test topology: how each package runs

The backend and the shared packages all use Node's built-in `node:test`, executed through `tsx` directly against TypeScript. The desktop client uses vitest. Each package keeps its own lockfile and is installed separately with `npm ci`.

| Package | Runner | Test discovery | Concurrency | Unit files |
| --- | --- | --- | --- | --- |
| `apps/api` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=8` | 281 |
| `workers/ai-worker` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=8` | 127 |
| `packages/shared` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=1` | 103 |
| `packages/agent-host` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | `--test-concurrency=1` | 4 |
| `packages/agent-core` | `node --import tsx --test` | `src/**/__tests__/*.test.ts` (shell glob) | default | 14 |
| `packages/ai-quality` | `node --import tsx --test` | `find src -name '*.test.ts' \| sort` | default | 9 |
| `packages/card-generation` | no `test` script | — | — | 0 |
| `apps/desktop-client` | `vitest run --passWithNoTests` | vitest default include | vitest parallel | 356 |

Three things deserve to be called out:

- `packages/agent-core` is the only package that does not use `find`. Its glob expands to `src/<one-level>/__tests__/*.test.ts`. All 14 of its files currently sit at exactly that depth, so they all run; move a test one level deeper and it is **silently skipped**.
- `packages/card-generation` has a `typecheck` script and nothing else — **no `test` script and no test files**. Its types stay correct only indirectly: 15 source files in `apps/api`, `packages/agent-host` and `workers/ai-worker` import it, so those packages' typecheck programs follow its sources. It is not in the `make verify` package list and not a tested directory in CI.
- Of the desktop client's 356 files, 350 live under `src/` (172 `.test.ts` plus 178 `.test.tsx`); the remaining 6 are outside `src/`: `scripts/split-chat-routing-probe.test.ts`, `scripts/runtime-asset-containment.test.mjs`, `scripts/validate-room-layers.test.mjs` and three files in `demos/__tests__/`. vitest's default include also matches `.test.mjs`, so all six are in `npm test`'s denominator — and `runtime-asset-containment.test.mjs` measures build output under `out/`, so **there is nothing to measure unless the build ran first** (which is why the CI desktop job builds before testing; see below).

The desktop config does not set a global `environment`; each test file declares its own in a leading docblock. Under `src/`, 197 files say `// @vitest-environment jsdom`, 2 say `node`, and the rest fall back to vitest's default node environment. `apps/desktop-client/vitest.config.ts` does two things — it raises `testTimeout` and `hookTimeout` to 15,000 ms and registers `./vitest.setup.ts`. That setup file raises Testing Library's `asyncUtilTimeout` from the default 1000 ms to 5000 ms (`testTimeout` cannot reach it) and fills in the browser semantics jsdom lacks for `HTMLMediaElement.play()/load()` and `Range.getClientRects()`. The reason is written in the config comment: under full parallelism a loaded machine produces **passes in isolation and timeouts in the whole run**.

## One command: `make verify`

`make verify` is the local baseline and also the CI contract. It depends on `version-check` and then runs, line by line from `Makefile:144`:

```bash
node .github/scripts/version-contract.mjs --check           # prerequisite: version contract
node --test \
  .github/scripts/version-contract.test.mjs \
  .github/scripts/release-manifest-contract.test.mjs \
  .github/scripts/coverage-gate-lib.test.mjs \
  .github/scripts/ci-workflow-contract.test.mjs \
  .github/scripts/postgres-integration-lifecycle.test.mjs   # 5 repository-level contract tests
node .github/scripts/verify-schema-mirror.mjs               # 2 verify-* gates
node .github/scripts/verify-companion-capability-config.mjs
cd packages/shared     && npm run typecheck && npm test
cd packages/agent-core && npm run typecheck && npm test
cd packages/agent-host && npm run typecheck && npm test
cd packages/ai-quality && npm run typecheck && npm test && npm run pr-gate
cd apps/api            && npm run typecheck && npm test
cd apps/desktop-client && npm run typecheck && npm test
cd workers/ai-worker   && npm run typecheck && npm test
```

Notes:

- `verify` **does not install dependencies**; it assumes `npm ci` has already run in each package.
- `packages/ai-quality` runs one extra step, `pr-gate`: the AI quality layer's PR gate on fixed stubs and a fixed dataset. It makes no paid network calls.
- `packages/card-generation` is not in this chain.
- The version contract covers three package roots (`apps/api`, `workers/ai-worker`, `packages/shared`), with `release/version.json` as the single source.

## Per-package commands from a clean checkout

`../../../README.md` gives this cold-start order, shared package first:

```bash
(cd packages/shared && npm ci && npm run typecheck && npm test)
(cd apps/api && npm ci && npm run typecheck && npm test)
(cd workers/ai-worker && npm ci && npm run typecheck && npm test)
(cd apps/desktop-client && npm ci && npm run typecheck && npm test)
```

Cross-package dependencies use `file:` links, and `tsc` reads **the imported package's own** `node_modules` when resolving its transitive imports, so npm workspace hoisting does not help here. Every CI job therefore lists the packages its program really pulls in and runs `npm ci` in each. The `apps/api` and `workers/ai-worker` typecheck programs are interlocked: files in `workers/ai-worker/src/integration-tests/` import `apps/api/src/...` by relative path, and omitting the other side produces TS2307 errors.

On the desktop client, `npm run typecheck` is two `tsc --noEmit -p` invocations (`tsconfig.node.json` and `tsconfig.web.json`, both with `--composite false`). The root `tsconfig.json` only holds `references`, so running plain `tsc --noEmit` there may check nothing at all.

## Where unit tests end and real-database tests begin

> **Note:** `npm test` never picks up `*.integration.ts` — the backend discovery rule is `find src -name '*.test.ts'`, and the two naming schemes do not overlap (measured: 0 `.test.ts` files under `src/integration-tests/`). Everything `make verify` and CI run is therefore **database-free**. Real-database suites need their own command and a clean throwaway database.

Files on disk: 119 under `apps/api/src/integration-tests/` and 37 under `workers/ai-worker/src/integration-tests/`, **156** in total. They are referenced by **55** `test:*:postgres` scripts (40 in `apps/api`, 15 in `workers/ai-worker`), which together cover **154** distinct files. Two files are referenced by nothing: `apps/api/src/integration-tests/note-collaboration-postgres.integration.ts` and `workers/ai-worker/src/integration-tests/queue-postgres.integration.ts`. There are no dangling references in the other direction — all 154 named files exist, and `ci-test-file-references.test.ts` keeps that true.

`make test-postgres` is the single entry point. For each of `apps/api` and `workers/ai-worker` it uses a one-line `node -e` to **auto-discover** every script whose name starts with `test:` and ends with `:postgres`, runs each with `npm run --silent`, and aborts on the first non-zero exit. While running, it injects these variables (values assembled from the Makefile's `IT_*` variables, which default to the `COMPANION_HOME_TEST_*` set: host `127.0.0.1`, port `5432`, database `ailearn`):

| Variable | Role it points at |
| --- | --- |
| `DATABASE_URL` | `ailearn` (superuser, fixtures and teardown only) |
| `DATABASE_URL_MIGRATOR` | `ailearn_migrator` |
| `DATABASE_URL_API` / `DATABASE_URL_API_RLS` / `RATE_LIMIT_TEST_DATABASE_URL` | `ailearn_api` (`NOBYPASSRLS`) |
| `DATABASE_URL_WORKER` / `QUEUE_TEST_WORKER_A_DATABASE_URL` / `QUEUE_TEST_WORKER_B_DATABASE_URL` | `ailearn_worker` |
| `DATABASE_URL_TEST_ADMIN` / `CONTENT_HASH_TEST_DATABASE_URL` / `SEC02_TEST_DATABASE_URL` / `NOTE_VERSION_RESTORE_TEST_DATABASE_URL` | `ailearn` |
| `RLS_TEST_MIGRATOR_DATABASE_URL` / `RLS_TEST_API_DATABASE_URL` / `RLS_TEST_WORKER_DATABASE_URL` | the same three roles as above |
| `QUEUE_TEST_MIGRATOR_DATABASE_URL` | `ailearn_migrator` |

The restricted roles are **not optional**: a superuser has `BYPASSRLS`, so isolation assertions either fail or pass falsely. Each suite reads its own dedicated variables (RLS, queue, content hash, SEC-02 invites, version restore, rate limiting) and a missing one produces `throw new Error('… is required')` — an explicit refusal, not a silent skip, so the whole file goes red before a single case runs.

These suites cannot run against the shared development database, because their assertions assume "the only rows here are my fixtures" (the RLS policy catalogue, worker queue claims, projection pagination). Residual rows cause false failures. The supporting tools:

| Command / script | Purpose |
| --- | --- |
| `make disposable-db DISPOSABLE_DB=<name>` | Recreate a throwaway database inside the running dev postgres |
| `bash scripts/dev-disposable-db.sh <name>` | The same thing; the Makefile target just calls it |
| `scripts/psql-lite.mjs` | A minimal `psql` stand-in so the disposable-database script also works on machines without the docker CLI |
| `scripts/with-restricted-db-urls.py <package-dir> <command…>` | Swap `DATABASE_URL_API` / `DATABASE_URL_WORKER` for the restricted roles, then run the command |

The name guard on a disposable database: the target must match `ailearn_*` and must **not** be `ailearn`, otherwise the script refuses to run. `dev-disposable-db.sh` prints the integration-test environment variables ready to copy.

Two narrower targets each run one script, which helps when reproducing a single suite:

- `make test-companion-home-profile-postgres` → `apps/api`'s `test:companion-home-profile:postgres`.
- `make test-companion-integration-postgres` → `apps/api`'s `test:companion-integration:postgres` (the 31-file companion integration matrix).

Typical usage:

```bash
bash scripts/dev-disposable-db.sh ailearn_it
make test-postgres COMPANION_HOME_TEST_DB=ailearn_it
```

## Source guards and contract tests

The project's distinctive mechanism is **tests that read their own source**: the subject is files, directories, import graphs and string shapes rather than runtime behaviour. They run under `npm test`, so they are part of `make verify` and part of CI. The tables state the invariant each one actually enforces (the name is the file name; all live in `__tests__/`).

### Desktop (`apps/desktop-client/src/main/__tests__/`)

These files live on the main side because they need `node:fs`; `tsconfig.web.json`'s program has no Node types.

| Guard | Invariant it protects |
| --- | --- |
| `component-size-guard.test.ts` | Turns `AGENTS.md`'s "a function over 400 lines or 25 hooks is a signal" into hard criteria: file > 2000 lines, function > 1200 lines, hook > 50 are fatal with no exemptions; anything between the soft lines (1200 / 600 / 25) must be registered in `SIZE_DEBT` with a note on what gets split next; the ledger **may only shrink**. |
| `renderer-style-closure-guard.test.ts` | "A class is emitted but nobody receives it": every class name emitted by renderer TSX must have a rule in the stylesheets, otherwise the page renders with no paper, no edge, no breathing room. |
| `renderer-style-dead-guard.test.ts` | The opposite — dead CSS that is "received but never emitted". The actual dead set must equal `KNOWN_DEAD` exactly, each entry carrying a reason it still sits on disk; any newly grown dead style turns red immediately. |
| `renderer-style-order-guard.test.ts` | Stylesheets enter from exactly one place, `styles.ts`: every CSS file on disk is in the list, component modules may no longer `import` CSS, and cross-layer order matches the layering rationale at the top of the list. |
| `css-var-resolution-guard.test.ts` | Every `var(--x)` must be declared somewhere, carry a fallback, or be injected from JS; if none holds, the whole declaration is invalid at computed-value time (shadows and borders silently disappear). |
| `hud-substrate-guard.test.ts` | The HUD substrate may not regress into literals or a second source of truth: the bare single-class declarations removed by structural deduplication must not be copied back, and `var(--hud-*)` references must not be rewritten as hex. Each criterion carries a deliberately violating synthetic CSS as a positive control. |
| `desktop-ipc-channel-coverage.test.ts` | IPC channel **set equality**: every channel declared in the contract must either have an `ipcMain.handle` in the main process or appear in the explicitly justified outbound/event list — and the list itself is asserted to be bound that way, so it cannot rot into a catch-all exemption. |
| `ipc-channel-single-source-guard.test.ts` | Channel names must not be written as literals twice, once in main and once in preload. Apart from the two constants in `shared/window-state.ts`, everything goes through `DESKTOP_IPC_CHANNELS`. |
| `page-readable-registration.test.ts` | Reconciles every `useHudPage(…)` call site against the `pageId`s that file emits (both literal and variable shapes are recognised). The difference goes into `NOT_REGISTERED_WITH_REASON` (a judgement made after reading the code) or `PENDING_W2_7` (unfinished work, may only shrink). |
| `graph-surface-shape-guard.test.ts` | The control-flow shape of the graph component: `edge.decidable ?` must not become always-true, and the optimistic update must happen before the `await`. It searches the file name through the directory tree, so moving the component no longer breaks it. |
| `startup-failure-guard.test.ts` | A startup failure must be a visible failure: the callback's error is caught, the exit code is non-zero, and the message is written to userData so a user can report it. |
| `home-feature-wiring-guard.test.ts` | Home feature "wired" status is reconciled against real handlers in both directions: anything marked native must have a branch, and anything with a branch must not still be marked pending. |

The same directory holds further guards not listed above (`doc-reference-guard`, `renderer-copy-guard`, `renderer-html-sink-guard`, `output-stream-guard`, `task-scene-background-guard`, `universe-canvas-sizing-guard`, `objective-flow-copy/css-guard`, `objective-progress-band-guard`, `settings-surface-css-guard`, `surface-state-paper-css-guard`, `formal-assessment-guard`, `companion-center-copy-guard`, `notebook-round-lost-shape-guard`); they belong to the same read-the-source family.

### API (`apps/api/src/__tests__/`)

| Guard | Invariant it protects |
| --- | --- |
| `error-envelope-source-guard.test.ts` | The error envelope: `DomainError` maps to HTTP bodies stably, and service vs. simple error shapes stay consistent. |
| `cursor-column-db-clock-source-guard.test.ts` | Any timestamp column used as a pagination cursor must be written with the database clock — clock skew between replicas makes the tuple comparison drop or repeat rows. |
| `feature-flags-naming-source-guard.test.ts` | File names must match their contents. The real capability-flag choke point is `apps/api/src/config/learning-companion-flags.ts`; the file in `packages/shared` was renamed to `provider-prompt-cache.ts` on 2026-09-29 and must not grow back into two same-named, different things. |
| `companion-layer-boundaries-source-guard.test.ts` | Plan 40b §6.2 layer boundary: the reachability closure from `packages/shared/src/ai-task-kernel.ts`, judged on **resolved paths**, may not import the persona, domain write entry points, `db-schema/*` or `apps/api/src/modules/*`. Mentioning "persona" in a comment is not a violation; importing it is. |
| `doc-pointer-reachability-source-guard.test.ts` | `docs/**.md` pointers in source comments must still open. Scan roots: `apps/api/src`, `workers/ai-worker/src`, `packages/shared/src`, `apps/desktop-client/src`. Includes a self-proof that a deliberately broken pointer is reported as dangling. |
| `ci-test-file-references.test.ts` | Integration files named by scripts must exist. References are resolved relative to each step's own `working-directory`, so in-package paths are not misreported as dead. |
| `integration-db-url-guard.test.ts` | Hard-coded development database URLs must not reappear in test code (scans `src/integration-tests`, `src/__tests__`, `*.test.ts` and `src/scripts`). Production code is **deliberately out of scope**: the fallbacks there point at compose service names and are guarded by a required `NODE_ENV=production` check. |
| `source-text-guard-naming.test.ts` | The guards themselves must be classifiable by naming convention. |

`route-contract` and `schema-isolation-gate` are **not part of that unit group**. They are real-database suites under `apps/api/src/integration-tests/`:

- `route-contract-postgres.integration.ts` (run by `test:route-contract:postgres`) checks the real HTTP contract of the authenticated routes.
- `schema-isolation-gate-postgres.integration.ts` is the workspace-isolation **schema ratchet**, run by `test:users-rls:postgres`. It registers the current set of violations as a baseline and then requires the actual set to equal it exactly: a new table without a foreign key turns red, and so does fixing a table without deleting it from the baseline. The foreign-key baseline currently holds **89** entries (table names, no duplicates); the "RLS not enabled" baseline **is an empty array and must stay empty**. The RLS criterion looks for `workspace_id` **or** `user_id`, so tables partitioned by person such as `users` are in the denominator.

### Repository level (`.github/scripts/`)

| Contract test | Invariant it protects |
| --- | --- |
| `ci-workflow-contract.test.mjs` | Pins both directions. The seven directories `make verify` runs per package must **each** appear as a tested path in `main-ci.yml` (only matrix `path:` entries and literal `working-directory:` values count; `${{ matrix.path }}` references do not) — dropping one turns red. Conversely CI must not mention gate names that local does not run: `coverage-gate`, `skip-todo-gate`, `gitleaks`, `npm audit`, `trivy`, `pgvector`; it must not start a postgres service; and the `push` trigger must still include `main`. |
| `version-contract.test.mjs` | `release/version.json` is the single source and the three package roots (`apps/api`, `workers/ai-worker`, `packages/shared`) stay in sync; `--write` synchronises, `--check` detects drift. The root list is written out explicitly in the test rather than derived from the implementation constant, so deleting a root surfaces as a readable failure instead of a silent pass. |
| `release-manifest-contract.test.mjs` | The manifest's required gates (`unit`, `integration`, `coverage`, `dependencyScan`, `secretScan`, `containerScan`), the shape of the journal and image digests, and the fail-closed rule that a complete artifact must exist on an exact release tag. |
| `postgres-integration-lifecycle.test.mjs` | Every client created by `const x = postgres(` inside the two `src/integration-tests/` directories must be explicitly `end()`-ed; no leaked connections. |
| `coverage-gate-lib.test.mjs` | The threshold library's parsing and aggregation semantics, including "fail closed when the changed-lines input is missing". |

## The two gates that only run for releases

> **Note:** Neither `make coverage-gate` nor `make skip-todo-gate` is part of `make verify`, and neither is in CI. They are only reached through `make release-check`, which is `verify-release-inputs.mjs` → `make verify` → `coverage-gate.mjs` → `release-manifest-generate.mjs` → `release-manifest-contract.mjs`. A green `make verify` therefore says nothing about coverage thresholds or unregistered skips. `ci-workflow-contract.test.mjs` exists precisely so these two cannot quietly be re-hanged on CI.

### `make coverage-gate`

`node .github/scripts/coverage-gate.mjs` runs `c8` over four packages (`packages/shared`, `packages/ai-quality`, `apps/api`, `workers/ai-worker`), counts each package's full production source in the denominator, aggregates the reports and judges them against thresholds. The desktop client, `agent-core` and `agent-host` are **not** in the coverage package list. Thresholds come from `.github/scripts/coverage-gate-lib.mjs`:

| Gate | Lines | Branches |
| --- | --- | --- |
| All production source | 50 | 60 |
| Default for critical modules (when no explicit override) | 85 | 75 |
| Changed lines | 50 | no branch line |
| `identity` (`apps/api/src/modules/identity/`) | 50 | 85 |
| `tenant isolation` (`apps/api/src/db/client.ts`, `apps/api/src/modules/identity/middleware.ts`, `workers/ai-worker/src/db.ts`) | 75 | 65 |
| `job + lease` (worker `handlers/index.ts`, `index.ts`, `lib/job-lease.ts`, `queue.ts` and `apps/api/src/modules/job/`) | 33 | 55 |
| `import + export` (`apps/api/src/modules/import/`, `export/`) | **0** | **0** |

The critical-module thresholds were re-baselined to the measured values on 2026-09-29; the script comment names the discipline a **ratchet**: they may only move up. The `import-export` group is 0/0 and the comment records it as an explicit debt — those four files have no unit tests at all, so the line can currently only prevent "0 going negative". Changed-lines coverage **fails closed** when no base/head-aware line map is supplied (recorded as not passed); with no base/head configured locally it is recorded as skipped.

A `--report-only` mode still exists and always exits 0. Neither `make coverage-gate` nor `release-check` uses it.

### `make skip-todo-gate`

`node .github/scripts/skip-todo-gate.mjs` runs the tests for the same four packages, counts skipped/todo from TAP output and fails on anything not in the allowlist. `--package <path>` limits it to one package. The allowlist is `.github/scripts/skip-todo-allowlist.json` and currently holds **1 entry**:

| Field | Value |
| --- | --- |
| Test name | real LLM generation (calls DashScope once `.env` is configured) |
| Package | `apps/api` |
| Type | `skip` |
| Expires | `2026-10-19` |

The script validates the allowlist itself: all required fields present, `type` limited to `skip` or `todo`, and `expiresAt` may not exceed **now + 14 days**. That is the gate's ceiling — before expiry, either supply the credentials or rework the case into something a local stand-in can run; it cannot be extended indefinitely.

## What CI actually runs

Four workflows. `node-version` always comes from a repository-level `env.NODE_VERSION: "22"` handed to `actions/setup-node@v4`, with each package's lockfile listed explicitly under `cache-dependency-path`.

| Workflow | File | Triggers | Jobs |
| --- | --- | --- | --- |
| CI | `.github/workflows/main-ci.yml` | `push` to `main`, `push` tags `v*`, `pull_request`, `workflow_dispatch` | `packages` (matrix), `api`, `worker`, `desktop` |
| Desktop client | `.github/workflows/desktop-client.yml` | `workflow_dispatch`, `push` tags `desktop-v*` and `v*` | `shared-contracts`, `variant-quality` (v1/v2 matrix), `package-smoke` (matrix) |
| Desktop package | `.github/workflows/desktop-package.yml` | `workflow_dispatch`, called via `workflow_call` | `windows`, `macos`, `summary` |
| Desktop release | `.github/workflows/desktop-release.yml` | `push` tags `desktop-v*`, `workflow_dispatch` | `resolve`, `build` (reuses desktop-package), `release` |

The rule is stated in the header of `main-ci.yml`: **CI = exactly what the local tests run**, package by package. The `packages` matrix has four labels — Shared contracts, Agent core, Agent host, AI quality (PR mock). Each entry runs `npm ci` in the packages listed in its `deps`, then `npm run typecheck` and `npm test`; the AI quality entry adds `npm run pr-gate`. The `api` and `worker` jobs set `DATABASE_URL_API` / `DATABASE_URL_WORKER` to a deliberately **unreachable** `postgres://ci:ci@127.0.0.1:1/ci`: unit tests import `db.ts` at module load, which builds a lazy pool, and the compose hostname `postgres` does not resolve on a runner — a failed DNS lookup would hang the job until timeout. The `desktop` job **builds before testing**, because `scripts/runtime-asset-containment.test.mjs` measures what ended up under `out/renderer/assets`; without `out/` there is nothing to measure (measured 2026-10-06: without this step three cases fail on a clean runner while local stays green, because the working tree still contains `out/` from an earlier build).

In `desktop-client.yml`, `variant-quality` runs the v1 and v2 values of `VITE_HOME_SCENE_VARIANT` through typecheck → `validate:room-layers` → build → `validate:room-layers:output` → test and uploads `out`. `package-smoke` depends on it and, on linux-x64 / windows-x64 / macos-native runners, produces an unpacked app with `electron-builder --dir`, first **reading `productName` from `electron-builder.yml`** rather than hard-coding the executable name, then running `npm run package:smoke`. The Linux leg uses `xvfb-run` and sets `AILEARN_PACKAGED_OFFLINE_ONLY=1`.

`desktop-package.yml` **packages only and sets no quality gate**: install → build → produce installers → upload artifacts. `windows` and `macos` do not depend on each other; `summary` runs with `if: always()`. Its reason for existing is that you should be able to get an installable, double-clickable package even when the quality gates are red — and separately decide whether that package may be released.

## Known mismatches between docs and code

These differences were found while checking. They are listed so the next step is either to fix the documentation or to re-connect the gate; each row names the **authoritative file**.

| Claim / symptom | Authoritative file | Actual state |
| --- | --- | --- |
| "GitHub Actions also runs: Prometheus alert-rule syntax checks, fresh / repeated / upgrade migrations, API and Worker production builds, non-root image checks, a full production compose start with health checks, worker task consumption, PostgreSQL backup and restore drills" | Header comment of `.github/workflows/main-ci.yml` + `GATES_THAT_LEFT_CI` in `.github/scripts/ci-workflow-contract.test.mjs` | All of these **left CI on 2026-10-06**. CI now has four jobs: the packages matrix, api, worker, desktop. The README paragraph has not been updated. |
| The same README line about "typecheck for five packages" | `main-ci.yml` | Seven directories are typechecked: `packages/shared`, `agent-core`, `agent-host`, `ai-quality`, `apps/api`, `apps/desktop-client`, `workers/ai-worker`. |
| "CI still builds production images from docker-compose.yml directly (see .github/workflows/main-ci.yml)" | Comment above `ensure-db-volume` in the `Makefile` | `main-ci.yml` contains no `docker build` and no compose build step. |
| "`verify` will **really** enforce the coverage threshold" / "Skip/todo allowlist gate (blocks verify and release-check)" | The `verify` and `skip-todo-gate` comments in the `Makefile` | `verify` runs neither `coverage-gate.mjs` nor `skip-todo-gate.mjs`. Only `release-check` runs the coverage gate; the skip/todo gate is not in any chain. Both comments predate 2026-10-06. |
| "Secret scan (Gitleaks) and container scan (Trivy) are integrated in CI" | `Makefile` comment above `verify` + `main-ci.yml` | No workflow contains a gitleaks or trivy step, and `ci-workflow-contract.test.mjs` lists both among the names that must not return. `.gitleaks.toml` is still in the repository. |
| `scripts/with-restricted-db-urls.py` says it mirrors `.github/workflows/main-ci.yml:386-387` | `main-ci.yml` is 257 lines | The cited lines do not exist. `DATABASE_URL_API` / `_WORKER` are on lines 126–127 and 170–171. |
| Comments in `desktop-client.yml`, `desktop-release.yml`, `desktop-version.mjs` and `ci-test-file-references.test.ts` refer to `ci.yml` | `.github/workflows/` directory | The workflow is now `main-ci.yml`; `ci.yml` no longer exists. One criterion is affected: `ciReferences()` in `ci-test-file-references.test.ts` reads `.github/workflows/ci.yml` and returns `[]` when the file is missing, so **the workflow half of that guard is currently inert**; only the `package.json` half is holding (154 references, so the non-empty self-check still passes). |
| `verify-alerts-syntax.mjs`, `verify-shared-exports.mjs`, `coverage-baseline-save.mjs`, `capture-image-digests.mjs`, `.github/ci/ai-platforms.mock.json` | Repository-wide grep excluding `node_modules` and the archive | **None of these five files is called by any make target, workflow or package script.** The output of `capture-image-digests.mjs` is consumed only by `release-manifest-generate.mjs --images`, and neither `make release-manifest` nor `release-check` passes `--images`, so RC manifest image fields take the placeholder branch. |
| `test-companion-integration-postgres` | The two `.PHONY` lists in the `Makefile` | The target is defined on line 276 but **appears in neither `.PHONY` list**. If a directory of that name ever exists, make treats it as a prerequisite and skips the recipe. |
| The `test-postgres` preamble says the local database must first be migrated ("`make migrate` 或容器内 migrate") | The `Makefile` target list | There is no `migrate` target; migrations are applied by the one-shot `migrate` container in the dev compose file. |
| The README project tree lists `packages/db` | The `packages/` directory | What exists is `agent-core`, `agent-host`, `ai-quality`, `card-generation`, `shared`. `packages/db` does not exist, and `card-generation` and `ai-quality` are missing from that tree. |

## Real-window QA

Unit tests and guards cannot tell you whether the real window feels right. The practice here is to write each window pass into `docs/testing/`, stating what was run, what was seen and — explicitly — what was **not** verified:

| File | Content |
| --- | --- |
| `docs/testing/full-qa-2026-10-05.md` | First pass over all pages and the main flows |
| `docs/testing/full-qa-2026-10-05-final.md` | Closing record for the same pass, with a 2026-10-06 re-test update: problem, solution and "evidence after the fix" per item, keeping unclosed items listed (1 to handle, 2 unverified due to version or observation duration) |
| `docs/testing/companion-record-reading-2026-10-05.md` | Companion record reading pass, with test counts broken down by area |
| `docs/testing/discovery-bookmarks-2026-10-05.md` | Discovery book entry and bookmark chain |

Packaged-app evidence comes from `apps/desktop-client/scripts/`, exposed as package scripts:

| Script | What it does |
| --- | --- |
| `npm run package:smoke` | `node scripts/smoke-packaged.mjs`: launches the packaged app through Playwright's `_electron`; finds the bundle by reading `productName` from `electron-builder.yml`; supports `AILEARN_PACKAGED_PREFLIGHT_ONLY` and `AILEARN_PACKAGED_OFFLINE_ONLY` |
| `npm run package:evidence` | Runs `package:smoke` first, then `node scripts/package-evidence.mjs` to collect smoke results and artifact sha256 digests |
| `npm run evidence:manifest` | `node --experimental-strip-types scripts/evidence-manifest.ts`, building the quality evidence manifest from `scripts/fixtures/evidence-manifest.input.json` (contract types from `packages/shared/src/quality-evidence-contracts.ts`) |
| `npm run capture:evidence` | `npm run build`, then `node scripts/capture-evidence.mjs` |

Output lands in `.impeccable/evidence/` at the repository root (`package-smoke.json`, `packaged-manifest.json`, …). The `package-smoke` job in `desktop-client.yml` uploads `.impeccable/evidence/package-smoke-offline.json` together with `release/` as an artifact.

## Adding a test in this repository

These conventions come from `../../../AGENTS.md` plus the way existing test files are written; following them avoids another round of rework.

1. **Keep tests next to what they cover.** Components, styles, copy and state logic live in the feature domain directory; its tests go into that domain's `__tests__/`. Do not create a top-level test directory.
2. **The name decides whether it runs.** Backend tests must be `*.test.ts` to be picked up by `npm test`; anything needing a real database must be `*.integration.ts` **and** be added to a `test:*:postgres` script — otherwise it becomes the third file on disk nobody runs.
3. **Declare your database need.** Read the environment through `testDatabaseUrl()` from `@ailearn/shared/integration-test-db-env`, which fails loudly when a variable is missing. Do not write `?? "postgres://…localhost…"` fallbacks (`integration-db-url-guard` scans for them, and such a fallback once wrote fixtures into the real dev database). If the case assumes an empty database, say so in a comment and point at `scripts/dev-disposable-db.sh`.
4. **Use restricted roles for isolation assertions.** `ailearn_api` and `ailearn_worker` are `NOBYPASSRLS`; under a superuser these assertions either fail or pass falsely. `make test-postgres` supplies the whole variable set; for one-off local reproduction use `scripts/with-restricted-db-urls.py`.
5. **A static guard must include a positive control.** Source-reading guards are green by construction, so add a self-proof: feed it a deliberately violating sample and assert it reports the violation (`hud-substrate-guard`, `doc-pointer-reachability-source-guard` and `ci-test-file-references` all do this). Also assert the denominator is non-empty, so a broken parser cannot pass silently.
6. **Do not pin criteria to file paths.** `graph-surface-shape-guard` now searches the directory tree for the file name, because sibling-relative paths let one test indefinitely postpone splitting the component. The assertion is about the shape of the control flow, not where it lives.
7. **Ledgers may only shrink.** Exemptions, baselines and pending lists (`SIZE_DEBT`, `KNOWN_DEAD`, `PENDING_W2_7`, the two schema-ratchet baselines) must be written as "the actual set equals the list", and must also go red when something is fixed but not removed. Every exemption carries its reason, and deleting an entry deletes the reason with it.
8. **Motion and interaction changes need a real window.** Rapid repeated clicks, reversing mid-transition, motion Off, the system reduced-motion setting, the keyboard focus path, plus genuinely long content, zoom levels and companion placement. Screenshots and unit tests do not substitute for these; write a record in the style of `docs/testing/` and list what stayed unverified.

## What this page does not cover

- Live AI provider calls and online quality evaluation: `pr-gate` only exercises fixed stubs, and `test:platform-live:postgres` needs real provider credentials. Neither is in `make verify` or CI.
- Production image builds, compose smoke tests, backup and restore drills, Alpha infrastructure checks, Gitleaks / npm audit / Trivy scans: the scripts and configuration are in the repository, but no automated chain calls them today. How to run them by hand is in [Operations](./operations.md).
- Current coverage numbers: this page states thresholds and judging rules only. Measuring requires running `make coverage-gate`, which produces its own report.
- Desktop renderer testing practice and the jsdom boundary: see [Desktop client](./desktop-client.md).
- Behavioural tests for `packages/card-generation`: there are none, and this page does not imply coverage.

## Related guides

- [Handbook overview](./overview.md)
- [Architecture](./architecture.md)
- [Development](./development.md)
- [Desktop client](./desktop-client.md)
- [API and data](./api-and-data.md)
- [AI and companion](./ai-and-companion.md)
- [Operations](./operations.md)
- [FAQ and troubleshooting](./faq-and-troubleshooting.md)
- Repository root: [README](../../../README.md), [AGENTS.md](../../../AGENTS.md), [third-party notices](../../../THIRD_PARTY_NOTICES.md)
- Plan index: [docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md)
