# Companion audit continued from Cursor — 2026-11-07

This continues Cursor conversation `0a285ca8-73d6-4d08-a95b-ca1af9611e63` in the existing checkout. The inherited task covers companion speed, quality, stability, background AI jobs and prefix caching. Existing unrelated workspace changes were preserved.

The active decisions remain: use the model's normal reasoning default; treat text, reasoning and native tool activity as output for the 60-second silence policy; determine action completion from successful receipts; do not classify ordinary replies by phrase lists or add restrictions for the last bad sentence.

## Changes and reasons

### Ended turns stop model execution and recovery

The final Cursor fix checked for an inactive run on entry to stream recovery. The same stop occurring during a 5xx or empty-stream retry could still enter another recovery branch. Every retry boundary now propagates that stop. The agent loop also propagates it before considering a host-generated delivery from earlier writes.

Run status is authoritative. A failed, cancelled or succeeded step inside a still-active run remains a checkpoint error; it cannot silently abandon that run. Recovery transactions distinguish a normally ended run from a changed account, generation, lease or context. Factual receipt transactions retain their existing ownership fences and can still record facts about completed work.

A cancelled run previously kept its model request and interactive worker slot until provider output resumed. The dialogue handler now checks scoped run status every 500 ms and aborts the in-flight operation when that run ends. This is independent of the long job-lease heartbeat and the provider's silence watchdog. No output timeout was shortened.

### Silence is measured from actual model output

The inherited transport counted any SSE `data:` frame as reasoning activity. Status frames and empty SDK start/end events could therefore postpone the 60-second silence policy without text, reasoning or tool output. The decoded wire observer now classifies nonempty model content. It also accepts complete reasoning, message and function-call items from providers that omit deltas. Transport heartbeats, status frames and empty items do not reset the watchdog.

A regression holds a real stream open after status frames and advances the clock through 60 seconds; the watchdog returns `provider_first_output_timeout`. Both supported wire protocols also retain their normal text/reasoning/tool activity coverage.

### Citation verification precedes display cleanup

The runtime removed unread citation markers before asking whether their pages had actually been read. A search-only citation could therefore lose the evidence request that should have kept its draft private. The existing page-read receipt check now runs first for both ordinary text and finish-tool candidates. This checks structured citation identity and receipts, without scanning prose for completion claims.

### Expansion drafts receive content review before storage

The first real background matrix completed all four jobs, but inspection found substantive errors in the expansion drafts. One reversed an angle relation; two worked examples retained inconsistent calculations. Successful generation and exact source quotations had not established that the new explanations were correct.

Expansion now has a separate, governed model task that reviews the whole draft batch against its source material before `note_expansion_tasks` can become ready. Each draft needs an explicit approval, complete revision or rejection. The host validates complete coverage and revision shape, preserves candidate identities and verified references, and checks the resulting batch's normal invariants. Rejection or unavailable source permission prevents storage of the batch. A malformed review has one contract-repair attempt; a substantive rejection does not regenerate the author draft.

The review uses a stable system policy and puts source material and drafts in a data message. It preserves the configured model's reasoning default and charges durable goal calls through the existing reservation port. It adds a background model call. Ordinary chat receives no additional reviewer call from this change.

The old binary-search-specific prompt patches were removed. Source labels now use the actual `blockOrdinal`, without a second numbering scheme or an instruction to restart numbering at zero.

### Diary memory preserves the complete selected exchange

A fresh real diary/summary pair exposed an additional defect. The diary's deterministic digest copied up to 80 characters from the earliest high-weight reply. The full diary and conversation summary retained later corrections, while the associated memory stored the superseded opening values.

The derived memory now keeps the complete selected source exchange, including speaker labels and corrections, only when the entire record fits the shared memory contract. Larger exchanges remain accessible through the diary's source links and the normal conversation-summary/memory paths; they do not produce a clipped diary memory. This adds no model call. Newly created short-exchange memories also carry the exact source event IDs. Draft and revision checkpoint versions were advanced so old clipped outputs cannot resume under the new behavior.

Publication and its derived memory now share the upsert receipt: a retry that preserves an already published diary cannot attach a different run's excerpt. Published historical artifacts were not rewritten.

## Verification

| Check | Result |
| --- | --- |
| Starting worker suite | 2,021 passed |
| Starting package type checks | shared, API, desktop and worker passed |
| Final worker suite | 2,034 passed, zero failures |
| Final worker type check | Passed |
| Companion PostgreSQL suites | 26 suites, 233 tests passed; diary suites refreshed after the final memory change |
| New expansion publication/review PostgreSQL tests | 5 passed |
| Focused API checks, including SSE and structural guards | 15 passed |
| Focused shared HTTP/contract checks | 31 passed |
| Fresh HTTP text turns | 24: 19 succeeded, 4 intentionally cancelled, 1 awaited confirmation and was then cancelled |
| Random-token image tests | 3 passed: no image, one image, two images plus a document |
| Real background generation | Overview, mind map, expansion and learning-card generation completed; six card questions retained exact source grounding |
| Real diary and conversation-summary jobs | Two fresh pairs completed; the final diary retained six source links, summary coverage was 1–6 with no gaps, and no clipped diary memory was stored |

The database tests used isolated databases and restricted worker/API roles. Several suites require their own database-name prefixes, so the recorded run gave each suite its own clone of a freshly migrated template. See [the suite manifest](evidence/agent-cursor-continuation-2026-11-07/postgres-suites.json).

Seven integration assertions reproduced against the saved starting source. These covered old forced-thinking expectations, removed routing-side-model behavior, request framing and checkpoint fixtures. Two further startup assertions expected timing data in the old prompt location or tried to revive an expired launch delivery. Their fixtures and expectations now follow the implemented behavior. The expansion handler was removed from the uncovered-handler baseline after adding real publication tests; the coverage guard's negative witness now uses a remaining baseline member.

The initial live harness also made two incorrect assumptions: a domain prefix was treated as an exact receipt operation name, and memory recall was required to use no tools. Raw outputs remain in the evidence folder; [verification.json](evidence/agent-cursor-continuation-2026-11-07/verification.json) records these corrections separately. One cancellation check sampled a still-pending job too early; its eventual successful completion is recorded below. The first diary collector queried a nonexistent memory `status` column after both jobs completed; a corrected read collected those same artifacts without rerunning either job.

## Real-model and window observations

All measured main calls used `mimo_responses` / `mimo-v2.6-flash`. Thirty-two main calls reported positive prefix-cache hits, ranging from 1,024 to 10,240 tokens. Missing cache counts are retained as unknown. Short background policies were not padded to reach a cache threshold.

Two running cancellation jobs completed 282 ms and 307 ms after their runs ended. A third run was cancelled while its job was still queued; that job completed without executing the cancelled turn 1,765 ms later. In the three following conversations, the first recorded reasoning/text/tool output arrived in 0.76–1.41 seconds. Final replies arrived in 3.16–6.71 seconds. Earlier probes included queue delays up to 9.38 seconds, so these results are bounded observations rather than a universal latency claim.

A fresh source-backed search turn completed with real search/read receipts and citations. The citation ordering regression also passed in the scripted Postgres runtime test.

After the transport activity fix, another fresh conversation completed in 2.28 seconds and a tool-backed calculation completed in 7.59 seconds. Their three model calls all reported prefix-cache hits. The final diary job completed in 58.66 seconds and its separate conversation-summary job in 14.07 seconds. Their stored content and provenance were inspected; these remain individual measurements.

The new content reviewer independently revised all three original faulty expansion drafts. The corrections agree with the relations documented in [OpenStax's total-internal-reflection section](https://openstax.org/books/university-physics-volume-3/pages/1-4-total-internal-reflection) and [wave equations](https://openstax.org/books/university-physics-volume-1/pages/16-key-equations). The review took 49.4 seconds. A separate full job on ideal-gas process conditions generated and stored three reviewed drafts: author generation took 54.3 seconds and review took 40.2 seconds. The final stored drafts were inspected.

A real Electron development window was opened with a temporary profile and a synthetic account. Checks covered thought/text delivery, persisted conversation history, cached-voice controls, Stop during generation and a new conversation immediately after Stop. The cancelled lecture did not return as a late answer. HTTP probes also received `voice.segment.ready` events. Microphone capture, ASR and hardware barge-in were not revalidated here.

The temporary Electron processes were closed and the synthetic UI account's companion participation and sessions were disabled after verification. Local development services remain running.

These checks establish the observed behavior of the recorded source and cases. Model judgments and future provider latency remain variable; a content reviewer does not prove every possible generated fact. No production deployment or Git commit was performed.

## Reproduction and evidence

From `workers/ai-worker`, run `npm test` and `npm run typecheck`. With the explicit disposable database URLs configured, use `npm run test:companion-integration:postgres` with each suite's required isolated database and `npm run test:note-expansion:postgres` for the five new publication tests. The new tests cover approval, revision, rejection, review contract repair, source deletion during review and preservation of the original draft's source identity.

The [evidence folder](evidence/agent-cursor-continuation-2026-11-07/verification.json) contains raw live outputs, before/after expansion content, the isolated suite manifest, source hashes and a patch relative to the saved starting workspace. Fixtures contain synthetic data; credentials and environment files are excluded.
