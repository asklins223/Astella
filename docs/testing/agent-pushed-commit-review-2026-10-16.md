# Desktop Agent review after the pushed v1.8.0 changes

Reviewed base: `2c590012003bbac18e4f74af656e65038c38a937`. Scope: desktop client and its API/worker dependencies; mobile is excluded. The base commit's GitHub CI passed. That result did not cover the two behavioral defects below.

## Corrections

1. Eager dispatch evaluated `!isJobLeaseActive(...)` without awaiting the asynchronous result. Negating the Promise always produced `false`, so this particular precommit check could not detect a replaced lease. Eager dispatch remains off by default and later execution/ledger fences still apply; this is not evidence of an unrestricted write path. The factory now shares an explicit asynchronous precommit check. A real PostgreSQL regression first accepts the live owner, replaces the stored job lease, and then requires rejection. Before the correction it failed with “Missing expected rejection”.
2. Finalization always updated relationship familiarity and interaction count after its publication transaction, even when that transaction declined a cancelled, superseded or already succeeded run. Such a discarded answer could create a false relationship fact. The transaction now returns a committed-publication acknowledgement; only that acknowledgement permits the weak relationship update. A real PostgreSQL regression checks all three terminal states. Before the correction, the cancelled case incorrectly created a profile. A positive case verifies one successful delivery counts once and ordinary handler replay does not count again.

The regression tests are part of the already registered `companion-dialogue-postgres.integration.ts` suite. No history, prompt, tool result or model response is truncated by these corrections. Existing run/job/source/account fences are retained.

## Validation and release boundary

The two failure cases were reproduced in the isolated review PostgreSQL database, then passed after the corrections together with the positive successful-delivery case. Worker and API type checks and the 44 related API source/authorization guards pass. The complete worker unit suite passes **1,852/1,852**; the related PostgreSQL suite passes **81/81**, including confirmation recovery, complete-source summaries, history retrieval, source invalidation, speculative reuse and the three new behavior checks. Logs are retained in the review task as `work/pushed-review-fixed-worker-tests.log`, `work/pushed-review-isolated-worker.log` and `work/pushed-review-two-regressions-red.log`.

At review time, the human's `v1.8.0` tag points to the base commit above; its release workflows are separate from these follow-up corrections. The tag must not be moved to disguise that difference. The production private environment has a root-only backup and contains the required MiMo key and container configuration path; remote MiMo authentication returned HTTP 200 and listed the configured model. This is configuration reachability evidence, not evidence that the new application images have already been deployed.

This review adds database fault/ownership checks, not a new native UI or multi-day acceptance claim. The earlier report's unresolved acceptance limits—sustained proactive-content quality, comparable end-to-end latency, interrupted voice delivery and long-running semantic retention—remain explicit.
