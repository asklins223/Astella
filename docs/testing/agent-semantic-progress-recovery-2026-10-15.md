# Desktop semantic source progress recovery — 2026-10-15

Scope remains desktop and its dependent Agent/backend chain. Mobile is excluded. This continues [history pressure/recovery](agent-history-pressure-recovery-2026-10-15.md) and [retrieval decisions](agent-history-retrieval-decisions-2026-10-15.md). The review goal remains active.

## Repair and boundaries

Pressure compaction previously saved a replacement only after every source part completed. A worker crash in the middle repeated earlier model requests. `summarizeCompleteCompanionSource` now optionally commits each validated cumulative semantic state before requesting the next part. It resumes only when the complete source hash, exact processed-prefix hash, UTF-16 boundary, summary hash/schema and protocol contract match. The contract includes provider/model/prompt version, capabilities, output shaping, input capacity, initial inherited state and full initial prompt. Changed input or malformed state restarts from the retained original source; an unread suffix never becomes replacement coverage. A completed final source state can also be reused if the process dies before the replacement is committed.

Migration `0439_companion_compaction_progress.sql` adds a separate private `compaction_checkpoint` column to the existing scoped model-step ledger. It holds one current state per source kind rather than appending a copy of the full handoff for every part. It does not replace the independent model-result checkpoint or duplicate source text per part. Reads/writes bind workspace, user, run, conversation, step and full request; run/generation/account state, current source context and job lease are checked under locks. A cancelled run, old lease or finished step cannot accept a late write. `finishStep` clears intermediate progress after the step completes; complete compaction checkpoints remain in the private handoff.

Both historical-exchange and active read-tool summarizers use this port. A matching request is required: storing source progress alone does not reconstruct missing prior tool turns. Ordinary compaction logs contain metadata, not the private summary. Storage errors are sanitized without attaching SQL bind parameters, and lease/context invalidation propagates instead of being treated as a recoverable summary failure. Public replay/issue-bundle projections select explicit metadata fields and do not include the new column. The updated worker requires migration 0439; it was applied and verified only in the isolated QA database, without modifying the primary database.

## Native interruption and recovery

The native Electron client submitted a status question against the valid 175,140-character historical message using the configured real MiMo provider. A temporary QA model profile declared a 250k-token window to force pressure; production configuration was unchanged. Run `465a6de8-e085-43a8-abda-5fe91942a97e` scanned the canonical historical source JSON, which totals 176,004 UTF-16 code units.

After the first real summary returned, the new progress record was committed through offset **155,713**, with one completed part. The final correction was still in the unread **20,291** code units. A QA-only provider hook held the next request before contacting the provider. Database inspection verified the partial prefix/source/summary hashes and absence of whole-source replacement coverage. The test killed only its own worker, confirmed the process had exited, and aged only that job's heartbeat by three minutes to invoke normal lease recovery promptly. It did not reset run status or resubmit the question.

The new worker automatically reclaimed the same job and logged `resumed partial complete-source compaction` at offset 155,713. Provider-request observation recorded exactly one resumed history-summary request: **[155713, 176004)**. It did not request the saved prefix again. The same run completed; the inspected desktop window displayed project 栖云, address 青禾, color undecided, seaside plan cancelled and never executed, and optics research unfinished. Both executed tools were reads. The original source hash remained unchanged, the complete history checkpoint matched the same source, and all three finished model steps had cleared their intermediate source progress.

Evidence in the audit outputs:

- `agent-native-source-progress-interrupted.json`: live database/worker checks before the deliberate kill.
- `agent-native-source-progress-before-requests.jsonl` and `agent-native-source-progress-after-requests.jsonl`: observed source boundaries; the held request was never sent by the killed worker.
- `agent-native-source-progress-resumed.json`, `agent-native-source-progress-cleanup.json` and `agent-native-source-progress-verification.json`: final state and combined assertions.
- `ui-native-source-progress-resumed.png`: inspected native journal with the five correct final facts.
- `work/source-progress-native-before-worker.log` and `work/source-progress-native-after-worker.log`: actual worker recovery logs.

The run's 142,275 ms to first persisted output includes the deliberate hold/crash/recovery interval. Its ten model reservations include the interrupted second-part reservation. These are recovery evidence, not a latency benchmark. At cleanup the resumed QA worker was already terminal with exit code 1 and no logged exception after the successful run; the cause is unconfirmed. The QA launcher now records child exit code/signal for the next sustained run. No long-running stability claim is based on this sample.

## Verification

- Final full worker unit suite: **1,843 passed, 0 failed** (`work/semantic-progress-worker-final-fences.log`).
- Final related PostgreSQL suite: **83 passed, 0 failed** (`work/semantic-progress-final-fences-postgres.log`). It checks fresh-store resumption, exact prefix/suffix consumption, policy mismatch, stale lease, different scope, cancellation, independent model-result preservation, pressure wiring for both source kinds, and cleanup on real step completion.
- Focused boundary/hash/Unicode/retrieval checks: **20 passed** (`work/semantic-progress-final-focused.log`). Source/policy/model/capacity/output changes and corrupt states cannot reuse earlier coverage; failure to persist a part prevents the next request.
- Shared, API, desktop and worker package type checks passed; worker checking passed again after the final error/fence changes. Migration/journal checks: **11 passed**. Migration 0439 ran successfully in the isolated database.
- The source-reference guard now scans unit and PostgreSQL integration test files; seven existing integration-covered names left its unreferenced baseline. This is a reference scan, not proof that suites ran. The first full run's guard failure and an earlier source-kind assertion fixture error are retained separately; passing claims use the final runs.

The native journal also exposed `nextFromSeq` in a user-facing progress summary. Future summaries now say that later records can be viewed, while model tool data retains the real pagination field. Existing historical receipts were not rewritten.

## Remaining work

Native fault injection here proves historical-source resumption for an identically reconstructed first-step request. Ordinary multi-step crash recovery still needs to reconstruct the accumulated tool transcript and correction state: the current runtime starts from committed base messages, and `loadContinuation` adds only the specifically decided proposal. This is the next review target before claiming general tool-context or format-correction recovery. Background summarizer jobs do not yet use this per-step progress store. Protected current input larger than its model window, inherited summary-hole backfill, native foreground quiet participation, sustained execution and comparable latency/quality measurements also remain open. Hash provenance is not a guarantee of arbitrary semantic summaries' completeness.
