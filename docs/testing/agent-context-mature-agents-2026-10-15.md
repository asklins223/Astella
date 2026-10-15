# Context handling review — 2026-10-15

The active review goal remains open. This round follows the user's explicit instruction to avoid hard truncation and examine mature agent implementations.

## Primary-source comparison

| Project | Relevant behavior | Application here |
| --- | --- | --- |
| [Pi compaction reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md) | Appends a compaction entry, retains recent messages using a kept-entry boundary, and preserves the raw transcript. Normal boundaries follow user-message spans; tool results stay paired with calls. It documents separate overflow/length recovery. | Keep durable originals and recent exchanges; replace older material only with a source-bound summary. |
| [OpenCode core compaction](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts) | Builds checkpoints containing summary and recent context. Groups a user message and subsequent replies into an exchange. It also contains truncation and omission fallbacks. | Adopt exchange boundaries and checkpoints. Do not copy its tool-output truncation or oldest-exchange dropping fallback. |
| [Codex compaction source](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs) | Replaces active history with a compaction checkpoint and records compaction metadata. Its implementation also contains limited retained-user text and oldest-item removal on compaction overflow. | Adopt auditable checkpoint identity. These truncation fallbacks do not satisfy this user's constraint and were not copied. |
| [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Describes semantic compaction, persistent notes, and loading source details through stable references. Warns that aggressive compression loses important context. | Keep decisions, corrections and unresolved work; preserve an original-history retrieval path. A source hash proves source identity, not semantic completeness. |

## Confirmed defect

Failed run `11e9e245-7323-4c7c-bb5f-1da5bc53fbb3` used a 2,048-token replay target. It retained old Bayes questions but omitted their completed assistant answers (5,156 and 9,164 estimated tokens including reasoning). The resulting request contained consecutive questions and the model tried to redo the old examples. The persisted snapshot is in `agent-failed-context-snapshot.json`.

## Implemented changes

- Removed the fixed 2,048-token replay target and the hole-picking budget selector. Uncovered messages remain complete even above a pressure target; the full-request governor sees actual usage.
- Summary-backed projection replaces only older, fully covered exchanges. Consecutive user additions and segmented assistant replies stay together. Coverage gaps preserve their entire exchanges. The most recent answered exchange and later additions remain verbatim.
- Replay reads past the 200-row database page through uncovered history and inherited coverage gaps. Page size is not a context boundary. The background summarizer uses an exchange boundary rather than the former replay token constant.
- Removed the second, 1,600-character summary rendering cutoff and optional-item dropping. The complete persisted summary is injected. A summary replacing history is required context; absent or unusable summary text cannot justify folding originals. Explicit caller capacities reject the whole projection rather than fabricate partial coverage.
- Retained provider reasoning handles and source hashes. No stored messages were cut, deleted, or rewritten.

## Verification

- Context/summary/stream-output regression: 174 passed, 0 failed (`work/context-projection-unit-final.log`).
- PostgreSQL handler, summary-commit and review-fence regressions: 35 passed, 0 failed (`work/context-projection-postgres.log`). Includes 450 messages, inherited coverage gaps, and a segmented exchange longer than a database page. This run preceded the final summary-rendering change; its targeted unit checks and the following real desktop run cover that later change.
- Package `npm run typecheck`: shared, API, desktop-client and ai-worker all exited 0. Desktop build exited 0.
- Real Electron + isolated PostgreSQL/API/worker + configured MiMo: run `214d4d7c-2b0b-40e2-b4eb-a0ecfc4b73ab` succeeded. Exact prompt was verified in the native input before submission. It answered the zero-probability/set-inclusion follow-up with a valid counterexample, did not redo the three examples, and executed no tools.
- That run retained all 22 history messages (25,531 estimated replay tokens including reasoning), omitted 0, and preserved both long mathematical answers. First persisted visible delta: 5,652 ms; final: 8,798 ms; 17 delta batches. One sample does not establish a latency distribution.
- Native rendered result was visually checked and captured in `ui-context-boundary-followup.png`. Full snapshot and run evidence: `agent-context-fixed-snapshot.json`, `agent-context-fixed-turn.json`.
- One preceding test attempt used native `typeText`, which corrupted non-ASCII input. That run is excluded as a boundary-question test; the next attempt used `paste` and verified the complete Unicode prompt before sending.

## Still open

1. Restart greeting run `9bf6666c-4ed3-410c-be61-3020dd4df13b` (`app.started`) answered the old failed mathematics question. It produced correct mathematics but violated the greeting occasion and must not count as a passed autonomy test. Existing prose prohibitions did not prevent it; inspect context authority and terminal-turn representation, then validate in the real app again.
2. The new raw-tool-protocol output fence prevents visible markup leakage, but currently terminates that malformed attempt. It is a protective boundary, not completed recovery. Add safe model feedback/recovery before publication without executing textual XML or retrying already-completed effects.
3. Oversized unsummarized history still needs a complete, pressure-triggered semantic compaction path, including a single oversized exchange. Do not restore arbitrary replay cutoffs or disguise omission as summary coverage. Verify summary completeness and recovery using actual provider limits.
4. Quiet-presence participation, interruption/cancellation, multi-device/mobile behavior, and long-running stability remain part of the active goal. No claim of an issue-free design is justified.
