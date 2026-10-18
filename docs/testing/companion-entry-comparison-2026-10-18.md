# Companion entry comparison — 2026-10-18

The three entry paths are implemented, but the experiment does **not** justify an unconditional replacement of the classified default. Fast native tool choice omitted required note reads and fabricated their contents. Always-on reasoning reduced request count but still produced a wrong logical answer, an empty response and an invalid tool protocol. `COMPANION_AGENT_ENTRY_MODE=classified` remains the current implementation default; this is not evidence that every conversational turn should wait for classification.

## Interpretation correction: conversational latency

The mixed-scenario totals cannot decide the best conversational entry. Among the four casual trials per arm, body-first medians were **2.983 s classified, 2.059 s direct fast, and 2.672 s direct thinking**. All four casual trials per arm passed their limited automatic checks. The classified arm requested 19 model calls for those four trials; each direct arm requested four. Three classified casual drafts were discarded before a formal rerun. These observations come from the request experiment without L1 seeding; they are not a measured production discard rate.

Four observations per arm do not establish stable speed or quality. Direct fast also had a 5.841-second casual observation. The appropriate next acceptance target is conversational body latency without a blocking classifier, evaluated separately from task correctness, task handoff latency and task-to-conversation misrouting. The existing note-read failures reject an unchecked all-traffic fast path; they do not reject a fast conversational path. A hybrid proposal must explain how it chooses or hands off work without another blocking model call, and must test omitted handoffs rather than assuming that absence of tool calls proves a casual turn.

## Implemented paths

- `classified`: existing interpreter, hedged classification, casual/question speculative streams, and formal rerun when neither draft is reusable.
- `direct_fast`: one native-tool request with thinking disabled. A real `companion_deepen` call enables the configured thinking level for subsequent steps; the state survives checkpoints.
- `direct_thinking`: one native-tool request using the model profile's existing default thinking level. No classifier, L1 evaluation, or speculative drafts.

Direct paths use an explicit unclassified host placeholder rather than pretending the model already decided `none`. They preserve original history and retain existing execution checks. Native `companion_configure_turn` applies current voice settings, persists an explicitly requested account dialect through the existing preference writer, and can narrow time-based wakeup constraints. Its source quote must occur in the current user message. These account voice controls retain the prior interpreter's preference semantics and do not authorize note edits or goal execution.

The direct paths are experimental: execution permissions do not independently detect every omitted tool or every unsupported factual assertion. This limitation was reproduced in a real database turn and is why the default remains classified.

Route metadata records `entryMode` and `classifier.source=direct`. Direct placeholders are excluded from L1 history seeding, so they cannot become teacher labels after switching modes. Checkpoints retain the entry mode and deepening state; a resumed run cannot silently change entry modes.

## Hybrid implementation after the conversational-latency correction

`COMPANION_AGENT_ENTRY_MODE=hybrid` adds a single fast generation before the task chain. It emits one JSON branch: `{"reply":"..."}` or `{"task":true}`. The existing incremental envelope decoder streams the reply body with the normal hold policy. There is no classifier or second draft before a reply. Task or unrecognized branches remain private and enter the existing interpreter, permission checks, note prefetch and execution loop; the task chain does not start another pair of speculative drafts.

Original conversation history is preserved. The reply result is consumed by the normal runtime rather than regenerated, and settled checkpoint recovery does not replay the front generation. Direct replies record `classifier.source=direct`, so they cannot seed the L1 teacher history. Task handoffs record the actual classifier receipt and entry timing; route metadata contains no conversation text.

The final real-database probe found another unsupported note answer despite successful request-fixture checks. The delivered path therefore does not rely on handoff judgment alone to obtain visible-note evidence: on a note page, the host loads the existing authorized first page before fast generation, respecting the current no-read constraint. Missing, unreadable, empty or truncated note context returns to classification before any fast publication. Only a complete bounded note can be answered directly from that observation; unrelated note-library contents are not prefetched. This keeps ordinary off-page conversation free of both note reads and classification, but long-note-page conversation can still take the conservative path.

Voice-related input is conservatively kept on the existing voice path: named dialects reuse the provider catalog, and Mandarin/dialect/accent/speech-rate context also bypasses the fast generation. This can slow topic-only voice discussion. It preserves the existing temporary/durable preference writer without requiring another classifier for ordinary conversation. Arbitrary style intent is still a model judgment, not a proven independent detector.

Early native-tool and JSON-plus-tool prototypes failed to honor reply framing or omitted handoffs; they are development pilots, not the acceptance comparison. A two-trial controlled attempt was stopped and retained, including a read request incorrectly answered with a task preamble. The implementation then explicitly disallowed task preambles as conversational answers. Do not discard these failures when assessing the architecture's limits.

A separate 20-scenario/two-repeat routing probe, before the voice bypass, matched the expected branch in 36/40 cases: 16/16 conversational/creative replies, 20/22 application/control handoffs, and 0/2 strict-proof handoffs. The two voice omissions now bypass the model through the existing voice path and have unit/database verification. The two proof omissions remain known limits. These are branch labels, not semantic answer accuracy, and the request fixtures were not used to judge real write success.

A streaming regression also exposed a pre-existing Unicode escape decoder defect: a chunk split immediately after a backslash emitted a following `uXXXX` literally. The decoder now waits for the escape kind before choosing its length; all split positions, surrogate pairs and byte-by-byte input are verified.

The 32-trial controlled comparison completed with 16/16 automatic checks in each arm. For the eight casual observations per arm **without a note page**, body-first p50 was **4.783 s classified versus 2.345 s hybrid**, with **35 versus 8** requested model calls. This subset has the same generation shape as the delivered off-page fast path. Across all twelve casual observations per arm, the earlier variant measured 5.326 s versus 2.345 s; its note-page shape preceded the final host-prefetch correction and is not a latency estimate for that correction. L1 was unseeded/unused, quantiles use linear interpolation, and these small synthetic samples do not establish production tail estimates. Manual review found a conversational quote attributed to the wrong speaker despite the automatic check passing.

After host prefetch, real database probes separately answered **72** and an unseen **93** from the actual note rows, each with one generation and no classifier. The existing voice path saved the durable Henan preference and applied Sichuan for the current turn. A real edit changed 72 to 75, preserved 61 and obtained the canonical API writer's successful receipt. The first edit-only attempt timed out because the disposable worker had no API note-edit consumer; that setup failure is retained, not reported as architecture latency. The successful repeat used `apps/api/scripts/companion-hybrid-note-dispatch.ts` against the same disposable database and the persisted page context. The helper invokes `processCompanionNoteEdit`; it contains no alternative writer and accepts only an explicit synthetic flag plus an `astella_hybrid_*` database.

Hybrid delivery verification: worker **1,992/1,992**, focused protocol/control tests **43/43**, and four hybrid PostgreSQL cases pass; worker and API type checks pass. The API reproduction helper starts and closes successfully against the disposable database. The local development worker was switched to `hybrid` only after the queue was idle, then recreated and verified healthy with `/ready` and `/metrics` returning 200. Repository fallback remains classified; no production deployment was performed. The disposable hybrid database was removed after its connections closed. Long-note context still takes the conservative classified path, and strict-proof automatic escalation remains unqualified.

## Request experiment

Ten new synthetic scenarios, two repetitions, three arms, deterministic shuffle seed 11: **60 trials**. Trials ran sequentially; A's intended internal concurrency was retained. The configured provider was `mimo_responses/mimo-v2.6-flash`, with `none/low/medium/high` declared and **medium** as the default. No model or gateway migration was performed.

The harness uses the existing persona builder, declared tools, provider governance, hedging, streaming decoder, speculative release predicates and formal request builder. Note read/write effects use isolated fixture receipts and actual argument schemas, including exact note identity, version, original blocks and preservation of unrelated content. Expected answers are evaluator-only. B can escalate only after a native model tool call.

This is a request-level experiment, not a replay of the whole production client: L1 was unseeded/unused, formal note prefetch was not simulated, and there was no client/TTS playback timing. These limits matter when estimating rollout gains.

| Arm | Trials | Completed with body | Body-first p50 | Body-first p95 | Requested model calls | Automatic checks passed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Classified + dual speculation | 20 | 19 | 7.029 s | 21.326 s | 108 | 19/20 |
| Direct fast | 20 | 20 | 2.864 s | 15.576 s | 30 | 18/20 |
| Direct thinking | 20 | 18 | 6.076 s | 24.832 s | 30 | 18/20 |

Quantiles use linear interpolation. Body-first time is the first published content of the final tool-free answer, using the same decoder/hold policy; a short buffered final answer is delivered at completion. Tool preambles are recorded separately. The tag-only `[serious]` response is not a body. The original console summary used upper-order quantiles and included that tag-only completion; the derived report corrects these statistical definitions without rerunning or deleting trials.

The p95 values describe completed answers with a body, not failure-inclusive tail latency. A had a 90-second timeout. C had a tag-only response and a protocol error. Equal scenario weights do not represent production traffic shares. Four observations per category are insufficient to establish stable tails or statistical superiority.

Automatic checks validate expected fixture reads/writes, exact edit effects, forbidden writes and limited answer facts. They are **not semantic accuracy**. Manual review additionally found:

- C's `liars/repeat=1` concluded that A spoke truth; the correct answer is B. The loose keyword check had incorrectly accepted it.
- C's `opportunity-cost/repeat=0` added the values of mutually exclusive alternatives instead of taking the best foregone alternative.
- B's `liars/repeat=1` reached the right name but included a contradictory consistency check.
- Several arms exceeded requested brevity; B also produced three poem lines when two were requested.

B did not self-escalate in these 20 trials. Its latency therefore does not establish the quality or cost of an effective automatic deepening policy. The two reasoning scenarios are diagnostic examples, not a hard-reasoning benchmark.

Cancelled calls frequently have no final usage: 49 calls in A and one in C lacked complete token usage. Observed token totals remain lower bounds. The reduction from 108 to 30 requested calls is measurable; a billing reduction percentage is not established.

## Integrated verification

Real database fixtures run in a disposable database, with a fixture-seeding administrative connection and scoped worker execution. No user notes or account settings are changed.

Deterministic integration verifies both direct entry modes without classification/speculation, original-history preservation, native deepening and checkpoint recovery, and persistence of “default Henan dialect, Sichuan for this turn” before the next response. The earlier classified tests remain in the same file.

An explicit real-model integration probe uses the same governed model and actual database tools:

- Direct thinking read the note and correctly answered **72**.
- Direct fast issued **no read** and answered **82.5**. The run still completed: the existing output checks did not cover this omission.
- Direct thinking applied Sichuan speech instructions and saved the durable Henan preference through the existing account writer.
- Fast mode accepted an explicit request to deepen and enabled reasoning. The full task took about **136.6 s** and six model calls, including calculation failures and a repeated explanation. This does not validate a universal “one extra round trip” cost estimate.

The live probe intentionally exits nonzero when an arm fails its acceptance assertions. Its fast-read failure is retained as evidence, not converted into a passing test. TTS instructions and persistence were checked; acoustic output and real-client playback latency were not measured.

Three pre-existing PostgreSQL expectations fail identically on an isolated HEAD checkout: truncated-output rejection and the two action-steering fallback cases. The new direct-mode database cases pass. Their baseline/current logs are kept with the experiment artifacts; do not label those three failures as newly introduced or silently rewrite their assertions.

Final regression: ai-worker **1,977/1,977**, shared **952/952**, and benchmark harness **6/6** pass. Shared, API, desktop-client and ai-worker type checks pass. The deterministic PostgreSQL file passes **11/14**, including all three new direct-entry cases; its three failures are the baseline failures described above. The real-model probe passes three of four scenarios and retains the fast-read failure. Its per-scenario abort limit is 180 seconds. The disposable database was removed after verification.

## Reproduction

```sh
cd workers/ai-worker
ENTRY_BENCH_REAL=1 node --import tsx scripts/companion-entry-benchmark.ts \
  --repeats 2 --out /tmp/companion-entry-comparison.json
```

The benchmark requires the configured provider and a consenting development account (`PROBE_WORKSPACE_ID` / `PROBE_USER_ID`). In the development worker container, copy `workers/ai-worker/scripts/.` into `/app/scripts/` first. Writes are fixture-local.

For database tests, create a disposable database with `scripts/dev-disposable-db.sh`, supply its database URLs, and run `companion-speculative-loop-postgres.integration.ts`. Fixture cleanup requires an administrative fixture connection; actual worker operations still use `DATABASE_URL_WORKER`.

The optional real-model database probe additionally requires `ENTRY_LIVE_REAL=1`, `ENTRY_LIVE_OUT`, and `--test-name-pattern 'live direct entries'`. Its synthetic account records explicit consent and an external-data policy; it never borrows a real user's data or modifies their preferences.

To try a direct path locally, set `COMPANION_AGENT_ENTRY_MODE=direct_fast` or `direct_thinking` and recreate the development worker. Leave `classified` for the baseline. Compose and `.env.example` expose all three values; no production deployment or default switch is part of this change.

The default tool-description and serialized catalog budgets remain 4,000 and 30,000 characters. The two opt-in internal controls have a separate 100-character description and 1,800-character schema allowance. Their cost is explicit rather than silently increasing the default allowance.
