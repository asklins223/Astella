# Desktop history retrieval decisions and host pressure — 2026-10-15

Scope: desktop and its dependent Agent/API chain. Mobile remains excluded. This continues [history pressure and recovery](agent-history-pressure-recovery-2026-10-15.md).

## Full-context retrieval decisions

The classifier sees five recent messages, while the main Agent receives the complete admitted history or its source-bound semantic summary. Previously, any classifier `read` decision forced `toolChoice: required` before the main model could assess that evidence. A historical question could therefore force a redundant lookup even after pressure compaction supplied the requested facts. Changing descriptions alone did not remove this structural requirement.

Pure history/memory read candidates now leave tool choice automatic. The main model retains the complete permitted tool surface and may retrieve missing facts, exact quotations, conflicts or state evidence. The classifier's attention data explicitly describes those candidates as hints. Writes, other reads (including note reads, web search and calculations), mixed candidates and unclassified reads retain the existing required-tool contract. Permission and execution checks still govern actual calls. Tool descriptions now describe evidence gaps rather than treating any question about the past as a mandatory search.

## Native observations

Three independent Electron submissions used identical valid synthetic history text (175,140 characters), the same human question, the configured real MiMo provider and a temporary 250k-token QA window. Original source hashes remained unchanged and all five final facts were correct. These are one sample per revision; generated summaries, account memories and provider timing can vary, so this is not a controlled causal benchmark or a production latency guarantee.

| Revision | First visible text | First target fact | All five facts | Final | Model calls | Read tools |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before retrieval changes | 118.603 s | 122.847 s | 123.809 s | 124.640 s | 11 | 4 |
| Descriptions only | 106.957 s | 107.180 s | 107.654 s | 108.251 s | 11 | 5 |
| Advisory history-read candidates | 29.763 s | 37.925 s | 39.145 s | 40.221 s | 7 | 2 |

Times are persisted `assistant.delta` timestamps relative to run acceptance. The latest first text was a retrieval preamble, not the conclusion. Both remaining reads were model-selected; unnecessary retrieval remains a quality/performance concern. Evidence: `agent-history-retrieval-latency-comparison.json`, `agent-history-retrieval-description-only.json`, `agent-history-retrieval-advisory-complete.json` and `ui-history-retrieval-advisory-complete.png` in the audit outputs.

## Host-origin defects found in the real application

Native `reply.finished` and `presence.quiet` runs failed under the same forced pressure. The runtime appended the current host observation before binding the historical prefix, then compared arrays of different lengths. The binder correctly refused the mismatch, leaving no semantic recovery path. Binding now receives only the frozen dialogue prefix; the full request still retains the exact current observation. A PostgreSQL case checks pressure recovery with an actual host-origin run, without creating a human request.

After this fix, native `reply.finished` run `9137f71e-0c3a-44a8-9e87-f856c35f5853` did compact the complete older exchanges, but then failed with `empty_after_markdown_strip`. A provider may return voice-control markers without speech. The outer dialogue code checked raw nonempty text rather than visible content, so this valid quiet outcome became an unsolicited error. A host-only result whose validated visible text is empty now finishes silently when no prefix has been delivered and there are no rich results. Other invalid output and human empty answers retain their failure behavior. PostgreSQL verifies both sides and the silent `turn.completed` event. This does not conceal failures of actual requested work.

The pre-fix native failures remain in `agent-history-pressure-host-failures.jsonl` and the worker logs. Real quiet participation after both fixes is tracked separately; a mocked pass alone does not establish that native acceptance.

A further native ending-turn input ("这轮就到这里，不需要再补充") completed in run `308a1daf-70ef-4c46-be52-43eecb599ee3`, with a brief closing reply, no tools and no writes. It still needed history pressure compaction (five model calls, about 27.3 seconds), so cheap conversational turns under pressure remain a latency concern. During the subsequent observation, the real desktop session reported `foreground=false`; that interval cannot count as native quiet-presence acceptance. No foreground or idle facts were fabricated. Evidence: `agent-native-host-ending-turn.json`.

## Verification and limits

- Full worker unit suite after advisory retrieval/binding changes: 1,839 passed, 0 failed. Focused runtime/retrieval cases: 68 passed.
- Shared capability contract/catalog/description checks: 21 passed. Shared, API, worker and desktop package type checks passed. Worker type checking passed again after the host quiet-output change.
- Final dialogue/runtime unit regression after the quiet-output change: 148 passed, 0 failed (`work/history-host-silence-final-focused.log`).
- Full related PostgreSQL regression after the quiet-output change: 82 passed, 0 failed (`work/history-host-silence-complete-postgres.log`). The new host marker, human empty-answer and pressure cases also passed together (6 cases).
- The first marker fixture incorrectly assumed Markdown was removed by the current visible-text sanitizer. It was corrected to actual voice markers and the existing `turn.completed` contract; the failing fixture log is retained.

The review goal stays active. [The subsequent source-progress repair](agent-semantic-progress-recovery-2026-10-15.md) adds durable intermediate pressure-compaction state and a native historical-source crash test. General tool-context/format-correction reconstruction, background-job progress, protected current input exceeding model capacity, inherited summary-hole backfill, longer native execution and broader comparable latency/quality samples remain open. Complete source delivery and hash provenance do not establish arbitrary summaries' semantic completeness.
