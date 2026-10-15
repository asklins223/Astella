# Desktop history retrieval and quote validation — 2026-10-15

The audit remains active. The user's latest decision limits acceptance to the desktop client and its dependent Agent/backend chain. Unreleased mobile clients are excluded. Audit-added iOS code was reverted and the dedicated audit simulator was shut down; existing mobile work was preserved.

## Historical evidence can be retrieved before a summary exists

Native Electron exposed a summary-only search gap: a failed mathematics question remained in the transcript, but searching from the separate inbox found nothing because the older conversation had no summary. `companion_recall_past_conversation` now searches scoped source messages as well as valid summaries, methods and goals. Source hits carry stable message identity, content hash, exchange anchor, creation time and reply terminal status. It searches all conversation kinds owned by the same user in the same workspace, including journey transcripts. A miss is not proof that no history exists, and unavailable search branches are reported explicitly.

Search returns locators rather than cut source excerpts. Reading a locator returns complete messages and an actual next-unread sequence cursor. The old implicit `fromSeq + 19` boundary prevented the reader from observing a 21st row and was incorrect when sequences had gaps. An explicitly requested endpoint is still respected. The page character target is soft: an oversized first message is returned whole. The tool no longer declares a false fixed output ceiling; full-request token governance measures the actual result. This does not solve requests whose protected evidence alone exceeds the model window.

PostgreSQL tests cover unsummarized and failed history, uncovered tails, user/workspace isolation, current-conversation exclusion, journey history, consecutive user additions, literal wildcard queries, actual tool search/read, invalid arguments, 21st-row discovery, sequence gaps, explicit endpoints and an oversized complete source message.

## Time is evidence supplied by the server

Native run `f7e8ae4c-6837-4e5c-9b08-4563798cf76d` successfully read the original question and its failed status, then converted its time incorrectly. Historical source tools now use the same clock evidence formatter as conversation replay: UTC source time, server-formatted local time in the frozen timezone, elapsed duration and the interval from the actual preceding message. The reader finds that predecessor even when it is outside the current page. Hour-long intervals retain their remaining seconds. Unit tests also cover the repeated local hour during a New York daylight-saving transition.

The reproduced source was created at 2026-10-15 15:10:14 in Asia/Shanghai. The following greeting was at 16:38:02, 1 hour 27 minutes 47 seconds later. Those are message creation times; they do not prove when narrated events happened.

## Quote verification preserves source boundaries

Native run `22651b96-3228-4544-8e9d-f07f5cad3951` then exposed a separate false rejection: equivalent ASCII/typographic quotation marks and an explicitly marked trailing ellipsis made a real excerpt fail validation. Correction caused a redundant read and eventually a failed run.

Quote comparison now accepts equivalent double quotation typography and an explicitly marked leading/trailing excerpt ellipsis when enough source text remains to verify it. Internal omissions and fabricated additions remain rejected. Each source string is checked independently; combining separate JSON records cannot manufacture a quote across their boundary. Recomputed selection evidence remains available when the runtime's native message list does not repeat the original context block. Assistant drafts are not treated as evidence.

The repeated native request, run `3edde779-e4fc-42cb-99cb-ae5f3f4e78c7`, succeeded with two real read calls: source search and the requested excerpt. There was no extra quote-repair read. The window displayed the correct local time, interval and failed reply status. Evidence: `agent-history-quote-fixed-turn.json` and `ui-history-time-quote-fixed.png` in this chat's outputs directory. Earlier failed runs remain recorded as failures.

## Verification and unresolved work

- Full worker suite after quote repair: 1,815 passed, 0 failed; `work/history-quote-worker-full.log`.
- Focused quote/runtime tests: 106 passed, 0 failed; `work/history-quote-repair-unit.log`.
- PostgreSQL history/dialogue/initiative tests after source/time changes, before quote repair: 72 passed, 0 failed; `work/history-time-postgres.log`.
- Shared, API, desktop-client and ai-worker package type checks passed after the source/time contract changes. The worker type check also passed after quote repair.
- Native Electron was exercised against the isolated QA API/database and the configured real MiMo provider. Screenshots and persisted runs were inspected; no mobile result counts toward desktop acceptance.

The successful retrieval sample still took 37,703 ms to first persisted visible output and 41,977 ms to final. Interpretation alone recorded 7,361 ms. The two tool-ledger creation times were approximately 21 and 28 seconds after the request. These timestamps do not isolate SQL, provider reasoning, transport and renderer durations; they are not a controlled latency improvement claim. Comparable repeated measurements remain required.

Background and active read-tool compaction now consume complete source through measured parts; see [complete-source semantic compaction](agent-complete-source-compaction-2026-10-15.md) for real-model failures and subsequent checks. Recovery before the main runtime and a protected current exchange larger than the model window remain open. Keep all original material recoverable; do not restore the old replay cap or character slicing. Desktop quiet-presence participation, worker restart during correction and long-running behavior also still require their own recorded acceptance evidence. Hash/coverage verification establishes source identity and boundaries, not semantic completeness of generated summaries.
